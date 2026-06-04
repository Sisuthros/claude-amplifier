// v1.5.1 — safe BigInt -> number conversion for SQLite rowids.
//
// better-sqlite3 returns lastInsertRowid as a BigInt. Blindly doing
// Number(bigint) silently loses precision above 2^53. In a local lessons DB
// that ceiling is astronomically far away, but "silently returns a wrong id"
// is exactly the class of bug this tool exists to prevent — so the conversion
// throws loudly instead of truncating quietly.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { safeRowid } from "../dist/storage.js";

describe("safeRowid (v1.5.1)", () => {
  test("passes through a normal small rowid", () => {
    assert.equal(safeRowid(42n), 42);
    assert.equal(safeRowid(1n), 1);
  });

  test("accepts a plain number too (defensive)", () => {
    assert.equal(safeRowid(7), 7);
  });

  test("throws — does NOT silently truncate — above MAX_SAFE_INTEGER", () => {
    const tooBig = BigInt(Number.MAX_SAFE_INTEGER) + 10n;
    assert.throws(
      () => safeRowid(tooBig),
      /rowid .* exceeds.*safe integer/i,
      "must throw rather than return a precision-lost number",
    );
  });

  test("accepts exactly MAX_SAFE_INTEGER (boundary)", () => {
    assert.equal(safeRowid(BigInt(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  });
});
