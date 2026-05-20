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
          enum: ["track", "get", "search", "supersede", "revert"],
          description:
            "Operation: track=add new, get=list active, search=text search, supersede/revert=update status.",
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
          description: "Decision id. Required for supersede/revert.",
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
      },
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
];

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

async function main() {
  const store = new SQLiteStore();

  // Print bootstrap summary to stderr (visible in MCP server logs, not sent to Claude)
  const summary = await bootstrap(store);
  process.stderr.write(summary + "\n");

  const server = new Server(
    { name: "claude-amplifier", version: "1.0.0" },
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

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
