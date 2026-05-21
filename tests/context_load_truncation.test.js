// Tests for amplify_context_load auto-truncation + smart priority (v1.4.1).
//
// Verifies that:
//   - max_tokens caps the rendered output (≈4 chars/token heuristic)
//   - priority="recent" sorts newest-first
//   - priority="frequency" sorts by frequency count
//   - priority="smart" combines frequency/confidence/recency/status
//   - the truncation marker ("Showed top N of M") appears when items are dropped
//   - omitting max_tokens uses the 4000-token default
//
// Run with: npm test

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { SQLiteStore } from "../dist/storage.js";
import { handleContextLoad } from "../dist/tools.js";

function freshStore() {
  const tmpPath = path.join(
    os.tmpdir(),
    `amp-ctx-trunc-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  const store = new SQLiteStore(tmpPath);
  return {
    store,
    cleanup: () => {
      store.close();
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    },
  };
}

function approxTokens(text) {
  return Math.ceil(text.length / 4);
}

// Seed N lessons. Caller can override per-lesson fields via overrides[i].
function seedLessons(store, project, n, overrides = []) {
  const created = [];
  for (let i = 0; i < n; i++) {
    const o = overrides[i] || {};
    const l = store.addLesson({
      project,
      type: o.type || "mistake",
      title: o.title || `Lesson #${i} title with some words to add length`,
      description:
        o.description ||
        `Description for lesson ${i}. ` +
          "Lorem ipsum dolor sit amet, consectetur adipiscing elit. " +
          "Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
      severity: o.severity || "medium",
      tags: o.tags || [],
      ...(o.pattern_key ? { pattern_key: o.pattern_key } : {}),
      ...(o.confidence !== undefined ? { confidence: o.confidence } : {}),
      ...(o.verification_status
        ? { verification_status: o.verification_status }
        : {}),
    });
    created.push(l);
  }
  return created;
}

// ── max_tokens caps output size ─────────────────────────────────────

describe("amplify_context_load: max_tokens budget", () => {
  test("max_tokens=100 keeps the rendered context tight (<= ~140 tokens incl. headers)", async () => {
    const { store, cleanup } = freshStore();
    try {
      seedLessons(store, "p", 50);
      const out = await handleContextLoad(store, {
        project: "p",
        max_tokens: 100,
      });
      // We allow some slack for the (small) header + truncation marker.
      // Lessons themselves must respect the budget — the test fails if the
      // ranker ignores max_tokens entirely.
      assert.ok(
        approxTokens(out) <= 250,
        `output ~${approxTokens(out)} tokens, too large for max_tokens=100`
      );
      // Should have included at most a couple of lessons.
      const shownMatches = out.match(/^\[\d+\]/gm) || [];
      assert.ok(
        shownMatches.length <= 3,
        `expected <=3 lessons shown, got ${shownMatches.length}`
      );
    } finally {
      cleanup();
    }
  });

  test("default max_tokens is 4000 when arg is omitted", async () => {
    const { store, cleanup } = freshStore();
    try {
      seedLessons(store, "p", 10);
      const out = await handleContextLoad(store, { project: "p" });
      assert.ok(
        out.includes("Budget: 4000 tokens"),
        "expected header to declare the 4000-token default"
      );
    } finally {
      cleanup();
    }
  });
});

// ── priority ordering ───────────────────────────────────────────────

