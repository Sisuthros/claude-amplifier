// v1.5.0 — pattern_key suggester.
//
// pattern_key is the v1.2.0 mechanism that aggregates "same lesson worded
// differently" into one row with a frequency counter. It only works if both
// callers pick the same key. Two sessions writing
//   pattern_key="save-findings-to-amplifier"
//   pattern_key="record-big-insights-in-session"
// for what is conceptually the same lesson produces two rows with frequency=1
// each, defeating the pattern detector.
//
// This module proposes existing pattern_keys for a new lesson based on
// trigram similarity against the lesson's title+description. No embeddings,
// no extra deps — trigrams are coarse but good enough for "did someone
// already coin a key for this?".

import type { SQLiteStore } from "./storage.js";

export interface PatternSuggestion {
  pattern_key: string;
  similarity: number;
  /** How many existing lessons currently use this key. */
  existing_frequency: number;
  /** Sample title from one of those lessons (helps Claude decide). */
  example_title: string;
}

export interface SuggestResult {
  /** Top existing pattern_keys ranked by similarity (similarity ≥ MIN_SIMILARITY). */
  matches: PatternSuggestion[];
  /** Suggested new key if no existing match clears the threshold; otherwise null. */
  proposed_new_key: string | null;
  /** Threshold used. Exposed so callers can explain why nothing matched. */
  min_similarity: number;
}

// Trigram Jaccard is strict: synonyms like "verify"/"confirm" or "save"/"persist"
// produce surprisingly low scores even when the meaning is identical. 0.3 was
// chosen empirically — high enough to reject unrelated topics, low enough to
// catch real rewordings ("Amplifier write verification" vs "Verify Amplifier
// write success" scores around 0.4).
const MIN_SIMILARITY = 0.3;
const MAX_RESULTS = 3;

/**
 * Build a set of character trigrams from a normalised string. Lowercase,
 * collapse whitespace, drop most punctuation. Trigrams handle both small
 * spelling variations and partial overlap better than word-token Jaccard.
 */
function trigrams(text: string): Set<string> {
  const norm = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const padded = `  ${norm}  `;
  const grams = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) {
    grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

/**
 * Jaccard similarity between two trigram sets — |A∩B| / |A∪B|.
 * Returns 0 when both are empty (avoid NaN).
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Render a probable new pattern_key from a title. Lowercases, keeps letters
 * and digits, joins with hyphens, caps at 5 words / 50 chars. Deliberately
 * boring — the value of pattern_key is that it groups things, not that it's
 * clever.
 */
export function proposePatternKey(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  let key = words.join("-").slice(0, 50);
  if (!key) key = "lesson";
  // Trim trailing hyphen if slice cut mid-word
  return key.replace(/-+$/, "");
}

interface ExistingKeyRow {
  pattern_key: string;
  total_frequency: number;
  example_title: string;
  combined_text: string;
}

/**
 * Pull all pattern_keys for a project plus a representative title and the
 * concatenated text of lessons using each key. Used as the corpus for
 * trigram comparison.
 */
function fetchExistingKeys(
  store: SQLiteStore,
  project: string,
): ExistingKeyRow[] {
  const db = (store as unknown as { db: any }).db;
  if (!db) return [];
  const rows = db
    .prepare(
      `SELECT pattern_key,
              SUM(frequency) AS total_frequency,
              MIN(title) AS example_title,
              GROUP_CONCAT(title || ' ' || COALESCE(description, ''), ' || ') AS combined_text
         FROM lessons
        WHERE project = ? AND pattern_key IS NOT NULL AND pattern_key != ''
        GROUP BY pattern_key`,
    )
    .all(project) as any[];
  return rows.map((r) => ({
    pattern_key: String(r.pattern_key),
    total_frequency: Number(r.total_frequency ?? 1),
    example_title: String(r.example_title ?? ""),
    combined_text: String(r.combined_text ?? ""),
  }));
}

/**
 * Rank existing pattern_keys by similarity against the new lesson text.
 * Returns matches above MIN_SIMILARITY, plus a fallback proposed key if
 * nothing clears the bar.
 */
export function suggestPatternKey(
  store: SQLiteStore,
  project: string,
  title: string,
  description: string,
): SuggestResult {
  const incoming = trigrams(`${title} ${description}`);
  const existing = fetchExistingKeys(store, project);

  const scored = existing.map((row) => {
    const corpus = `${row.pattern_key} ${row.combined_text}`;
    const sim = jaccard(incoming, trigrams(corpus));
    return {
      pattern_key: row.pattern_key,
      similarity: Number(sim.toFixed(3)),
      existing_frequency: row.total_frequency,
      example_title: row.example_title,
    };
  });

  scored.sort((a, b) => b.similarity - a.similarity);
  const matches = scored
    .filter((s) => s.similarity >= MIN_SIMILARITY)
    .slice(0, MAX_RESULTS);

  const proposed_new_key =
    matches.length === 0 ? proposePatternKey(title) : null;

  return {
    matches,
    proposed_new_key,
    min_similarity: MIN_SIMILARITY,
  };
}
