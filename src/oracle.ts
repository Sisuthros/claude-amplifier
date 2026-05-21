/**
 * Pattern Oracle — Amplifier 1.4.0
 *
 * Given a prompt and project context, scans stored lessons, decisions and
 * patterns to identify failure modes that have happened before. Returns a
 * structured risk assessment plus human-readable advice.
 *
 * Pure module — no I/O of its own. The caller passes in everything it needs.
 * That makes it trivial to unit-test and keeps the SQLite layer reusable.
 *
 * Scoring (per design doc 2026-05-21):
 *
 *   score = Σ pattern.frequency * pattern.confidence * weight(status)
 *   weight: confirmed=1.0, evidence=0.6, claim=0.2
 *
 *   risk: score<1.0 low, <3.0 medium, <6.0 high, ≥6.0 critical
 *
 * Threshold values are env-tunable via AMPLIFIER_ORACLE_THRESHOLD_*.
 */

import type { Lesson, Decision } from "./storage.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreflightInput {
  project: string;
  prompt: string;
  context?: string;
  /** All candidate lessons (preferably from getAllLessonsForProject + globals). */
  candidateLessons: Lesson[];
  /** Active decisions for the project; oracle weighs them in. */
  candidateDecisions: Decision[];
  /**
   * v1.5 prototype: pre-computed semantic scores per (kind, refId).
   * When the caller has run semantic search beforehand, it passes the scores
   * in here. The oracle blends them with the token-overlap score.
   * Enabled only when `AMPLIFIER_USE_SEMANTIC=true` and this field is present.
   */
  semanticScores?: {
    lessons?: Map<number, number>;   // lesson.id -> cosine similarity [0..1]
    decisions?: Map<number, number>; // decision.id -> cosine similarity [0..1]
  };
}

export interface MatchedPattern {
  pattern_key: string;
  title: string;
  frequency: number;
  last_seen: string;
  verification_status: "claim" | "evidence" | "confirmed";
  confidence: number;
  /** Cumulative weight contribution to the total risk score. */
  weight_contribution: number;
}

export interface MatchedLesson {
  id: number;
  title: string;
  type: Lesson["type"];
  severity: Lesson["severity"];
  verification_status: "claim" | "evidence" | "confirmed";
  confidence: number;
}

export interface MatchedDecision {
  id: number;
  title: string;
  category: string;
  /** "active"|"superseded"|"reverted" — only "active" should weight the score. */
  status: Decision["status"];
}

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type EvidenceQuality = "strong" | "weak" | "anecdotal";

export interface PreflightResult {
  risk_level: RiskLevel;
  score: number;
  matched_patterns: MatchedPattern[];
  matched_lessons: MatchedLesson[];
  matched_decisions: MatchedDecision[];
  suggested_approach: string;
  evidence_quality: EvidenceQuality;
}

// ---------------------------------------------------------------------------
// Thresholds (env-tunable for hand-tuning in production)
// ---------------------------------------------------------------------------

function thresholds() {
  const env = process.env;
  return {
    medium: Number(env.AMPLIFIER_ORACLE_THRESHOLD_MEDIUM ?? 1.0),
    high: Number(env.AMPLIFIER_ORACLE_THRESHOLD_HIGH ?? 3.0),
    critical: Number(env.AMPLIFIER_ORACLE_THRESHOLD_CRITICAL ?? 6.0),
  };
}

function statusWeight(status: "claim" | "evidence" | "confirmed" | undefined): number {
  switch (status) {
    case "confirmed":
      return 1.0;
    case "evidence":
      return 0.6;
    case "claim":
      return 0.2;
    default:
      return 1.0; // pre-1.4.0 rows without status default to confirmed
  }
}

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

/**
 * Convert a prompt to a set of lowercased keyword tokens for fuzzy matching.
 * Strips punctuation, lowercases, drops short stopwords.
 *
 * Bilingual stopword list (English + Finnish) so the Oracle works when Claude
 * is being talked to in either language.
 */
const STOPWORDS = new Set([
  // English
  "the", "and", "for", "with", "from", "this", "that", "have", "has", "you",
  "your", "are", "was", "were", "but", "not", "can", "will", "would", "could",
  "should", "shall", "may", "might", "must", "any", "all", "some", "one", "two",
  "into", "out", "over", "under", "what", "when", "where", "why", "how", "let",
  "lets", "make", "made", "use", "using", "used", "get", "got", "set", "add",
  "remove", "fix", "change", "update", "create", "delete", "run", "test",
  // Finnish (lightweight set, only super-common functional words)
  "että", "olen", "olet", "olla", "vain", "kanssa", "joka", "kuin", "mikä",
  "myös", "tämä", "tuo", "kun", "jos", "tai", "sekä", "ole", "ovat", "oli",
  "olisi", "voi", "voisi", "voiko", "saa", "saan", "ja", "tai", "vai", "mutta",
  "ei", "kyllä",
]);

