/**
 * Auto-claim SessionEnd analyzer — Amplifier 1.4.1
 *
 * Reads a Claude Code session transcript (JSONL) and uses deterministic
 * string-pattern heuristics to suggest lesson candidates for
 * `amplify_record_claim`. No LLM call, no Anthropic key required — the
 * goal is "good enough to nudge the user", not "perfect classification".
 *
 * Three pattern families are detected:
 *
 *   1. user_correction   — user reprimanded / corrected Claude
 *                          ("no, don't do that", "wrong, never use X")
 *   2. rule_statement    — user declared an enduring rule
 *                          ("always check pwd before rm", "never push to main")
 *   3. success_confirm   — user confirmed Claude's choice worked
 *                          ("perfect, that worked", "exactly, keep going")
 *
 * The module returns at most `maxSuggestions` (default 3) structured
 * suggestions, ranked by signal strength. The caller decides whether to
 * actually record them; this is suggestion-only, never auto-write.
 *
 * Pure module: takes a transcript string in, returns suggestions out.
 * No filesystem, no network, no SQLite. Trivially testable.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SuggestionKind =
  | "user_correction"
  | "rule_statement"
  | "success_confirm"
  // v1.5.0 — assistant-side signals. The user-side patterns above catch
  // reactions ("no, don't"); these catch the assistant declaring something
  // worth remembering ("I was wrong about X", "this is a tier jump",
  // architecture writeups long enough to deserve a decision row).
  | "assistant_correction"
  | "assistant_insight"
  | "architecture_decision";

export interface ClaimSuggestion {
  kind: SuggestionKind;
  /** Suggested lesson type — feeds `amplify_record_claim.type`. */
  type: "mistake" | "success" | "insight" | "warning";
  /** Short, one-line title derived from the matched user message. */
  title: string;
  /** Up-to-280-char excerpt of the user message that triggered the match. */
  description: string;
  /** Surrounding context: the assistant turn right before the user reaction. */
  context: string;
  /** Severity guess based on language ("never" / "wrong" / etc.). */
  severity: "low" | "medium" | "high";
  /** Deterministic ranking score — higher = stronger signal. */
  score: number;
  /** Tags suggested for amplify_record_claim. */
  tags: string[];
}

export interface AnalyzeOptions {
  /** Cap on returned suggestions. Default 3. */
  maxSuggestions?: number;
  /** Minimum user-message length (chars) to be considered. Default 12. */
  minUserMessageLength?: number;
}

interface TranscriptTurn {
  role: "user" | "assistant" | "system";
  text: string;
}

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

/**
 * Claude Code transcripts are JSONL. Each line is a record like:
 *   { "type": "user", "message": { "role": "user", "content": "..." } }
 *   { "type": "assistant", "message": { "role": "assistant", "content": [...] } }
 * Content may be a string or an array of `{ type: "text", text: "..." }`.
 * Tool-use blocks are ignored — they aren't conversational signal.
 */
export function parseTranscript(jsonl: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  const lines = jsonl.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = (rec.message ?? rec) as Record<string, unknown>;
    const role = (msg.role ?? rec.type) as string | undefined;
    if (role !== "user" && role !== "assistant" && role !== "system") continue;
    const text = extractText(msg.content);
    if (!text) continue;
    turns.push({ role: role as TranscriptTurn["role"], text });
  }
  return turns;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      // tool_use / tool_result blocks intentionally ignored
    } else if (typeof block === "string") {
      parts.push(block);
    }
  }
  return parts.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Heuristics — pure string patterns, case-insensitive
// ---------------------------------------------------------------------------

