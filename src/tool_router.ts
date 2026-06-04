/**
 * tool_router.ts — central dispatch for MCP tool calls.
 *
 * Extracted verbatim from the CallToolRequestSchema handler body in index.ts
 * (P1 #6 structural split). `dispatchToolCall` reproduces the original
 * switch-dispatch, try/catch, and `{ content: [{ type: "text", text }] }`
 * envelope byte-for-byte — zero behavior change. index.ts now wires the MCP
 * server's request handler straight to this function.
 */

import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";

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

/**
 * Shape of the value returned to the MCP transport for a tool call.
 *
 * The index signature mirrors the SDK's `CallToolResult` (which carries an
 * open `[x: string]: unknown`) so this type slots into the server's
 * `setRequestHandler(CallToolRequestSchema, ...)` return union without a cast.
 */
export interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  [x: string]: unknown;
}

/**
 * Route a parsed CallTool request to its handler.
 *
 * Mirrors the historical inline handler exactly:
 *   - unknown tool name → "Error: unknown tool '<name>'."
 *   - any handler throw → caught and returned as "Error: <message>"
 *   - always returns a single text-content envelope (never throws)
 */
export async function dispatchToolCall(
  store: SQLiteStore,
  request: CallToolRequest,
): Promise<ToolCallResult> {
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
}
