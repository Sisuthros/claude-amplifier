#!/usr/bin/env node
/**
 * Claude Amplifier — persistent memory for Claude across sessions, via MCP.
 *
 * Exposes four MCP tools:
 *   amplify_learn            — record a lesson (mistake / success / insight)
 *   amplify_decisions        — track / query architectural decisions
 *   amplify_context_load     — load saved context at the start of a session
 *   amplify_global_patterns  — manage cross-project patterns
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { SQLiteStore } from "./storage.js";
import {
  handleLearn,
  handleDecisions,
  handleContextLoad,
  handleGlobalPatterns,
  handleLinkDecisions,
  // v1.4.0
  handlePreflight,
  handleRecordClaim,
  handleVerifyClaim,
  handlePromotePattern,
  handleEvidenceChain,
  // v1.5.0
  handleAuditFreshness,
  handleSuggestPatternKey,
  handlePromoteFromMemoryMd,
} from "./tools.js";
import { bootstrap } from "./bootstrap.js";

// ---------------------------------------------------------------------------
// Tool definitions (shown to Claude in the MCP tool list)
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "amplify_learn",
    description:
      "Record a lesson — a mistake, success, or insight — so Claude remembers it in future sessions.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project name (e.g. 'my-app' or 'work/api-service').",
        },
        type: {
          type: "string",
          enum: ["mistake", "success", "insight", "warning"],
          description: "Category of the lesson.",
        },
        title: { type: "string", description: "Short, descriptive title." },
        description: {
          type: "string",
          description: "What happened and why it matters.",
        },
        context: {
          type: "string",
          description: "Surrounding circumstances (optional).",
        },
        resolution: {
          type: "string",
          description: "How the issue was resolved (optional).",
        },
        prevention: {
          type: "string",
          description: "How to avoid this in future (optional).",
        },
        severity: {
          type: "string",
          enum: ["low", "medium", "high", "critical"],
          description: "Impact level. Defaults to 'medium'.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for filtering (optional).",
        },
        trigger: {
          type: "string",
          description:
            "The specific situation or action that triggers this lesson — useful for pattern detection (optional).",
        },
        pattern_key: {
          type: "string",
          description:
            "v1.2.0 — explicit pattern grouping key (e.g. 'read-docs-before-coding'). When set, recording another lesson with the same key for this project bumps a frequency counter instead of creating a duplicate. Use this when the same lesson recurs with different wording each time. (optional)",
        },
      },
      required: ["project", "title", "description"],
    },
  },
  {
    name: "amplify_decisions",
    description:
      "Track and query architectural / design decisions for a project.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: [
            "track",
            "get",
            "search",
            "supersede",
            "revert",
            "update",
            "update_outcome",
            "overdue",
          ],
          description:
            "Operation: track=add new, get=list active, search=text search, supersede/revert=replace decision, update=refine fields without superseding (v1.2.0), update_outcome=mark validation, overdue=list decisions whose check-in passed.",
        },
        project: {
          type: "string",
          description: "Project name. Required for track/get.",
        },
        category: {
          type: "string",
          description:
            "Decision category (e.g. 'architecture', 'tooling', 'security'). Defaults to 'general'.",
        },
        title: {
          type: "string",
          description: "Short decision title. Required for track.",
        },
        description: {
          type: "string",
          description: "Full description. Required for track.",
        },
        rationale: {
          type: "string",
          description: "Why this decision was made (optional).",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags (optional).",
        },
        query: {
          type: "string",
          description: "Text to search for. Required for op=search.",
        },
        id: {
          type: "number",
          description:
            "Decision id. Required for supersede/revert/update/update_outcome.",
        },
        outcome_check_in: {
          type: "string",
          description:
            "When to follow up on this decision. Relative ('+7d', '+30d') or ISO date. Surfaces in 'overdue' when past due.",
        },
        outcome_status: {
          type: "string",
          enum: ["pending", "validated", "failed"],
          description:
            "For op=update_outcome: mark whether the decision worked. Defaults to 'validated'.",
        },
        restore_step: {
          type: "string",
          description:
            "How to restore this decision if the system gets reset (e.g. container recreate, image pull). Surfaces in active reminders every session.",
        },
        next_step: {
          type: "string",
          description: "Concrete next action when this decision is unblocked.",
        },
        blocked_on: {
          type: "string",
          description:
            "What this decision is waiting on (person, event, dependency).",
        },
        trade_offs: {
          type: "array",
          items: { type: "string" },
          description: "Tradeoffs accepted when choosing this decision.",
        },
        alternatives_considered: {
          type: "array",
          items: { type: "string" },
          description: "Alternatives considered and rejected.",
        },
        supersedes: {
          type: "number",
          description:
            "ID of an older decision this one replaces. The old one is automatically marked 'superseded'.",
        },
        relations: {
          type: "object",
          properties: {
            triggered_by: { type: "array", items: { type: "number" } },
            caused: { type: "array", items: { type: "number" } },
            relates_to: { type: "array", items: { type: "number" } },
          },
          description:
            "Knowledge-graph links to other decision IDs by relation type.",
        },
      },
      required: ["op"],
    },
  },
  {
    name: "amplify_context_load",
    description:
      "Load saved context (decisions, lessons, patterns) for the current project at the start of a session.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project name. Use this OR project_path.",
        },
        project_path: {
          type: "string",
          description:
            "Absolute path to the project root; the final directory name is used as the project name.",
        },
        types: {
          oneOf: [
            {
              type: "array",
              items: {
                type: "string",
                enum: ["lessons", "decisions", "patterns", "bootstrap", "all"],
              },
            },
            { type: "string", enum: ["all"] },
          ],
          description:
            "Which data types to load. Defaults to ['lessons','decisions','patterns']. Pass 'all' to include everything.",
        },
        max_tokens: {
          type: "number",
          description:
            "v1.4.1 — soft token budget for the rendered context. Default 4000. " +
            "If exceeded, lower-priority lessons are dropped and the output notes 'Showed top N of M'. " +
            "Use ~20000 to see everything in a large project.",
        },
        priority: {
          type: "string",
          enum: ["smart", "recent", "frequency"],
          description:
            "v1.4.1 — how to rank lessons when truncating. " +
            "'smart' (default) = frequency × 2 + confidence × 3 + recency_bonus + status_weight. " +
            "'recent' = newest first. 'frequency' = most-repeated first.",
        },
      },
    },
  },
  {
    name: "amplify_link_decisions",
    description:
      "v1.2.0 — Add a knowledge-graph link between two existing decisions. Lightweight: one call = one link. Idempotent.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "number",
          description: "ID of the decision that holds the link.",
        },
        to: {
          type: "number",
          description: "ID of the decision being linked to.",
        },
        relation: {
          type: "string",
          enum: ["triggered_by", "caused", "relates_to"],
          description:
            "Relation type: triggered_by=this was caused by `to`; caused=this led to `to`; relates_to=loose association.",
        },
      },
      required: ["from", "to", "relation"],
    },
  },
  {
    name: "amplify_global_patterns",
    description:
      "Manage cross-project patterns (best practices, conventions) that apply to all or multiple projects.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["get", "add"],
          description: "get=list all patterns, add=record a new pattern.",
        },
        title: {
          type: "string",
          description: "Pattern name. Required for op=add.",
        },
        description: {
          type: "string",
          description: "What the pattern is and when to apply it. Required for op=add.",
        },
        example: {
          type: "string",
          description: "Concrete code or command example (optional).",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags (optional).",
        },
        applies_to: {
          type: "string",
          description:
            "Project scope: 'all' (default) or a comma-separated list of project names.",
        },
      },
      required: ["op"],
    },
  },

  // -----------------------------------------------------------------------
  // v1.4.0 — Pattern Oracle + Verification Gate
  // -----------------------------------------------------------------------
  {
    name: "amplify_preflight",
    description:
      "v1.4.0 — Before starting a task, check stored lessons + decisions for matching failure patterns. Returns risk_level (low/medium/high/critical), matched patterns and lessons, and suggested approach. Call this BEFORE diving in when working on something that touches a familiar area.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name." },
        prompt: {
          type: "string",
          description:
            "The task / prompt about to be executed (free text). The oracle scans for matching prior issues. Alias: 'task'.",
        },
        task: {
          type: "string",
          description: "Alias for 'prompt'. Either field is accepted.",
        },
        context: {
          type: "string",
          description:
            "Optional extra context (file names, recent commits, etc.) that improves matching.",
        },
      },
      required: ["project"],
    },
  },
  {
    name: "amplify_record_claim",
    description:
      "v1.4.0 — Record a lesson as an UNVERIFIED claim (default confidence 0.5). Use this for any 'I just learned X' moment that has not been confirmed by tests, commits, or user confirmation. Promote later with amplify_verify_claim. (amplify_learn remains for confirmed/legacy records.)",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        type: {
          type: "string",
          enum: ["mistake", "success", "insight", "warning"],
        },
        title: { type: "string" },
        description: { type: "string" },
        context: { type: "string" },
        resolution: { type: "string" },
        prevention: { type: "string" },
        severity: {
          type: "string",
          enum: ["low", "medium", "high", "critical"],
        },
        tags: { type: "array", items: { type: "string" } },
        trigger: { type: "string" },
        pattern_key: {
          type: "string",
          description: "Explicit pattern grouping key for aggregation across worded variants.",
        },
        initial_confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Override starting confidence (default 0.5).",
        },
      },
      required: ["project", "title", "description"],
    },
  },
  {
    name: "amplify_verify_claim",
    description:
      "v1.4.0 — Attach evidence to a lesson to promote it. Promotion rules: (claim + 1 evidence) → 'evidence' (conf 0.7); (evidence + user_confirmation OR ≥2 distinct evidence types) → 'confirmed' (conf 1.0). Use this when tests pass, a commit lands, or the user explicitly confirms.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Lesson id to verify." },
        evidence_type: {
          type: "string",
          enum: [
            "git_commit",
            "test_run",
            "user_confirmation",
            "external_doc",
            "manual_review",
          ],
        },
        evidence_link: {
          type: "string",
          description: "Git SHA, test ID, URL, or short note — proof of the claim.",
        },
        promote_to: {
          type: "string",
          enum: ["evidence", "confirmed"],
          description: "Optional override (default: follow auto-promotion rules).",
        },
      },
      required: ["id", "evidence_type", "evidence_link"],
    },
  },
  {
    name: "amplify_promote_pattern",
    description:
      "v1.4.0 — Promote a pattern_key from per-project to global scope. Requires the key to exist in ≥2 projects with ≥1 confirmed lesson. After promotion the pattern weighs more in cross-project Pattern Oracle scoring.",
    inputSchema: {
      type: "object",
      properties: {
        pattern_key: {
          type: "string",
          description: "Pattern key to promote (must exist on ≥2 projects).",
        },
      },
      required: ["pattern_key"],
    },
  },
  {
    name: "amplify_evidence_chain",
    description:
      "v1.4.0 — Show the evidence chain that supports a stored lesson or decision. Useful for auditing why Amplifier 'knows' something — surfaces commits, test runs, and user confirmations that promoted a claim to confirmed.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        kind: { type: "string", enum: ["lesson", "decision"], default: "lesson" },
      },
      required: ["id"],
    },
  },
  {
    name: "amplify_promote_from_memory_md",
    description:
      "v1.5.0 — Read a memory/<YYYY-MM-DD>.md file and surface DRAFT suggestions for amplify_learn / amplify_decisions follow-up calls. Heuristics: architectural Wrote: lines (plan/decision/architecture/blueprint/manifesto), >50 events per hour, ≥8× repeated tool/terminal calls. Returns drafts only — never writes to SQLite. Use when amplify_audit_freshness flagged a stale day worth triaging.",
    inputSchema: {
      type: "object",
      properties: {
        memory_file: {
          type: "string",
          description:
            "Absolute path to a memory/<YYYY-MM-DD>.md file (or any file in the same format).",
        },
      },
      required: ["memory_file"],
    },
  },
  {
    name: "amplify_suggest_pattern_key",
    description:
      "v1.5.0 — Suggest an existing pattern_key (or propose a new one) for a lesson before recording it. Use this before amplify_learn when you suspect the lesson is a recurring pattern. Prevents the failure where two sessions invent two different keys for the same lesson and the frequency counter never aggregates. Returns up to 3 existing keys ranked by trigram similarity, or a new key suggestion if none clear the threshold.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name." },
        title: { type: "string", description: "The lesson title you intend to record." },
        description: { type: "string", description: "The lesson description (helps disambiguate)." },
      },
      required: ["project", "title", "description"],
    },
  },
  {
    name: "amplify_audit_freshness",
    description:
      "v1.5.0 — List memory/<YYYY-MM-DD>.md files that are newer than the latest Amplifier write for a project. Use this when amplify_context_load surfaces a stale-memory warning, or when you suspect a previous session did real work without recording lessons/decisions. Surfaces unrecorded sessions so they can be triaged retroactively.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project name. Use this OR project_path.",
        },
        project_path: {
          type: "string",
          description:
            "Absolute path to the project root; the final directory name is used as the project name. If memory_dir is omitted, defaults to <project_path>/memory.",
        },
        memory_dir: {
          type: "string",
          description:
            "Optional explicit memory directory. Defaults to <project_path>/memory or $HOME/.claude/memory.",
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

async function runMcpServer(): Promise<void> {
  const store = new SQLiteStore();

  // Print bootstrap summary to stderr (visible in MCP server logs, not sent to Claude)
  const summary = await bootstrap(store);
  process.stderr.write(summary + "\n");

  const server = new Server(
    { name: "claude-amplifier", version: "1.5.0" },
    { capabilities: { tools: {} } }
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    let text: string;

    try {
      switch (name) {
        case "amplify_learn":
          text = await handleLearn(store, args as Record<string, unknown>);
          break;
        case "amplify_decisions":
          text = await handleDecisions(store, args as Record<string, unknown>);
          break;
        case "amplify_context_load":
          text = await handleContextLoad(store, args as Record<string, unknown>);
          break;
        case "amplify_global_patterns":
          text = await handleGlobalPatterns(store, args as Record<string, unknown>);
          break;
        case "amplify_link_decisions":
          text = await handleLinkDecisions(store, args as Record<string, unknown>);
          break;
        // v1.4.0
        case "amplify_preflight":
          text = await handlePreflight(store, args as Record<string, unknown>);
          break;
        case "amplify_record_claim":
          text = await handleRecordClaim(store, args as Record<string, unknown>);
          break;
        case "amplify_verify_claim":
          text = await handleVerifyClaim(store, args as Record<string, unknown>);
          break;
        case "amplify_promote_pattern":
          text = await handlePromotePattern(store, args as Record<string, unknown>);
          break;
        case "amplify_evidence_chain":
          text = await handleEvidenceChain(store, args as Record<string, unknown>);
          break;
        // v1.5.0
        case "amplify_audit_freshness":
          text = await handleAuditFreshness(store, args as Record<string, unknown>);
          break;
        case "amplify_suggest_pattern_key":
          text = await handleSuggestPatternKey(store, args as Record<string, unknown>);
          break;
        case "amplify_promote_from_memory_md":
          text = await handlePromoteFromMemoryMd(store, args as Record<string, unknown>);
          break;
        default:
          text = `Error: unknown tool '${name}'.`;
      }
    } catch (err) {
      text = `Error: ${(err as Error).message}`;
    }

    return {
      content: [{ type: "text", text }],
    };
  });

  // Start transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ---------------------------------------------------------------------------
// Entry point — route to CLI subcommands or the MCP stdio server.
// `claude-amplifier`           → MCP server (default, what Claude Desktop/Code call)
// `claude-amplifier mcp`       → MCP server (explicit)
// `claude-amplifier init|seed|list|stats|export|import|doctor|help` → CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const first = args[0];

  // No args or explicit "mcp" → run the MCP server.
  if (!first || first === "mcp") {
    await runMcpServer();
    return;
  }

  // Anything else is a CLI subcommand. Dynamic import keeps the MCP path
  // free of CLI-only deps and avoids pulling in chalk-style colour code paths
  // when Claude Desktop spawns us as a subprocess.
  const { runCli } = await import("./cli.js");
  const code = await runCli(args);
  process.exit(code);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