/** Words / phrases that signal the user is correcting Claude. */
const CORRECTION_PATTERNS: Array<{ rx: RegExp; weight: number; sev: "low" | "medium" | "high" }> = [
  { rx: /\b(no|nope|don'?t|do not)\s+(do|use|run|touch|use that|do that)\b/i, weight: 3, sev: "high" },
  { rx: /\b(that'?s|that is)\s+wrong\b/i, weight: 3, sev: "high" },
  { rx: /\b(stop|halt|cancel)\b.{0,30}\b(that|doing|now)\b/i, weight: 2, sev: "medium" },
  { rx: /\b(you broke|you ruined|you trashed)\b/i, weight: 3, sev: "high" },
  { rx: /\b(not what i asked|wrong direction|missed the point)\b/i, weight: 2, sev: "medium" },
  // Finnish — \b doesn't fire around ä/ö in JS regex (ASCII word-boundary),
  // so use Unicode lookarounds (\p{L} = any letter) instead.
  { rx: /(?<![\p{L}\p{N}])(älä|ei niin|väärin|et ymmärrä)(?![\p{L}\p{N}])/iu, weight: 2, sev: "medium" },
];

/** Words / phrases that signal the user is stating an enduring rule. */
const RULE_PATTERNS: Array<{ rx: RegExp; weight: number; sev: "low" | "medium" | "high" }> = [
  { rx: /\b(always|every time|whenever)\b.{3,120}/i, weight: 3, sev: "medium" },
  { rx: /\b(never|do not ever|don'?t ever)\b.{3,120}/i, weight: 3, sev: "high" },
  { rx: /\b(rule|sääntö)\s*[:#]/i, weight: 3, sev: "medium" },
  { rx: /\bfrom now on\b.{3,120}/i, weight: 2, sev: "medium" },
  { rx: /(?<![\p{L}\p{N}])(aina|älä koskaan)(?![\p{L}\p{N}]).{3,120}/iu, weight: 2, sev: "medium" },
];

/** Words / phrases that signal the user confirms success. */
const SUCCESS_PATTERNS: Array<{ rx: RegExp; weight: number; sev: "low" | "medium" | "high" }> = [
  { rx: /\b(perfect|exactly|that worked|works now|fixed it)\b/i, weight: 3, sev: "medium" },
  { rx: /\b(great|nice|excellent|nailed it)\b.{0,40}(keep|continue|next)\b/i, weight: 2, sev: "low" },
  { rx: /\b(ship it|merge it|land it|lgtm|looks good)\b/i, weight: 3, sev: "medium" },
  { rx: /(?<![\p{L}\p{N}])(juuri näin|toimii|hyvä|loistava)(?![\p{L}\p{N}])/iu, weight: 2, sev: "low" },
];

// v1.5.0 — assistant-side patterns.

/** Assistant explicitly admits a mistake. */
const ASSISTANT_CORRECTION_PATTERNS: Array<{ rx: RegExp; weight: number; sev: "low" | "medium" | "high" }> = [
  { rx: /\b(i was wrong|i'?m wrong|my mistake|i misread)\b/i, weight: 3, sev: "high" },
  { rx: /\b(i'?ll correct|let me correct|correcting that)\b/i, weight: 2, sev: "medium" },
  { rx: /(?<![\p{L}\p{N}])(rikoin sääntö|olin väärässä|tämä on toistuva virhe)(?![\p{L}\p{N}])/iu, weight: 3, sev: "high" },
];

/** Assistant flags an insight worth remembering. */
const ASSISTANT_INSIGHT_PATTERNS: Array<{ rx: RegExp; weight: number; sev: "low" | "medium" | "high" }> = [
  { rx: /\bthis is a (tier|step|level) (jump|change)\b/i, weight: 3, sev: "medium" },
  { rx: /\b(rare|unusual|first time i'?ve seen)\b.{3,80}/i, weight: 2, sev: "medium" },
  { rx: /\bkey (finding|insight|takeaway|lesson)\b/i, weight: 2, sev: "medium" },
  { rx: /(?<![\p{L}\p{N}])(tason hyppy|harvinaista|ensimmäinen kerta)(?![\p{L}\p{N}])/iu, weight: 3, sev: "medium" },
  { rx: /(?<![\p{L}\p{N}])(tärkeä havainto|tärkeä löytö|tärkeä oppi)(?![\p{L}\p{N}])/iu, weight: 2, sev: "medium" },
];

/** Assistant produces a long writeup that looks decision-shaped. */
const ARCHITECTURE_KEYWORDS = /\b(architecture|gateway|service|port|schema|migration|api|endpoint|pipeline|workflow|deployment|integration)\b/i;
const DECISION_STRUCTURE_PATTERNS: Array<{ rx: RegExp; weight: number; sev: "low" | "medium" | "high" }> = [
  // The presence of "next step:" / "rationale:" / "trade-off:" alongside
  // architecture vocabulary is a strong signal that the assistant just
  // produced something that belongs in amplify_decisions(track).
  { rx: /\b(next step|outcome check-in|rationale|trade-?offs?)\s*[:#]/i, weight: 3, sev: "medium" },
  { rx: /\b(decision|choice|approach):/i, weight: 2, sev: "low" },
  { rx: /\b(seuraava askel|perustelu|trade-off)\s*[:#]/i, weight: 3, sev: "medium" }, // Finnish
];

interface RawHit {
  kind: SuggestionKind;
  turnIndex: number;
  weight: number;
  severity: "low" | "medium" | "high";
}

function scanTurn(text: string, kind: SuggestionKind, patterns: typeof CORRECTION_PATTERNS): RawHit | null {
  for (const p of patterns) {
    if (p.rx.test(text)) {
      return { kind, turnIndex: -1, weight: p.weight, severity: p.sev };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main entry — analyzeTranscript
// ---------------------------------------------------------------------------

const TYPE_BY_KIND: Record<SuggestionKind, ClaimSuggestion["type"]> = {
  user_correction: "mistake",
  rule_statement: "insight",
  success_confirm: "success",
  assistant_correction: "mistake",
  assistant_insight: "insight",
  architecture_decision: "insight", // becomes a decision via tools.ts mapping
};

const TAGS_BY_KIND: Record<SuggestionKind, string[]> = {
  user_correction: ["session-end", "user-correction"],
  rule_statement: ["session-end", "rule"],
  success_confirm: ["session-end", "success"],
  assistant_correction: ["session-end", "assistant-correction"],
  assistant_insight: ["session-end", "assistant-insight"],
  architecture_decision: ["session-end", "decision-candidate"],
};

// v1.5.0 — minimum assistant-message length to be considered for the
// "architecture writeup" signal. 600 chars ≈ ~150 tokens. Anything shorter
// is probably a one-liner answer, not a tier-jump explanation.
const MIN_ASSISTANT_LENGTH_FOR_DECISION = 600;

export function analyzeTranscript(jsonl: string, opts: AnalyzeOptions = {}): ClaimSuggestion[] {
  const maxSuggestions = opts.maxSuggestions ?? 3;
  const minLen = opts.minUserMessageLength ?? 12;

  const turns = parseTranscript(jsonl);
  if (turns.length < 2) return [];

  const hits: RawHit[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.text.length < minLen) continue;
    if (t.role === "user") {
      const corr = scanTurn(t.text, "user_correction", CORRECTION_PATTERNS);
      if (corr) hits.push({ ...corr, turnIndex: i });
      const rule = scanTurn(t.text, "rule_statement", RULE_PATTERNS);
      if (rule) hits.push({ ...rule, turnIndex: i });
      const succ = scanTurn(t.text, "success_confirm", SUCCESS_PATTERNS);
      if (succ) hits.push({ ...succ, turnIndex: i });
    } else if (t.role === "assistant") {
      // v1.5.0 — assistant-side detection. Catches "I was wrong", "this is a
      // tier jump", and long architecture writeups that should become
      // decisions.
      const ac = scanTurn(t.text, "assistant_correction", ASSISTANT_CORRECTION_PATTERNS);
      if (ac) hits.push({ ...ac, turnIndex: i });
      const ai = scanTurn(t.text, "assistant_insight", ASSISTANT_INSIGHT_PATTERNS);
      if (ai) hits.push({ ...ai, turnIndex: i });

      // Decision candidate: long assistant message with architecture vocab
      // AND structural markers like "next step:" / "rationale:" / "trade-off:".
      if (
        t.text.length >= MIN_ASSISTANT_LENGTH_FOR_DECISION &&
        ARCHITECTURE_KEYWORDS.test(t.text)
      ) {
        const ds = scanTurn(t.text, "architecture_decision", DECISION_STRUCTURE_PATTERNS);
        if (ds) hits.push({ ...ds, turnIndex: i });
      }
    }
  }

  if (hits.length === 0) return [];

  // De-duplicate hits that land on the same user turn + kind: keep highest weight.
  const dedup = new Map<string, RawHit>();
  for (const h of hits) {
    const key = `${h.turnIndex}:${h.kind}`;
    const prev = dedup.get(key);
    if (!prev || h.weight > prev.weight) dedup.set(key, h);
  }

  // Convert to suggestions, ranked by weight desc, then by turn index desc
  // (latest signals win because they reflect the most recent user intent).
  const ranked = Array.from(dedup.values()).sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return b.turnIndex - a.turnIndex;
  });

  const out: ClaimSuggestion[] = [];
  for (const hit of ranked) {
    if (out.length >= maxSuggestions) break;
    const userTurn = turns[hit.turnIndex];
    const prevAssistant =
      hit.turnIndex > 0 && turns[hit.turnIndex - 1].role === "assistant"
        ? turns[hit.turnIndex - 1].text
        : "";

    const excerpt = truncate(userTurn.text.replace(/\s+/g, " ").trim(), 280);
    const ctx = truncate(prevAssistant.replace(/\s+/g, " ").trim(), 280);

    out.push({
      kind: hit.kind,
      type: TYPE_BY_KIND[hit.kind],
      title: deriveTitle(hit.kind, userTurn.text),
      description: excerpt,
      context: ctx,
      severity: hit.severity,
      score: hit.weight,
      tags: TAGS_BY_KIND[hit.kind],
    });
  }

  return out;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

function deriveTitle(kind: SuggestionKind, text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const firstSentence = flat.split(/[.!?]\s/)[0];
  const head = truncate(firstSentence, 80);
  switch (kind) {
    case "user_correction":
      return `User correction: ${head}`;
    case "rule_statement":
      return `Rule: ${head}`;
    case "success_confirm":
      return `Confirmed working: ${head}`;
    case "assistant_correction":
      return `Assistant correction: ${head}`;
    case "assistant_insight":
      return `Insight: ${head}`;
    case "architecture_decision":
      return `Decision candidate: ${head}`;
  }
}
