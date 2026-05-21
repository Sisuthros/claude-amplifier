// Unit tests for the v1.5 semantic-search prototype.
//
// We DO NOT load the real @xenova/transformers model in these tests:
//   1. It would download ~100MB of ONNX weights on first run (CI hostile).
//   2. The dep isn't installed by default in the v1.5 prototype branch.
//
// Instead we inject a mock embedder via _setEmbedderForTesting that returns
// deterministic vectors keyed on the input string. That lets us assert the
// math + ranking behaviour without ever touching the model.
//
// Run with: npm test

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  cosineSimilarity,
  semanticSearch,
  embed,
  _resetEmbedderForTesting,
  _setEmbedderForTesting,
} from "../dist/semantic.js";

// ── cosineSimilarity math ───────────────────────────────────────────

describe("cosineSimilarity", () => {
  test("identical vectors -> 1", () => {
    const v = new Float32Array([1, 0, 0]);
    assert.equal(cosineSimilarity(v, v), 1);
  });

  test("orthogonal vectors -> 0", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    assert.equal(cosineSimilarity(a, b), 0);
  });

  test("opposite vectors -> -1", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    assert.equal(cosineSimilarity(a, b), -1);
  });

  test("zero vector -> 0 (no NaN)", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    const score = cosineSimilarity(a, b);
    assert.equal(score, 0);
    assert.ok(!Number.isNaN(score));
  });

  test("mismatched lengths throw", () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    assert.throws(() => cosineSimilarity(a, b), /length mismatch/);
  });

  test("normalization independence (cosine is scale-invariant)", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([2, 4, 6]); // 2x scaled — same direction
    const score = cosineSimilarity(a, b);
    assert.ok(Math.abs(score - 1) < 1e-6);
  });
});

// ── semanticSearch ranking with a mocked embedder ───────────────────

describe("semanticSearch (mocked embedder)", () => {
  beforeEach(() => {
    _resetEmbedderForTesting();
  });

  /**
   * Mock embedder that returns hand-picked vectors keyed on a substring of the
   * input. This lets us drive the cosine math deterministically.
   */
  function installMockEmbedder() {
    const vectors = {
      query:   new Float32Array([1, 0, 0]),
      strong:  new Float32Array([0.95, 0.31, 0]),  // ~0.95 cos with query
      medium:  new Float32Array([0.5, 0.866, 0]),  // 0.5 cos
      weak:    new Float32Array([0.2, 0.98, 0]),   // 0.2 cos — below default 0.3 threshold
      orth:    new Float32Array([0, 1, 0]),        // 0 cos
    };

    _setEmbedderForTesting(async (text) => {
      for (const [k, v] of Object.entries(vectors)) {
        if (text.includes(k)) {
          // The real pipeline returns an object with a .data field.
          return { data: v };
        }
      }
      return { data: new Float32Array([0, 0, 1]) }; // default — orthogonal to query
    });
  }

  test("ranks candidates by cosine similarity desc", async () => {
    installMockEmbedder();

    const hits = await semanticSearch(
      "query about something",
      [
        { id: 1, text: "this is a weak match" },
        { id: 2, text: "this is a strong match" },
        { id: 3, text: "this is a medium match" },
      ],
      5,
      0 // threshold 0 so the weak one survives for ordering check
    );

    assert.equal(hits.length, 3);
    assert.equal(hits[0].id, 2, "strong should win");
    assert.equal(hits[1].id, 3, "medium second");
    assert.equal(hits[2].id, 1, "weak last");
    assert.ok(hits[0].score > hits[1].score);
    assert.ok(hits[1].score > hits[2].score);
  });

  test("applies threshold filter (default 0.3)", async () => {
    installMockEmbedder();

    const hits = await semanticSearch(
      "query",
      [
        { id: 1, text: "weak match (score ~0.2)" },
        { id: 2, text: "strong match (score ~0.95)" },
        { id: 3, text: "orth vector (score 0)" },
      ],
      5
      // default threshold = 0.3 — weak (0.2) and orth (0) should drop
    );

    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, 2);
  });

  test("respects topK", async () => {
    installMockEmbedder();

    const hits = await semanticSearch(
      "query",
      [
        { id: 1, text: "strong A" },
        { id: 2, text: "strong B" },
        { id: 3, text: "medium one" },
      ],
      2,
      0
    );

    assert.equal(hits.length, 2);
  });

  test("empty candidate list returns []", async () => {
    installMockEmbedder();
    const hits = await semanticSearch("query", [], 5);
    assert.deepEqual(hits, []);
  });

  test("uses pre-computed vector when supplied (skips embed)", async () => {
    // Install an embedder that throws if called for candidates — proves the
    // pre-computed vector short-circuit works.
    let embedderCalls = 0;
    _setEmbedderForTesting(async (text) => {
      embedderCalls++;
      // Only the query string should ever hit the embedder.
      return { data: new Float32Array([1, 0, 0]) };
    });

    const hits = await semanticSearch(
      "anything",
      [
        {
          id: 7,
          text: "irrelevant — vector takes precedence",
          vector: new Float32Array([1, 0, 0]),
        },
      ],
      1,
      0
    );

    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, 7);
    assert.equal(embedderCalls, 1, "embedder should fire once (for the query only)");
  });
});

// ── embed() smoke ───────────────────────────────────────────────────

describe("embed (mocked)", () => {
  beforeEach(() => {
    _resetEmbedderForTesting();
  });

  test("empty string returns zero vector without invoking embedder", async () => {
    let called = false;
    _setEmbedderForTesting(async () => {
      called = true;
      return { data: new Float32Array([1, 2, 3]) };
    });

    const v = await embed("");
    assert.equal(v.length, 384);
    assert.equal(v[0], 0);
    assert.equal(called, false, "should short-circuit empty input");
  });

  test("returns a Float32Array copy of the pipeline output", async () => {
    const src = new Float32Array([0.1, 0.2, 0.3]);
    _setEmbedderForTesting(async () => ({ data: src }));

    const v = await embed("some prompt");
    assert.ok(v instanceof Float32Array);
    assert.equal(v.length, 3);
    assert.ok(Math.abs(v[0] - 0.1) < 1e-6);
    // Confirm it's a copy, not a shared reference.
    assert.notStrictEqual(v, src);
  });
});
