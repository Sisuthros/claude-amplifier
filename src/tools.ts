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
  const parts = [
    `[${l.id}] ${l.severity.toUpperCase()} · ${l.type} — ${l.title}`,
    `  Project: ${l.project}`,
    `  Description: ${l.description}`,
  ];
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
  });

  return [
    `Lesson recorded (id: ${lesson.id}).`,
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
  } = args as Record<string, string>;

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
      });

      return [
        `Decision recorded (id: ${decision.id}).`,
        `  Project: ${decision.project} | Category: ${decision.category}`,
        `  Title: ${decision.title}`,
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
      return `Error: unknown op '${op}'. Valid: track | get | search | supersede | revert`;
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
  ];

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