export function tokenize(text: string): Set<string> {
  if (!text) return new Set();
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s_/-]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return new Set(tokens);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Score how strongly a lesson's text matches the prompt tokens.
 * Returns 0..1 — overlap ratio over the smaller token set.
 */
function lessonOverlap(promptTokens: Set<string>, lesson: Lesson): number {
  const lessonText = [
    lesson.title,
    lesson.description,
    lesson.trigger ?? "",
    lesson.context ?? "",
    lesson.prevention ?? "",
    (lesson.tags ?? []).join(" "),
    lesson.pattern_key ?? "",
  ].join(" ");
  const lessonTokens = tokenize(lessonText);
  if (promptTokens.size === 0 || lessonTokens.size === 0) return 0;

  let hits = 0;
  for (const t of promptTokens) {
    if (lessonTokens.has(t)) hits++;
  }
  return hits / Math.min(promptTokens.size, lessonTokens.size);
}

function decisionOverlap(promptTokens: Set<string>, decision: Decision): number {
  const text = [
    decision.title,
    decision.description,
    decision.rationale ?? "",
    decision.category,
    (decision.tags ?? []).join(" "),
    decision.next_step ?? "",
    decision.blocked_on ?? "",
  ].join(" ");
  const tokens = tokenize(text);
  if (promptTokens.size === 0 || tokens.size === 0) return 0;
  let hits = 0;
  for (const t of promptTokens) {
    if (tokens.has(t)) hits++;
  }
  return hits / Math.min(promptTokens.size, tokens.size);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function preflight(input: PreflightInput): PreflightResult {
  const promptText = [input.prompt, input.context ?? ""].join(" ");
  const promptTokens = tokenize(promptText);

  // Match lessons. We need a minimum overlap to avoid noise.
  const OVERLAP_THRESHOLD = 0.15;

  // ── v1.5 prototype: feature-flagged semantic blending ────────────────
  // When AMPLIFIER_USE_SEMANTIC=true and the caller supplied semanticScores,
  // we treat the higher of (token overlap, semantic score) as the effective
  // match signal. This keeps the v1.4.0 behavior exactly intact when the
  // flag is off, and lets us A/B the two strategies side-by-side.
  //
  // Blending strategy is intentionally simple-max so the prototype is easy
  // to reason about. A real v1.5 should probably do a weighted blend
  // (e.g. 0.6*semantic + 0.4*token) once we measure quality on a corpus.
  const semanticEnabled =
    process.env.AMPLIFIER_USE_SEMANTIC === "true" &&
    input.semanticScores !== undefined;
  const SEMANTIC_THRESHOLD = 0.5; // cosine ≥0.5 = roughly comparable to 0.15 overlap

  const matchedLessonObjs: Array<{ lesson: Lesson; overlap: number }> = [];
  for (const lesson of input.candidateLessons) {
    const tokenOv = lessonOverlap(promptTokens, lesson);
    let effectiveOv = tokenOv;

    if (semanticEnabled) {
      const semScore = input.semanticScores?.lessons?.get(lesson.id) ?? 0;
      // Rescale semantic score from [SEMANTIC_THRESHOLD..1] to [0..1] so it
      // blends meaningfully with token-overlap which is already [0..1].
      const semNormalized =
        semScore >= SEMANTIC_THRESHOLD
          ? (semScore - SEMANTIC_THRESHOLD) / (1 - SEMANTIC_THRESHOLD)
          : 0;
      effectiveOv = Math.max(tokenOv, semNormalized);
    }

    if (effectiveOv >= OVERLAP_THRESHOLD) {
      matchedLessonObjs.push({ lesson, overlap: effectiveOv });
    }
  }

  // Group matched lessons by pattern_key (those with a key) to compute pattern stats.
  const patternMap = new Map<
    string,
    {
      title: string;
      frequency: number;
      last_seen: string;
      verification_status: "claim" | "evidence" | "confirmed";
      confidence: number;
      weight_contribution: number;
    }
  >();

  let totalScore = 0;
  const matched_lessons: MatchedLesson[] = [];

  for (const { lesson, overlap } of matchedLessonObjs) {
    const freq = lesson.frequency ?? 1;
    const conf = lesson.confidence ?? 1.0;
    const status = lesson.verification_status ?? "confirmed";
    const weight = statusWeight(status);
    const contribution = freq * conf * weight * overlap;
    totalScore += contribution;

    matched_lessons.push({
      id: lesson.id,
      title: lesson.title,
      type: lesson.type,
      severity: lesson.severity,
      verification_status: status,
      confidence: conf,
    });

    if (lesson.pattern_key) {
      const existing = patternMap.get(lesson.pattern_key);
      if (existing) {
        existing.frequency += freq;
        existing.weight_contribution += contribution;
        // Keep the most-confident status across grouped lessons.
        if (rankStatus(status) > rankStatus(existing.verification_status)) {
          existing.verification_status = status;
          existing.confidence = conf;
        }
        if (lesson.updated_at > existing.last_seen) {
          existing.last_seen = lesson.updated_at;
        }
      } else {
        patternMap.set(lesson.pattern_key, {
          title: lesson.title,
          frequency: freq,
          last_seen: lesson.updated_at,
          verification_status: status,
          confidence: conf,
          weight_contribution: contribution,
        });
      }
    }
  }

  const matched_patterns: MatchedPattern[] = Array.from(patternMap.entries())
    .map(([pattern_key, info]) => ({
      pattern_key,
      title: info.title,
      frequency: info.frequency,
      last_seen: info.last_seen,
      verification_status: info.verification_status,
      confidence: info.confidence,
      weight_contribution: round2(info.weight_contribution),
    }))
    .sort((a, b) => b.weight_contribution - a.weight_contribution);

  // Match decisions (active only).
  const matched_decisions: MatchedDecision[] = [];
  for (const decision of input.candidateDecisions) {
    if (decision.status !== "active") continue;
    const tokenOv = decisionOverlap(promptTokens, decision);
    let effectiveOv = tokenOv;

    if (semanticEnabled) {
      const semScore = input.semanticScores?.decisions?.get(decision.id) ?? 0;
      const semNormalized =
        semScore >= SEMANTIC_THRESHOLD
          ? (semScore - SEMANTIC_THRESHOLD) / (1 - SEMANTIC_THRESHOLD)
          : 0;
      effectiveOv = Math.max(tokenOv, semNormalized);
    }

    if (effectiveOv >= OVERLAP_THRESHOLD) {
      matched_decisions.push({
        id: decision.id,
        title: decision.title,
        category: decision.category,
        status: decision.status,
      });
      // Decisions add a small fixed weight (0.5) when matched; we don't want them
      // to dominate but they should still nudge the score up.
      totalScore += 0.5 * statusWeight(decision.verification_status);
    }
  }

  const t = thresholds();
  const risk_level: RiskLevel =
    totalScore < t.medium
      ? "low"
      : totalScore < t.high
        ? "medium"
        : totalScore < t.critical
          ? "high"
          : "critical";

  const evidence_quality = calculateEvidenceQuality(matched_patterns);
  const suggested_approach = buildAdvice(risk_level, matched_patterns, matched_lessons, matched_decisions);

  return {
    risk_level,
    score: round2(totalScore),
    matched_patterns,
    matched_lessons,
    matched_decisions,
    suggested_approach,
    evidence_quality,
  };
}

function rankStatus(s: "claim" | "evidence" | "confirmed" | undefined): number {
  return s === "confirmed" ? 3 : s === "evidence" ? 2 : s === "claim" ? 1 : 3;
}

function calculateEvidenceQuality(matched: MatchedPattern[]): EvidenceQuality {
  if (matched.length === 0) return "anecdotal";
  const confirmedCount = matched.filter((m) => m.verification_status === "confirmed").length;
  const evidenceCount = matched.filter((m) => m.verification_status === "evidence").length;
  const claimCount = matched.length - confirmedCount - evidenceCount;
  if (confirmedCount >= 2) return "strong";
  if (confirmedCount >= 1 || evidenceCount >= 2) return "weak";
  if (claimCount > 0) return "anecdotal";
  return "anecdotal";
}

function buildAdvice(
  risk: RiskLevel,
  patterns: MatchedPattern[],
  lessons: MatchedLesson[],
  decisions: MatchedDecision[]
): string {
  if (patterns.length === 0 && lessons.length === 0 && decisions.length === 0) {
    return "No matching history. Proceed with normal caution.";
  }

  const parts: string[] = [];

  if (risk === "critical") {
    parts.push("CRITICAL: this prompt matches a recurring failure pattern.");
  } else if (risk === "high") {
    parts.push("HIGH risk: similar work has caused problems before.");
  } else if (risk === "medium") {
    parts.push("Some prior history matches this prompt.");
  } else {
    parts.push("Low overlap with prior issues.");
  }

  const topPattern = patterns[0];
  if (topPattern) {
    parts.push(
      `Most-relevant pattern: "${topPattern.title}" (key: ${topPattern.pattern_key}, seen ${topPattern.frequency}×, ${topPattern.verification_status}).`
    );
  }

  // Surface prevention notes from matched confirmed lessons
  const preventionLessons = lessons.filter(
    (l) => l.verification_status === "confirmed" && l.severity !== "low"
  );
  if (preventionLessons.length > 0) {
    parts.push(
      `Review ${preventionLessons.length} confirmed lesson(s) before proceeding (call amplify_get_lessons).`
    );
  }

  if (decisions.length > 0) {
    parts.push(
      `${decisions.length} active decision(s) touch this area — check rationale before changing direction.`
    );
  }

  return parts.join(" ");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
