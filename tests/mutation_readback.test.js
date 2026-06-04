// P0 #5 — read-back / rowcount verification on NON-INSERT mutation paths.
//
// v1.5.0 added write-verification to the two INSERT paths (addLesson/addDecision).
// But the mutation paths could still report success even when zero rows changed
// or the row no longer existed:
//
//   1. the frequency-bump branch inside addLesson  (UPDATE ... frequency+1)
//   2. updateOutcomeStatus
//   3. updateDecisionStatus            (op=supersede / op=revert)
//   4. updateDecision
//   5. linkDecisions
//   6. verifyLesson                    (amplify_verify_claim)
//   7. demoteLesson
//
// Each of these is now hardened: a mutation that targets a NON-EXISTENT id, or
// whose rowcount comes back 0, or whose read-back fails, surfaces a real error
// instead of a fake success. The corresponding tool handlers must NOT return a
// success string for a no-op mutation.
//
// These tests mirror tests/write_verification.test.js style:
//   (a) a missing id surfaces an error (not success), and
//   (b) a simulated read-back / rowcount-zero failure surfaces an error.
// Plus a false-positive guard so legitimate behaviour (e.g. addDecision
// superseding a non-existent id, or updateDecision with no changed fields) is
// preserved.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { SQLiteStore, AmplifierMutationError } from "../dist/storage.js";
import { handleDecisions, handleLinkDecisions, handleVerifyClaim } from "../dist/tools.js";

