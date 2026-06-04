// v1.5.1 — UTF-8-aware token estimate.
//
// The old estimate (text.length / 4) counts JS string *code units*, which
// badly under-counts multi-byte content: Finnish "ä/ö", emoji, CJK, and long
// code paths all eat more tokens than their .length suggests. Under-counting
// is the dangerous direction — it lets context_load overfill the budget and
// blow the window. Counting UTF-8 *bytes* / 4 is still dependency-free but
// tracks real tokenization far better for non-ASCII text.
//
// We don't assert exact token counts (that needs a real tokenizer); we assert
// the estimator no longer under-counts heavy multi-byte text, and stays sane
// for ASCII.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { estimateTokens } from "../dist/tools.js";

describe("estimateTokens UTF-8 awareness (v1.5.1)", () => {
  test("empty string is 0", () => {
    assert.equal(estimateTokens(""), 0);
  });

  test("plain ASCII stays ~length/4 (no regression)", () => {
    const ascii = "a".repeat(40); // 40 bytes
    assert.equal(estimateTokens(ascii), 10);
  });

  test("multi-byte text estimates HIGHER than naive length/4", () => {
    // Finnish: every ä/ö is 2 UTF-8 bytes. "ääöö" = 4 chars, 8 bytes.
    const finnish = "ääöö".repeat(10); // 40 chars, 80 bytes
    const naive = Math.ceil(40 / 4); // old behaviour = 10
    assert.ok(
      estimateTokens(finnish) > naive,
      `multi-byte estimate ${estimateTokens(finnish)} must exceed naive ${naive}`,
    );
  });

  test("emoji is not under-counted to near-zero", () => {
    // A 4-byte emoji is length 2 in JS; naive/4 would round it to ~1 token
    // for many emoji, wildly under-counting. Byte-based keeps it honest.
    const emoji = "🚀".repeat(10); // 20 code units, 40 bytes
    assert.ok(
      estimateTokens(emoji) >= 10,
      `emoji estimate ${estimateTokens(emoji)} should reflect byte weight`,
    );
  });
});
