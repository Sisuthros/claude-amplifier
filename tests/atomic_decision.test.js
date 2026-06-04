// P0 #4 — addDecision must be atomic.
//
// addDecision does three things that must succeed or fail together:
//   1. INSERT the new decision.
//   2. If supersedes_id is set, mark the OLD decision "superseded".
//   3. Read the NEW decision back (write-verification, v1.5.0).
//
// Before this fix these were three separate statements with no surrounding
// transaction. A failure in step 2 or 3 could leave the database in a partial
// state: the old decision flipped to "superseded" while the new one never
// persisted (read-back threw), or the new decision inserted while the old one
// was left dangling. Both are silent corruption — exactly the failure class
// this tool exists to prevent.
//
// These tests pin the atomic contract:
//   (a) happy path: new decision active, old correctly superseded.
//   (b) read-back of the NEW decision fails -> AmplifierWriteError AND the old
//       decision stays ACTIVE (whole transaction rolled back).
//   (c) supersede mutation fails -> full rollback (new decision not dangling,
//       old decision stays ACTIVE).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { SQLiteStore, AmplifierWriteError } from "../dist/storage.js";

function tmpDbPath() {
  return path.join(
    os.tmpdir(),
    `amp-atomic-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function tmpLogPath() {
  return path.join(
    os.tmpdir(),
    `amp-atomic-errlog-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
}

/** Insert a baseline "old" decision we can supersede. Returns its row. */
function seedOldDecision(store, project) {
  return store.addDecision({
    project,
    category: "general",
    title: "Old decision",
    description: "the one to be superseded",
    tags: [],
    status: "active",
  });
}

describe("addDecision atomicity (P0 #4)", () => {
  test("(a) happy path: new decision active, old correctly superseded", () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const old = seedOldDecision(store, "p");
      assert.equal(old.status, "active");

      const fresh = store.addDecision({
        project: "p",
        category: "general",
        title: "New decision",
        description: "replaces the old one",
        tags: [],
        status: "active",
        supersedes_id: old.id,
      });

      // New decision persisted and active.
      assert.equal(fresh.status, "active");
      const active = store.getDecisions("p", "active");
      assert.equal(active.length, 1);
      assert.equal(active[0].id, fresh.id);
      assert.equal(active[0].title, "New decision");

      // Old decision flipped to superseded.
      const superseded = store.getDecisions("p", "superseded");
      assert.equal(superseded.length, 1);
      assert.equal(superseded[0].id, old.id);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  test("(b) read-back of new decision fails -> old stays ACTIVE, no partial state", () => {
    const dbPath = tmpDbPath();
    const logPath = tmpLogPath();
    process.env.AMPLIFIER_WRITE_ERRORS_LOG = logPath;
    const store = new SQLiteStore(dbPath);
    try {
      const old = seedOldDecision(store, "p");

      // Force the post-INSERT read-back of the NEW decision to fail. Because
      // the read-back lives inside the transaction, this must roll back BOTH
      // the INSERT and the supersede UPDATE.
      store.getDecisionById = () => undefined;

      assert.throws(
        () =>
          store.addDecision({
            project: "p",
            category: "general",
            title: "Vanishing new decision",
            description: "d",
            tags: [],
            status: "active",
            supersedes_id: old.id,
          }),
        (err) =>
          err instanceof AmplifierWriteError && err.table === "decisions",
      );

      // Restore the real read-back so we can inspect actual DB state.
      delete store.getDecisionById;

      // Old decision must remain ACTIVE — the supersede was rolled back.
      const active = store.getDecisions("p", "active");
      assert.equal(active.length, 1, "old decision should still be active");
      assert.equal(active[0].id, old.id);

      // The new (vanishing) decision must NOT be present in any status.
      const superseded = store.getDecisions("p", "superseded");
      assert.equal(superseded.length, 0, "nothing should be superseded");
      const all = [
        ...store.getDecisions("p", "active"),
        ...store.getDecisions("p", "superseded"),
      ];
      assert.ok(
        !all.some((d) => d.title === "Vanishing new decision"),
        "new decision must not be left dangling",
      );

      // Audit log captured the failure.
      const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);
      assert.equal(JSON.parse(lines[0]).table, "decisions");
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
      try { fs.unlinkSync(logPath); } catch {}
      delete process.env.AMPLIFIER_WRITE_ERRORS_LOG;
    }
  });

  test("(c) supersede mutation fails -> full rollback, new decision not dangling", () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const old = seedOldDecision(store, "p");

      // Force the supersede mutation to throw. The whole transaction (INSERT of
      // the new decision included) must roll back.
      store.updateDecisionStatus = () => {
        throw new Error("simulated supersede failure");
      };

      assert.throws(
        () =>
          store.addDecision({
            project: "p",
            category: "general",
            title: "New decision that should roll back",
            description: "d",
            tags: [],
            status: "active",
            supersedes_id: old.id,
          }),
        /simulated supersede failure/,
      );

      delete store.updateDecisionStatus;

      // Old decision still ACTIVE.
      const active = store.getDecisions("p", "active");
      assert.equal(active.length, 1, "only the old decision should remain");
      assert.equal(active[0].id, old.id);

      // The new decision must NOT have persisted.
      assert.ok(
        !active.some((d) => d.title === "New decision that should roll back"),
        "new decision must be rolled back, not dangling",
      );
      assert.equal(store.getDecisions("p", "superseded").length, 0);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  // False-positive guard: a supersede that LEGITIMATELY targets a missing id
  // must still commit the new decision (no spurious rollback). UPDATE ... WHERE
  // id = <missing> affects zero rows, which is fine — it is not an error.
  test("(d) false-positive guard: superseding a non-existent id still commits the new decision", () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const fresh = store.addDecision({
        project: "p",
        category: "general",
        title: "Standalone new decision",
        description: "supersedes an id that was never inserted",
        tags: [],
        status: "active",
        supersedes_id: 999999,
      });
      assert.equal(fresh.status, "active");
      const active = store.getDecisions("p", "active");
      assert.equal(active.length, 1);
      assert.equal(active[0].id, fresh.id);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });
});
