import { SQLiteStore, Lesson, Decision, Pattern } from "./storage.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

  const lesson = store.addLesson({
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

      const decision = store.addDecision({
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
  const { project, project_path, types: rawTypes } = args as Record<
    string,
    unknown
  >;

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

  const ctx = store.loadContext(projectName, types);

  const sections: string[] = [
    `=== Claude Amplifier Context: ${projectName} ===`,
    `Loaded at: ${new Date().toISOString()}`,
    // v1.2.0 — one-line summary so the reader can orient before the full
    // payload. Shows attention-required items (overdue, recurring) first.
    ctx.summary ? `Summary: ${ctx.summary}` : "",
  ].filter(Boolean);

  if (ctx.decisions.length) {
    sections.push(
      `\n--- Active Decisions (${ctx.decisions.length}) ---`,
      ...ctx.decisions.map(formatDecision)
    );
  } else {
    sections.push("\n--- Active Decisions ---\nNone recorded yet.");
  }

  if (ctx.lessons.length) {
    sections.push(
      `\n--- Recent Lessons (${ctx.lessons.length}) ---`,
      ...ctx.lessons.map(formatLesson)
    );
  } else {
    sections.push("\n--- Recent Lessons ---\nNone recorded yet.");
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

  return sections.join("\n");
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

