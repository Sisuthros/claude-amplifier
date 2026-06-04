// v1.5.1 — concurrency hardening.
//
// better-sqlite3 is fully synchronous. With WAL on, concurrent readers are
// fine, but two writers (Claude Desktop + Claude Code, or a SessionEnd hook
// firing while an interactive session writes) can collide on the same
// millisecond and throw SQLITE_BUSY. CLAUDE.md actively encourages a
// session-start hook, so concurrent processes are the expected case, not an
// edge case.
//
// The fix is a busy timeout: better-sqlite3 retries for up to N ms before
// giving up instead of throwing immediately. These tests assert the timeout
// is actually configured on the connection.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { SQLiteStore } from "../dist/storage.js";

describe("SQLite concurrency hardening (v1.5.1)", () => {
  test("connection has a non-zero busy_timeout configured", () => {
    const dir = mkdtempSync(join(tmpdir(), "amp-busy-"));
    const store = new SQLiteStore(join(dir, "amplifier.db"));
    try {
      // pragmas() exposes connection PRAGMA values for diagnostics (doctor).
      const value = store.pragmas().busy_timeout;
      assert.ok(
        typeof value === "number" && value >= 1000,
        `busy_timeout must be >= 1000ms, got ${value}`,
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("WAL mode is still enabled (regression guard)", () => {
    const dir = mkdtempSync(join(tmpdir(), "amp-wal-"));
    const store = new SQLiteStore(join(dir, "amplifier.db"));
    try {
      assert.equal(
        store.pragmas().journal_mode.toLowerCase(),
        "wal",
        "journal_mode should stay WAL",
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
