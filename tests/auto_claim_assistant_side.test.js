// v1.5.0 — assistant-side detection tests for auto_claim_session_end.
//
// Pre-1.5.0 only scanned USER messages for reactions like "no, don't" or
// "perfect, that worked". That misses the most important case:
// the assistant itself producing tier-jump explanations, mistake admissions,
// or architecture writeups that should be persisted as decisions.
//
// The yesterday-incident (2026-05-25 architecture session) had a 6000-word
// architecture review with phrases like "this is a tier jump", "key insight",
// "next step:", "rationale:" — none of which were caught by the user-only
// detector. v1.5.0 adds three new SuggestionKinds:
//   assistant_correction  — "I was wrong about X"
//   assistant_insight     — "this is a tier jump", "key insight"
//   architecture_decision — long writeup with arch vocab + "next step:" markers

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { analyzeTranscript } from "../dist/hooks/auto_claim_session_end.js";

/** Build a minimal JSONL transcript from {role, text} pairs. */
function mkTranscript(turns) {
  return turns
    .map((t) =>
      JSON.stringify({
        type: t.role,
        message: { role: t.role, content: t.text },
      }),
    )
    .join("\n");
}

describe("assistant_correction detection (v1.5.0)", () => {
  test("detects 'I was wrong about X'", () => {
    const tx = mkTranscript([
      { role: "user", text: "Is the new token already deployed everywhere?" },
      {
        role: "assistant",
        text: "Actually, I was wrong — the new token only landed on Hetzner, not WSL2 yet.",
      },
    ]);
    const out = analyzeTranscript(tx);
    const ac = out.find((s) => s.kind === "assistant_correction");
    assert.ok(ac, "should detect assistant_correction");
    assert.equal(ac.type, "mistake");
    assert.equal(ac.severity, "high");
  });

  test("detects Finnish 'olin väärässä'", () => {
    const tx = mkTranscript([
      { role: "user", text: "Mitkä kaikki paikat tämä kattaa?" },
      {
        role: "assistant",
        text: "Olin väärässä — token ei mennyt WSL2:een ollenkaan, vain Hetzneriin.",
      },
    ]);
    const out = analyzeTranscript(tx);
    assert.ok(out.find((s) => s.kind === "assistant_correction"));
  });
});

describe("assistant_insight detection (v1.5.0)", () => {
  test("detects 'this is a tier jump'", () => {
    const tx = mkTranscript([
      { role: "user", text: "Arvio architecture-stackista?" },
      {
        role: "assistant",
        text: "Tämä on tason hyppy. Agentti ei rakentanut lisää featureita vaan tavan kasvaa.",
      },
    ]);
    const out = analyzeTranscript(tx);
    const ai = out.find((s) => s.kind === "assistant_insight");
    assert.ok(ai, "should detect assistant_insight from 'tason hyppy'");
    assert.equal(ai.type, "insight");
  });

  test("detects 'key insight'", () => {
    const tx = mkTranscript([
      { role: "user", text: "What did we learn?" },
      {
        role: "assistant",
        text:
          "Key insight: write-verification must happen on every INSERT because " +
          "lastInsertRowid cannot be trusted blindly. Past versions silently " +
          "coerced undefined into a Lesson object.",
      },
    ]);
    const out = analyzeTranscript(tx);
    assert.ok(out.find((s) => s.kind === "assistant_insight"));
  });
});

describe("architecture_decision detection (v1.5.0)", () => {
  test("detects long writeup with architecture vocab and structural markers", () => {
    const longArch = `
      I've finished the new amplifier service. Architecture:
      - Service runs on port 3500, exposes a gateway endpoint
      - Schema migration added a new column to lessons table
      - The API uses an MCP-compatible JSON-RPC layer
      - Pipeline: prepare → INSERT → SELECT (verify) → emit
      Next step: write tests for the read-back path, then publish.
      Rationale: silent failures in the past made Claude hallucinate ids.
      Trade-offs: one extra SELECT per write (negligible for our volume).
    `.repeat(2);
    const tx = mkTranscript([
      { role: "user", text: "Build the verifier" },
      { role: "assistant", text: longArch },
    ]);
    const out = analyzeTranscript(tx);
    const ad = out.find((s) => s.kind === "architecture_decision");
    assert.ok(ad, "should detect architecture_decision");
    assert.match(ad.title, /Decision candidate/);
  });

  test("does NOT detect short messages even if they contain arch vocab", () => {
    const tx = mkTranscript([
      { role: "user", text: "What is this?" },
      { role: "assistant", text: "Service on port 3500. Next step: ship." },
    ]);
    const out = analyzeTranscript(tx);
    assert.equal(
      out.find((s) => s.kind === "architecture_decision"),
      undefined,
      "short messages should not trigger decision detection",
    );
  });

  test("does NOT detect long writeups without architecture vocab", () => {
    const tx = mkTranscript([
      { role: "user", text: "Tell me a story" },
      {
        role: "assistant",
        text:
          "Once upon a time there was a fox. " +
          "The fox went to the forest. The forest was deep. ".repeat(50),
      },
    ]);
    const out = analyzeTranscript(tx);
    assert.equal(out.find((s) => s.kind === "architecture_decision"), undefined);
  });
});

describe("co-existence with user-side detection (v1.5.0)", () => {
  test("user_correction and assistant_correction can both fire in the same transcript", () => {
    // user-side CORRECTION_PATTERNS expects pairs like "no + do/run/use".
    // Quoting that exact pattern keeps the test honest about what the
    // detector actually catches today.
    const tx = mkTranscript([
      { role: "user", text: "No, don't run that command on production!" },
      {
        role: "assistant",
        text: "I was wrong to suggest that — reverting now. Sorry.",
      },
    ]);
    const out = analyzeTranscript(tx);
    assert.ok(
      out.find((s) => s.kind === "user_correction"),
      "user_correction should fire",
    );
    assert.ok(
      out.find((s) => s.kind === "assistant_correction"),
      "assistant_correction should fire",
    );
  });

  test("ranking still respects maxSuggestions cap", () => {
    const tx = mkTranscript([
      { role: "user", text: "Never push to main from now on" },
      { role: "assistant", text: "I was wrong about that earlier." },
      { role: "user", text: "That worked, perfect!" },
      {
        role: "assistant",
        text: "Key insight: write-verification is the missing piece.",
      },
    ]);
    const out = analyzeTranscript(tx, { maxSuggestions: 2 });
    assert.ok(out.length <= 2);
  });
});
