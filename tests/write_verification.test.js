// v1.5.0 — write-verification tests.
//
// Past versions silently coerced a failed INSERT into an undefined Lesson
// using `getLessonById(rowid)!`. Callers stringified the result as
// "Lesson recorded (id: undefined)" — looked like a win, persisted nothing.
//
// These tests pin the new behaviour:
//   1. addLesson/addDecision throw AmplifierWriteError if the row cannot be
//      read back after INSERT.
//   2. handleLearn/handleDecisions catch that error and return a clear
//      ERROR-prefixed string instead of returning a fake success.
//   3. write-errors.jsonl gets an audit entry.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { SQLiteStore, AmplifierWriteError } from "../dist/storage.js";
import { handleLearn, handleDecisions } from "../dist/tools.js";

function tmpDbPath() {
  return path.join(
    os.tmpdir(),
    `amp-wv-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function tmpLogPath() {
  return path.join(
    os.tmpdir(),
    `amp-wv-errlog-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
}

/**
 * Stub a single store method so the post-INSERT read-back returns undefined,
 * simulating "INSERT reported success but row is gone".
 */
function stubReadBackToUndefined(store, methodName) {
  store[methodName] = () => undefined;
}

describe("AmplifierWriteError (v1.5.0)", () => {
  test("exposes table, project, title, and lastInsertRowid", () => {
    const err = new AmplifierWriteError({
      table: "lessons",
      project: "p",
      title: "Some lesson",
      lastInsertRowid: 42,
    });
    assert.equal(err.name, "AmplifierWriteError");
    assert.equal(err.table, "lessons");
    assert.equal(err.project, "p");
    assert.equal(err.title, "Some lesson");
    assert.equal(err.lastInsertRowid, 42);
    assert.match(err.message, /did not persist/);
    assert.match(err.message, /Some lesson/);
  });

  test("includes the custom cause when provided", () => {
    const err = new AmplifierWriteError({
      table: "decisions",
      project: "p",
      title: "T",
      lastInsertRowid: 7,
      cause: "disk full",
    });
    assert.match(err.message, /disk full/);
  });
});

describe("addLesson read-back verification (v1.5.0)", () => {
  test("throws AmplifierWriteError when row cannot be read back", () => {
    const dbPath = tmpDbPath();
    const logPath = tmpLogPath();
    process.env.AMPLIFIER_WRITE_ERRORS_LOG = logPath;
    const store = new SQLiteStore(dbPath);
    try {
      // Simulate: INSERT runs and returns a rowid, but getLessonById can't
      // find the row (e.g. database swapped, race condition, replica lag in
      // a hypothetical future setup).
      // SQLiteStore.getLessonById is private, so we reach in by name.
      stubReadBackToUndefined(store, "getLessonById");

      assert.throws(
        () =>
          store.addLesson({
            project: "p",
            type: "mistake",
            title: "Vanishing lesson",
            description: "INSERT ok but SELECT gone",
            severity: "high",
            tags: [],
          }),
        (err) => {
          assert.ok(err instanceof AmplifierWriteError);
          assert.equal(err.table, "lessons");
          assert.equal(err.project, "p");
          assert.equal(err.title, "Vanishing lesson");
          assert.ok(err.lastInsertRowid >= 1);
          return true;
        },
      );

      // Audit log got an entry
      const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.table, "lessons");
      assert.equal(entry.project, "p");
      assert.equal(entry.title, "Vanishing lesson");
      assert.match(entry.reason, /follow-up SELECT/);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
      try { fs.unlinkSync(logPath); } catch {}
      delete process.env.AMPLIFIER_WRITE_ERRORS_LOG;
    }
  });
});

describe("addDecision read-back verification (v1.5.0)", () => {
  test("throws AmplifierWriteError when row cannot be read back", () => {
    const dbPath = tmpDbPath();
    const logPath = tmpLogPath();
    process.env.AMPLIFIER_WRITE_ERRORS_LOG = logPath;
    const store = new SQLiteStore(dbPath);
    try {
      stubReadBackToUndefined(store, "getDecisionById");
      assert.throws(
        () =>
          store.addDecision({
            project: "p",
            category: "general",
            title: "Vanishing decision",
            description: "d",
            tags: [],
            status: "active",
          }),
        (err) => err instanceof AmplifierWriteError && err.table === "decisions",
      );

      const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.table, "decisions");
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
      try { fs.unlinkSync(logPath); } catch {}
      delete process.env.AMPLIFIER_WRITE_ERRORS_LOG;
    }
  });
});

describe("handleLearn surfaces failure as ERROR text (v1.5.0)", () => {
  test("returns ERROR string, never fake success, when read-back fails", async () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      stubReadBackToUndefined(store, "getLessonById");
      const out = await handleLearn(store, {
        project: "p",
        title: "T",
        description: "D",
        type: "insight",
        severity: "medium",
      });
      assert.match(out, /^ERROR: Lesson NOT recorded/);
      assert.match(out, /Do not claim this lesson was saved/);
      // The pre-v1.5.0 silent failure produced "Lesson recorded (id: undefined)"
      assert.doesNotMatch(out, /^Lesson recorded/);
      assert.doesNotMatch(out, /id: undefined/);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  test("happy path still returns Lesson recorded with numeric id", async () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const out = await handleLearn(store, {
        project: "p",
        title: "Real lesson",
        description: "D",
        type: "insight",
        severity: "medium",
      });
      assert.match(out, /^Lesson recorded \(id: \d+\)/);
      assert.doesNotMatch(out, /undefined/);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });
});

describe("handleDecisions track surfaces failure as ERROR text (v1.5.0)", () => {
  test("returns ERROR string when read-back fails", async () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      stubReadBackToUndefined(store, "getDecisionById");
      const out = await handleDecisions(store, {
        op: "track",
        project: "p",
        title: "T",
        description: "D",
      });
      assert.match(out, /^ERROR: Decision NOT recorded/);
      assert.match(out, /Do not claim this decision was saved/);
      assert.doesNotMatch(out, /^Decision recorded/);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });

  test("happy path returns Decision recorded with numeric id", async () => {
    const dbPath = tmpDbPath();
    const store = new SQLiteStore(dbPath);
    try {
      const out = await handleDecisions(store, {
        op: "track",
        project: "p",
        title: "Real decision",
        description: "D",
      });
      assert.match(out, /^Decision recorded \(id: \d+\)/);
      assert.doesNotMatch(out, /undefined/);
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    }
  });
});