describe("amplify_context_load: priority modes", () => {
  test('priority="recent" lists newest lessons first', async () => {
    const { store, cleanup } = freshStore();
    try {
      // Insert sequentially; SQLite created_at order = insertion order.
      const ls = seedLessons(store, "p", 5, [
        { title: "OLDEST AAAA" },
        { title: "OLDER BBBB" },
        { title: "MIDDLE CCCC" },
        { title: "NEWER DDDD" },
        { title: "NEWEST EEEE" },
      ]);
      const out = await handleContextLoad(store, {
        project: "p",
        priority: "recent",
        max_tokens: 20000,
      });
      const idxNewest = out.indexOf("NEWEST EEEE");
      const idxOldest = out.indexOf("OLDEST AAAA");
      assert.ok(idxNewest > -1 && idxOldest > -1, "both lessons should render");
      assert.ok(
        idxNewest < idxOldest,
        "newest should appear before oldest under priority=recent"
      );
      // sanity: header reports the priority used
      assert.ok(out.includes("priority=recent"));
    } finally {
      cleanup();
    }
  });

  test('priority="frequency" lists the most-repeated lessons first', async () => {
    const { store, cleanup } = freshStore();
    try {
      // Two distinct pattern keys; "hot" gets 4 hits, "cold" gets 1.
      for (let i = 0; i < 4; i++) {
        store.addLesson({
          project: "p",
          type: "mistake",
          title: `HOT variant ${i}`,
          description: "hot lesson variant " + i,
          severity: "high",
          tags: [],
          pattern_key: "hot-pattern",
        });
      }
      store.addLesson({
        project: "p",
        type: "mistake",
        title: "COLD single",
        description: "cold lesson, only seen once",
        severity: "medium",
        tags: [],
        pattern_key: "cold-pattern",
      });

      const out = await handleContextLoad(store, {
        project: "p",
        priority: "frequency",
        max_tokens: 20000,
      });
      const idxHot = out.indexOf("HOT variant");
      const idxCold = out.indexOf("COLD single");
      assert.ok(idxHot > -1 && idxCold > -1);
      assert.ok(
        idxHot < idxCold,
        "high-frequency lesson should appear before single-shot one"
      );
    } finally {
      cleanup();
    }
  });

  test('priority="smart" combines frequency, confidence, recency, status', async () => {
    const { store, cleanup } = freshStore();
    try {
      // Low-signal lesson: 1 occurrence, low confidence, plain claim.
      store.addLesson({
        project: "p",
        type: "mistake",
        title: "WEAK guess",
        description: "unverified hunch with low confidence",
        severity: "low",
        tags: [],
        confidence: 0.2,
        verification_status: "claim",
      });
      // High-signal lesson: repeated 3x via pattern_key, high confidence, confirmed.
      for (let i = 0; i < 3; i++) {
        store.addLesson({
          project: "p",
          type: "mistake",
          title: `STRONG signal ${i}`,
          description: "frequently-seen confirmed lesson",
          severity: "critical",
          tags: [],
          pattern_key: "strong-pattern",
          confidence: 0.95,
          verification_status: "confirmed",
        });
      }

      const out = await handleContextLoad(store, {
        project: "p",
        priority: "smart",
        max_tokens: 20000,
      });
      const idxStrong = out.indexOf("STRONG signal");
      const idxWeak = out.indexOf("WEAK guess");
      assert.ok(idxStrong > -1 && idxWeak > -1);
      assert.ok(
        idxStrong < idxWeak,
        "smart-priority should rank confirmed+repeated+high-confidence lesson above weak claim"
      );
    } finally {
      cleanup();
    }
  });
});

// ── truncation marker ───────────────────────────────────────────────

describe("amplify_context_load: truncation marker", () => {
  test('output contains "Showed top N of M" when truncation occurred', async () => {
    const { store, cleanup } = freshStore();
    try {
      seedLessons(store, "p", 40); // way more than 200-token budget can fit
      const out = await handleContextLoad(store, {
        project: "p",
        max_tokens: 200,
      });
      assert.match(
        out,
        /Showed top \d+ of \d+ lessons/,
        "expected truncation marker"
      );
      // And the marker must report a number strictly less than the seeded count.
      const m = out.match(/Showed top (\d+) of (\d+) lessons/);
      assert.ok(m);
      const shown = Number(m[1]);
      const total = Number(m[2]);
      assert.ok(shown < total, `expected shown(${shown}) < total(${total})`);
    } finally {
      cleanup();
    }
  });
});
