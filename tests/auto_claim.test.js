// Unit tests for the SessionEnd auto-claim heuristic analyzer.
//
// Deterministic, hermetic: no disk, no network, no SQLite. Each test
// constructs a synthetic JSONL transcript and asserts on the suggestions
// returned. Run with: npm test.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  analyzeTranscript,
  parseTranscript,
} from "../dist/hooks/auto_claim_session_end.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a JSONL transcript from an array of {role, text} turns. */
function buildTranscript(turns) {
  return turns
    .map((t) =>
      JSON.stringify({
        type: t.role,
        message: { role: t.role, content: t.text },
      })
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// parseTranscript
// ---------------------------------------------------------------------------

describe("parseTranscript", () => {
  test("parses string-content turns", () => {
    const jsonl = buildTranscript([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" },
    ]);
    const turns = parseTranscript(jsonl);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].role, "user");
    assert.equal(turns[0].text, "hello");
  });

  test("parses array-content turns (text blocks only, ignores tool_use)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me think." },
          { type: "tool_use", id: "x", name: "Bash", input: {} },
          { type: "text", text: "Done." },
        ],
      },
    });
    const turns = parseTranscript(line);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].text, "Let me think.\nDone.");
  });

  test("skips malformed JSONL lines without throwing", () => {
    const jsonl = [
      JSON.stringify({ type: "user", message: { role: "user", content: "first" } }),
      "this is not json",
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "second" } }),
    ].join("\n");
    const turns = parseTranscript(jsonl);
    assert.equal(turns.length, 2);
  });
});

// ---------------------------------------------------------------------------
// analyzeTranscript — pattern detection
// ---------------------------------------------------------------------------

describe("analyzeTranscript — user_correction pattern", () => {
  test("detects 'no, don't do that' as a correction", () => {
    const jsonl = buildTranscript([
      { role: "user", text: "Add a Bearer token logger to the auth module." },
      { role: "assistant", text: "OK, adding console.log(req.headers.authorization) to middleware." },
      { role: "user", text: "No, don't do that — we never log tokens. Take it back out." },
    ]);
    const suggestions = analyzeTranscript(jsonl);
    assert.ok(suggestions.length >= 1);
    const correction = suggestions.find((s) => s.kind === "user_correction");
    assert.ok(correction, "expected a user_correction suggestion");
    assert.equal(correction.type, "mistake");
    assert.equal(correction.severity, "high");
    // Context should include the assistant turn that triggered the rebuke
    assert.match(correction.context, /Bearer token|console\.log/);
  });

  test("detects 'that's wrong' phrasing", () => {
    const jsonl = buildTranscript([
      { role: "user", text: "Run the migration." },
      { role: "assistant", text: "Running TRUNCATE on users table..." },
      { role: "user", text: "That is wrong, you destroyed prod data." },
    ]);
    const suggestions = analyzeTranscript(jsonl);
    const correction = suggestions.find((s) => s.kind === "user_correction");
    assert.ok(correction);
    assert.equal(correction.type, "mistake");
  });
});

describe("analyzeTranscript — rule_statement pattern", () => {
  test("detects 'always' rule", () => {
    const jsonl = buildTranscript([
      { role: "assistant", text: "Should I run rm -rf node_modules?" },
      { role: "user", text: "Always run pwd first before any destructive shell command." },
    ]);
    const suggestions = analyzeTranscript(jsonl);
    const rule = suggestions.find((s) => s.kind === "rule_statement");
    assert.ok(rule);
    assert.equal(rule.type, "insight");
    assert.match(rule.title, /Rule:/);
  });

  test("detects 'never' rule with high severity", () => {
    const jsonl = buildTranscript([
      { role: "assistant", text: "Pushing the branch to main now." },
      { role: "user", text: "Never push directly to main. Open a PR." },
    ]);
    const suggestions = analyzeTranscript(jsonl);
    const rule = suggestions.find((s) => s.kind === "rule_statement");
    assert.ok(rule);
    assert.equal(rule.severity, "high");
  });
});

