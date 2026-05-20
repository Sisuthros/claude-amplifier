// Unit tests for SQLiteStore v1.2.0 features.
//
// Uses node:test (built into Node 18+ stable, no extra deps).  Run with:
//   npm test
//
// Each test gets its own temp DB so they cannot poison each other.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { SQLiteStore } from "../dist/storage.js";

function freshStore() {
  const tmpPath = path.join(
    os.tmpdir(),
    `amp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  const store = new SQLiteStore(tmpPath);
  return {
    store,
    cleanup: () => {
      store.close();
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // sqlite WAL leftovers — fine to ignore in tests
      }
    },
  };
}

// ── Lessons + pattern_key ───────────────────────────────────────────

describe("recordLesson with pattern_key (v1.2.0)", () => {
  test("two lessons with same pattern_key aggregate into one with frequency=2", () => {
    const { store, cleanup } = freshStore();
    try {
      const l1 = store.addLesson({
        project: "p",
        type: "mistake",
        title: "Read NIM docs",
        description: "A",
        severity: "high",
        tags: [],
        pattern_key: "read-docs-first",
      });
      const l2 = store.addLesson({
        project: "p",
        type: "mistake",
        title: "Check Hermes spec",
        description: "B",
        severity: "high",
        tags: [],
        pattern_key: "read-docs-first",
      });

      assert.equal(l1.id, l2.id, "ids should be the same");
      assert.equal(l2.frequency, 2);
      assert.equal(l2.pattern_key, "read-docs-first");
    } finally {
      cleanup();
    }
  });

  test("three lessons with same pattern_key reach frequency=3", () => {
    const { store, cleanup } = freshStore();
    try {
      for (const title of ["NIM", "Hermes", "ZeptoClaw"]) {
        store.addLesson({
          project: "p",
          type: "mistake",
          title,
          description: title,
          severity: "high",
          tags: [],
          pattern_key: "read-docs-first",
        });
      }
      const lessons = store.getLessons("p");
      assert.equal(lessons.length, 1);
      assert.equal(lessons[0].frequency, 3);
    } finally {
      cleanup();
    }
  });

  test("lessons in different projects do not share pattern_key", () => {
    const { store, cleanup } = freshStore();
    try {
      const a = store.addLesson({
        project: "proj-a",
        type: "mistake",
        title: "X",
        description: "X",
        severity: "low",
        tags: [],
        pattern_key: "shared-key",
      });
      const b = store.addLesson({
        project: "proj-b",
        type: "mistake",
        title: "Y",
        description: "Y",
        severity: "low",
        tags: [],
        pattern_key: "shared-key",
      });
      assert.notEqual(a.id, b.id);
      assert.equal(a.frequency, 1);
      assert.equal(b.frequency, 1);
    } finally {
      cleanup();
    }
  });

  test("v1.1.0 title-fallback still works without pattern_key", () => {
    const { store, cleanup } = freshStore();
    try {
      const l1 = store.addLesson({
        project: "p",
        type: "mistake",
        title: "Same title",
        description: "first",
        severity: "low",
        tags: [],
      });
      const l2 = store.addLesson({
        project: "p",
        type: "mistake",
        title: "Same title",
        description: "second",
        severity: "low",
        tags: [],
      });
      assert.equal(l1.id, l2.id);
      assert.equal(l2.frequency, 2);
    } finally {
      cleanup();
    }
  });
});

// ── updateDecision (v1.2.0) ─────────────────────────────────────────

describe("updateDecision (v1.2.0)", () => {
  test("partial update preserves id and created_at", async () => {
    const { store, cleanup } = freshStore();
    try {
      const d1 = store.addDecision({
        project: "p",
        category: "tech",
        title: "Use Postgres",
        description: "original",
        tags: [],
        status: "active",
      });
      const originalCreatedAt = d1.created_at;

      // Wait so the updated_at timestamp can differ
      await new Promise((r) => setTimeout(r, 20));

      const d2 = store.updateDecision(d1.id, {
        description: "refined",
        next_step: "Add migrations",
      });

      assert.equal(d2.id, d1.id);
      assert.equal(d2.created_at, originalCreatedAt);
      assert.equal(d2.description, "refined");
      assert.equal(d2.next_step, "Add migrations");
      // Untouched fields preserved
      assert.equal(d2.title, "Use Postgres");
    } finally {
      cleanup();
    }
  });

  test("updateDecision returns null for missing id", () => {
    const { store, cleanup } = freshStore();
    try {
      const result = store.updateDecision(99999, { description: "x" });
      assert.equal(result, null);
    } finally {
      cleanup();
    }
  });

  test("empty patch returns existing decision unchanged", () => {
    const { store, cleanup } = freshStore();
    try {
      const d1 = store.addDecision({
        project: "p",
        category: "tech",
        title: "Keep",
        description: "as-is",
        tags: [],
        status: "active",
      });
      const d2 = store.updateDecision(d1.id, {});
      assert.equal(d2.description, "as-is");
    } finally {
      cleanup();
    }
  });

  test("array fields (trade_offs, alternatives_considered) serialise correctly", () => {
    const { store, cleanup } = freshStore();
    try {
      const d1 = store.addDecision({
        project: "p",
        category: "tech",
        title: "X",
        description: "x",
        tags: [],
        status: "active",
      });
      const d2 = store.updateDecision(d1.id, {
        trade_offs: ["loses local debug", "adds €30/mo cost"],
        alternatives_considered: ["MinIO", "Cloudflare R2"],
      });
      assert.deepEqual(d2.trade_offs, ["loses local debug", "adds €30/mo cost"]);
      assert.deepEqual(d2.alternatives_considered, ["MinIO", "Cloudflare R2"]);
    } finally {
      cleanup();
    }
  });
});

// ── linkDecisions (v1.2.0) ──────────────────────────────────────────

describe("linkDecisions (v1.2.0)", () => {
  test("creates relations entry on the from-decision", () => {
    const { store, cleanup } = freshStore();
    try {
      const a = store.addDecision({
        project: "p",
        category: "a",
        title: "A",
        description: "a",
        tags: [],
        status: "active",
      });
      const b = store.addDecision({
        project: "p",
        category: "b",
        title: "B",
        description: "b",
        tags: [],
        status: "active",
      });
      const result = store.linkDecisions(a.id, b.id, "caused");
      assert.deepEqual(result.related_decision_ids.caused, [b.id]);
    } finally {
      cleanup();
    }
  });

  test("idempotent — same link twice does not duplicate", () => {
    const { store, cleanup } = freshStore();
    try {
      const a = store.addDecision({
        project: "p",
        category: "a",
        title: "A",
        description: "a",
        tags: [],
        status: "active",
      });
      const b = store.addDecision({
        project: "p",
        category: "b",
        title: "B",
        description: "b",
        tags: [],
        status: "active",
      });
      store.linkDecisions(a.id, b.id, "relates_to");
      store.linkDecisions(a.id, b.id, "relates_to");
      const refreshed = store
        .getDecisions("p", "active")
        .find((d) => d.id === a.id);
      assert.equal(refreshed.related_decision_ids.relates_to.length, 1);
    } finally {
      cleanup();
    }
  });

  test("multiple distinct targets stack under one relation", () => {
    const { store, cleanup } = freshStore();
    try {
      const a = store.addDecision({
        project: "p",
        category: "a",
        title: "A",
        description: "a",
        tags: [],
        status: "active",
      });
      const b = store.addDecision({
        project: "p",
        category: "b",
        title: "B",
        description: "b",
        tags: [],
        status: "active",
      });
      const c = store.addDecision({
        project: "p",
        category: "c",
        title: "C",
        description: "c",
        tags: [],
        status: "active",
      });
      store.linkDecisions(a.id, b.id, "caused");
      store.linkDecisions(a.id, c.id, "caused");
      const refreshed = store.getDecisions("p", "active").find((d) => d.id === a.id);
      assert.equal(refreshed.related_decision_ids.caused.length, 2);
      assert.ok(refreshed.related_decision_ids.caused.includes(b.id));
      assert.ok(refreshed.related_decision_ids.caused.includes(c.id));
    } finally {
      cleanup();
    }
  });

  test("self-link throws", () => {
    const { store, cleanup } = freshStore();
    try {
      const a = store.addDecision({
        project: "p",
        category: "a",
        title: "A",
        description: "a",
        tags: [],
        status: "active",
      });
      assert.throws(() => store.linkDecisions(a.id, a.id, "caused"));
    } finally {
      cleanup();
    }
  });

  test("non-existent from-id returns null", () => {
    const { store, cleanup } = freshStore();
    try {
      const result = store.linkDecisions(99999, 88888, "caused");
      assert.equal(result, null);
    } finally {
      cleanup();
    }
  });
});

// ── supersedes behaviour ────────────────────────────────────────────

describe("supersedes (v1.1.0)", () => {
  test("supersedes_id automatically marks the older decision superseded", () => {
    const { store, cleanup } = freshStore();
    try {
      const old = store.addDecision({
        project: "p",
        category: "tech",
        title: "Use Postgres",
        description: "v1",
        tags: [],
        status: "active",
      });
      store.addDecision({
        project: "p",
        category: "tech",
        title: "Use CockroachDB",
        description: "v2",
        tags: [],
        status: "active",
        supersedes_id: old.id,
      });

      const active = store.getDecisions("p", "active");
      const superseded = store.getDecisions("p", "superseded");

      assert.equal(active.length, 1);
      assert.equal(active[0].title, "Use CockroachDB");
      assert.equal(superseded.length, 1);
      assert.equal(superseded[0].id, old.id);
    } finally {
      cleanup();
    }
  });
});

// ── loadContext + summary (v1.2.0) ──────────────────────────────────

describe("loadContext summary line (v1.2.0)", () => {
  test("summary is a non-empty string with project name", () => {
    const { store, cleanup } = freshStore();
    try {
      store.addDecision({
        project: "p",
        category: "tech",
        title: "X",
        description: "x",
        tags: [],
        status: "active",
      });
      const ctx = store.loadContext("p", ["all"]);
      assert.ok(ctx.summary.startsWith("[p]"));
      assert.ok(ctx.summary.includes("1 active decisions"));
    } finally {
      cleanup();
    }
  });

  test("summary surfaces recurring patterns", () => {
    const { store, cleanup } = freshStore();
    try {
      // Bump a lesson to frequency=3 to make it count as recurring
      for (let i = 0; i < 3; i++) {
        store.addLesson({
          project: "p",
          type: "mistake",
          title: "Same",
          description: `${i}`,
          severity: "medium",
          tags: [],
        });
      }
      const ctx = store.loadContext("p", ["all"]);
      assert.ok(ctx.summary.includes("recurring"));
    } finally {
      cleanup();
    }
  });

  test("active_reminders populated when restore_step set", () => {
    const { store, cleanup } = freshStore();
    try {
      store.addDecision({
        project: "p",
        category: "ops",
        title: "Container patch",
        description: "x",
        tags: [],
        status: "active",
        restore_step: "Run /root/patches/exec-host-unlock.sh after recreate",
      });
      const ctx = store.loadContext("p", ["all"]);
      assert.equal(ctx.active_reminders.length, 1);
      assert.equal(
        ctx.active_reminders[0].restore_step,
        "Run /root/patches/exec-host-unlock.sh after recreate"
      );
      assert.ok(ctx.summary.includes("restore step"));
    } finally {
      cleanup();
    }
  });
});

// ── Backwards compatibility ─────────────────────────────────────────

describe("backwards compatibility", () => {
  test("loadContext returns lesson with default frequency=1", () => {
    const { store, cleanup } = freshStore();
    try {
      store.addLesson({
        project: "p",
        type: "insight",
        title: "T",
        description: "D",
        severity: "low",
        tags: [],
      });
      const ctx = store.loadContext("p", ["lessons"]);
      assert.equal(ctx.lessons[0].frequency, 1);
    } finally {
      cleanup();
    }
  });

  test("addDecision without v1.1+ fields still works", () => {
    const { store, cleanup } = freshStore();
    try {
      const d = store.addDecision({
        project: "p",
        category: "tech",
        title: "Plain",
        description: "no lifecycle",
        tags: ["x"],
        status: "active",
      });
      assert.equal(d.title, "Plain");
      assert.deepEqual(d.tags, ["x"]);
      assert.deepEqual(d.trade_offs, []);
    } finally {
      cleanup();
    }
  });
});
