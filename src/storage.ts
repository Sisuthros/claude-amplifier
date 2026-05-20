import Database from "better-sqlite3";
import os from "os";
import path from "path";
import fs from "fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Lesson {
  id: number;
  project: string;
  type: "mistake" | "success" | "insight" | "warning";
  title: string;
  description: string;
  context?: string;
  resolution?: string;
  prevention?: string;
  severity: "low" | "medium" | "high" | "critical";
  tags: string[];
  created_at: string;
  updated_at: string;
  // v1.1.0 — pattern detection
  /** The specific situation/action that triggers this lesson. */
  trigger?: string;
  /** Number of times this lesson has been recorded/matched. */
  frequency?: number;
  /**
   * v1.2.0 — explicit pattern grouping key. When set, frequency-bumping uses
   * this key instead of exact title match, so semantically-equivalent lessons
   * with different wording still aggregate into one pattern.
   *
   * Example: pattern_key="read-docs-before-coding" matches all variants of
   * "Lue VIRALLINEN dokumentaatio...", "Check official API spec first...", etc.
   */
  pattern_key?: string;
  // v1.4.0 — verification gate
  /** "claim" (unverified), "evidence" (some support), "confirmed" (verified). */
  verification_status?: "claim" | "evidence" | "confirmed";
  /** JSON array of {evidence_type, evidence_link, recorded_at}. */
  evidence_links?: Array<{
    evidence_type: "git_commit" | "test_run" | "user_confirmation" | "external_doc" | "manual_review";
    evidence_link: string;
    recorded_at: string;
  }>;
  /** 0..1, weights the lesson when Pattern Oracle scores. */
  confidence?: number;
}

export interface Decision {
  id: number;
  project: string;
  category: string;
  title: string;
  description: string;
  rationale?: string;
  tags: string[];
  status: "active" | "superseded" | "reverted";
  created_at: string;
  updated_at: string;
  // v1.1.0 — lifecycle metadata
  /** ISO date or relative "+7d"/"+30d"; surfaces in overdue check when past due. */
  outcome_check_in?: string;
  /** "pending" | "validated" | "failed" — set by amplify_update_decision_outcome. */
  outcome_status?: string;
  /** Notes for how to restore this decision if the system gets reset. */
  restore_step?: string;
  /** Concrete next action (used together with blocked_on). */
  next_step?: string;
  /** What this decision is waiting on (person, event, dependency). */
  blocked_on?: string;
  /** Tradeoffs accepted when choosing this decision. */
  trade_offs?: string[];
  /** Alternatives that were considered and rejected. */
  alternatives_considered?: string[];
  /** ID of the decision this one replaces (knowledge-graph link). */
  supersedes_id?: number;
  /** Reverse links: decision IDs grouped by relation type. */
  related_decision_ids?: {
    triggered_by?: number[];
    caused?: number[];
    relates_to?: number[];
  };
  // v1.4.0 — verification gate (same triple as on lessons)
  verification_status?: "claim" | "evidence" | "confirmed";
  evidence_links?: Array<{
    evidence_type: "git_commit" | "test_run" | "user_confirmation" | "external_doc" | "manual_review";
    evidence_link: string;
    recorded_at: string;
  }>;
  confidence?: number;
}

/** v1.4.0 — audit log entry for pattern_key promotion to global scope. */
export interface PatternPromotion {
  id: number;
  pattern_key: string;
  promoted_at: string;
  promoted_from_projects: string[];
  total_frequency: number;
}

export interface Pattern {
  id: number;
  title: string;
  description: string;
  example?: string;
  tags: string[];
  applies_to: string;
  created_at: string;
}

export interface Preference {
  id: number;
  project: string;
  key: string;
  value: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString().replace("T", " ").split(".")[0];
}

// ---------------------------------------------------------------------------
// SQLiteStore
// ---------------------------------------------------------------------------

export class SQLiteStore {
  private db: Database.Database;
  /** Resolved path of the SQLite file. Exposed so the CLI can print it in `doctor` / `stats`. */
  public readonly dbPath: string;

