// v1.5.0 — stale-memory detection tests.
//
// The yesterday-incident: session 2026-05-25 had ~294 tool calls logged in
// memory/2026-05-25.md but never called amplify_learn / amplify_decisions.
// Next session loaded context, saw nothing, and didn't know to ask. These
// tests pin the new behaviour:
//
//   1. freshnessReport finds memory/<date>.md files newer than the latest
//      Amplifier write for a project.
//   2. handleContextLoad emits a ⚠ warning block when stale files exist.
//   3. handleAuditFreshness lists them in detail.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { SQLiteStore } from "../dist/storage.js";
import { freshnessReport, formatFreshnessWarning } from "../dist/freshness.js";
import { handleContextLoad, handleAuditFreshness } from "../dist/tools.js";

function tmpDbPath() {
  return path.join(
    os.tmpdir(),
    `amp-fresh-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function tmpMemoryDir() {
  const dir = path.join(
    os.tmpdir(),
    `amp-mem-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMemFile(dir, name, content = "x", mtime = null) {
  const full = path.join(dir, name);
  fs.writeFileSync(full, content);
  if (mtime) {
    fs.utimesSync(full, mtime, mtime);
  }
  return full;
}

function freshFixture() {
  const dbPath = tmpDbPath();
  const memDir = tmpMemoryDir();
  const store = new SQLiteStore(dbPath);
  return {
    store,
    memDir,
    cleanup: () => {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
      try { fs.rmSync(memDir, { recursive: true, force: true }); } catch {}
    },
  };
}

describe("freshnessReport (v1.5.0)", () => {
  test("returns memory_dir_missing when directory does not exist", () => {
    const { store, cleanup } = freshFixture();
    try {
      const report = freshnessReport(store, "p", {
        memory_dir: path.join(os.tmpdir(), "definitely-not-here-" + Date.now()),
      });
      assert.equal(report.memory_dir_missing, true);
      assert.equal(report.stale_files.length, 0);
    } finally {
      cleanup();
    }
  });

  test("with no Amplifier writes yet, all memory files are stale", () => {
    const { store, memDir, cleanup } = freshFixture();
    try {
      writeMemFile(memDir, "2026-05-25.md", "hello");
      writeMemFile(memDir, "2026-05-26.md", "world");
      writeMemFile(memDir, "not-a-date.md", "ignored");
      const report = freshnessReport(store, "p", { memory_dir: memDir });
      assert.equal(report.memory_dir_missing, false);
      assert.equal(report.latest_amplifier_write, null);
      assert.equal(report.stale_files.length, 2);
      const dates = report.stale_files.map((f) => f.date).sort();
      assert.deepEqual(dates, ["2026-05-25", "2026-05-26"]);
    } finally {
      cleanup();
    }
  });

  test("only files newer than latest Amplifier write count as stale", () => {
    const { store, memDir, cleanup } = freshFixture();
    try {
      // Older memory file (mtime in the past)
      const past = new Date("2026-05-20T10:00:00Z");
      writeMemFile(memDir, "2026-05-20.md", "old", past);

      // Record an Amplifier write — this resets the baseline. Sleep one
      // SQLite-clock-tick because amplify writes use second-resolution now().
      store.addLesson({
        project: "p",
        type: "insight",
        title: "Baseline",
        description: "Recorded after the old memory file",
        severity: "low",
        tags: [],
      });

      // Now write a NEW memory file with mtime in the future. We can't reliably
      // sleep for SQLite to advance, so we set mtime explicitly into the future.
      const future = new Date(Date.now() + 60_000);
      writeMemFile(memDir, "2026-05-26.md", "new", future);

      const report = freshnessReport(store, "p", { memory_dir: memDir });
      assert.ok(report.latest_amplifier_write, "should have a baseline write");
      const stale = report.stale_files.map((f) => f.date);
      assert.deepEqual(stale, ["2026-05-26"]);
    } finally {
      cleanup();
    }
  });

  test("ignores files that don't match YYYY-MM-DD.md naming", () => {
    const { store, memDir, cleanup } = freshFixture();
    try {
      writeMemFile(memDir, "README.md", "x");
      writeMemFile(memDir, "scratch.md", "x");
      writeMemFile(memDir, "20260526.md", "wrong format");
      writeMemFile(memDir, "2026-05-26.md", "ok");
      writeMemFile(memDir, "2026-05-26-clasu-lessons.md", "ok with suffix");
      const report = freshnessReport(store, "p", { memory_dir: memDir });
      const dates = report.stale_files.map((f) => f.date).sort();
      assert.deepEqual(dates, ["2026-05-26", "2026-05-26"]);
    } finally {
      cleanup();
    }
  });
});

describe("formatFreshnessWarning (v1.5.0)", () => {
  test("returns null when nothing is stale", () => {
    const out = formatFreshnessWarning({
      project: "p",
      memory_dir: "/m",
      latest_amplifier_write: "2026-05-26 12:00:00",
      stale_files: [],
      memory_dir_missing: false,
    });
    assert.equal(out, null);
  });

  test("returns null when memory dir is missing (not a warning case)", () => {
    const out = formatFreshnessWarning({
      project: "p",
      memory_dir: "/m",
      latest_amplifier_write: null,
      stale_files: [],
      memory_dir_missing: true,
    });
    assert.equal(out, null);
  });

  test("warns and lists up to 5 recent files", () => {
    const stale = Array.from({ length: 7 }, (_, i) => ({
      path: `/m/2026-05-${20 + i}.md`,
      date: `2026-05-${String(20 + i).padStart(2, "0")}`,
      mtime: `2026-05-${String(20 + i).padStart(2, "0")}T10:00:00.000Z`,
      size_bytes: 1024 * (i + 1),
    }));
    const out = formatFreshnessWarning({
      project: "p",
      memory_dir: "/m",
      latest_amplifier_write: "2026-05-19 10:00:00",
      stale_files: stale,
      memory_dir_missing: false,
    });
    assert.match(out, /Stale memory files — 7 newer/);
    assert.match(out, /Latest Amplifier write: 2026-05-19/);
    assert.match(out, /and 2 more/);
    assert.match(out, /amplify_audit_freshness/);
  });
});

describe("handleContextLoad emits stale warning (v1.5.0)", () => {
  test("warning appears in context_load output when memory files are unrecorded", async () => {
    const { store, memDir, cleanup } = freshFixture();
    try {
      writeMemFile(memDir, "2026-05-25.md", "hours of work");
      process.env.CLAUDE_AMPLIFIER_MEMORY_DIR = memDir;
      const out = await handleContextLoad(store, { project: "p" });
      delete process.env.CLAUDE_AMPLIFIER_MEMORY_DIR;
      assert.match(out, /Stale memory files/);
      assert.match(out, /2026-05-25/);
    } finally {
      try { delete process.env.CLAUDE_AMPLIFIER_MEMORY_DIR; } catch {}
      cleanup();
    }
  });

  test("warning is absent when memory dir is missing", async () => {
    const { store, cleanup } = freshFixture();
    try {
      process.env.CLAUDE_AMPLIFIER_MEMORY_DIR = path.join(os.tmpdir(), "no-such-" + Date.now());
      const out = await handleContextLoad(store, { project: "p" });
      delete process.env.CLAUDE_AMPLIFIER_MEMORY_DIR;
      assert.doesNotMatch(out, /Stale memory files/);
    } finally {
      try { delete process.env.CLAUDE_AMPLIFIER_MEMORY_DIR; } catch {}
      cleanup();
    }
  });
});

describe("handleAuditFreshness tool (v1.5.0)", () => {
  test("requires project or project_path", async () => {
    const { store, cleanup } = freshFixture();
    try {
      const out = await handleAuditFreshness(store, {});
      assert.match(out, /Error: provide 'project' or 'project_path'/);
    } finally {
      cleanup();
    }
  });

  test("reports clean state when nothing is stale", async () => {
    const { store, memDir, cleanup } = freshFixture();
    try {
      // Record amplifier write, no memory files newer than that
      store.addLesson({
        project: "p",
        type: "insight",
        title: "Hi",
        description: "d",
        severity: "low",
        tags: [],
      });
      const out = await handleAuditFreshness(store, {
        project: "p",
        memory_dir: memDir,
      });
      assert.match(out, /All memory files for project "p" are older/);
    } finally {
      cleanup();
    }
  });

  test("lists stale files in oldest-first order", async () => {
    const { store, memDir, cleanup } = freshFixture();
    try {
      writeMemFile(memDir, "2026-05-25.md", "older");
      // Tiny sleep substitute: set explicit mtimes
      const t1 = new Date(Date.now() - 1000);
      const t2 = new Date(Date.now());
      fs.utimesSync(path.join(memDir, "2026-05-25.md"), t1, t1);
      writeMemFile(memDir, "2026-05-26.md", "newer", t2);

      const out = await handleAuditFreshness(store, {
        project: "p",
        memory_dir: memDir,
      });
      assert.match(out, /Stale memory files for project "p"/);
      assert.match(out, /Stale count: 2/);
      // Oldest first
      const idx25 = out.indexOf("2026-05-25.md");
      const idx26 = out.indexOf("2026-05-26.md");
      assert.ok(idx25 < idx26, "older file should appear first");
    } finally {
      cleanup();
    }
  });

  test("explains when memory dir is missing", async () => {
    const { store, cleanup } = freshFixture();
    try {
      const missing = path.join(os.tmpdir(), "amp-nodir-" + Date.now());
      const out = await handleAuditFreshness(store, {
        project: "p",
        memory_dir: missing,
      });
      assert.match(out, /Memory directory not found/);
    } finally {
      cleanup();
    }
  });
});
