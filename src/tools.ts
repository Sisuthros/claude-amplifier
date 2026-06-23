import {
  SQLiteStore,
  Lesson,
  Decision,
  Pattern,
  AmplifierWriteError,
  AmplifierMutationError,
} from "./storage.js";
import {
  freshnessReport,
  formatFreshnessWarning,
  type FreshnessReport,
} from "./freshness.js";
import { suggestPatternKey } from "./pattern_suggest.js";
import {
  analyzeMemoryFile,
  formatPromotionReport,
} from "./promote_memory.js";
import {
  ValidationError,
  validateId,
  validateOptionalId,
  validateEnum,
  validateRequiredString,
  validateStringArray,
  validateRelations,
} from "./validation.js";
import {
  similarity,
  tsOf,
  isoOf,
} from "./auto-capture-helpers.js";

/**
 * P1 #7 — run a validation block and convert a thrown {@link ValidationError}
 * into the legacy `"Error: …"` string the handlers have always returned for
 * bad input. The handlers' public contract is "return an Error string, never
 * throw, for caller mistakes"; the validation helpers throw, so this adapter
 * preserves that contract without changing the accepted input shape. Any
 * non-ValidationError (a real bug) is re-thrown so it isn't swallowed.
 */
function withValidation<T>(fn: () => T): T | string {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ValidationError) return `Error: ${err.message}`;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// v1.4.1 — context_load truncation defaults
const DEFAULT_CONTEXT_MAX_TOKENS = 4000;
const CONTEXT_LESSONS_POOL_LIMIT = 200; // fetch this many before ranking

type PriorityMode = "smart" | "recent" | "frequency";

/**
 * Cheap token estimate: ~4 UTF-8 *bytes* per token. We deliberately avoid a
 * real tokenizer dependency — this runs on every session start and the goal is
 * "don't drown the context", not exact accounting.
 *
 * Counting bytes rather than `text.length` (JS code units) matters: Finnish
 * ä/ö, emoji, CJK and dense code paths are multi-byte and were badly
 * under-counted by length/4. Under-counting is the dangerous direction — it
 * lets context_load overfill the budget and blow the window. Bytes/4 tracks
 * real tokenization far better for non-ASCII while staying dependency-free.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

/**
 * Weight applied to a lesson's verification_status when ranking by "smart".
 * Confirmed > evidence > claim; unset is treated like "claim".
 */
function verificationStatusWeight(status?: string): number {
  switch (status) {
    case "confirmed":
      return 1.5;
    case "evidence":
      return 1.0;
    case "claim":
      return 0.3;
    default:
      return 0.5; // legacy lessons with no status — neutral
  }
}

/**
 * Recency bonus: lessons recorded in the last 14 days get +1.5.
 * Returns 0 if the date can't be parsed (defensive).
 */
function recencyBonus(createdAt: string, nowMs: number = Date.now()): number {
  const ts = Date.parse(createdAt.replace(" ", "T") + "Z");
  if (Number.isNaN(ts)) return 0;
  const ageDays = (nowMs - ts) / (1000 * 60 * 60 * 24);
  return ageDays < 14 ? 1.5 : 0;
}

/**
 * Smart score:
 *   frequency × 2.0 + confidence × 3.0 + recency_bonus + status_weight
 *
 * Defaults are tuned so a fresh, confirmed, repeating lesson beats an
 * old single-occurrence claim by a wide margin without any one signal
 * dominating.
 */
function smartScore(l: Lesson, nowMs: number = Date.now()): number {
  const freq = l.frequency ?? 1;
  const conf = l.confidence ?? 0.5;
  return (
    freq * 2.0 +
    conf * 3.0 +
    recencyBonus(l.created_at, nowMs) +
    verificationStatusWeight(l.verification_status)
  );
}

/**
 * Sort lessons in place by the requested priority mode.
 *   - "recent":   newest created_at first (legacy behaviour).
 *   - "frequency": highest frequency first, tie-break by recency.
 *   - "smart":    weighted score (see smartScore).
 */
function sortLessonsByPriority(
  lessons: Lesson[],
  mode: PriorityMode,
  nowMs: number = Date.now()
): Lesson[] {
  const sorted = [...lessons];
  if (mode === "recent") {
    sorted.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  } else if (mode === "frequency") {
    sorted.sort((a, b) => {
      const fa = a.frequency ?? 1;
      const fb = b.frequency ?? 1;
      if (fb !== fa) return fb - fa;
      return a.created_at < b.created_at ? 1 : -1;
    });
  } else {
    // smart
    sorted.sort((a, b) => smartScore(b, nowMs) - smartScore(a, nowMs));
  }
  return sorted;
}

/**
 * Greedily include items from `items` (already priority-sorted) until the
 * remaining token budget would be exceeded. Returns the kept items plus
 * how many were dropped.
 */
