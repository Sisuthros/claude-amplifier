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
import { createRequire } from "node:module";

// Read the version from package.json at runtime so the MCP server's reported
// version never drifts from the published package — the official MCP registry
// requires server.json version to match the npm version exactly.
const PKG_VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    return (require("../package.json") as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

import { SQLiteStore } from "./storage.js";
import { TOOLS } from "./tool_schemas.js";
import { dispatchToolCall } from "./tool_router.js";
import { bootstrap } from "./bootstrap.js";

// ---------------------------------------------------------------------------
// Server setup
//
// Tool schemas live in ./tool_schemas.ts (the TOOLS array) and dispatch lives
// in ./tool_router.ts (dispatchToolCall). This file stays a thin
// server/CLI entrypoint that wires those two together.
// ---------------------------------------------------------------------------

async function runMcpServer(): Promise<void> {
  const store = new SQLiteStore();

  // Print bootstrap summary to stderr (visible in MCP server logs, not sent to Claude)
  const summary = await bootstrap(store);
  process.stderr.write(summary + "\n");

  const server = new Server(
    { name: "claude-amplifier", version: PKG_VERSION },
    { capabilities: { tools: {} } }
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Handle tool calls — routed through the dedicated dispatcher.
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    dispatchToolCall(store, request)
  );

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
