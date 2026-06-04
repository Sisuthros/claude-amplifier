// P1 #7 — lightweight validation helpers (NO new dependency).
//
// src/validation.ts provides small PURE helpers used at the top of the
// write-path handlers (handleLearn, handleRecordClaim, handleVerifyClaim,
// handleDecisions, handleLinkDecisions). Each helper either returns a typed,
// normalized value or throws a clear Error — no Zod, no schema library, no I/O,
// no wall-clock, no randomness. These tests pin every helper's valid AND
// invalid behavior so a silent regression (e.g. an id of 0 or "" slipping
// through as a real id, or an enum typo being accepted) is caught.
//
// design-memory-eval discipline:
//   - deterministic fixtures (plain literals, no clock/network),
//   - assert BOTH the returned value AND the thrown Error message text,
//   - false-positive guards: each "accepts" case proves the helper does NOT
//     over-reject legitimate input.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  validateId,
  validateOptionalId,
  validateEnum,
  validateRequiredString,
  validateStringArray,
  validateRelations,
  ValidationError,
} from "../dist/validation.js";

describe("validateId (positive integer)", () => {
  test("accepts a positive integer number", () => {
    assert.equal(validateId(42, "id"), 42);
    assert.equal(validateId(1, "id"), 1);
  });

  test("accepts a numeric string and coerces to number (back-compat)", () => {
    // The MCP layer historically passed ids as strings (Number(args.id)).
    assert.equal(validateId("7", "id"), 7);
    assert.equal(validateId("100", "from"), 100);
  });

  test("throws ValidationError on zero", () => {
    assert.throws(
      () => validateId(0, "id"),
      (err) =>
        err instanceof ValidationError && /'id'.*positive integer/i.test(err.message),
    );
  });

  test("throws on negative", () => {
    assert.throws(() => validateId(-3, "id"), /'id'.*positive integer/i);
  });

  test("throws on a non-integer float", () => {
    assert.throws(() => validateId(2.5, "id"), /'id'.*positive integer/i);
  });

  test("throws on a non-numeric string", () => {
    assert.throws(() => validateId("abc", "id"), /'id'.*positive integer/i);
  });

  test("throws on null / undefined / empty", () => {
    assert.throws(() => validateId(undefined, "id"), /'id'/);
    assert.throws(() => validateId(null, "id"), /'id'/);
    assert.throws(() => validateId("", "id"), /'id'/);
  });

  test("error message names the field that was passed", () => {
    assert.throws(() => validateId(0, "from"), /'from'/);
  });
});

describe("validateOptionalId", () => {
  test("returns undefined for missing values (undefined / null / empty string)", () => {
    assert.equal(validateOptionalId(undefined, "supersedes"), undefined);
    assert.equal(validateOptionalId(null, "supersedes"), undefined);
    assert.equal(validateOptionalId("", "supersedes"), undefined);
  });

  test("validates when a value IS present", () => {
    assert.equal(validateOptionalId("12", "supersedes"), 12);
    assert.equal(validateOptionalId(5, "supersedes"), 5);
  });

  test("false-positive guard: a present-but-invalid id still throws", () => {
    assert.throws(
      () => validateOptionalId(0, "supersedes"),
      /'supersedes'.*positive integer/i,
    );
    assert.throws(() => validateOptionalId("nope", "supersedes"), /'supersedes'/);
  });
});

describe("validateEnum (value in allowed set)", () => {
  const TYPES = ["mistake", "success", "insight", "warning"];

  test("accepts a value in the allowed set and returns it typed", () => {
    assert.equal(validateEnum("success", TYPES, "type"), "success");
    assert.equal(validateEnum("warning", TYPES, "type"), "warning");
  });

  test("throws on a value NOT in the set, listing the allowed values", () => {
    assert.throws(
      () => validateEnum("build_passed", TYPES, "type"),
      (err) =>
        err instanceof ValidationError &&
        /'type'/.test(err.message) &&
        /mistake, success, insight, warning/.test(err.message),
    );
  });

  test("throws on undefined / empty", () => {
    assert.throws(() => validateEnum(undefined, TYPES, "type"), /'type'/);
    assert.throws(() => validateEnum("", TYPES, "type"), /'type'/);
  });

  test("supports an optional default for a missing value", () => {
    assert.equal(validateEnum(undefined, TYPES, "type", "insight"), "insight");
    assert.equal(validateEnum("", TYPES, "type", "insight"), "insight");
    // false-positive guard: a PRESENT but invalid value is NOT silently
    // replaced by the default — it still throws.
    assert.throws(() => validateEnum("bogus", TYPES, "type", "insight"), /'type'/);
  });
});