function truncateByTokenBudget<T>(
  items: T[],
  formatFn: (item: T) => string,
  remainingBudget: number
): { kept: T[]; dropped: number; tokensUsed: number } {
  const kept: T[] = [];
  let used = 0;
  for (const item of items) {
    const cost = estimateTokens(formatFn(item)) + 1; // +1 for the joining newline
    if (used + cost > remainingBudget) break;
    kept.push(item);
    used += cost;
  }
  return { kept, dropped: items.length - kept.length, tokensUsed: used };
}

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [raw];
    } catch {
      return raw
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function formatLesson(l: Lesson): string {
  const freq = l.frequency && l.frequency > 1 ? ` (seen ${l.frequency}x)` : "";
  const parts = [
    `[${l.id}] ${l.severity.toUpperCase()} · ${l.type}${freq} — ${l.title}`,
    `  Project: ${l.project}`,
    `  Description: ${l.description}`,
  ];
  if (l.trigger) parts.push(`  Trigger: ${l.trigger}`);
  if (l.context) parts.push(`  Context: ${l.context}`);
  if (l.resolution) parts.push(`  Resolution: ${l.resolution}`);
  if (l.prevention) parts.push(`  Prevention: ${l.prevention}`);
  if (l.tags.length) parts.push(`  Tags: ${l.tags.join(", ")}`);
  parts.push(`  Recorded: ${l.created_at}`);
  return parts.join("\n");
}

function formatDecision(d: Decision): string {
  const parts = [
    `[${d.id}] [${d.category}] ${d.title}`,
    `  Project: ${d.project} | Status: ${d.status}`,
    `  Description: ${d.description}`,
  ];
  if (d.rationale) parts.push(`  Rationale: ${d.rationale}`);
  if (d.trade_offs && d.trade_offs.length) {
    parts.push(`  Trade-offs: ${d.trade_offs.join("; ")}`);
  }
  if (d.next_step) parts.push(`  Next step: ${d.next_step}`);
  if (d.blocked_on) parts.push(`  Blocked on: ${d.blocked_on}`);
  if (d.outcome_check_in) {
    parts.push(`  Outcome check-in: ${d.outcome_check_in} (${d.outcome_status ?? "pending"})`);
  }
  if (d.restore_step) parts.push(`  Restore step: ${d.restore_step}`);
  if (d.supersedes_id) parts.push(`  Supersedes: #${d.supersedes_id}`);
  if (d.tags.length) parts.push(`  Tags: ${d.tags.join(", ")}`);
  parts.push(`  Recorded: ${d.created_at}`);
  return parts.join("\n");
}

function formatPattern(p: Pattern): string {
  const parts = [
    `[${p.id}] ${p.title}`,
    `  Applies to: ${p.applies_to}`,
    `  ${p.description}`,
  ];
  if (p.example) parts.push(`  Example: ${p.example}`);
  if (p.tags.length) parts.push(`  Tags: ${p.tags.join(", ")}`);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

/**
 * amplify_learn — record a lesson (mistake, success, or insight)
 */
export async function handleLearn(
  store: SQLiteStore,
  args: Record<string, unknown>
): Promise<string> {
  const {
    context,
    resolution,
    prevention,
    tags,
    trigger,
    pattern_key,
  } = args as Record<string, string>;

  // P1 #7 — validate + normalize required/enum fields up front. Returns the
  // legacy "Error: …" string (not a throw) for any caller mistake, preserving
  // back-compat. The accepted input shape is unchanged: project/title/
  // description stay required non-empty strings, type/severity stay the same
  // enums with the same defaults.
  const validTypes = ["mistake", "success", "insight", "warning"] as const;
  const validSeverities = ["low", "medium", "high", "critical"] as const;

  const validated = withValidation(() => ({
    project: validateRequiredString(args.project, "project"),
    title: validateRequiredString(args.title, "title"),
    description: validateRequiredString(args.description, "description"),
    type: validateEnum(args.type, validTypes, "type", "insight"),
    severity: validateEnum(args.severity, validSeverities, "severity", "medium"),
  }));
  if (typeof validated === "string") return validated;
  const { project, title, description, type, severity } = validated;

  let lesson: Lesson;
  try {
    lesson = store.addLesson({
      project,
      type: type as Lesson["type"],
      title,
      description,
      context: context || undefined,
      resolution: resolution || undefined,
      prevention: prevention || undefined,
      severity: severity as Lesson["severity"],
      tags: parseTags(tags),
      trigger: trigger || undefined,
      pattern_key: pattern_key || undefined,
    });
  } catch (err) {
    // v1.5.0 — surface real failures to Claude instead of letting MCP crash
    // or returning a fake success. AmplifierWriteError signals an INSERT that
    // did not persist; any other error is unexpected but worth reporting
    // verbatim so the user can diagnose.
    if (err instanceof AmplifierWriteError) {
      return (
        `ERROR: Lesson NOT recorded. ${err.message}\n` +
        `  See ~/.claude-amplifier/write-errors.jsonl for the audit entry.\n` +
        `  Do not claim this lesson was saved. Retry the call or report the issue.`
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    return `ERROR: Lesson NOT recorded — ${msg}. Do not claim this lesson was saved.`;
  }

  const freqNote =
    lesson.frequency && lesson.frequency > 1
      ? ` (this situation has been recorded ${lesson.frequency} times — pattern!)`
      : "";

  return [
    `Lesson recorded (id: ${lesson.id})${freqNote}.`,
    `  Type: ${lesson.type} | Severity: ${lesson.severity}`,
    `  Project: ${lesson.project}`,
    `  Title: ${lesson.title}`,
  ].join("\n");
}

/**
 * amplify_decisions — track or retrieve architectural decisions
 */
export async function handleDecisions(
  store: SQLiteStore,
  args: Record<string, unknown>
): Promise<string> {
  const {
    op = "track",
    project,
    category = "general",
    title,
    description,
    rationale,
    tags,
    query,
    id,
    status,
    outcome_check_in,
    restore_step,
    next_step,
    blocked_on,
    supersedes,
    outcome_status,
  } = args as Record<string, string>;
  const trade_offs = args.trade_offs;
  const alternatives_considered = args.alternatives_considered;
  const relations = args.relations;

  switch (op) {
    case "track": {
      // P1 #7 — validate required strings, the optional supersedes id, and the
      // relations payload up front. Same accepted shape (supersedes still
      // string-or-number; relations still the 3-bucket object) but a bad id /
      // unknown relation key / non-array bucket now yields a clear Error string
      // instead of being silently passed through to storage.
      const v = withValidation(() => ({
        project: validateRequiredString(args.project, "project"),
        title: validateRequiredString(args.title, "title"),
        description: validateRequiredString(args.description, "description"),
        supersedes_id: validateOptionalId(args.supersedes, "supersedes"),
        related_decision_ids: validateRelations(args.relations, "relations"),
      }));
      if (typeof v === "string") {
        // Preserve the historical "for op=track" suffix on the bare
        // required-field errors so existing callers/messages stay recognizable.
        return v
          .replace(
            /^Error: '(project|title|description)' is required[^\n]*$/,
            (_m, f) => `Error: '${f}' is required for op=track.`,
          );
      }

      let decision: Decision;
      try {
        decision = store.addDecision({
          project: v.project,
          category,
          title: v.title,
          description: v.description,
          rationale: rationale || undefined,
          tags: parseTags(tags),
          status: "active",
          outcome_check_in: outcome_check_in || undefined,
          restore_step: restore_step || undefined,
          next_step: next_step || undefined,
          blocked_on: blocked_on || undefined,
          trade_offs: Array.isArray(trade_offs) ? (trade_offs as string[]) : undefined,
          alternatives_considered: Array.isArray(alternatives_considered)
            ? (alternatives_considered as string[])
            : undefined,
          supersedes_id: v.supersedes_id,
          related_decision_ids: v.related_decision_ids,
        });
      } catch (err) {
        if (err instanceof AmplifierWriteError) {
          return (
            `ERROR: Decision NOT recorded. ${err.message}\n` +
            `  See ~/.claude-amplifier/write-errors.jsonl for the audit entry.\n` +
            `  Do not claim this decision was saved. Retry the call or report the issue.`
          );
        }
        const msg = err instanceof Error ? err.message : String(err);
        return `ERROR: Decision NOT recorded — ${msg}. Do not claim this decision was saved.`;
      }

      const extras: string[] = [];
      if (decision.outcome_check_in)
        extras.push(`  Outcome check-in scheduled: ${decision.outcome_check_in}`);
      if (decision.supersedes_id)
        extras.push(`  Superseded decision #${decision.supersedes_id}`);

      return [
        `Decision recorded (id: ${decision.id}).`,
        `  Project: ${decision.project} | Category: ${decision.category}`,
        `  Title: ${decision.title}`,
        ...extras,
      ].join("\n");
    }

    case "update_outcome": {
      if (!id) return "Error: 'id' is required for op=update_outcome.";
      const newStatus = (outcome_status as any) ?? "validated";
      if (!["pending", "validated", "failed"].includes(newStatus)) {
        return "Error: 'outcome_status' must be one of: pending, validated, failed.";
      }
      // P0 #5 — a missing id makes updateOutcomeStatus throw rather than
      // silently no-op, so we never report a fake "outcome marked as …".
      try {
        store.updateOutcomeStatus(Number(id), newStatus);
      } catch (err) {
        if (err instanceof AmplifierMutationError) {
          return `ERROR: decision ${id} not found — outcome NOT updated. ${err.message}`;
        }
        throw err;
      }
      return `Decision ${id} outcome marked as ${newStatus}.`;
    }

    case "overdue": {
      const overdue = store.getOverdueOutcomes(project || undefined);
      if (!overdue.length) return "No overdue outcome check-ins.";
      return [
        `=== Overdue outcome check-ins (${overdue.length}) ===`,
        ...overdue.map(formatDecision),
      ].join("\n\n");
    }

    case "update": {
      // v1.2.0 — refine a decision without superseding it.
      if (!id) return "Error: 'id' is required for op=update.";

      // Build patch from any field the caller provided. We use 'in args'
      // checks so that passing an explicit null/empty value clears the
      // existing field (otherwise everything is preserved unchanged).
      const patch: Record<string, unknown> = {};
      const passThrough = [
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
      ];
      for (const f of passThrough) {
        if (f in args) patch[f] = (args as any)[f];
      }
      if ("tags" in args) patch.tags = parseTags((args as any).tags);
      if ("trade_offs" in args) {
        patch.trade_offs = Array.isArray((args as any).trade_offs)
          ? (args as any).trade_offs
          : parseTags((args as any).trade_offs);
      }
      if ("alternatives_considered" in args) {
        patch.alternatives_considered = Array.isArray((args as any).alternatives_considered)
          ? (args as any).alternatives_considered
          : parseTags((args as any).alternatives_considered);
      }
      if ("relations" in args) {
        patch.related_decision_ids = (args as any).relations ?? {};
      }
      if ("supersedes" in args) {
        patch.supersedes_id = (args as any).supersedes
          ? Number((args as any).supersedes)
          : null;
      }

      if (Object.keys(patch).length === 0) {
        return `Error: op=update requires at least one field to change.`;
      }

      const updated = store.updateDecision(Number(id), patch as any);
      if (!updated) return `Error: decision ${id} not found.`;
      return [
        `Decision ${id} updated. Fields changed: ${Object.keys(patch).join(", ")}.`,
        "",
        formatDecision(updated),
      ].join("\n");
    }

    case "get": {
      if (!project) return "Error: 'project' is required for op=get.";
      const decisions = store.getDecisions(project, status || "active");
      if (!decisions.length)
        return `No active decisions found for project '${project}'.`;
      return decisions.map(formatDecision).join("\n\n");
    }

    case "search": {
      if (!query) return "Error: 'query' is required for op=search.";
      const decisions = store.searchDecisions(query, project || undefined);
      if (!decisions.length) return `No decisions matching '${query}'.`;
      return decisions.map(formatDecision).join("\n\n");
    }

    case "supersede":
    case "revert": {
      if (!id) return `Error: 'id' is required for op=${op}.`;
      const newStatus = op === "supersede" ? "superseded" : "reverted";
      // P0 #5 — a missing id makes updateDecisionStatus throw (default
      // requireExists:true) rather than silently no-op, so we never report a
      // fake "Decision N marked as …" for a decision that doesn't exist.
      try {
        store.updateDecisionStatus(Number(id), newStatus);
      } catch (err) {
        if (err instanceof AmplifierMutationError) {
          return `ERROR: decision ${id} not found — NOT marked as ${newStatus}. ${err.message}`;
        }
        throw err;
      }
      return `Decision ${id} marked as ${newStatus}.`;
    }

    default:
      return `Error: unknown op '${op}'. Valid: track | get | search | supersede | revert | update | update_outcome | overdue`;
  }
}

/**
 * amplify_link_decisions — v1.2.0 — add a knowledge-graph link between
 * two existing decisions without rewriting either of them. Idempotent.
 */
export async function handleLinkDecisions(
  store: SQLiteStore,
  args: Record<string, unknown>
): Promise<string> {
  // P1 #7 — validate the two ids (positive integers, string-or-number) and the
  // relation enum up front. Same accepted shape; a missing/zero/non-numeric id
  // or bad relation now produces a clear Error string. A valid-but-nonexistent
  // id still falls through to store.linkDecisions → "not found" (unchanged).
  const validRelations = ["triggered_by", "caused", "relates_to"] as const;
  const v = withValidation(() => ({
    from: validateId(args.from, "from"),
    to: validateId(args.to, "to"),
    relation: validateEnum(args.relation, validRelations, "relation"),
  }));
  if (typeof v === "string") return v;

  try {
    const updated = store.linkDecisions(v.from, v.to, v.relation);
    if (!updated) return `Error: decision ${v.from} not found.`;
    return `Linked: decision #${v.from} --${v.relation}--> decision #${v.to}.`;
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

/**
 * amplify_context_load — load saved context for a session
 */
export async function handleContextLoad(
  store: SQLiteStore,
  args: Record<string, unknown>
): Promise<string> {
  const {
    project,
    project_path,
    types: rawTypes,
    max_tokens: rawMaxTokens,
    priority: rawPriority,
  } = args as Record<string, unknown>;

  // Derive project name from path or explicit name
  let projectName = String(project || "");
  if (!projectName && project_path) {
    const parts = String(project_path).replace(/\\/g, "/").split("/");
    projectName = parts.filter(Boolean).pop() || "unknown";
  }
  if (!projectName) {
    return "Error: provide 'project' or 'project_path'.";
  }

  let types: Array<"lessons" | "decisions" | "patterns" | "bootstrap"> = [
    "lessons",
    "decisions",
    "patterns",
  ];
  if (rawTypes === "all" || (Array.isArray(rawTypes) && rawTypes.includes("all"))) {
    types = ["lessons", "decisions", "patterns", "bootstrap"] as any;
  } else if (Array.isArray(rawTypes) && rawTypes.length > 0) {
    types = rawTypes as any;
  }

  // v1.4.1 — token budget + priority
  const maxTokensRaw = Number(rawMaxTokens);
  const maxTokens =
    Number.isFinite(maxTokensRaw) && maxTokensRaw > 0
      ? Math.floor(maxTokensRaw)
      : DEFAULT_CONTEXT_MAX_TOKENS;

  const priority: PriorityMode =
    rawPriority === "recent" || rawPriority === "frequency"
      ? rawPriority
      : "smart";

  // Fetch a wider lessons pool so the ranker has room to work.
  const ctx = store.loadContext(projectName, types, CONTEXT_LESSONS_POOL_LIMIT);

  // Rank lessons by chosen priority. Decisions/patterns are typically small
  // and important enough that we keep them untruncated when possible.
  const totalLessonsFound = ctx.lessons.length;
  const rankedLessons = sortLessonsByPriority(ctx.lessons, priority);

  // Build header (always emitted, doesn't count toward truncation calc but
  // is small in practice).
  const headerLines: string[] = [
    `=== Claude Amplifier Context: ${projectName} ===`,
    `Loaded at: ${new Date().toISOString()}`,
    ctx.summary ? `Summary: ${ctx.summary}` : "",
    `Budget: ${maxTokens} tokens · priority=${priority}`,
  ].filter(Boolean);

  const sections: string[] = [...headerLines];

  // Decisions: keep all but trim from the bottom if they alone would
  // exceed the budget. Decisions are user-curated and few, so this
  // virtually never trims in practice.
  let budgetLeft = maxTokens - estimateTokens(headerLines.join("\n"));
  const decisionTrunc = truncateByTokenBudget(
    ctx.decisions,
    formatDecision,
    budgetLeft
  );
  budgetLeft -= decisionTrunc.tokensUsed;

  if (ctx.decisions.length) {
    sections.push(
      `\n--- Active Decisions (${decisionTrunc.kept.length}${
        decisionTrunc.dropped ? ` of ${ctx.decisions.length}` : ""
      }) ---`,
      ...decisionTrunc.kept.map(formatDecision)
    );
    if (decisionTrunc.dropped) {
      sections.push(
        `... ${decisionTrunc.dropped} more decisions hidden (token budget). ` +
          `Call again with max_tokens=${Math.max(maxTokens * 3, 12000)} to see more.`
      );
    }
  } else {
    sections.push("\n--- Active Decisions ---\nNone recorded yet.");
  }

  // Lessons: this is the main truncation target. Apply token budget on the
  // ranked list.
  const lessonTrunc = truncateByTokenBudget(
    rankedLessons,
    formatLesson,
    Math.max(0, budgetLeft)
  );
  budgetLeft -= lessonTrunc.tokensUsed;

  if (totalLessonsFound) {
    const droppedFromPool = lessonTrunc.dropped;
    sections.push(
      `\n--- Lessons (showed ${lessonTrunc.kept.length} of ${totalLessonsFound}, priority=${priority}) ---`,
      ...lessonTrunc.kept.map(formatLesson)
    );
    if (droppedFromPool > 0) {
      sections.push(
        `Showed top ${lessonTrunc.kept.length} of ${totalLessonsFound} lessons. ` +
          `Use max_tokens=${Math.max(maxTokens * 3, 20000)} to see more, ` +
          `or priority="recent"|"frequency" to change ranking.`
      );
    }
  } else {
    sections.push("\n--- Lessons ---\nNone recorded yet.");
  }

  if (ctx.patterns.length) {
    sections.push(
      `\n--- Global Patterns (${ctx.patterns.length}) ---`,
      ...ctx.patterns.map(formatPattern)
    );
  }

  if (Object.keys(ctx.preferences).length) {
    sections.push("\n--- Preferences ---");
    for (const [k, v] of Object.entries(ctx.preferences)) {
      sections.push(`  ${k}: ${v}`);
    }
  }

  if (ctx.overdue_outcomes && ctx.overdue_outcomes.length) {
    sections.push(
      `\n--- ⏰ Overdue Outcome Check-ins (${ctx.overdue_outcomes.length}) ---`,
      `These decisions had a check-in date that has passed. Confirm whether the`,
      `decision worked, then mark the outcome with:`,
      `  amplify_decisions({ op: "update_outcome", id: <id>, outcome_status: "validated" | "failed" })`,
      "",
      ...ctx.overdue_outcomes.map(
        (d) => `  [#${d.id}] ${d.title} — check-in: ${d.outcome_check_in}`
      )
    );
  }

  if (ctx.active_reminders && ctx.active_reminders.length) {
    sections.push(
      `\n--- 🔧 Restore Steps for Active Decisions (${ctx.active_reminders.length}) ---`,
      `If the system was reset (container rebuilt, machine reformatted), these`,
      `decisions describe how to put them back in place:`,
      "",
      ...ctx.active_reminders.map(
        (r) => `  [#${r.decision_id}] ${r.title}\n    → ${r.restore_step}`
      )
    );
  }

  // v1.5.0 — stale-memory warning. If memory/<date>.md files exist newer
  // than the latest Amplifier write, surface them at the bottom of the
  // session-start context so the operator (or the assistant) can decide
  // whether to retroactively record what happened.
  try {
    const report = freshnessReport(store, projectName, {
      project_path: project_path ? String(project_path) : undefined,
    });
    const warning = formatFreshnessWarning(report);
    if (warning) sections.push(warning);
  } catch {
    // Freshness check is best-effort. A broken memory dir must never break
    // the rest of context_load.
  }

  return sections.join("\n");
}

/**
 * amplify_audit_freshness — v1.5.0 — list memory/<date>.md files that are
 * newer than the latest Amplifier write for a project. Surfaces unrecorded
 * sessions so the operator can retroactively call amplify_learn /
 * amplify_decisions for things worth keeping.
 */
export async function handleAuditFreshness(
  store: SQLiteStore,
  args: Record<string, unknown>,
): Promise<string> {
  const { project, project_path, memory_dir } = args as Record<string, string>;

  let projectName = String(project || "");
  if (!projectName && project_path) {
    const parts = String(project_path).replace(/\\/g, "/").split("/");
    projectName = parts.filter(Boolean).pop() || "";
  }
  if (!projectName) {
    return "Error: provide 'project' or 'project_path'.";
  }

  let report: FreshnessReport;
  try {
    report = freshnessReport(store, projectName, {
      memory_dir: memory_dir || undefined,
      project_path: project_path || undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: freshness check failed — ${msg}`;
  }

  if (report.memory_dir_missing) {
    return [
      `Memory directory not found: ${report.memory_dir}`,
      `(Nothing to audit. This is normal for projects without a memory/ hook.)`,
    ].join("\n");
  }

  if (report.stale_files.length === 0) {
    return [
      `✓ All memory files for project "${projectName}" are older than the latest Amplifier write.`,
      `  Latest Amplifier write: ${report.latest_amplifier_write ?? "(none yet)"}`,
      `  Memory dir scanned: ${report.memory_dir}`,
    ].join("\n");
  }

  const lines: string[] = [
    `Stale memory files for project "${projectName}":`,
    `  Memory dir: ${report.memory_dir}`,
    report.latest_amplifier_write
      ? `  Latest Amplifier write: ${report.latest_amplifier_write}`
      : `  Latest Amplifier write: (none — all memory files unrecorded)`,
    `  Stale count: ${report.stale_files.length}`,
    "",
    "Files (oldest first):",
  ];
  for (const f of report.stale_files) {
    const kb = (f.size_bytes / 1024).toFixed(1);
    lines.push(`  • ${f.date}.md — ${kb} KB — mtime ${f.mtime}`);
  }
  lines.push(
    "",
    "Next step: open each file, decide what's worth keeping, and call amplify_learn / amplify_decisions retroactively.",
  );
  return lines.join("\n");
}

/**
 * amplify_suggest_pattern_key — v1.5.0 — propose existing pattern_keys (or
 * a new one) for a lesson before it is recorded. Helps prevent the
 * "two sessions invent two different keys for the same lesson" failure mode.
 */
export async function handleSuggestPatternKey(
  store: SQLiteStore,
  args: Record<string, unknown>,
): Promise<string> {
  const { project, title, description } = args as Record<string, string>;

  if (!project) return "Error: 'project' is required.";
  if (!title) return "Error: 'title' is required.";
  if (!description) return "Error: 'description' is required.";

  const result = suggestPatternKey(store, project, title, description);

  if (result.matches.length === 0) {
    return [
      `No existing pattern_key for project "${project}" scored above ${result.min_similarity}.`,
      `Suggested NEW key: "${result.proposed_new_key}"`,
      "",
      `Use this key when calling amplify_learn, or pick your own. Reusing the same key`,
      `across recurring lessons is what makes the frequency counter actually count.`,
    ].join("\n");
  }

  const lines: string[] = [
    `Existing pattern_keys for project "${project}" similar to "${title}":`,
    "",
  ];
  for (const m of result.matches) {
    lines.push(
      `  • "${m.pattern_key}" — similarity ${m.similarity}, frequency ${m.existing_frequency}`,
      `      example: ${m.example_title}`,
    );
  }
  lines.push(
    "",
    `Pick one of these if it actually describes the same recurring lesson. If none do,`,
    `coin a new key (e.g. "${result.proposed_new_key ?? "your-new-key"}") rather than forcing a partial match.`,
  );
  return lines.join("\n");
}

/**
 * amplify_promote_from_memory_md — v1.5.0 — read a memory/<YYYY-MM-DD>.md
 * file, run heuristic detection (architectural Wrote: lines, intense
 * activity windows, repeated calls), and return DRAFT suggestions.
 * Never writes to SQLite — the operator decides which drafts deserve
 * amplify_learn / amplify_decisions follow-up calls.
 */
export async function handlePromoteFromMemoryMd(
  _store: SQLiteStore,
  args: Record<string, unknown>,
): Promise<string> {
  const { memory_file } = args as Record<string, string>;
  if (!memory_file) {
    return "Error: 'memory_file' is required (absolute path to a memory/<date>.md file).";
  }
  try {
    const report = analyzeMemoryFile(memory_file);
    return formatPromotionReport(report);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: could not analyze memory file — ${msg}`;
  }
}

/**
 * amplify_global_patterns — get or add patterns that apply across ALL projects
 */
export async function handleGlobalPatterns(
  store: SQLiteStore,
  args: Record<string, unknown>
): Promise<string> {
  const {
    op = "get",
    title,
    description,
    example,
    tags,
    applies_to = "all",
  } = args as Record<string, string>;

  switch (op) {
    case "get": {
      const patterns = store.getPatterns();
      if (!patterns.length) return "No global patterns recorded yet.";
      return [
        `=== Global Patterns (${patterns.length}) ===`,
        ...patterns.map(formatPattern),
      ].join("\n\n");
    }

    case "add": {
      if (!title) return "Error: 'title' is required for op=add.";
      if (!description) return "Error: 'description' is required for op=add.";

      const pattern = store.addPattern({
        title,
        description,
        example: example || undefined,
        tags: parseTags(tags),
        applies_to: applies_to || "all",
      });

      return [
        `Pattern recorded (id: ${pattern.id}).`,
        `  Title: ${pattern.title}`,
        `  Applies to: ${pattern.applies_to}`,
      ].join("\n");
    }

    default:
      return `Error: unknown op '${op}'. Valid: get | add`;
  }
}

// ===========================================================================
// v1.4.0 — Pattern Oracle + Verification Gate
// ===========================================================================

import { preflight, PreflightResult } from "./oracle.js";

/**
 * amplify_preflight — call before starting work to surface failure patterns.
 *
 * Returns a human-readable report plus the structured PreflightResult as JSON.
 * The structured payload is embedded inside a fenced ```json block so Claude
 * can parse it programmatically if it wants to.
 */
export async function handlePreflight(
  store: SQLiteStore,
  args: Record<string, unknown>
): Promise<string> {
  const project = String(args.project ?? "");
  const prompt = String(args.prompt ?? args.task ?? "");
  const context = args.context ? String(args.context) : undefined;

  if (!project) return "Error: 'project' is required.";
  if (!prompt) return "Error: 'prompt' (or 'task') is required.";

  const candidateLessons = store.getAllLessonsForProject(project);
  const candidateDecisions = store.getDecisions(project, "active");
  const promotedPatterns = store.getPromotedPatternSignals(project);

  const result: PreflightResult = preflight({
    project,
    prompt,
    context,
    candidateLessons,
    candidateDecisions,
    promotedPatterns,
  });

  const riskBadge =
    result.risk_level === "critical"
      ? "🔴 CRITICAL"
      : result.risk_level === "high"
        ? "🟠 HIGH"
        : result.risk_level === "medium"
          ? "🟡 MEDIUM"
          : "🟢 LOW";

  const lines = [
    `${riskBadge} risk · score ${result.score} · evidence: ${result.evidence_quality}`,
    "",
    result.suggested_approach,
    "",
  ];

  if (result.matched_patterns.length) {
    lines.push("=== Matched Patterns ===");
    for (const p of result.matched_patterns.slice(0, 5)) {
      lines.push(
        `  • ${p.pattern_key} (${p.frequency}× · ${p.verification_status} · contrib ${p.weight_contribution})`
      );
    }
    lines.push("");
  }

  if (result.matched_lessons.length) {
    lines.push(`=== Matched Lessons (${result.matched_lessons.length}) ===`);
    for (const l of result.matched_lessons.slice(0, 5)) {
      lines.push(`  • [${l.id}] ${l.severity.toUpperCase()} · ${l.type} — ${l.title} (${l.verification_status})`);
    }
    lines.push("");
  }

  if (result.matched_decisions.length) {
    lines.push(`=== Matched Decisions (${result.matched_decisions.length}) ===`);
    for (const d of result.matched_decisions.slice(0, 5)) {
      lines.push(`  • [${d.id}] [${d.category}] ${d.title}`);
    }
    lines.push("");
  }

  lines.push("```json");
  lines.push(JSON.stringify(result, null, 2));
  lines.push("```");

  return lines.join("\n");
}

/**
 * amplify_record_claim — record an unverified claim. Same shape as amplify_learn
 * but sets verification_status="claim" with confidence 0.5 (or user override).
 *
 * The original amplify_learn handler stays for 1.3.x compatibility but routes
 * to this code path with verification_status="confirmed" — see handleLearn at
 * the top of this file (unchanged).
 */
export async function handleRecordClaim(
  store: SQLiteStore,
  args: Record<string, unknown>
): Promise<string> {
  // P1 #7 — validate the required strings up front (replacing the
  // `String(args.x ?? "")` + `if (!x)` pattern). type/severity keep their
  // historical lenient coercion here so the accepted input shape is unchanged.
  const validated = withValidation(() => ({
    project: validateRequiredString(args.project, "project"),
    title: validateRequiredString(args.title, "title"),
    description: validateRequiredString(args.description, "description"),
  }));
  if (typeof validated === "string") return validated;
  const { project, title, description } = validated;

  const type = (args.type ? String(args.type) : "insight") as Lesson["type"];
  const context = args.context ? String(args.context) : undefined;
  const resolution = args.resolution ? String(args.resolution) : undefined;
  const prevention = args.prevention ? String(args.prevention) : undefined;
  const severity = (args.severity ? String(args.severity) : "medium") as Lesson["severity"];
  const trigger = args.trigger ? String(args.trigger) : undefined;
  const pattern_key = args.pattern_key ? String(args.pattern_key) : undefined;
  const initial_confidence =
    typeof args.initial_confidence === "number"
      ? Math.max(0, Math.min(1, args.initial_confidence))
      : 0.5;

  const { created, lesson } = store.recordLesson({
    project,
    type,
    title,
    description,
    context,
    resolution,
    prevention,
    severity,
    tags: parseTags(args.tags),
    trigger,
    pattern_key,
    verification_status: "claim",
    evidence_links: [],
    confidence: initial_confidence,
  } as Parameters<typeof store.recordLesson>[0]);

  const status = created ? "Claim recorded" : "Existing claim frequency-bumped";
  return [
    `${status} (id: ${lesson.id}, status: claim, confidence: ${lesson.confidence ?? initial_confidence}).`,
    `  Title: ${lesson.title}`,
    `  Pattern key: ${lesson.pattern_key ?? "(none)"}`,
    `  Promote with: amplify_verify_claim id=${lesson.id} evidence_type=… evidence_link=…`,
  ].join("\n");
}

/**
 * amplify_verify_claim — promote a claim to evidence or confirmed.
 */
export async function handleVerifyClaim(
  store: SQLiteStore,
  args: Record<string, unknown>
): Promise<string> {
  // P1 #7 — validate the id (positive integer), the evidence_type against the
  // CANONICAL enum, and the required evidence_link up front. Same accepted
  // shape (id still string-or-number; same enum members + field name). A valid
  // id for a missing lesson still falls through to store.verifyLesson →
  // "not found" (unchanged). promote_to keeps its own optional check below.
  const valid_types = [
    "git_commit",
    "test_run",
    "user_confirmation",
    "external_doc",
    "manual_review",
  ] as const;

  const v = withValidation(() => ({
    id: validateId(args.id, "id"),
    evidence_type: validateEnum(args.evidence_type, valid_types, "evidence_type"),
    evidence_link: validateRequiredString(args.evidence_link, "evidence_link"),
  }));
  if (typeof v === "string") return v;
  const { id, evidence_type, evidence_link } = v;

  const promote_to = args.promote_to ? String(args.promote_to) : undefined;
  if (promote_to && promote_to !== "evidence" && promote_to !== "confirmed") {
    return "Error: promote_to must be 'evidence' or 'confirmed'.";
  }

  const updated = store.verifyLesson(
    id,
    evidence_type,
    evidence_link,
    promote_to as "evidence" | "confirmed" | undefined
  );

  if (!updated) return `Error: lesson #${id} not found.`;

  return [
    `Verification recorded (id: ${updated.id}).`,
    `  Status: ${updated.verification_status} (confidence ${updated.confidence})`,
    `  Evidence links: ${(updated.evidence_links ?? []).length}`,
    `  Latest evidence: ${evidence_type} → ${evidence_link}`,
  ].join("\n");
}

/**
 * amplify_promote_pattern — promote a pattern_key from per-project to global.
 *
 * Rule: pattern_key must appear in ≥2 projects AND at least one of those
 * lessons must be "confirmed". Without those conditions the call errors.
 */
export async function handlePromotePattern(
  store: SQLiteStore,
  args: Record<string, unknown>
): Promise<string> {
  const pattern_key = String(args.pattern_key ?? "");
  if (!pattern_key) return "Error: 'pattern_key' is required.";

  const stats = store
    .getPatternStats()
    .find((s) => s.pattern_key === pattern_key);
  if (!stats) return `Error: pattern_key '${pattern_key}' not found in any lesson.`;

  if (stats.projects.length < 2) {
    return [
      `Cannot promote '${pattern_key}': only present in 1 project (${stats.projects[0] ?? "—"}).`,
      `Need ≥2 projects.`,
    ].join("\n");
  }

  if (stats.confirmed_count < 1) {
    return [
      `Cannot promote '${pattern_key}': no confirmed lesson with this key yet.`,
      `Verify at least one lesson first (amplify_verify_claim).`,
    ].join("\n");
  }

  const promo = store.recordPromotion(
    pattern_key,
    stats.projects,
    stats.total_frequency
  );

  return [
    `Pattern promoted to global: ${pattern_key}`,
    `  Source projects: ${promo.promoted_from_projects.join(", ")}`,
    `  Total frequency: ${promo.total_frequency}`,
    `  Promotion id: ${promo.id}`,
  ].join("\n");
}

/**
 * amplify_evidence_chain — show the evidence chain that supports a stored fact.
 */
export async function handleEvidenceChain(
  store: SQLiteStore,
  args: Record<string, unknown>
): Promise<string> {
  const id = Number(args.id);
  const kind = (args.kind ? String(args.kind) : "lesson") as "lesson" | "decision";

  if (!id || isNaN(id)) return "Error: 'id' is required and must be a number.";
  if (kind !== "lesson" && kind !== "decision") {
    return "Error: 'kind' must be 'lesson' or 'decision'.";
  }

  const chain = store.getEvidenceChain(id, kind);
  if (!chain) return `Error: ${kind} #${id} not found.`;

  const item = chain.item;
  const lines = [
    `=== Evidence chain for ${kind} #${id} ===`,
    `  Title: ${(item as Lesson | Decision).title}`,
    `  Status: ${(item as Lesson | Decision).verification_status ?? "confirmed"}`,
    `  Confidence: ${(item as Lesson | Decision).confidence ?? 1.0}`,
    "",
  ];

  if (chain.evidence_links.length === 0) {
    lines.push("(no evidence links — this is a pre-1.4.0 record, treated as confirmed)");
  } else {
    lines.push(`Evidence links (${chain.evidence_links.length}):`);
    for (const link of chain.evidence_links) {
      lines.push(
        `  • ${link.evidence_type} @ ${link.recorded_at}: ${link.evidence_link}`
      );
    }
  }

  return lines.join("\n");
}

// ===========================================================================
// v1.6.0 — Auto-capture tools
//
// Ported from the chimera-prime fork's src/handlers/auto-capture.ts (Clasu,
// 2026-05-25). Ville's brief: "Tämä pitäisi tapahtua automaattisesti. Ei
// kerjäämällä." — make capturing lessons cheap enough that Claude does it
// without being nagged.
//
// Adaptation notes for the master port:
//   - Handlers take (store, args) and return a bare string (the router wraps
//     it), instead of the fork's HandlerContext / HandlerResult envelope.
//   - Storage access is store.getAllLessonsForProject(project) (the fork used
//     ctx.store.getLessons({ project })).
//   - master's Lesson.id is a NUMBER (the fork assumed a string id), so any
//     id slicing uses String(l.id).
//   - master's Lesson has NO `category` column — the fork's category filter
//     lived only in suggest_pattern_key, which master already ships, so it is
//     not ported here.
//   - Structured output is returned as JSON.stringify(payload, null, 2) so the
//     shape stays machine-readable (mirrors the fork's textResponse(obj)).
// ===========================================================================

/**
 * amplify_capture_session — scan a recent transcript for learning triggers
 * (frustration, "this is important", success, prohibitions, forward-looking
 * decisions) and return GUIDANCE on what to capture. Pure text analysis — it
 * does NOT touch the database and saves nothing. Claude still owns the judgment
 * call about which suggestions deserve an amplify_learn / amplify_track_decision
 * follow-up.
 */
export async function handleCaptureSession(
  _store: SQLiteStore,
  args: Record<string, unknown>,
): Promise<string> {
  const validated = withValidation(() => ({
    project: validateRequiredString(args.project, "project"),
    recent_messages: validateRequiredString(args.recent_messages, "recent_messages"),
  }));
  if (typeof validated === "string") return validated;
  const { project, recent_messages } = validated;

  const triggers_found = Array.isArray(args.triggers_found)
    ? (args.triggers_found as unknown[]).map(String)
    : [];

  // Trigger table. Fresh RegExp instances per call so the case-insensitive
  // flag never carries lastIndex state across invocations.
  //
  // PORT NOTE: the fork used ASCII `\b...\b` boundaries, but JS `\b` is
  // defined over ASCII `\w` only — so Finnish trigger words that begin or end
  // on ä/ö (ärsyttävää, tärkeää, älä koskaan, älä unohda, ylpeä) NEVER matched
  // in the fork, silently defeating the "Finnish+English" promise. We use
  // Unicode-aware boundaries `(?<![\p{L}\p{N}_])…(?![\p{L}\p{N}_])` with the
  // `u` flag so Finnish and English both match while still respecting word
  // boundaries (e.g. "importantly" does not trigger "important").
  const B = (alt: string): RegExp =>
    new RegExp(`(?<![\\p{L}\\p{N}_])(${alt})(?![\\p{L}\\p{N}_])`, "iu");
  const triggers: Array<{ pattern: RegExp; type: string; severity: string }> = [
    { pattern: B("ärsyttävää|jankutat|olet tehnyt tämän jo|annoying|frustrating"), type: "mistake", severity: "high" },
    { pattern: B("älä unohda|don't forget|tärkeää|important|opin tämän"), type: "insight", severity: "high" },
    { pattern: B("hieno|perfect|toimii|works|ylpeä|proud|hieno hetki"), type: "success", severity: "medium" },
    { pattern: B("älä koskaan|never do|kielletty|forbidden"), type: "mistake", severity: "critical" },
    { pattern: B("tästä eteenpäin|from now on|going forward|jatkossa"), type: "decision", severity: "medium" },
  ];

  const detected: Array<{ trigger: string; type: string; severity: string; context_snippet: string }> = [];
  for (const t of triggers) {
    const match = recent_messages.match(t.pattern);
    if (match && match.index !== undefined) {
      const start = Math.max(0, match.index - 80);
      const end = Math.min(recent_messages.length, match.index + 120);
      detected.push({
        trigger: match[0],
        type: t.type,
        severity: t.severity,
        context_snippet: recent_messages.slice(start, end).replace(/\n+/g, " "),
      });
    }
  }

  // Caller-flagged triggers always count as user-flagged / high.
  for (const flag of triggers_found) {
    detected.push({ trigger: flag, type: "user-flagged", severity: "high", context_snippet: "(user flagged)" });
  }

  const suggestions = detected.slice(0, 5).map((d, i) => ({
    suggested_action: "Call amplify_learn (or amplify_record_claim) / amplify_decisions",
    suggested_type: d.type,
    suggested_severity: d.severity,
    extracted_from_trigger: d.trigger,
    context: d.context_snippet,
    next_step:
      i === 0
        ? "Before recording: call amplify_suggest_pattern_key with the proposed title to find existing pattern_keys."
        : "Repeat dedup + pattern_key check for this one too.",
  }));

  return JSON.stringify(
    {
      project,
      triggers_detected: detected.length,
      suggestions,
      summary:
        detected.length === 0
          ? "No learning triggers found in recent messages. Nothing to capture."
          : `Found ${detected.length} learning trigger(s). Review each, then record with dedup-check first.`,
      workflow: [
        "1. For each suggestion, draft a title + description.",
        "2. Call amplify_suggest_pattern_key with title.",
        "3. Use returned pattern_key (existing or new).",
        "4. Call amplify_learn (or amplify_record_claim) with full payload.",
      ],
    },
    null,
    2,
  );
}

/**
 * amplify_dedup_check — before writing a new lesson, find near-duplicates so a
 * frequency-bump lands on the right existing row instead of fragmenting the
 * pattern. Read-only: scores '<title> <description>' against every lesson in
 * the project via word-token Jaccard and returns the top 5 above `threshold`.
 */
export async function handleDedupCheck(
  store: SQLiteStore,
  args: Record<string, unknown>,
): Promise<string> {
  const validated = withValidation(() => ({
    title: validateRequiredString(args.title, "title"),
  }));
  if (typeof validated === "string") return validated;
  const { title } = validated;

  const project = typeof args.project === "string" ? args.project : undefined;
  const description = typeof args.description === "string" ? args.description : "";
  const threshold = typeof args.threshold === "number" ? args.threshold : 0.5;

  const lessons = store.getAllLessonsForProject(project ?? "");
  const probe = `${title} ${description}`;

  const duplicates = lessons
    .map((l) => ({
      id: l.id,
      title: l.title,
      pattern_key: l.pattern_key,
      frequency: l.frequency ?? 1,
      type: l.type,
      similarity: Math.round(similarity(probe, `${l.title} ${l.description ?? ""}`) * 100) / 100,
    }))
    .filter((m) => m.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5);

  const is_likely_duplicate = duplicates.length > 0 && duplicates[0].similarity >= 0.7;

  return JSON.stringify(
    {
      is_likely_duplicate,
      duplicates,
      recommendation:
        duplicates.length === 0
          ? "No duplicates found. Safe to record as new lesson."
          : is_likely_duplicate
            ? `Strong duplicate match: '${duplicates[0].title}' (similarity ${duplicates[0].similarity}). Consider using pattern_key '${duplicates[0].pattern_key ?? "(none)"}' to increment frequency instead of creating a new entry.`
            : "Weak matches only. Likely safe to record as new lesson, but consider using pattern_key for grouping.",
    },
    null,
    2,
  );
}

/**
 * amplify_recent_patterns — list the most-active pattern_keys in the last N
 * days, grouped and summed, so you can see what keeps biting you. Read-only.
 */
export async function handleRecentPatterns(
  store: SQLiteStore,
  args: Record<string, unknown>,
): Promise<string> {
  const project = typeof args.project === "string" ? args.project : undefined;
  const days = typeof args.days === "number" && args.days > 0 ? Math.floor(args.days) : 7;
  const limitRaw = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 10;
  const limit = Math.min(limitRaw, 50);

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const lessons = store.getAllLessonsForProject(project ?? "");

  const recent = lessons.filter((l) => tsOf(l.updated_at ?? l.created_at) >= cutoff);

  const byKey = new Map<
    string,
    {
      pattern_key: string;
      total_frequency: number;
      lesson_count: number;
      sample_title: string;
      latest_update: string;
      latest_ms: number;
      types: Set<string>;
    }
  >();

  for (const l of recent) {
    const key = l.pattern_key ?? `(no-key: ${String(l.id).slice(0, 8)})`;
    const entry =
      byKey.get(key) ??
      {
        pattern_key: key,
        total_frequency: 0,
        lesson_count: 0,
        sample_title: l.title,
        latest_update: isoOf(l.updated_at ?? l.created_at),
        latest_ms: tsOf(l.updated_at ?? l.created_at),
        types: new Set<string>(),
      };
    entry.total_frequency += l.frequency ?? 1;
    entry.lesson_count += 1;
    entry.types.add(l.type);
    const lms = tsOf(l.updated_at ?? l.created_at);
    if (lms > entry.latest_ms) {
      entry.latest_ms = lms;
      entry.latest_update = isoOf(l.updated_at ?? l.created_at);
      entry.sample_title = l.title;
    }
    byKey.set(key, entry);
  }

  const top_patterns = [...byKey.values()]
    .sort((a, b) => b.total_frequency - a.total_frequency)
    .slice(0, limit)
    .map((e) => ({ ...e, types: [...e.types] }));

  return JSON.stringify(
    {
      window_days: days,
      total_recent_lessons: recent.length,
      top_patterns,
      insight:
        top_patterns.length > 0
          ? `Top pattern: '${top_patterns[0].pattern_key}' (frequency ${top_patterns[0].total_frequency}, ${top_patterns[0].lesson_count} lessons). Consider whether this needs a mechanical fix vs. another rule.`
          : "No recurring patterns in the recent window.",
    },
    null,
    2,
  );
}

/**
 * amplify_decay_old — report which lessons have gone cold (stale, low-frequency,
 * non-critical) and could be decayed/archived. REPORT-ONLY: performs no write
 * even when dry_run=false — cold-marking needs a future 'cold_at' column +
 * storage UPDATE. The output is a recommendation, not a mutation.
 */
export async function handleDecayOld(
  store: SQLiteStore,
  args: Record<string, unknown>,
): Promise<string> {
  const project = typeof args.project === "string" ? args.project : undefined;
  const cold_threshold_days =
    typeof args.cold_threshold_days === "number" && args.cold_threshold_days > 0
      ? Math.floor(args.cold_threshold_days)
      : 60;
  const min_frequency_to_keep_warm =
    typeof args.min_frequency_to_keep_warm === "number" && args.min_frequency_to_keep_warm > 0
      ? Math.floor(args.min_frequency_to_keep_warm)
      : 3;
  const dry_run = typeof args.dry_run === "boolean" ? args.dry_run : true;

  const cutoff = Date.now() - cold_threshold_days * 24 * 60 * 60 * 1000;
  const lessons = store.getAllLessonsForProject(project ?? "");

  const cold: Array<{
    id: number;
    title: string;
    pattern_key: string | undefined;
    frequency: number;
    last_seen: string;
    age_days: number;
  }> = [];

  for (const l of lessons) {
    const lastSeenMs = tsOf(l.updated_at ?? l.created_at);
    if (lastSeenMs >= cutoff) continue; // still warm
    if ((l.frequency ?? 1) >= min_frequency_to_keep_warm) continue; // frequent → keep warm
    if (l.severity === "critical") continue; // critical lessons never decay
    const age_days = Math.round((Date.now() - lastSeenMs) / (24 * 60 * 60 * 1000));
    cold.push({
      id: l.id,
      title: l.title,
      pattern_key: l.pattern_key,
      frequency: l.frequency ?? 1,
      last_seen: isoOf(l.updated_at ?? l.created_at),
      age_days,
    });
  }

  return JSON.stringify(
    {
      dry_run,
      cold_threshold_days,
      min_frequency_to_keep_warm,
      would_mark_cold_count: cold.length,
      sample: cold.slice(0, 10),
      note: dry_run
        ? "Dry run only. No changes made. NOTE: this build is report-only — even dry_run=false writes nothing (cold-marking needs a cold_at column + UPDATE in storage, a v2 follow-up)."
        : "Report-only build: cold-marking write is NOT implemented — nothing was modified. Add a cold_at column + storage UPDATE to enable actual marking.",
    },
    null,
    2,
  );
}

