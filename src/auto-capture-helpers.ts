// ---------------------------------------------------------------------------
// auto-capture-helpers.ts — pure helpers for the v1.6.0 auto-capture tools.
// ---------------------------------------------------------------------------
//
// Ported from the chimera-prime fork's src/handlers/auto-capture.ts (Clasu,
// 2026-05-25). These are the small, deterministic, dependency-free building
// blocks shared by the four auto-capture handlers in tools.ts:
//
//   - similarity()          word-token Jaccard for dedup / near-duplicate scan
//   - slugifyPatternKey()   slug a title into a candidate pattern_key
//   - tsOf()                parse a lesson timestamp into epoch ms
//   - isoOf()               render a lesson timestamp as an ISO-ish string
//
// They live in their own module (rather than in tools.ts) so they can be unit
// tested in isolation and so the handler file stays focused on dispatch glue.
//
// NOTE on naming: the master codebase already exports a *trigram*-based
// `suggestPatternKey` from pattern_suggest.ts (used by amplify_suggest_pattern_key).
// The auto-capture port uses a *word-token* Jaccard `similarity` and a separate
// slug function, so the slug is named `slugifyPatternKey` to avoid colliding
// with that existing export.

/**
 * Cheap token-overlap similarity. No embeddings needed — just lowercase set
 * intersection over Jaccard. Surprisingly good for short titles.
 *
 * Tokens shorter than 3 characters are dropped (stop-word-ish noise filter),
 * matching the source implementation exactly. Two empty token sets → 0 (never
 * NaN).
 */
export function similarity(a: string, b: string): number {
  const tok = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );
  const A = tok(a);
  const B = tok(b);
  if (A.size === 0 || B.size === 0) return 0;
  let intersection = 0;
  for (const x of A) if (B.has(x)) intersection++;
  const union = A.size + B.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Slug-ify a title into a candidate pattern_key.
 * "Lumen2 ≠ Lumina nimenvalinnan jälkeen" → "lumen2-not-lumina-after-naming"
 *
 * Finnish vowels are folded (ä/Ä→a, ö/Ö→o, å/Å→a) BEFORE diacritics are
 * stripped, so Finnish lesson titles produce stable ASCII slugs. Capped at 6
 * words.
 */
export function slugifyPatternKey(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/[äÄ]/g, "a")
    .replace(/[öÖ]/g, "o")
    .replace(/[åÅ]/g, "a")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 6) // keep short
    .join("-")
    .replace(/-+/g, "-");
}

/**
 * Parse a lesson timestamp (created_at / updated_at) into epoch milliseconds.
 *
 * The master storage layer writes timestamps as "YYYY-MM-DD HH:MM:SS" (space
 * separator, no timezone — see storage.ts `now()`). To compare consistently
 * against `Date.now()` we normalise the space to "T" and append "Z" so the
 * value is read as UTC, matching the codebase's existing `recencyBonus`
 * convention. Numeric epochs and already-ISO strings are also accepted.
 *
 * Returns 0 for anything unparseable (defensive — never NaN).
 */
export function tsOf(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined || raw === "") return 0;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;

  const str = String(raw);
  // Normalise "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DD HH:MM:SSZ" as UTC.
  const normalized = str.includes("T") ? str : str.replace(" ", "T");
  const withZone = /[zZ]|[+-]\d\d:?\d\d$/.test(normalized)
    ? normalized
    : `${normalized}Z`;
  const ms = Date.parse(withZone);
  if (!Number.isNaN(ms)) return ms;

  // Last-ditch: let the Date constructor try the raw string.
  const fallback = new Date(str).getTime();
  return Number.isNaN(fallback) ? 0 : fallback;
}

/**
 * Render a lesson timestamp as a display string. Numeric epochs become ISO
 * strings; string timestamps are returned as-is (they're already human
 * readable). Empty/missing → "".
 */
export function isoOf(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined || raw === "") return "";
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? new Date(raw).toISOString() : "";
  }
  return String(raw);
}