describe("analyzeTranscript — success_confirm pattern", () => {
  test("detects 'that worked, keep going'", () => {
    const jsonl = buildTranscript([
      { role: "assistant", text: "Switched to nvidia/qwen3-coder-480b. Try a request now." },
      { role: "user", text: "Perfect, that worked. Keep going." },
    ]);
    const suggestions = analyzeTranscript(jsonl);
    const success = suggestions.find((s) => s.kind === "success_confirm");
    assert.ok(success);
    assert.equal(success.type, "success");
  });
});

// ---------------------------------------------------------------------------
// Filtering and limits
// ---------------------------------------------------------------------------

describe("analyzeTranscript — filtering", () => {
  test("filters out user messages shorter than minUserMessageLength", () => {
    const jsonl = buildTranscript([
      { role: "assistant", text: "Did the thing." },
      // Has "no" but is below default 12-char threshold
      { role: "user", text: "no" },
    ]);
    const suggestions = analyzeTranscript(jsonl);
    assert.equal(suggestions.length, 0);
  });

  test("returns empty for transcripts with fewer than 2 turns", () => {
    const jsonl = buildTranscript([{ role: "user", text: "Hello world, lots of text here." }]);
    const suggestions = analyzeTranscript(jsonl);
    assert.equal(suggestions.length, 0);
  });

  test("returns empty for empty / blank input", () => {
    assert.equal(analyzeTranscript("").length, 0);
    assert.equal(analyzeTranscript("   \n   \n").length, 0);
  });

  test("caps suggestions at maxSuggestions (default 3)", () => {
    // Build 6 distinct user turns that each match a pattern
    const turns = [];
    for (let i = 0; i < 6; i++) {
      turns.push({ role: "assistant", text: `Assistant message ${i} doing some thing.` });
      turns.push({
        role: "user",
        text: `No, don't do that, attempt number ${i} was wrong direction completely.`,
      });
    }
    const suggestions = analyzeTranscript(buildTranscript(turns));
    assert.equal(suggestions.length, 3);
  });

  test("honours custom maxSuggestions", () => {
    const turns = [];
    for (let i = 0; i < 4; i++) {
      turns.push({ role: "assistant", text: `Doing thing ${i} now.` });
      turns.push({ role: "user", text: `Never use approach number ${i} for this kind of task.` });
    }
    const suggestions = analyzeTranscript(buildTranscript(turns), { maxSuggestions: 1 });
    assert.equal(suggestions.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

describe("analyzeTranscript — output shape", () => {
  test("every suggestion has the documented fields", () => {
    const jsonl = buildTranscript([
      { role: "assistant", text: "Suggest I push to main directly." },
      { role: "user", text: "Never push directly to main. From now on, always open a PR." },
    ]);
    const suggestions = analyzeTranscript(jsonl);
    assert.ok(suggestions.length >= 1);
    for (const s of suggestions) {
      assert.ok(typeof s.kind === "string");
      assert.ok(["mistake", "success", "insight", "warning"].includes(s.type));
      assert.ok(typeof s.title === "string" && s.title.length > 0);
      assert.ok(typeof s.description === "string");
      assert.ok(typeof s.context === "string");
      assert.ok(["low", "medium", "high"].includes(s.severity));
      assert.ok(typeof s.score === "number");
      assert.ok(Array.isArray(s.tags));
    }
  });

  test("descriptions are truncated below 281 chars", () => {
    const longUserText =
      "No, don't do that, " + "x".repeat(500);
    const jsonl = buildTranscript([
      { role: "assistant", text: "Doing a thing." },
      { role: "user", text: longUserText },
    ]);
    const suggestions = analyzeTranscript(jsonl);
    for (const s of suggestions) {
      assert.ok(s.description.length <= 281, `desc length ${s.description.length}`);
    }
  });
});