function tmpDbPath() {
  return path.join(
    os.tmpdir(),
    `amp-mrb-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

/** Seed a lesson and return it. */
function seedLesson(store, project = "p", extra = {}) {
  return store.addLesson({
    project,
    type: "mistake",
    title: "Seed lesson",
    description: "d",
    severity: "high",
    tags: [],
    ...extra,
  });
}

/** Seed a decision and return it. */
function seedDecision(store, project = "p", extra = {}) {
  return store.addDecision({
    project,
    category: "general",
    title: "Seed decision",
    description: "d",
    tags: [],
    status: "active",
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// AmplifierMutationError shape
// ---------------------------------------------------------------------------

describe("AmplifierMutationError (P0 #5)", () => {
  test("exposes operation, table, and id", () => {
    const err = new AmplifierMutationError({
      operation: "updateDecisionStatus",
      table: "decisions",
      id: 42,
    });
    assert.equal(err.name, "AmplifierMutationError");
    assert.equal(err.operation, "updateDecisionStatus");
    assert.equal(err.table, "decisions");
    assert.equal(err.id, 42);
    assert.match(err.message, /did not change any row/);
    assert.match(err.message, /42/);
  });

  test("includes the custom cause when provided", () => {
    const err = new AmplifierMutationError({
      operation: "verifyLesson",
      table: "lessons",
      id: 7,
      cause: "read-back returned no row",
    });
    assert.match(err.message, /read-back returned no row/);
  });
});

// ---------------------------------------------------------------------------
// 1. frequency-bump branch inside addLesson
// ---------------------------------------------------------------------------

describe("addLesson frequency-bump read-back verification (P0 #5)", () => {
  test("(b) throws when the bumped row cannot be read back", () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      // First insert succeeds (read-back happens before the stub).
      seedLesson(store, "p", { pattern_key: "k" });
      // Now break read-back so the SECOND call (which frequency-bumps the
      // existing row) cannot confirm the mutation persisted.
      store.getLessonById = () => undefined;
      assert.throws(
        () => seedLesson(store, "p", { pattern_key: "k" }),
        (err) =>
          err instanceof AmplifierMutationError &&
          err.table === "lessons" &&
          err.operation === "addLesson:frequencyBump",
      );
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  test("(guard) a real frequency bump still returns the lesson with frequency 2", () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const first = seedLesson(store, "p", { pattern_key: "k" });
      assert.equal(first.frequency, 1);
      const second = seedLesson(store, "p", { pattern_key: "k" });
      assert.equal(second.id, first.id);
      assert.equal(second.frequency, 2);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });
});

// ---------------------------------------------------------------------------
// 2. updateOutcomeStatus  (op=update_outcome)
// ---------------------------------------------------------------------------

describe("updateOutcomeStatus rowcount verification (P0 #5)", () => {
  test("(a) missing id throws AmplifierMutationError", () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      assert.throws(
        () => store.updateOutcomeStatus(999999, "validated"),
        (err) =>
          err instanceof AmplifierMutationError &&
          err.table === "decisions" &&
          err.operation === "updateOutcomeStatus",
      );
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  test("(handler-a) op=update_outcome on missing id returns ERROR, never success", async () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const out = await handleDecisions(store, {
        op: "update_outcome",
        id: 999999,
        outcome_status: "validated",
      });
      assert.match(out, /^ERROR:/);
      assert.doesNotMatch(out, /outcome marked as/);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  test("(guard) op=update_outcome on a real decision still succeeds", async () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const d = seedDecision(store, "p", { outcome_check_in: "+7d" });
      const out = await handleDecisions(store, {
        op: "update_outcome",
        id: d.id,
        outcome_status: "validated",
      });
      assert.match(out, /outcome marked as validated/);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });
});

// ---------------------------------------------------------------------------
// 3. updateDecisionStatus  (op=supersede / op=revert)
// ---------------------------------------------------------------------------

describe("updateDecisionStatus rowcount verification (P0 #5)", () => {
  test("(a) missing id throws AmplifierMutationError", () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      assert.throws(
        () => store.updateDecisionStatus(999999, "superseded"),
        (err) =>
          err instanceof AmplifierMutationError &&
          err.table === "decisions" &&
          err.operation === "updateDecisionStatus",
      );
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  test("(handler-a) op=supersede on missing id returns ERROR, never success", async () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const out = await handleDecisions(store, { op: "supersede", id: 999999 });
      assert.match(out, /^ERROR:/);
      // Guard against the pre-fix fake success "Decision 999999 marked as superseded."
      assert.doesNotMatch(out, /^Decision \d+ marked as superseded\./);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  test("(handler-a) op=revert on missing id returns ERROR, never success", async () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const out = await handleDecisions(store, { op: "revert", id: 999999 });
      assert.match(out, /^ERROR:/);
      // Guard against the pre-fix fake success "Decision 999999 marked as reverted."
      assert.doesNotMatch(out, /^Decision \d+ marked as reverted\./);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  test("(guard) op=supersede on a real decision still succeeds", async () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const d = seedDecision(store, "p");
      const out = await handleDecisions(store, { op: "supersede", id: d.id });
      assert.match(out, /marked as superseded/);
      assert.equal(store.getDecisions("p", "superseded").length, 1);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  // CRITICAL false-positive guard: addDecision's INTERNAL supersede of a
  // non-existent id must STILL commit the new decision (this is the contract
  // pinned by atomic_decision.test.js (d)). The hardening must not regress it.
  test("(guard) addDecision superseding a non-existent id still commits", () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const fresh = seedDecision(store, "p", { supersedes_id: 999999 });
      assert.equal(fresh.status, "active");
      assert.equal(store.getDecisions("p", "active").length, 1);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });
});

// ---------------------------------------------------------------------------
// 4. updateDecision  (op=update)
// ---------------------------------------------------------------------------

describe("updateDecision rowcount verification (P0 #5)", () => {
  test("(a) missing id returns null (handler surfaces ERROR)", () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      assert.equal(store.updateDecision(999999, { title: "x" }), null);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  test("(b) throws when the updated row cannot be read back", () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const d = seedDecision(store, "p");
      // Existence check passes (uses the real read-back), the UPDATE runs, then
      // the post-update read-back fails.
      let calls = 0;
      const realGet = store.getDecisionById.bind(store);
      store.getDecisionById = (id) => {
        calls += 1;
        return calls === 1 ? realGet(id) : undefined; // first call = existence, second = read-back
      };
      assert.throws(
        () => store.updateDecision(d.id, { title: "changed" }),
        (err) =>
          err instanceof AmplifierMutationError &&
          err.table === "decisions" &&
          err.operation === "updateDecision",
      );
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  test("(guard) no-op update (no changed fields) returns existing, not an error", () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const d = seedDecision(store, "p");
      const out = store.updateDecision(d.id, {});
      assert.ok(out);
      assert.equal(out.id, d.id);
      assert.equal(out.title, d.title);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  test("(guard) a real update changes the field and reads it back", async () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const d = seedDecision(store, "p");
      const out = await handleDecisions(store, {
        op: "update",
        id: d.id,
        title: "Renamed",
      });
      assert.match(out, /updated/);
      assert.equal(store.getDecisions("p", "active")[0].title, "Renamed");
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });
});

// ---------------------------------------------------------------------------
// 5. linkDecisions
// ---------------------------------------------------------------------------

describe("linkDecisions rowcount verification (P0 #5)", () => {
  test("(a) missing fromId returns null (handler surfaces ERROR)", () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      assert.equal(store.linkDecisions(999999, 1, "relates_to"), null);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  test("(handler-a) link from a missing decision returns ERROR, never success", async () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const out = await handleLinkDecisions(store, {
        from: 999999,
        to: 1,
        relation: "relates_to",
      });
      assert.match(out, /not found/i);
      assert.doesNotMatch(out, /^Linked:/);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  test("(b) throws when the linked row cannot be read back", () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const a = seedDecision(store, "p", { title: "A" });
      const b = seedDecision(store, "p", { title: "B" });
      let calls = 0;
      const realGet = store.getDecisionById.bind(store);
      store.getDecisionById = (id) => {
        calls += 1;
        return calls === 1 ? realGet(id) : undefined; // existence ok, read-back gone
      };
      assert.throws(
        () => store.linkDecisions(a.id, b.id, "relates_to"),
        (err) =>
          err instanceof AmplifierMutationError &&
          err.table === "decisions" &&
          err.operation === "linkDecisions",
      );
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  test("(guard) a real link succeeds and is idempotent", async () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const a = seedDecision(store, "p", { title: "A" });
      const b = seedDecision(store, "p", { title: "B" });
      const out = await handleLinkDecisions(store, {
        from: a.id,
        to: b.id,
        relation: "relates_to",
      });
      assert.match(out, /^Linked:/);
      // idempotent — second call still works, no duplicate
      const out2 = store.linkDecisions(a.id, b.id, "relates_to");
      assert.deepEqual(out2.related_decision_ids.relates_to, [b.id]);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });
});

// ---------------------------------------------------------------------------
// 6. verifyLesson  (amplify_verify_claim)
// ---------------------------------------------------------------------------

describe("verifyLesson rowcount verification (P0 #5)", () => {
  test("(a) missing id returns null (handler surfaces ERROR)", () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      assert.equal(
        store.verifyLesson(999999, "git_commit", "abc123"),
        null,
      );
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  test("(handler-a) verify a missing lesson returns ERROR, never success", async () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const out = await handleVerifyClaim(store, {
        id: 999999,
        evidence_type: "git_commit",
        evidence_link: "abc123",
      });
      assert.match(out, /not found/i);
      assert.doesNotMatch(out, /^Verification recorded/);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  test("(b) throws when the verified row cannot be read back", () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const l = seedLesson(store, "p", { verification_status: "claim" });
      store.getLessonById = () => undefined; // read-back after UPDATE fails
      assert.throws(
        () => store.verifyLesson(l.id, "git_commit", "abc123"),
        (err) =>
          err instanceof AmplifierMutationError &&
          err.table === "lessons" &&
          err.operation === "verifyLesson",
      );
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  test("(guard) a real verify promotes the claim and reads it back", async () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const l = seedLesson(store, "p", { verification_status: "claim" });
      const out = await handleVerifyClaim(store, {
        id: l.id,
        evidence_type: "git_commit",
        evidence_link: "abc123",
      });
      assert.match(out, /^Verification recorded/);
      assert.match(out, /Status: evidence/);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });
});

// ---------------------------------------------------------------------------
// 7. demoteLesson
// ---------------------------------------------------------------------------

describe("demoteLesson rowcount verification (P0 #5)", () => {
  test("(a) missing id returns null", () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      assert.equal(store.demoteLesson(999999), null);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  test("(b) throws when the demoted row cannot be read back", () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const l = seedLesson(store, "p");
      store.getLessonById = () => undefined; // read-back after UPDATE fails
      assert.throws(
        () => store.demoteLesson(l.id),
        (err) =>
          err instanceof AmplifierMutationError &&
          err.table === "lessons" &&
          err.operation === "demoteLesson",
      );
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  test("(guard) a real demote resets status to claim and reads it back", () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const l = seedLesson(store, "p", { verification_status: "confirmed" });
      const out = store.demoteLesson(l.id);
      assert.ok(out);
      assert.equal(out.verification_status, "claim");
      assert.equal(out.confidence, 0.5);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });
});
