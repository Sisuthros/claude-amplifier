/**
 * SQLiteStore — thin wrapper around the Node.js built-in `node:sqlite` module.
 *
 * Requires Node >= 22.5.0 (experimental, stable in Node 24).
 * Zero native dependencies — no compilation needed.
 */

// node:sqlite is experimental; suppress the warning programmatically
process.removeAllListeners("warning");

import { DatabaseSync } from "node:sqlite";
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

/** node:sqlite returns null-prototype objects — normalise them. */
function toPlain<T>(row: unknown): T {
  return Object.assign({}, row) as T;
}

function now(): string {
  return new Date().toISOString().replace("T", " ").split(".")[0];
}

// ---------------------------------------------------------------------------
// SQLiteStore
// ---------------------------------------------------------------------------

export class SQLiteStore {
  private db: DatabaseSync;

  constructor(dbPath?: string) {
    const dir = dbPath
      ? path.dirname(dbPath)
      : path.join(os.homedir(), ".claude-amplifier");

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const resolvedPath = dbPath ?? path.join(dir, "amplifier.db");
    this.db = new DatabaseSync(resolvedPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
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
  }

  // -------------------------------------------------------------------------
  // Lessons
  // -------------------------------------------------------------------------

  addLesson(data: Omit<Lesson, "id" | "created_at" | "updated_at">): Lesson {
    const ts = now();
    const stmt = this.db.prepare(`
      INSERT INTO lessons
        (project, type, title, description, context, resolution, prevention, severity, tags, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      data.project,
      data.type,
      data.title,
      data.description,
      data.context ?? null,
      data.resolution ?? null,
      data.prevention ?? null,
      data.severity,
      JSON.stringify(data.tags),
      ts,
      ts
    );
    return this.getLessonById(Number(info.lastInsertRowid))!;
  }

  getLessons(project: string, limit = 50): Lesson[] {
    const stmt = this.db.prepare(
      `SELECT * FROM lessons WHERE project = ? ORDER BY created_at DESC LIMIT ?`
    );
    const rows = stmt.all(project, limit) as unknown[];
    return rows.map((r) => this.parseLesson(toPlain(r)));
  }

  searchLessons(query: string, project?: string): Lesson[] {
    const like = `%${query}%`;
    const rows = project
      ? (this.db
          .prepare(
            `SELECT * FROM lessons WHERE project = ?
             AND (title LIKE ? OR description LIKE ? OR tags LIKE ?)
             ORDER BY created_at DESC LIMIT 30`
          )
          .all(project, like, like, like) as unknown[])
      : (this.db
          .prepare(
            `SELECT * FROM lessons
             WHERE title LIKE ? OR description LIKE ? OR tags LIKE ?
             ORDER BY created_at DESC LIMIT 30`
          )
          .all(like, like, like) as unknown[]);
    return rows.map((r) => this.parseLesson(toPlain(r)));
  }

  private getLessonById(id: number): Lesson | undefined {
    const row = this.db
      .prepare(`SELECT * FROM lessons WHERE id = ?`)
      .get(id) as unknown;
    return row ? this.parseLesson(toPlain(row)) : undefined;
  }

  private parseLesson(row: Record<string, unknown>): Lesson {
    return {
      ...(row as any),
      tags: JSON.parse((row.tags as string) || "[]"),
    };
  }

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------

  addDecision(
    data: Omit<Decision, "id" | "created_at" | "updated_at">
  ): Decision {
    const ts = now();
    const stmt = this.db.prepare(`
      INSERT INTO decisions
        (project, category, title, description, rationale, tags, status, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      data.project,
      data.category,
      data.title,
      data.description,
      data.rationale ?? null,
      JSON.stringify(data.tags),
      data.status,
      ts,
      ts
    );
    return this.getDecisionById(Number(info.lastInsertRowid))!;
  }

  getDecisions(project: string, status = "active"): Decision[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM decisions WHERE project = ? AND status = ?
         ORDER BY created_at DESC`
      )
      .all(project, status) as unknown[];
    return rows.map((r) => this.parseDecision(toPlain(r)));
  }

  searchDecisions(query: string, project?: string): Decision[] {
    const like = `%${query}%`;
    const rows = project
      ? (this.db
          .prepare(
            `SELECT * FROM decisions WHERE project = ?
             AND (title LIKE ? OR description LIKE ? OR category LIKE ? OR tags LIKE ?)
             AND status = 'active' ORDER BY created_at DESC LIMIT 30`
          )
          .all(project, like, like, like, like) as unknown[])
      : (this.db
          .prepare(
            `SELECT * FROM decisions
             WHERE (title LIKE ? OR description LIKE ? OR category LIKE ? OR tags LIKE ?)
             AND status = 'active' ORDER BY created_at DESC LIMIT 30`
          )
          .all(like, like, like, like) as unknown[]);
    return rows.map((r) => this.parseDecision(toPlain(r)));
  }

  updateDecisionStatus(id: number, status: Decision["status"]): void {
    this.db
      .prepare(
        `UPDATE decisions SET status = ?, updated_at = ? WHERE id = ?`
      )
      .run(status, now(), id);
  }

  private getDecisionById(id: number): Decision | undefined {
    const row = this.db
      .prepare(`SELECT * FROM decisions WHERE id = ?`)
      .get(id) as unknown;
    return row ? this.parseDecision(toPlain(row)) : undefined;
  }

  private parseDecision(row: Record<string, unknown>): Decision {
    return {
      ...(row as any),
      tags: JSON.parse((row.tags as string) || "[]"),
    };
  }

  // -------------------------------------------------------------------------
  // Patterns
  // -------------------------------------------------------------------------

  addPattern(data: Omit<Pattern, "id" | "created_at">): Pattern {
    const ts = now();
    const stmt = this.db.prepare(`
      INSERT INTO patterns (title, description, example, tags, applies_to, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      data.title,
      data.description,
      data.example ?? null,
      JSON.stringify(data.tags),
      data.applies_to,
      ts
    );
    return this.getPatternById(Number(info.lastInsertRowid))!;
  }

  getPatterns(project?: string): Pattern[] {
    const rows = project
      ? (this.db
          .prepare(
            `SELECT * FROM patterns
             WHERE applies_to = 'all' OR applies_to LIKE ?
             ORDER BY created_at DESC`
          )
          .all(`%${project}%`) as unknown[])
      : (this.db
          .prepare(`SELECT * FROM patterns ORDER BY created_at DESC`)
          .all() as unknown[]);
    return rows.map((r) => this.parsePattern(toPlain(r)));
  }

  private getPatternById(id: number): Pattern | undefined {
    const row = this.db
      .prepare(`SELECT * FROM patterns WHERE id = ?`)
      .get(id) as unknown;
    return row ? this.parsePattern(toPlain(row)) : undefined;
  }

  private parsePattern(row: Record<string, unknown>): Pattern {
    return {
      ...(row as any),
      tags: JSON.parse((row.tags as string) || "[]"),
    };
  }

  // -------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------

  setPreference(project: string, key: string, value: string): void {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO preferences (project, key, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(project, key, value, ts);
  }

  getPreference(project: string, key: string): string | undefined {
    const row = this.db
      .prepare(`SELECT value FROM preferences WHERE project = ? AND key = ?`)
      .get(project, key) as unknown;
    return row ? (toPlain<{ value: string }>(row)).value : undefined;
  }

  getAllPreferences(project: string): Record<string, string> {
    const rows = this.db
      .prepare(`SELECT key, value FROM preferences WHERE project = ?`)
      .all(project) as unknown[];
    return Object.fromEntries(
      rows.map((r) => {
        const p = toPlain<{ key: string; value: string }>(r);
        return [p.key, p.value];
      })
    );
  }

  // -------------------------------------------------------------------------
  // Context load (bulk fetch for session bootstrap)
  // -------------------------------------------------------------------------

  loadContext(
    project: string,
    types: Array<"lessons" | "decisions" | "patterns" | "bootstrap">
  ): {
    lessons: Lesson[];
    decisions: Decision[];
    patterns: Pattern[];
    preferences: Record<string, string>;
  } {
    const result = {
      lessons: [] as Lesson[],
      decisions: [] as Decision[],
      patterns: [] as Pattern[],
      preferences: {} as Record<string, string>,
    };

    const all = (types as string[]).includes("all");

    if (all || types.includes("lessons")) {
      result.lessons = this.getLessons(project, 30);
    }
    if (all || types.includes("decisions")) {
      result.decisions = this.getDecisions(project);
    }
    if (all || types.includes("patterns")) {
      result.patterns = this.getPatterns(project);
    }
    if (all || types.includes("bootstrap")) {
      result.preferences = this.getAllPreferences(project);
      if (!result.lessons.length) {
        const rows = this.db
          .prepare(
            `SELECT * FROM lessons WHERE project = ? AND severity IN ('high','critical')
             ORDER BY created_at DESC LIMIT 10`
          )
          .all(project) as unknown[];
        result.lessons = rows.map((r) => this.parseLesson(toPlain(r)));
      }
    }

    return result;
  }

  close(): void {
    this.db.close();
  }
}
