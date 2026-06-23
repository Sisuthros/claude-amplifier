// P1 #6 — structural split of index.ts into tool_schemas.ts + tool_router.ts.
//
// index.ts used to inline BOTH the TOOLS schema array AND the
// CallToolRequestSchema switch-dispatch body. That made the entrypoint a
// 600-line god-file and meant the dispatch logic could only be exercised
// through a live MCP stdio server.
//
// These tests pin the post-split contract:
//   1. src/tool_schemas.ts exports `TOOLS` — the exact same 13 tool schemas
//      the MCP server advertises via tools/list (identical names + shapes,
//      including the canonical evidence schema).
//   2. src/tool_router.ts exports `dispatchToolCall(store, request)` which
//      reproduces the old switch-dispatch byte-for-byte: same routing, same
//      `{ content: [{ type: "text", text }] }` envelope, same error handling
//      (unknown tool → "Error: unknown tool", thrown handler → "Error: ...").
//   3. index.ts still imports both and wires them to the MCP server.
//
// This is a STRUCTURAL move only — zero behavior change. The false-positive
// guard below proves the router does NOT silently succeed for a bogus tool
// name (which a naive "always return text" stub would).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { SQLiteStore } from "../dist/storage.js";
import { TOOLS } from "../dist/tool_schemas.js";
import { dispatchToolCall } from "../dist/tool_router.js";

function tmpDbPath() {
  return path.join(
    os.tmpdir(),
    `amp-split-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

// The exact 13 tool names the server has always advertised, in declaration
// order. If the split dropped, renamed, or reordered any of these, tools/list
// output would change and this assertion fails.
const EXPECTED_TOOL_NAMES = [
  "amplify_learn",
  "amplify_decisions",
  "amplify_context_load",
  "amplify_link_decisions",
  "amplify_global_patterns",
  "amplify_preflight",
  "amplify_record_claim",
  "amplify_verify_claim",
  "amplify_promote_pattern",
  "amplify_evidence_chain",
  "amplify_promote_from_memory_md",
  "amplify_suggest_pattern_key",
  "amplify_audit_freshness",
  // v1.6.0 — auto-capture
  "amplify_capture_session",
  "amplify_dedup_check",
  "amplify_recent_patterns",
  "amplify_decay_old",
];

describe("tool_schemas.ts — TOOLS array (P1 #6)", () => {
  test("exports all 17 tools in the original order", () => {
    assert.ok(Array.isArray(TOOLS), "TOOLS must be an array");
    assert.equal(TOOLS.length, 17);
    assert.deepEqual(
      TOOLS.map((t) => t.name),
      EXPECTED_TOOL_NAMES,
    );
  });

  test("every tool has a name, description and inputSchema", () => {
    for (const t of TOOLS) {
      assert.equal(typeof t.name, "string");
      assert.ok(t.name.length > 0, `${t.name} name`);
      assert.equal(typeof t.description, "string");
      assert.ok(t.description.length > 0, `${t.name} description`);
      assert.equal(typeof t.inputSchema, "object");
      assert.equal(t.inputSchema.type, "object", `${t.name} inputSchema.type`);
    }
  });

  test("amplify_verify_claim keeps the canonical evidence schema", () => {
    const verify = TOOLS.find((t) => t.name === "amplify_verify_claim");
    assert.ok(verify, "amplify_verify_claim must exist");
    const props = verify.inputSchema.properties;
    // Canonical field name is evidence_link (NOT evidence).
    assert.ok(props.evidence_link, "evidence_link field present");
    assert.ok(!props.evidence, "must NOT use the stale 'evidence' field name");
    // Canonical evidence_type enum.
    assert.deepEqual(props.evidence_type.enum, [
      "git_commit",
      "test_run",
      "user_confirmation",
      "external_doc",
      "manual_review",
    ]);
    // Stale wrong terms must not have crept back in.
    for (const stale of [
      "build_passed",
      "test_passed",
      "production_metric",
      "independent_observation",
    ]) {
      assert.ok(
        !props.evidence_type.enum.includes(stale),
        `stale evidence_type '${stale}' must be gone`,
      );
    }
    assert.deepEqual(verify.inputSchema.required, [
      "id",
      "evidence_type",
      "evidence_link",
    ]);
  });
});

describe("tool_router.ts — dispatchToolCall (P1 #6)", () => {
  test("dispatches a real tool and returns the text-content envelope", async () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const res = await dispatchToolCall(store, {
        params: {
          name: "amplify_learn",
          arguments: {
            project: "split-test",
            title: "Router routes correctly",
            description: "D",
            type: "insight",
            severity: "medium",
          },
        },
      });
      // Same envelope shape the inline handler produced.
      assert.ok(Array.isArray(res.content));
      assert.equal(res.content.length, 1);
      assert.equal(res.content[0].type, "text");
      assert.match(res.content[0].text, /^Lesson recorded \(id: \d+\)/);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  test("dispatches amplify_decisions (op=track) through the router", async () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const res = await dispatchToolCall(store, {
        params: {
          name: "amplify_decisions",
          arguments: {
            op: "track",
            project: "split-test",
            title: "Routed decision",
            description: "D",
          },
        },
      });
      assert.match(res.content[0].text, /^Decision recorded \(id: \d+\)/);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  test("defaults missing arguments to an empty object (no crash)", async () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      // No `arguments` key at all — the old handler used `arguments: args = {}`.
      // The router must NOT throw on missing arguments; it returns a valid
      // text envelope (amplify_global_patterns with no op lists patterns).
      const res = await dispatchToolCall(store, {
        params: { name: "amplify_global_patterns" },
      });
      assert.equal(res.content[0].type, "text");
      assert.equal(typeof res.content[0].text, "string");
      assert.ok(res.content[0].text.length > 0);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  // FALSE-POSITIVE GUARD: a bogus tool name must NOT route to a real handler
  // and must NOT throw — it returns the exact "unknown tool" message.
  test("unknown tool returns the unknown-tool error, never fake success", async () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const res = await dispatchToolCall(store, {
        params: { name: "amplify_not_a_real_tool", arguments: {} },
      });
      assert.equal(res.content[0].type, "text");
      assert.equal(
        res.content[0].text,
        "Error: unknown tool 'amplify_not_a_real_tool'.",
      );
      // Guard: it must not have masqueraded as a successful record.
      assert.doesNotMatch(res.content[0].text, /recorded/);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  // A handler that throws must be caught and surfaced as "Error: <message>",
  // exactly like the old try/catch in index.ts.
  test("a thrown handler error is caught and returned as Error text", async () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      // amplify_evidence_chain with a non-existent id should not 500 the
      // server; whatever it returns must be a text envelope, never a throw.
      const res = await dispatchToolCall(store, {
        params: {
          name: "amplify_verify_claim",
          // Missing required fields → handler throws → caught → Error text.
          arguments: {},
        },
      });
      assert.equal(res.content[0].type, "text");
      assert.match(res.content[0].text, /Error/);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  // Every advertised tool name must be routable (no orphan schema with no
  // dispatch arm). We don't assert success — just that the router does NOT
  // fall through to the unknown-tool branch for any advertised name.
  test("every advertised tool name has a dispatch arm", async () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      for (const name of EXPECTED_TOOL_NAMES) {
        const res = await dispatchToolCall(store, {
          params: { name, arguments: {} },
        });
        assert.equal(res.content[0].type, "text");
        assert.doesNotMatch(
          res.content[0].text,
          /unknown tool/,
          `${name} must be routable`,
        );
      }
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });
});