  constructor(dbPath?: string) {
    const dir = dbPath
      ? path.dirname(dbPath)
      : path.join(os.homedir(), ".claude-amplifier");

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const resolvedPath = dbPath ?? path.join(dir, "amplifier.db");
    this.dbPath = resolvedPath;
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  // -------------------------------------------------------------------------
  // CLI helpers — cross-project listing & a "created vs bumped" variant of
  // addLesson so the CLI's `seed` and `import` commands can tell the user
  // exactly what happened.
  // -------------------------------------------------------------------------

  /** Insert or frequency-bump a lesson, telling the caller which path happened. */
  recordLesson(
    data: Omit<Lesson, "id" | "created_at" | "updated_at" | "frequency"> & {
      frequency?: number;
    }
  ): { created: boolean; lesson: Lesson } {
    const before = this.findExistingLesson(data);
    const lesson = this.addLesson({ ...data, frequency: data.frequency ?? 1 } as Omit<
      Lesson,
      "id" | "created_at" | "updated_at"
    >);
    return { created: !before, lesson };
  }

  private findExistingLesson(data: {
    project: string;
    title: string;
    type: string;
    pattern_key?: string;
  }): { id: number; frequency: number } | undefined {
    if (data.pattern_key) {
      const byKey = this.db
        .prepare(`SELECT id, frequency FROM lessons WHERE project = ? AND pattern_key = ?`)
        .get(data.project, data.pattern_key) as { id: number; frequency: number } | undefined;
      if (byKey) return byKey;
    }
    return this.db
      .prepare(
        `SELECT id, frequency FROM lessons
         WHERE project = ? AND title = ? AND type = ? AND pattern_key IS NULL`
      )
      .get(data.project, data.title, data.type) as
      | { id: number; frequency: number }
      | undefined;
  }

  /** All lessons across every project — used by `claude-amplifier list` / `stats`. */
  getAllLessons(limit = 1000): Lesson[] {
    const rows = this.db
      .prepare(`SELECT * FROM lessons ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as any[];
    return rows.map(this.parseLesson);
  }

  /** All decisions across every project — active and superseded. */
  getAllDecisions(limit = 1000): Decision[] {
    const rows = this.db
      .prepare(`SELECT * FROM decisions ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as any[];
    return rows.map((r) => this.parseDecision(r));
  }

  /** All global patterns (cross-project rules). */
  getAllPatterns(): Pattern[] {
    const rows = this.db
      .prepare(`SELECT * FROM patterns ORDER BY created_at DESC`)
      .all() as any[];
    return rows.map((r) => this.parsePattern(r));
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lessons (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project     TEXT NOT NULL,
        type        TEXT NOT NULL DEFAULT 'insight',
        title       TEXT NOT NULL,
        description TEXT NOT NULL,
        context     TEXT,
        resolution  TEXT,
        prevention  TEXT,
        severity    TEXT NOT NULL DEFAULT 'medium',
        tags        TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS decisions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project     TEXT NOT NULL,
        category    TEXT NOT NULL DEFAULT 'general',
        title       TEXT NOT NULL,
        description TEXT NOT NULL,
        rationale   TEXT,
        tags        TEXT NOT NULL DEFAULT '[]',
        status      TEXT NOT NULL DEFAULT 'active',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS patterns (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        title       TEXT NOT NULL,
        description TEXT NOT NULL,
        example     TEXT,
        tags        TEXT NOT NULL DEFAULT '[]',
        applies_to  TEXT NOT NULL DEFAULT 'all',
        created_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS preferences (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project     TEXT NOT NULL,
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        UNIQUE(project, key)
      );

      CREATE INDEX IF NOT EXISTS idx_lessons_project   ON lessons(project);
      CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project);
      CREATE INDEX IF NOT EXISTS idx_decisions_status  ON decisions(status);
    `);

    // v1.1.0 additive columns — safe to run repeatedly because the
    // try/catch swallows the "duplicate column" error when columns
    // already exist from a previous run.
    this.addColumnIfMissing("lessons", "trigger", "TEXT");
    this.addColumnIfMissing("lessons", "frequency", "INTEGER NOT NULL DEFAULT 1");
    this.addColumnIfMissing("lessons", "pattern_key", "TEXT");

    this.addColumnIfMissing("decisions", "outcome_check_in", "TEXT");
    this.addColumnIfMissing("decisions", "outcome_status", "TEXT");
    this.addColumnIfMissing("decisions", "restore_step", "TEXT");
    this.addColumnIfMissing("decisions", "next_step", "TEXT");
    this.addColumnIfMissing("decisions", "blocked_on", "TEXT");
    this.addColumnIfMissing("decisions", "trade_offs", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("decisions", "alternatives_considered", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("decisions", "supersedes_id", "INTEGER");
    this.addColumnIfMissing("decisions", "relations", "TEXT NOT NULL DEFAULT '{}'");

    // v1.4.0 additive columns — verification gate.
    // Existing 1.3.x rows default to "confirmed" so old data keeps working.
    this.addColumnIfMissing(
      "lessons",
      "verification_status",
      "TEXT NOT NULL DEFAULT 'confirmed'"
    );
    this.addColumnIfMissing(
      "lessons",
      "evidence_links",
      "TEXT NOT NULL DEFAULT '[]'"
    );
    this.addColumnIfMissing(
      "lessons",
      "confidence",
      "REAL NOT NULL DEFAULT 1.0"
    );

    this.addColumnIfMissing(
      "decisions",
      "verification_status",
      "TEXT NOT NULL DEFAULT 'confirmed'"
    );
    this.addColumnIfMissing(
      "decisions",
      "evidence_links",
      "TEXT NOT NULL DEFAULT '[]'"
    );
    this.addColumnIfMissing(
      "decisions",
      "confidence",
      "REAL NOT NULL DEFAULT 1.0"
    );

    // v1.4.0 — audit table for cross-project pattern promotions.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pattern_promotions (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern_key            TEXT NOT NULL,
        promoted_at            TEXT NOT NULL,
        promoted_from_projects TEXT NOT NULL,
        total_frequency        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_promotions_key ON pattern_promotions(pattern_key);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_decisions_outcome ON decisions(outcome_check_in)
        WHERE outcome_check_in IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_lessons_verification ON lessons(verification_status);
      CREATE INDEX IF NOT EXISTS idx_decisions_verification ON decisions(verification_status);
    `);
  }

  private addColumnIfMissing(table: string, column: string, ddl: string): void {
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    } catch (err: any) {
      if (!/duplicate column/i.test(String(err?.message))) throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Lessons
  // -------------------------------------------------------------------------

  addLesson(data: Omit<Lesson, "id" | "created_at" | "updated_at">): Lesson {
    const ts = now();

    // v1.2.0 — pattern-key matching is preferred over title matching, since
    // recurring patterns often surface with slightly different wording each
    // time. If a pattern_key is provided and an active lesson with that key
    // exists for the project, bump its frequency. Otherwise fall back to
    // exact (project, title, type) matching for backwards compatibility.
    let existing: { id: number; frequency: number } | undefined;

    if (data.pattern_key) {
      existing = this.db.prepare(
        `SELECT id, frequency FROM lessons WHERE project = ? AND pattern_key = ?`
      ).get(data.project, data.pattern_key) as
        | { id: number; frequency: number }
        | undefined;
    }

    if (!existing) {
      existing = this.db.prepare(
        `SELECT id, frequency FROM lessons
         WHERE project = ? AND title = ? AND type = ? AND pattern_key IS NULL`
      ).get(data.project, data.title, data.type) as
        | { id: number; frequency: number }
        | undefined;
    }

    if (existing) {
      this.db.prepare(
        `UPDATE lessons SET frequency = frequency + 1, updated_at = ? WHERE id = ?`
      ).run(ts, existing.id);
      return this.getLessonById(existing.id)!;
    }

    // v1.4.0 defaults: pre-existing 1.3.x rows are confirmed; new claims
    // from amplify_record_claim arrive with verification_status="claim" and
    // confidence 0.5. addLesson keeps "confirmed" as the safe default so the
    // 1.3.x amplify_learn wrapper preserves its meaning.
    const verification_status = data.verification_status ?? "confirmed";
    const evidence_links = JSON.stringify(data.evidence_links ?? []);
    const confidence =
      typeof data.confidence === "number"
        ? data.confidence
        : verification_status === "confirmed"
          ? 1.0
          : verification_status === "evidence"
            ? 0.7
            : 0.5;

    const info = this.db.prepare(`
      INSERT INTO lessons
        (project, type, title, description, context, resolution, prevention, severity,
         tags, created_at, updated_at, trigger, frequency, pattern_key,
         verification_status, evidence_links, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      data.project, data.type, data.title, data.description,
      data.context ?? null, data.resolution ?? null, data.prevention ?? null,
      data.severity, JSON.stringify(data.tags), ts, ts,
      data.trigger ?? null,
      data.pattern_key ?? null,
      verification_status,
      evidence_links,
      confidence
    );
    return this.getLessonById(info.lastInsertRowid as number)!;
  }

  getLessons(project: string, limit = 50): Lesson[] {
    const rows = this.db.prepare(
      `SELECT * FROM lessons WHERE project = ? ORDER BY created_at DESC LIMIT ?`
    ).all(project, limit) as any[];
    return rows.map(this.parseLesson);
  }

  searchLessons(query: string, project?: string): Lesson[] {
    const like = `%${query}%`;
    const rows = project
      ? this.db.prepare(
          `SELECT * FROM lessons WHERE project = ?
           AND (title LIKE ? OR description LIKE ? OR tags LIKE ?)
           ORDER BY created_at DESC LIMIT 30`
        ).all(project, like, like, like) as any[]
      : this.db.prepare(
          `SELECT * FROM lessons
           WHERE title LIKE ? OR description LIKE ? OR tags LIKE ?
           ORDER BY created_at DESC LIMIT 30`
        ).all(like, like, like) as any[];
    return rows.map(this.parseLesson);
  }

  private getLessonById(id: number): Lesson | undefined {
    const row = this.db.prepare(`SELECT * FROM lessons WHERE id = ?`).get(id) as any;
    return row ? this.parseLesson(row) : undefined;
  }

  private parseLesson(row: any): Lesson {
    return {
      ...row,
      tags: JSON.parse(row.tags || "[]"),
      frequency: row.frequency ?? 1,
      pattern_key: row.pattern_key ?? undefined,
      verification_status: row.verification_status ?? "confirmed",
      evidence_links: row.evidence_links
        ? JSON.parse(row.evidence_links)
        : [],
      confidence: typeof row.confidence === "number" ? row.confidence : 1.0,
    };
  }

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------

  addDecision(data: Omit<Decision, "id" | "created_at" | "updated_at">): Decision {
    const ts = now();
    const verification_status = data.verification_status ?? "confirmed";
    const evidence_links = JSON.stringify(data.evidence_links ?? []);
    const confidence =
      typeof data.confidence === "number"
        ? data.confidence
        : verification_status === "confirmed"
          ? 1.0
          : verification_status === "evidence"
            ? 0.7
            : 0.5;

    const info = this.db.prepare(`
      INSERT INTO decisions
        (project, category, title, description, rationale, tags, status,
         created_at, updated_at,
         outcome_check_in, outcome_status, restore_step, next_step, blocked_on,
         trade_offs, alternatives_considered, supersedes_id, relations,
         verification_status, evidence_links, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.project, data.category, data.title, data.description,
      data.rationale ?? null, JSON.stringify(data.tags), data.status, ts, ts,
      data.outcome_check_in ?? null,
      data.outcome_check_in ? "pending" : null,
      data.restore_step ?? null,
      data.next_step ?? null,
      data.blocked_on ?? null,
      JSON.stringify(data.trade_offs ?? []),
      JSON.stringify(data.alternatives_considered ?? []),
      data.supersedes_id ?? null,
      JSON.stringify(data.related_decision_ids ?? {}),
      verification_status,
      evidence_links,
      confidence
    );

    // If this decision supersedes another, mark the older one and link reverse.
    if (data.supersedes_id) {
      this.updateDecisionStatus(data.supersedes_id, "superseded");
    }

    return this.getDecisionById(info.lastInsertRowid as number)!;
  }

  /**
   * Return decisions where the outcome check-in date has passed but the
   * outcome status is still "pending". Surfaces in active reminders.
   */
  getOverdueOutcomes(project?: string): Decision[] {
    // SQLite has no native date arithmetic for our relative format ("+7d"),
    // so we fetch pending check-ins and filter in JS.
    const sql = project
      ? `SELECT * FROM decisions WHERE project = ?
         AND outcome_check_in IS NOT NULL AND outcome_status = 'pending'`
      : `SELECT * FROM decisions
         WHERE outcome_check_in IS NOT NULL AND outcome_status = 'pending'`;
    const rows = (project ? this.db.prepare(sql).all(project) : this.db.prepare(sql).all()) as any[];
    const overdue = rows.filter((r) => this.isOutcomeOverdue(r.outcome_check_in, r.created_at));
    return overdue.map(this.parseDecision);
  }

  updateOutcomeStatus(id: number, status: "pending" | "validated" | "failed"): void {
    this.db.prepare(
      `UPDATE decisions SET outcome_status = ?, updated_at = ? WHERE id = ?`
    ).run(status, now(), id);
  }

  private isOutcomeOverdue(checkIn: string, createdAt: string): boolean {
    // Relative format "+7d" / "+30d" — add days to created_at.
    const relMatch = /^\+(\d+)d$/.exec(checkIn);
    let dueDate: Date;
    if (relMatch) {
      const baseDate = new Date(createdAt.replace(" ", "T") + "Z");
      dueDate = new Date(baseDate.getTime() + parseInt(relMatch[1], 10) * 86400000);
    } else {
      // Assume ISO date
      dueDate = new Date(checkIn);
    }
    return !isNaN(dueDate.getTime()) && dueDate.getTime() < Date.now();
  }

  getDecisions(project: string, status = "active"): Decision[] {
    const rows = this.db.prepare(
      `SELECT * FROM decisions WHERE project = ? AND status = ? ORDER BY created_at DESC`
    ).all(project, status) as any[];
    return rows.map(this.parseDecision);
  }

  searchDecisions(query: string, project?: string): Decision[] {
    const like = `%${query}%`;
    const rows = project
      ? this.db.prepare(
          `SELECT * FROM decisions WHERE project = ?
           AND (title LIKE ? OR description LIKE ? OR category LIKE ? OR tags LIKE ?)
           AND status = 'active' ORDER BY created_at DESC LIMIT 30`
        ).all(project, like, like, like, like) as any[]
      : this.db.prepare(
          `SELECT * FROM decisions
           WHERE (title LIKE ? OR description LIKE ? OR category LIKE ? OR tags LIKE ?)
           AND status = 'active' ORDER BY created_at DESC LIMIT 30`
        ).all(like, like, like, like) as any[];
    return rows.map(this.parseDecision);
  }

  updateDecisionStatus(id: number, status: Decision["status"]): void {
    this.db.prepare(
      `UPDATE decisions SET status = ?, updated_at = ? WHERE id = ?`
    ).run(status, now(), id);
  }

  /**
   * v1.2.0 — Partial update of an existing decision. Only the fields you pass
   * are changed; everything else is preserved. Use this instead of `supersede`
   * when you're refining a decision (e.g. adding a follow-up step or updating
   * an outcome check-in) rather than replacing it.
   *
   * Returns the updated decision, or null if id doesn't exist.
   */
  updateDecision(
    id: number,
    patch: Partial<Omit<Decision, "id" | "project" | "created_at">>
  ): Decision | null {
    const existing = this.getDecisionById(id);
    if (!existing) return null;

    // Build SET clauses dynamically — only update fields present in `patch`.
    const sets: string[] = [];
    const values: any[] = [];

    const scalarFields = [
      "category",
      "title",
      "description",
      "rationale",
      "status",
      "outcome_check_in",
      "outcome_status",
      "restore_step",
      "next_step",
      "blocked_on",
      "supersedes_id",
    ] as const;

    for (const f of scalarFields) {
      if (f in patch) {
        sets.push(`${f} = ?`);
        values.push((patch as any)[f] ?? null);
      }
    }

    // JSON-encoded array fields
    if ("tags" in patch) {
      sets.push("tags = ?");
      values.push(JSON.stringify(patch.tags ?? []));
    }
    if ("trade_offs" in patch) {
      sets.push("trade_offs = ?");
      values.push(JSON.stringify(patch.trade_offs ?? []));
    }
    if ("alternatives_considered" in patch) {
      sets.push("alternatives_considered = ?");
      values.push(JSON.stringify(patch.alternatives_considered ?? []));
    }
    if ("related_decision_ids" in patch) {
      sets.push("relations = ?");
      values.push(JSON.stringify(patch.related_decision_ids ?? {}));
    }

    if (sets.length === 0) return existing;

    sets.push("updated_at = ?");
    values.push(now());
    values.push(id);

    this.db
      .prepare(`UPDATE decisions SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values);

    return this.getDecisionById(id) ?? null;
  }

  /**
   * v1.2.0 — Lightweight knowledge-graph linking. Adds `to_id` to `from_id`'s
   * relations under the specified `relation` type. Idempotent — calling twice
   * does not duplicate the link.
   *
   * Returns the updated decision, or null if from_id doesn't exist.
   */
  linkDecisions(
    fromId: number,
    toId: number,
    relation: "triggered_by" | "caused" | "relates_to"
  ): Decision | null {
    const existing = this.getDecisionById(fromId);
    if (!existing) return null;
    if (fromId === toId) {
      throw new Error("Cannot link a decision to itself.");
    }

    const relations = existing.related_decision_ids ?? {};
    const list = relations[relation] ?? [];
    if (!list.includes(toId)) {
      list.push(toId);
    }
    relations[relation] = list;

    this.db
      .prepare(
        `UPDATE decisions SET relations = ?, updated_at = ? WHERE id = ?`
      )
      .run(JSON.stringify(relations), now(), fromId);

    return this.getDecisionById(fromId) ?? null;
  }

  private getDecisionById(id: number): Decision | undefined {
    const row = this.db.prepare(`SELECT * FROM decisions WHERE id = ?`).get(id) as any;
    return row ? this.parseDecision(row) : undefined;
  }

  private parseDecision(row: any): Decision {
    return {
      ...row,
      tags: JSON.parse(row.tags || "[]"),
      trade_offs: row.trade_offs ? JSON.parse(row.trade_offs) : [],
      alternatives_considered: row.alternatives_considered
        ? JSON.parse(row.alternatives_considered)
        : [],
      related_decision_ids: row.relations ? JSON.parse(row.relations) : {},
      verification_status: row.verification_status ?? "confirmed",
      evidence_links: row.evidence_links
        ? JSON.parse(row.evidence_links)
        : [],
      confidence: typeof row.confidence === "number" ? row.confidence : 1.0,
    };
  }

  // -------------------------------------------------------------------------
  // v1.4.0 — Verification gate operations
  // -------------------------------------------------------------------------

  /**
   * Promote a lesson from claim → evidence → confirmed by appending evidence.
   * Each call appends one evidence_link entry.
   *
   * Rules:
   *   - claim + 1 evidence link → "evidence", confidence 0.7
   *   - evidence + user_confirmation OR 2+ distinct evidence types → "confirmed", confidence 1.0
   *   - explicit promote_to overrides the auto-rule (capped at "confirmed")
   *
   * Returns the updated lesson, or null if id doesn't exist.
   */
  verifyLesson(
    id: number,
    evidence_type: NonNullable<Lesson["evidence_links"]>[number]["evidence_type"],
    evidence_link: string,
    promote_to?: "evidence" | "confirmed"
  ): Lesson | null {
    const row = this.db.prepare(`SELECT * FROM lessons WHERE id = ?`).get(id) as any;
    if (!row) return null;

    const links: NonNullable<Lesson["evidence_links"]> = row.evidence_links
      ? JSON.parse(row.evidence_links)
      : [];
    links.push({
      evidence_type,
      evidence_link,
      recorded_at: now(),
    });

    let nextStatus: NonNullable<Lesson["verification_status"]> = row.verification_status ?? "claim";
    if (promote_to) {
      nextStatus = promote_to;
    } else {
      // Auto-promotion rules
      const hasUserConfirmation = links.some((l) => l.evidence_type === "user_confirmation");
      const distinctTypes = new Set(links.map((l) => l.evidence_type)).size;
      if (hasUserConfirmation || distinctTypes >= 2) {
        nextStatus = "confirmed";
      } else if (links.length >= 1) {
        nextStatus = "evidence";
      }
    }

    const nextConfidence =
      nextStatus === "confirmed" ? 1.0 : nextStatus === "evidence" ? 0.7 : 0.5;

    this.db.prepare(
      `UPDATE lessons
       SET evidence_links = ?, verification_status = ?, confidence = ?, updated_at = ?
       WHERE id = ?`
    ).run(JSON.stringify(links), nextStatus, nextConfidence, now(), id);

    return this.getLessonById(id) ?? null;
  }

  /**
   * Demote a lesson back to "claim" by clearing all evidence_links.
   * Used by amplify_verify_claim with promote_to:"claim", or when evidence
   * is later proven false.
   */
  demoteLesson(id: number): Lesson | null {
    const row = this.db.prepare(`SELECT id FROM lessons WHERE id = ?`).get(id) as { id: number } | undefined;
    if (!row) return null;
    this.db.prepare(
      `UPDATE lessons
       SET evidence_links = '[]', verification_status = 'claim', confidence = 0.5, updated_at = ?
       WHERE id = ?`
    ).run(now(), id);
    return this.getLessonById(id) ?? null;
  }

  /**
   * Cross-project pattern statistics for promotion detection.
   * Returns: per pattern_key, the list of projects + total frequency +
   * count of confirmed lessons.
   */
  getPatternStats(): Array<{
    pattern_key: string;
    projects: string[];
    total_frequency: number;
    confirmed_count: number;
  }> {
    const rows = this.db.prepare(`
      SELECT pattern_key,
             GROUP_CONCAT(DISTINCT project)                              AS projects,
             SUM(frequency)                                              AS total_frequency,
             SUM(CASE WHEN verification_status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed_count
      FROM lessons
      WHERE pattern_key IS NOT NULL
      GROUP BY pattern_key
    `).all() as Array<{
      pattern_key: string;
      projects: string;
      total_frequency: number;
      confirmed_count: number;
    }>;
    return rows.map((r) => ({
      pattern_key: r.pattern_key,
      projects: r.projects ? r.projects.split(",") : [],
      total_frequency: r.total_frequency ?? 0,
      confirmed_count: r.confirmed_count ?? 0,
    }));
  }

  /**
   * Record that a pattern_key has been promoted to global scope.
   * Idempotent — calling twice does not duplicate the row.
   */
  recordPromotion(
    pattern_key: string,
    promoted_from_projects: string[],
    total_frequency: number
  ): PatternPromotion {
    const existing = this.db.prepare(
      `SELECT * FROM pattern_promotions WHERE pattern_key = ?`
    ).get(pattern_key) as any;

    if (existing) {
      return {
        ...existing,
        promoted_from_projects: JSON.parse(existing.promoted_from_projects),
      };
    }

    const info = this.db.prepare(`
      INSERT INTO pattern_promotions
        (pattern_key, promoted_at, promoted_from_projects, total_frequency)
      VALUES (?, ?, ?, ?)
    `).run(pattern_key, now(), JSON.stringify(promoted_from_projects), total_frequency);

    return {
      id: info.lastInsertRowid as number,
      pattern_key,
      promoted_at: now(),
      promoted_from_projects,
      total_frequency,
    };
  }

  getPromotion(pattern_key: string): PatternPromotion | null {
    const row = this.db.prepare(
      `SELECT * FROM pattern_promotions WHERE pattern_key = ?`
    ).get(pattern_key) as any;
    if (!row) return null;
    return {
      ...row,
      promoted_from_projects: JSON.parse(row.promoted_from_projects),
    };
  }

  /**
   * Reconstruct the evidence chain for a lesson or decision.
   * Returns the item plus a flattened list of its evidence_links.
   */
  getEvidenceChain(
    id: number,
    kind: "lesson" | "decision" = "lesson"
  ): {
    item: Lesson | Decision;
    evidence_links: NonNullable<Lesson["evidence_links"]>;
  } | null {
    if (kind === "lesson") {
      const lesson = this.getLessonById(id);
      if (!lesson) return null;
      return {
        item: lesson,
        evidence_links: lesson.evidence_links ?? [],
      };
    }
    const decision = this.getDecisionById(id);
    if (!decision) return null;
    return {
      item: decision,
      evidence_links: decision.evidence_links ?? [],
    };
  }

  /** Public accessor used by the Pattern Oracle to score risk. */
  getLessonsByPatternKey(pattern_key: string): Lesson[] {
    const rows = this.db.prepare(
      `SELECT * FROM lessons WHERE pattern_key = ? ORDER BY frequency DESC`
    ).all(pattern_key) as any[];
    return rows.map(this.parseLesson);
  }

  /** Used by the Pattern Oracle to fetch all candidate lessons cheaply. */
  getAllLessonsForProject(project: string): Lesson[] {
    const rows = this.db.prepare(
      `SELECT * FROM lessons WHERE project = ?`
    ).all(project) as any[];
    return rows.map(this.parseLesson);
  }

  // -------------------------------------------------------------------------
  // Patterns
  // -------------------------------------------------------------------------

  addPattern(data: Omit<Pattern, "id" | "created_at">): Pattern {
    const ts = now();
    const info = this.db.prepare(`
      INSERT INTO patterns (title, description, example, tags, applies_to, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      data.title, data.description, data.example ?? null,
      JSON.stringify(data.tags), data.applies_to, ts
    );
    return this.getPatternById(info.lastInsertRowid as number)!;
  }

  getPatterns(project?: string): Pattern[] {
    const rows = project
      ? this.db.prepare(
          `SELECT * FROM patterns WHERE applies_to = 'all' OR applies_to LIKE ? ORDER BY created_at DESC`
        ).all(`%${project}%`) as any[]
      : this.db.prepare(`SELECT * FROM patterns ORDER BY created_at DESC`).all() as any[];
    return rows.map(this.parsePattern);
  }

  private getPatternById(id: number): Pattern | undefined {
    const row = this.db.prepare(`SELECT * FROM patterns WHERE id = ?`).get(id) as any;
    return row ? this.parsePattern(row) : undefined;
  }

  private parsePattern(row: any): Pattern {
    return { ...row, tags: JSON.parse(row.tags || "[]") };
  }

  // -------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------

  setPreference(project: string, key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO preferences (project, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(project, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(project, key, value, now());
  }

  getPreference(project: string, key: string): string | undefined {
    const row = this.db.prepare(
      `SELECT value FROM preferences WHERE project = ? AND key = ?`
    ).get(project, key) as any;
    return row?.value;
  }

  getAllPreferences(project: string): Record<string, string> {
    const rows = this.db.prepare(
      `SELECT key, value FROM preferences WHERE project = ?`
    ).all(project) as any[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  // -------------------------------------------------------------------------
  // Context load (bulk fetch for session bootstrap)
  // -------------------------------------------------------------------------

  loadContext(
    project: string,
    types: Array<"lessons" | "decisions" | "patterns" | "bootstrap" | "all">
  ): {
    /**
     * v1.2.0 — short one-line summary of what's in this context.
     * Helps Claude orient quickly before scanning the full payload.
     */
    summary: string;
    lessons: Lesson[];
    decisions: Decision[];
    patterns: Pattern[];
    preferences: Record<string, string>;
    overdue_outcomes: Decision[];
    active_reminders: Array<{ decision_id: number; title: string; restore_step: string }>;
  } {
    const all = (types as string[]).includes("all");
    const result = {
      summary: "",
      lessons: [] as Lesson[],
      decisions: [] as Decision[],
      patterns: [] as Pattern[],
      preferences: {} as Record<string, string>,
      overdue_outcomes: [] as Decision[],
      active_reminders: [] as Array<{
        decision_id: number;
        title: string;
        restore_step: string;
      }>,
    };

    if (all || types.includes("lessons"))   result.lessons   = this.getLessons(project, 30);
    if (all || types.includes("decisions")) result.decisions = this.getDecisions(project);
    if (all || types.includes("patterns"))  result.patterns  = this.getPatterns(project);
    if (all || types.includes("bootstrap")) {
      result.preferences = this.getAllPreferences(project);
      if (!result.lessons.length) {
        result.lessons = this.db.prepare(
          `SELECT * FROM lessons WHERE project = ? AND severity IN ('high','critical')
           ORDER BY created_at DESC LIMIT 10`
        ).all(project).map(this.parseLesson);
      }
    }

    // Always surface lifecycle metadata if decisions were loaded.
    if (all || types.includes("decisions") || types.includes("bootstrap")) {
      result.overdue_outcomes = this.getOverdueOutcomes(project);
      result.active_reminders = result.decisions
        .filter((d) => d.restore_step && d.status === "active")
        .map((d) => ({
          decision_id: d.id,
          title: d.title,
          restore_step: d.restore_step!,
        }));
    }

    // v1.2.0 — Build a one-line summary so Claude can orient before reading
    // the full payload. Shows counts + the few items that need immediate
    // attention (overdue check-ins, critical lessons, recurring patterns).
    const criticalLessons = result.lessons.filter(
      (l) => l.severity === "critical" || l.severity === "high"
    ).length;
    const recurring = result.lessons.filter((l) => (l.frequency ?? 1) >= 3).length;
    const parts = [
      `${result.decisions.length} active decisions`,
      `${result.lessons.length} lessons`,
    ];
    if (criticalLessons) parts.push(`${criticalLessons} high/critical`);
    if (recurring) parts.push(`${recurring} recurring (seen 3x+)`);
    if (result.overdue_outcomes.length) {
      parts.push(`⏰ ${result.overdue_outcomes.length} overdue check-in${result.overdue_outcomes.length === 1 ? "" : "s"}`);
    }
    if (result.active_reminders.length) {
      parts.push(`🔧 ${result.active_reminders.length} restore step${result.active_reminders.length === 1 ? "" : "s"}`);
    }
    if (result.patterns.length) parts.push(`${result.patterns.length} patterns`);
    result.summary = `[${project}] ${parts.join(" · ")}`;

    return result;
  }

  close(): void {
    this.db.close();
  }
}
