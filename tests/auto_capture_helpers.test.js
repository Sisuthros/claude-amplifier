// v1.6.0 — unit tests for the pure auto-capture helpers.
//
// These functions are dependency-free (no I/O, no wall-clock except tsOf which
// only parses), so they are tested in isolation here. The handler-level
// behavior (capture/dedup/recent/decay) lives in auto_capture_tools.test.js.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  similarity,
  slugifyPatternKey,
  tsOf,
  isoOf,
} from "../dist/auto-capture-helpers.js";

describe("auto-capture-helpers — similarity()", () => {
  test("identical strings score 1", () => {
    assert.equal(similarity("read docs before coding", "read docs before coding"), 1);
  });

  test("fully disjoint token sets score 0", () => {
    assert.equal(similarity("alpha beta gamma", "delta epsilon zeta"), 0);
  });

  test("empty / all-short-token input scores 0 (no NaN)", () => {
    assert.equal(similarity("", "anything here"), 0);
    // "a", "b", "of" are all <=2 chars and dropped → empty set → 0.
    assert.equal(similarity("a b of", "read docs"), 0);
  });

  test("tokens of length <= 2 are dropped", () => {
    // "is", "to" dropped; only "verify" overlaps.
    const s = similarity("verify is to", "verify to is");
    assert.equal(s, 1, "only 'verify' survives in both → identical sets");
  });

  test("is case-insensitive and ignores punctuation", () => {
    assert.ok(similarity("Read, Docs!", "read docs") >= 0.99);
  });

  test("partial overlap is between 0 and 1", () => {
    const s = similarity("read docs before coding", "read docs after lunch");
    assert.ok(s > 0 && s < 1, `expected fractional, got ${s}`);
  });
});

describe("auto-capture-helpers — slugifyPatternKey()", () => {
  test("folds Finnish vowels ä/ö/å → a/o/a", () => {
    assert.equal(slugifyPatternKey("älä jätä tää"), "ala-jata-taa");
  });

  test("strips diacritics", () => {
    assert.equal(slugifyPatternKey("café résumé"), "cafe-resume");
  });

  test("caps at 6 words and lowercases", () => {
    assert.equal(
      slugifyPatternKey("One Two Three Four Five Six Seven Eight"),
      "one-two-three-four-five-six",
    );
  });

  test("collapses repeated hyphens", () => {
    assert.equal(slugifyPatternKey("a  --  b"), "a-b");
  });
});

describe("auto-capture-helpers — tsOf() / isoOf()", () => {
  test("parses the storage 'YYYY-MM-DD HH:MM:SS' format (as UTC)", () => {
    const ms = tsOf("2026-06-23 12:00:00");
    assert.equal(ms, Date.parse("2026-06-23T12:00:00Z"));
  });

  test("parses an ISO string", () => {
    const ms = tsOf("2026-06-23T12:00:00Z");
    assert.equal(ms, Date.parse("2026-06-23T12:00:00Z"));
  });

  test("space and ISO formats for the same instant agree", () => {
    assert.equal(tsOf("2026-06-23 12:00:00"), tsOf("2026-06-23T12:00:00Z"));
  });

  test("accepts a numeric epoch", () => {
    assert.equal(tsOf(1750680000000), 1750680000000);
  });

  test("garbage / empty input returns 0, never NaN", () => {
    assert.equal(tsOf("not-a-date"), 0);
    assert.equal(tsOf(""), 0);
    assert.equal(tsOf(null), 0);
    assert.equal(tsOf(undefined), 0);
    assert.ok(!Number.isNaN(tsOf("garbage")));
  });

  test("isoOf passes string timestamps through and renders numbers", () => {
    assert.equal(isoOf("2026-06-23 12:00:00"), "2026-06-23 12:00:00");
    assert.equal(isoOf(0), new Date(0).toISOString());
    assert.equal(isoOf(""), "");
    assert.equal(isoOf(null), "");
  });
});