describe("validateRequiredString (non-empty string)", () => {
  test("accepts and trims a non-empty string", () => {
    assert.equal(validateRequiredString("hello", "title"), "hello");
    assert.equal(validateRequiredString("  spaced  ", "title"), "spaced");
  });

  test("throws on empty string / whitespace-only", () => {
    assert.throws(
      () => validateRequiredString("", "title"),
      (err) => err instanceof ValidationError && /'title'.*required/i.test(err.message),
    );
    assert.throws(() => validateRequiredString("   ", "title"), /'title'.*required/i);
  });

  test("throws on undefined / null / non-string", () => {
    assert.throws(() => validateRequiredString(undefined, "project"), /'project'/);
    assert.throws(() => validateRequiredString(null, "project"), /'project'/);
    assert.throws(() => validateRequiredString(123, "project"), /'project'/);
  });
});

describe("validateStringArray", () => {
  test("returns [] for missing input (undefined / null)", () => {
    assert.deepEqual(validateStringArray(undefined, "tags"), []);
    assert.deepEqual(validateStringArray(null, "tags"), []);
  });

  test("passes through an array of strings", () => {
    assert.deepEqual(validateStringArray(["a", "b"], "tags"), ["a", "b"]);
  });

  test("coerces array members to strings and drops empties", () => {
    assert.deepEqual(validateStringArray(["a", 2, "", "  "], "tags"), ["a", "2"]);
  });

  test("parses a JSON-array string", () => {
    assert.deepEqual(validateStringArray('["x","y"]', "tags"), ["x", "y"]);
  });

  test("splits a comma-separated string", () => {
    assert.deepEqual(validateStringArray("x, y ,z", "tags"), ["x", "y", "z"]);
  });

  test("false-positive guard: a single non-JSON, non-comma string is one element", () => {
    assert.deepEqual(validateStringArray("solo", "tags"), ["solo"]);
  });

  test("throws on a non-array object (not a coercible shape)", () => {
    assert.throws(
      () => validateStringArray({ not: "an array" }, "tags"),
      (err) => err instanceof ValidationError && /'tags'/.test(err.message),
    );
  });
});

describe("validateRelations ({triggered_by?,caused?,relates_to?})", () => {
  test("returns undefined for missing input", () => {
    assert.equal(validateRelations(undefined, "relations"), undefined);
    assert.equal(validateRelations(null, "relations"), undefined);
  });

  test("accepts a valid relations payload and returns it normalized", () => {
    const rel = { triggered_by: [1, 2], caused: [3], relates_to: [] };
    assert.deepEqual(validateRelations(rel, "relations"), {
      triggered_by: [1, 2],
      caused: [3],
      relates_to: [],
    });
  });

  test("accepts a partial payload (only some relation keys)", () => {
    assert.deepEqual(validateRelations({ caused: [9] }, "relations"), {
      caused: [9],
    });
  });

  test("coerces numeric-string ids inside relation arrays", () => {
    assert.deepEqual(
      validateRelations({ relates_to: ["4", "5"] }, "relations"),
      { relates_to: [4, 5] },
    );
  });

  test("throws on an unknown relation key", () => {
    assert.throws(
      () => validateRelations({ bogus_relation: [1] }, "relations"),
      (err) =>
        err instanceof ValidationError &&
        /'relations'/.test(err.message) &&
        /bogus_relation|triggered_by/.test(err.message),
    );
  });

  test("throws when a relation value is not an array", () => {
    assert.throws(
      () => validateRelations({ caused: 5 }, "relations"),
      /'relations'.*caused.*array/i,
    );
  });

  test("throws when a relation array contains an invalid id", () => {
    assert.throws(
      () => validateRelations({ caused: [0] }, "relations"),
      /'relations'.*caused/i,
    );
    assert.throws(
      () => validateRelations({ triggered_by: ["x"] }, "relations"),
      /'relations'.*triggered_by/i,
    );
  });

  test("throws when input is not an object (e.g. array or string)", () => {
    assert.throws(() => validateRelations([1, 2], "relations"), /'relations'/);
    assert.throws(() => validateRelations("nope", "relations"), /'relations'/);
  });
});
