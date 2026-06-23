// v1.6.0 — behavior tests for the four auto-capture handlers, exercised
// through the MCP router (dispatchToolCall) so the router wiring, the JSON
// envelope, and the handler logic are all covered.
//
// Each test gets its own temp DB. Where a test needs lessons with specific
// ages (recent_patterns / decay_old), the created_at/updated_at columns are
// back-dated directly via the store's sqlite handle, the same escape hatch
// pattern_suggest.ts uses internally.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { SQLiteStore } from "../dist/storage.js";
import { dispatchToolCall } from "../dist/tool_router.js";

function freshStore() {
  const tmpPath = path.join(
    os.tmpdir(),
    `amp-ac-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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

function call(store, name, args) {
  return dispatchToolCall(store, { params: { name, arguments: args } });
}

// Parse the single text-content envelope as JSON.
async function callJson(store, name, args) {
  const res = await call(store, name, args);
  assert.ok(Array.isArray(res.content));
  assert.equal(res.content[0].type, "text");
  return JSON.parse(res.content[0].text);
}

// Back-date a lesson's timestamps to N days ago (storage 'YYYY-MM-DD HH:MM:SS').
function backdate(store, id, daysAgo) {
  const db = store.db;
  const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .split(".")[0];
  db.prepare(`UPDATE lessons SET created_at = ?, updated_at = ? WHERE id = ?`).run(ts, ts, id);
}

// ── amplify_capture_session ─────────────────────────────────────────

describe("amplify_capture_session", () => {
  test("detects each of the 5 trigger families with correct type/severity", async () => {
    const { store, cleanup } = freshStore();
    try {
      const cases = [
        { text: "this is really frustrating", type: "mistake", severity: "high" },
        { text: "tämä on tärkeää, muista se", type: "insight", severity: "high" },
        { text: "perfect, it works now", type: "success", severity: "medium" },
        { text: "never do that in production", type: "mistake", severity: "critical" },
        { text: "from now on we deploy on fridays", type: "decision", severity: "medium" },
      ];
      for (const c of cases) {
        const out = await callJson(store, "amplify_capture_session", {
          project: "p",
          recent_messages: c.text,
        });
        assert.equal(out.triggers_detected, 1, `one trigger for: ${c.text}`);
        assert.equal(out.suggestions[0].suggested_type, c.type, c.text);
        assert.equal(out.suggestions[0].suggested_severity, c.severity, c.text);
      }
    } finally {
      cleanup();
    }
  });

  test("snippet is bounded and newlines flattened", async () => {
    const { store, cleanup } = freshStore();
    try {
      const filler = "x".repeat(300);
      const out = await callJson(store, "amplify_capture_session", {
        project: "p",
        recent_messages: `${filler}\nline\nimportant\nmore\n${filler}`,
      });
      const snip = out.suggestions[0].context;
      assert.ok(!snip.includes("\n"), "newlines flattened");
      // -80 / +120 window around the match → at most 200 chars.
      assert.ok(snip.length <= 200, `snippet length ${snip.length} <= 200`);
    } finally {
      cleanup();
    }
  });

  test("caller-flagged triggers become user-flagged / high", async () => {
    const { store, cleanup } = freshStore();
    try {
      const out = await callJson(store, "amplify_capture_session", {
        project: "p",
        recent_messages: "nothing notable here",
        triggers_found: ["user corrected the name"],
      });
      assert.equal(out.triggers_detected, 1);
      assert.equal(out.suggestions[0].suggested_type, "user-flagged");
      assert.equal(out.suggestions[0].suggested_severity, "high");
    } finally {
      cleanup();
    }
  });

  test("caps suggestions at 5", async () => {
    const { store, cleanup } = freshStore();
    try {
      const out = await callJson(store, "amplify_capture_session", {
        // all 5 regex triggers + 3 flagged = 8 detected, 5 suggestions max
        project: "p",
        recent_messages: "frustrating important works never do from now on",
        triggers_found: ["a", "b", "c"],
      });
      assert.ok(out.triggers_detected > 5);
      assert.equal(out.suggestions.length, 5);
    } finally {
      cleanup();
    }
  });

  test("missing required args return an Error string, not a throw", async () => {
    const { store, cleanup } = freshStore();
    try {
      const res = await call(store, "amplify_capture_session", { project: "p" });
      assert.match(res.content[0].text, /^Error:/);
      const res2 = await call(store, "amplify_capture_session", {
        recent_messages: "hi",
      });
      assert.match(res2.content[0].text, /^Error:/);
    } finally {
      cleanup();
    }
  });
});

// ── amplify_dedup_check ─────────────────────────────────────────────

describe("amplify_dedup_check", () => {
  test("flags a strong (>=0.7) duplicate", async () => {
    const { store, cleanup } = freshStore();
    try {
      store.addLesson({
        project: "p",
        type: "mistake",
        title: "read docs before coding always",
        description: "check official docs first",
        severity: "high",
        tags: [],
        pattern_key: "read-docs-before-coding",
      });
      const out = await callJson(store, "amplify_dedup_check", {
        project: "p",
        title: "read docs before coding always",
        description: "check official docs first",
      });
      assert.equal(out.is_likely_duplicate, true);
      assert.equal(out.duplicates[0].pattern_key, "read-docs-before-coding");
      assert.ok(out.duplicates[0].similarity >= 0.7);
    } finally {
      cleanup();
    }
  });

  test("empty pool → not a duplicate, empty list", async () => {
    const { store, cleanup } = freshStore();
    try {
      const out = await callJson(store, "amplify_dedup_check", {
        project: "p",
        title: "totally new lesson",
      });
      assert.equal(out.is_likely_duplicate, false);
      assert.deepEqual(out.duplicates, []);
    } finally {
      cleanup();
    }
  });

  test("threshold filters out weak matches", async () => {
    const { store, cleanup } = freshStore();
    try {
      store.addLesson({
        project: "p",
        type: "insight",
        title: "configure docker network bridge",
        description: "networking",
        severity: "low",
        tags: [],
      });
      // High threshold → unrelated probe returns nothing.
      const out = await callJson(store, "amplify_dedup_check", {
        project: "p",
        title: "weather forecast tomorrow",
        threshold: 0.9,
      });
      assert.deepEqual(out.duplicates, []);
    } finally {
      cleanup();
    }
  });

  test("missing title returns an Error string", async () => {
    const { store, cleanup } = freshStore();
    try {
      const res = await call(store, "amplify_dedup_check", { project: "p" });
      assert.match(res.content[0].text, /^Error:/);
    } finally {
      cleanup();
    }
  });
});

// ── amplify_recent_patterns ─────────────────────────────────────────

describe("amplify_recent_patterns", () => {
  test("groups by pattern_key, sums frequency, applies cutoff", async () => {
    const { store, cleanup } = freshStore();
    try {
      // Two lessons same key (frequency aggregates to 2 on second add).
      store.addLesson({
        project: "p",
        type: "mistake",
        title: "Read NIM docs",
        description: "A",
        severity: "high",
        tags: [],
        pattern_key: "read-docs-first",
      });
      store.addLesson({
        project: "p",
        type: "warning",
        title: "Read NIM docs",
        description: "B",
        severity: "high",
        tags: [],
        pattern_key: "read-docs-first",
      });
      // An old lesson outside the 7-day window.
      const old = store.addLesson({
        project: "p",
        type: "insight",
        title: "ancient lesson",
        description: "C",
        severity: "low",
        tags: [],
        pattern_key: "old-key",
      });
      backdate(store, old.id, 90);

      const out = await callJson(store, "amplify_recent_patterns", {
        project: "p",
        days: 7,
      });
      // Only the recent key survives the cutoff.
      const keys = out.top_patterns.map((p) => p.pattern_key);
      assert.ok(keys.includes("read-docs-first"));
      assert.ok(!keys.includes("old-key"), "old lesson filtered out");
      const top = out.top_patterns.find((p) => p.pattern_key === "read-docs-first");
      assert.equal(top.total_frequency, 2);
      assert.equal(top.lesson_count, 1, "same key aggregates to one row");
    } finally {
      cleanup();
    }
  });

  test("keyless lessons get a synthetic (no-key: <id>) bucket", async () => {
    const { store, cleanup } = freshStore();
    try {
      const l = store.addLesson({
        project: "p",
        type: "insight",
        title: "no key here",
        description: "D",
        severity: "low",
        tags: [],
      });
      const out = await callJson(store, "amplify_recent_patterns", { project: "p" });
      const synthetic = out.top_patterns.find((p) =>
        p.pattern_key.startsWith("(no-key:"),
      );
      assert.ok(synthetic, "synthetic bucket present");
      assert.ok(synthetic.pattern_key.includes(String(l.id).slice(0, 8)));
    } finally {
      cleanup();
    }
  });

  test("limit is capped at 50", async () => {
    const { store, cleanup } = freshStore();
    try {
      const out = await callJson(store, "amplify_recent_patterns", {
        project: "p",
        limit: 999,
      });
      // No data, but the request must not error and must echo a sane window.
      assert.equal(out.window_days, 7);
      assert.ok(Array.isArray(out.top_patterns));
    } finally {
      cleanup();
    }
  });
});

// ── amplify_decay_old ───────────────────────────────────────────────

describe("amplify_decay_old", () => {
  test("warm (recent), frequent, and critical lessons are all skipped", async () => {
    const { store, cleanup } = freshStore();
    try {
      // recent → warm → skipped
      store.addLesson({
        project: "p",
        type: "insight",
        title: "fresh",
        description: "A",
        severity: "low",
        tags: [],
      });
      // critical + old → skipped (critical never decays)
      const crit = store.addLesson({
        project: "p",
        type: "mistake",
        title: "critical old",
        description: "B",
        severity: "critical",
        tags: [],
      });
      backdate(store, crit.id, 120);
      // frequent + old → skipped (frequency >= keep-warm)
      store.addLesson({
        project: "p",
        type: "warning",
        title: "frequent",
        description: "C",
        severity: "high",
        tags: [],
        pattern_key: "freq-key",
      });
      const freq = store.addLesson({
        project: "p",
        type: "warning",
        title: "frequent",
        description: "C2",
        severity: "high",
        tags: [],
        pattern_key: "freq-key",
      });
      const freq3 = store.addLesson({
        project: "p",
        type: "warning",
        title: "frequent",
        description: "C3",
        severity: "high",
        tags: [],
        pattern_key: "freq-key",
      });
      backdate(store, freq.id, 120); // frequency now 3, old
      // cold candidate: old, low-frequency, non-critical
      const cold = store.addLesson({
        project: "p",
        type: "insight",
        title: "cold candidate",
        description: "D",
        severity: "medium",
        tags: [],
      });
      backdate(store, cold.id, 120);

      const out = await callJson(store, "amplify_decay_old", {
        project: "p",
        cold_threshold_days: 60,
        min_frequency_to_keep_warm: 3,
      });
      assert.equal(out.would_mark_cold_count, 1, "only the genuine cold one");
      assert.equal(out.sample[0].title, "cold candidate");
      assert.ok(out.sample[0].age_days >= 100);
    } finally {
      cleanup();
    }
  });

  test("dry_run=false still performs NO write (report-only contract)", async () => {
    const { store, cleanup } = freshStore();
    try {
      const cold = store.addLesson({
        project: "p",
        type: "insight",
        title: "will not actually change",
        description: "D",
        severity: "medium",
        tags: [],
      });
      backdate(store, cold.id, 200);
      const before = store.db
        .prepare(`SELECT created_at, updated_at FROM lessons WHERE id = ?`)
        .get(cold.id);

      const out = await callJson(store, "amplify_decay_old", {
        project: "p",
        dry_run: false,
      });
      assert.equal(out.dry_run, false);
      assert.ok(out.would_mark_cold_count >= 1);
      assert.match(out.note, /report-only|NOT implemented|nothing was modified/i);

      // Prove the row was untouched.
      const after = store.db
        .prepare(`SELECT created_at, updated_at FROM lessons WHERE id = ?`)
        .get(cold.id);
      assert.deepEqual(after, before, "decay_old must not mutate any lesson");
    } finally {
      cleanup();
    }
  });

  test("defaults: 60 / 3 / dry_run=true", async () => {
    const { store, cleanup } = freshStore();
    try {
      const out = await callJson(store, "amplify_decay_old", { project: "p" });
      assert.equal(out.cold_threshold_days, 60);
      assert.equal(out.min_frequency_to_keep_warm, 3);
      assert.equal(out.dry_run, true);
    } finally {
      cleanup();
    }
  });
});

// ── router-level integration ────────────────────────────────────────

describe("auto-capture router integration", () => {
  test("each new tool returns a valid-JSON text envelope", async () => {
    const { store, cleanup } = freshStore();
    try {
      const probes = [
        ["amplify_capture_session", { project: "p", recent_messages: "important note" }],
        ["amplify_dedup_check", { project: "p", title: "x" }],
        ["amplify_recent_patterns", { project: "p" }],
        ["amplify_decay_old", { project: "p" }],
      ];
      for (const [name, args] of probes) {
        const res = await call(store, name, args);
        assert.equal(res.content[0].type, "text");
        assert.doesNotThrow(() => JSON.parse(res.content[0].text), `${name} returns JSON`);
      }
    } finally {
      cleanup();
    }
  });
});
