import {
  SQLiteStore,
  Lesson,
  Decision,
  Pattern,
  AmplifierWriteError,
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

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// v1.4.1 — context_load truncation defaults
const DEFAULT_CONTEXT_MAX_TOKENS = 4000;
const CONTEXT_LESSONS_POOL_LIMIT = 200; // fetch this many before ranking

type PriorityMode = "smart" | "recent" | "frequency";

/**
 * Cheap token estimate: ~4 chars per token. We deliberately avoid a real
 * tokenizer dependency — this runs on every session start and the goal is
 * "don't drown the context", not exact accounting.
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
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
    project,
    type = "insight",
    title,
    description,
    context,
    resolution,
    prevention,
    severity = "medium",
    tags,
    trigger,
    pattern_key,
  } = args as Record<string, string>;

  if (!project) return "Error: 'project' is required.";
  if (!title) return "Error: 'title' is required.";
  if (!description) return "Error: 'description' is required.";

  const validTypes = ["mistake", "success", "insight", "warning"];
  const validSeverities = ["low", "medium", "high", "critical"];

  if (!validTypes.includes(type as string)) {
    return `Error: 'type' must be one of: ${validTypes.join(", ")}`;
  }
  if (!validSeverities.includes(severity as string)) {
    return `Error: 'severity' must be one of: ${validSeverities.join(", ")}`;
  }

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
      if (!project) return "Error: 'project' is required for op=track.";
      if (!title) return "Error: 'title' is required for op=track.";
      if (!description) return "Error: 'description' is required for op=track.";

      let decision: Decision;
      try {
        decision = store.addDecision({
          project,
          category,
          title,
          description,
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
          supersedes_id: supersedes ? Number(supersedes) : undefined,
          related_decision_ids:
            relations && typeof relations === "object"
              ? (relations as Decision["related_decision_ids"])
              : undefined,
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
      store.updateOutcomeStatus(Number(id), newStatus);
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
      store.updateDecisionStatus(Number(id), newStatus);
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
  const { from, to, relation } = args as Record<string, string>;

  if (!from) return "Error: 'from' decision id is required.";
  if (!to) return "Error: 'to' decision id is required.";

  const validRelations = ["triggered_by", "caused", "relates_to"];
  if (!validRelations.includes(relation as string)) {
    return `Error: 'relation' must be one of: ${validRelations.join(", ")}`;
  }

  try {
    const updated = store.linkDecisions(
      Number(from),
      Number(to),
      relation as "triggered_by" | "caused" | "relates_to"
    );
    if (!updated) return `Error: decision ${from} not found.`;
    return `Linked: decision #${from} --${relation}--> decision #${to}.`;
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

  const result: PreflightResult = preflight({
    project,
    prompt,
    context,
    candidateLessons,
    candidateDecisions,
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
  const project = String(args.project ?? "");
  const type = (args.type ? String(args.type) : "insight") as Lesson["type"];
  const title = String(args.title ?? "");
  const description = String(args.description ?? "");
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

  if (!project) return "Error: 'project' is required.";
  if (!title) return "Error: 'title' is required.";
  if (!description) return "Error: 'description' is required.";

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
  const id = Number(args.id);
  const evidence_type = String(args.evidence_type ?? "") as
    | "git_commit"
    | "test_run"
    | "user_confirmation"
    | "external_doc"
    | "manual_review";
  const evidence_link = String(args.evidence_link ?? "");
  const promote_to = args.promote_to ? String(args.promote_to) : undefined;

  if (!id || isNaN(id)) return "Error: 'id' is required and must be a number.";
  if (!evidence_type) return "Error: 'evidence_type' is required.";
  if (!evidence_link) return "Error: 'evidence_link' is required.";

  const valid_types = [
    "git_commit",
    "test_run",
    "user_confirmation",
    "external_doc",
    "manual_review",
  ];
  if (!valid_types.includes(evidence_type)) {
    return `Error: evidence_type must be one of ${valid_types.join(", ")}.`;
  }
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

