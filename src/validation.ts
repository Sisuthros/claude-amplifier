// ---------------------------------------------------------------------------
// P1 #7 — lightweight, dependency-free input validation helpers
// ---------------------------------------------------------------------------
//
// These are small PURE functions used at the top of the write-path handlers
// (handleLearn, handleRecordClaim, handleVerifyClaim, handleDecisions,
// handleLinkDecisions). They replace ad-hoc `String(args.x ?? "")` coercions
// and scattered `!x` checks with one place that either returns a typed,
// normalized value or throws a clear `ValidationError`.
//
// DELIBERATELY no Zod / TypeBox / schema library. The product's differentiator
// is "2 runtime deps, local-first" — adding a validation library would break
// that positioning. These helpers are ~100 lines of plain TypeScript with no
// I/O, no wall-clock, and no randomness, so they are trivially testable and
// deterministic.
//
// Back-compat is the hard constraint: the accepted INPUT shape must not change.
// The MCP layer historically passed ids as strings (`Number(args.id)`) and tags
// as either arrays, JSON-array strings, or comma-separated strings. Every helper
// here accepts exactly those shapes so wiring them into the handlers cannot
// reject input the handlers previously accepted.

/** Thrown when a tool argument fails validation. Carries the field name. */
export class ValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

/**
 * Validate that `value` is (or coerces to) a positive integer.
 *
 * Accepts a number or a numeric string (the MCP layer passes ids as strings).
 * Rejects 0, negatives, non-integers (2.5), NaN, non-numeric strings, and
 * null/undefined/empty. Returns the value as a `number`.
 */
export function validateId(value: unknown, field: string): number {
  if (value === undefined || value === null || value === "") {
    throw new ValidationError(field, `'${field}' is required and must be a positive integer.`);
  }

  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    // Reject strings that aren't purely a number (e.g. "12abc", "  ", "abc").
    const trimmed = value.trim();
    if (trimmed === "" || !/^[+-]?\d+$/.test(trimmed)) {
      throw new ValidationError(field, `'${field}' must be a positive integer (got "${value}").`);
    }
    n = Number(trimmed);
  } else {
    throw new ValidationError(field, `'${field}' must be a positive integer.`);
  }

  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError(field, `'${field}' must be a positive integer (got ${n}).`);
  }
  return n;
}

/**
 * Like {@link validateId} but returns `undefined` when the value is absent
 * (undefined / null / empty string). A value that IS present but invalid still
 * throws — absence is optional, garbage is not.
 */
export function validateOptionalId(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return validateId(value, field);
}

/**
 * Validate that `value` is one of `allowed`. Returns the value typed as a member
 * of the union `T`. When `value` is absent (undefined / null / empty string)
 * and a `fallback` is given, the fallback is returned. A PRESENT-but-invalid
 * value always throws — the fallback never masks a typo.
 */
export function validateEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  fallback?: T,
): T {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback;
    throw new ValidationError(
      field,
      `'${field}' is required and must be one of: ${allowed.join(", ")}.`,
    );
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ValidationError(
      field,
      `'${field}' must be one of: ${allowed.join(", ")} (got "${String(value)}").`,
    );
  }
  return value as T;
}

/**
 * Validate that `value` is a non-empty string. Returns the trimmed string.
 * Rejects "", whitespace-only, non-strings, and null/undefined.
 */
export function validateRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ValidationError(field, `'${field}' is required and must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new ValidationError(field, `'${field}' is required and must be a non-empty string.`);
  }
  return trimmed;
}

/**
 * Normalize a "string array"-ish argument into `string[]`.
 *
 * Matches the long-standing `parseTags` semantics so wiring this in never
 * changes accepted input:
 *   - undefined / null            → []
 *   - an array                    → members stringified, empties dropped
 *   - a JSON-array string         → parsed, members stringified
 *   - a comma-separated string    → split, trimmed, empties dropped
 *   - any other single string     → [that string]
 *
 * A non-array, non-string object (which `parseTags` would silently turn into
 * []) is rejected here — that shape is almost always a caller bug, and the
 * write-path callers never legitimately pass it.
 */
export function validateStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];

  if (Array.isArray(value)) {
    return value.map(String).map((s) => s.trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    const raw = value;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(String).map((s) => s.trim()).filter(Boolean);
      }
      // JSON parsed but wasn't an array (e.g. a quoted scalar) — treat the
      // original string as a single element, same as parseTags.
      return [raw];
    } catch {
      return raw
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }
  }

  throw new ValidationError(
    field,
    `'${field}' must be a string array, a JSON-array string, or a comma-separated string.`,
  );
}

/** The three relation buckets a decision knowledge-graph link can use. */
export const RELATION_KEYS = ["triggered_by", "caused", "relates_to"] as const;
export type RelationKey = (typeof RELATION_KEYS)[number];
export type Relations = Partial<Record<RelationKey, number[]>>;

/**
 * Validate a relations payload of shape
 *   { triggered_by?: number[]; caused?: number[]; relates_to?: number[] }.
 *
 * Returns `undefined` when absent. Otherwise:
 *   - the input must be a plain (non-array) object,
 *   - every key must be one of RELATION_KEYS,
 *   - every value must be an array of positive-integer ids (numeric strings are
 *     coerced, matching the rest of the MCP layer).
 * Anything else throws a ValidationError naming the offending relation.
 */
export function validateRelations(value: unknown, field: string): Relations | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(
      field,
      `'${field}' must be an object like { triggered_by: [...], caused: [...], relates_to: [...] }.`,
    );
  }

  const out: Relations = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!RELATION_KEYS.includes(key as RelationKey)) {
      throw new ValidationError(
        field,
        `'${field}' has unknown relation key "${key}". Allowed: ${RELATION_KEYS.join(", ")}.`,
      );
    }
    if (!Array.isArray(raw)) {
      throw new ValidationError(
        field,
        `'${field}' relation "${key}" must be an array of decision ids.`,
      );
    }
    out[key as RelationKey] = raw.map((item, i) => {
      try {
        return validateId(item, `${field}.${key}[${i}]`);
      } catch {
        // Re-throw attributing to the top-level field + relation key so the
        // handler's caller sees a clear "'relations' relation caused ..." error
        // rather than a deeply-nested internal field name.
        throw new ValidationError(
          field,
          `'${field}' relation "${key}" must contain only positive-integer ids (bad value at index ${i}: ${JSON.stringify(item)}).`,
        );
      }
    });
  }
  return out;
}
