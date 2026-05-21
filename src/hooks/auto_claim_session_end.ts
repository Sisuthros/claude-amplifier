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

export type SuggestionKind = "user_correction" | "rule_statement" | "success_confirm";

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
  { rx: /\b(älä|ei niin|väärin|et ymmärrä)\b/i, weight: 2, sev: "medium" }, // Finnish corrections
];

/** Words / phrases that signal the user is stating an enduring rule. */
const RULE_PATTERNS: Array<{ rx: RegExp; weight: number; sev: "low" | "medium" | "high" }> = [
  { rx: /\b(always|every time|whenever)\b.{3,120}/i, weight: 3, sev: "medium" },
  { rx: /\b(never|do not ever|don'?t ever)\b.{3,120}/i, weight: 3, sev: "high" },
  { rx: /\b(rule|sääntö)\s*[:#]/i, weight: 3, sev: "medium" },
  { rx: /\bfrom now on\b.{3,120}/i, weight: 2, sev: "medium" },
  { rx: /\b(aina|älä koskaan)\b.{3,120}/i, weight: 2, sev: "medium" }, // Finnish rules
];

/** Words / phrases that signal the user confirms success. */
const SUCCESS_PATTERNS: Array<{ rx: RegExp; weight: number; sev: "low" | "medium" | "high" }> = [
  { rx: /\b(perfect|exactly|that worked|works now|fixed it)\b/i, weight: 3, sev: "medium" },
  { rx: /\b(great|nice|excellent|nailed it)\b.{0,40}(keep|continue|next)\b/i, weight: 2, sev: "low" },
  { rx: /\b(ship it|merge it|land it|lgtm|looks good)\b/i, weight: 3, sev: "medium" },
  { rx: /\b(juuri näin|toimii|hyvä|loistava)\b/i, weight: 2, sev: "low" }, // Finnish success
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
};

const TAGS_BY_KIND: Record<SuggestionKind, string[]> = {
  user_correction: ["session-end", "user-correction"],
  rule_statement: ["session-end", "rule"],
  success_confirm: ["session-end", "success"],
};

export function analyzeTranscript(jsonl: string, opts: AnalyzeOptions = {}): ClaimSuggestion[] {
  const maxSuggestions = opts.maxSuggestions ?? 3;
  const minLen = opts.minUserMessageLength ?? 12;

  const turns = parseTranscript(jsonl);
  if (turns.length < 2) return [];

  const hits: RawHit[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.role !== "user") continue;
    if (t.text.length < minLen) continue;
    const corr = scanTurn(t.text, "user_correction", CORRECTION_PATTERNS);
    if (corr) hits.push({ ...corr, turnIndex: i });
    const rule = scanTurn(t.text, "rule_statement", RULE_PATTERNS);
    if (rule) hits.push({ ...rule, turnIndex: i });
    const succ = scanTurn(t.text, "success_confirm", SUCCESS_PATTERNS);
    if (succ) hits.push({ ...succ, turnIndex: i });
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
  }
}
