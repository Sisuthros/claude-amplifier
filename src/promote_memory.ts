// v1.5.0 — retroactive promotion from memory/<YYYY-MM-DD>.md.
//
// The yesterday-incident: session 2026-05-25 logged ~294 tool calls to
// memory/2026-05-25.md but never called amplify_learn / amplify_decisions.
// Next session loaded Amplifier context, saw nothing, and treated the day
// as if nothing had happened.
//
// This module reads a single memory/<date>.md file and produces draft
// suggestions for amplify_learn / amplify_decisions. It NEVER writes to
// SQLite — the operator (or assistant) reviews the drafts and decides
// which ones are worth recording.
//
// File format expected (one line per event):
//   ### HH:MM — Tool: <name>
//   ### HH:MM — Terminal: `<command>`
//   ### HH:MM — Wrote: <path>
//
// Anything else is ignored. The format is whatever the project's own
// session-hook writes; this module makes no claim it's the universal
// memory format.

import fs from "fs";

export interface PromotionDraft {
  kind: "decision_candidate" | "intense_session" | "repeated_failure";
  type: "decision" | "insight" | "mistake";
  title: string;
  description: string;
  evidence: string[];
  /** 0..1, internal confidence — higher = stronger signal. */
  score: number;
}

interface ParsedEvent {
  /** "HH:MM" string as it appears in the file. */
  time: string;
  /** Approximate minute-of-day for ordering / per-hour aggregation. */
  minute_of_day: number;
  kind: "tool" | "terminal" | "wrote" | "other";
  payload: string;
}

const LINE_RE =
  /^###\s+(\d{2}):(\d{2})\s+—\s+(Tool|Terminal|Wrote):\s*(.+)$/;

export function parseMemoryFile(content: string): ParsedEvent[] {
  const out: ParsedEvent[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const m = raw.match(LINE_RE);
    if (!m) continue;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) continue;
    const kindRaw = m[3].toLowerCase();
    const kind: ParsedEvent["kind"] =
      kindRaw === "tool" ? "tool" :
      kindRaw === "terminal" ? "terminal" :
      kindRaw === "wrote" ? "wrote" :
      "other";
    out.push({
      time: `${m[1]}:${m[2]}`,
      minute_of_day: hh * 60 + mm,
      kind,
      payload: m[4].trim(),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Heuristic 1 — "Wrote:" lines that look like architectural artifacts.
// ---------------------------------------------------------------------------

// Match common architectural-artifact words AND their plurals
// (so paths like /docs/plans/foo.md or /decisions/bar.md count too).
const DECISION_FILENAME_PATTERNS = /\b(plan|decision|architecture|blueprint|design|manifesto|spec|adr)s?\b/i;

function detectDecisionCandidates(events: ParsedEvent[]): PromotionDraft[] {
  const drafts: PromotionDraft[] = [];
  for (const e of events) {
    if (e.kind !== "wrote") continue;
    if (!DECISION_FILENAME_PATTERNS.test(e.payload)) continue;
    const basename = e.payload.split(/[\/\\]/).pop() || e.payload;
    drafts.push({
      kind: "decision_candidate",
      type: "decision",
      title: `Wrote architectural artifact: ${basename}`,
      description:
        `Memory log captured a Wrote event for ${e.payload} at ${e.time}. ` +
        `Filename suggests an architectural/design artifact that may warrant ` +
        `an amplify_decisions(track) entry.`,
      evidence: [`${e.time} — Wrote: ${e.payload}`],
      score: 0.7,
    });
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// Heuristic 2 — bursts of activity. A hour with >50 tool calls usually means
// a substantive session, not idle pinging. Worth surfacing for review.
// ---------------------------------------------------------------------------

const INTENSE_HOUR_THRESHOLD = 50;

function detectIntenseSessions(events: ParsedEvent[]): PromotionDraft[] {
  const drafts: PromotionDraft[] = [];
  const perHour = new Map<number, ParsedEvent[]>();
  for (const e of events) {
    const hr = Math.floor(e.minute_of_day / 60);
    if (!perHour.has(hr)) perHour.set(hr, []);
    perHour.get(hr)!.push(e);
  }
  for (const [hr, evs] of perHour) {
    if (evs.length < INTENSE_HOUR_THRESHOLD) continue;
    const hhmm = `${String(hr).padStart(2, "0")}:00–${String(hr + 1).padStart(2, "0")}:00`;
    drafts.push({
      kind: "intense_session",
      type: "insight",
      title: `Intense session window: ${evs.length} events in ${hhmm}`,
      description:
        `${evs.length} memory events between ${hhmm}. Bursts this dense often ` +
        `indicate a tier-jump, debugging marathon, or focused refactor. Review ` +
        `the slice and decide whether an insight or decision was reached.`,
      evidence: evs.slice(0, 6).map((e) => `${e.time} — ${e.kind}: ${e.payload.slice(0, 80)}`),
      score: Math.min(1.0, 0.5 + evs.length / 200),
    });
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// Heuristic 3 — same command/tool repeated many times suggests a stuck loop
// or unresolved failure. Surface as a possible "do not do X" mistake.
// ---------------------------------------------------------------------------

const REPEAT_THRESHOLD = 8;

function detectRepeatedFailures(events: ParsedEvent[]): PromotionDraft[] {
  const drafts: PromotionDraft[] = [];
  const counter = new Map<string, ParsedEvent[]>();
  for (const e of events) {
    if (e.kind !== "tool" && e.kind !== "terminal") continue;
    // Normalise: collapse whitespace, drop trailing args after 60 chars.
    const key =
      e.kind +
      ":" +
      e.payload.replace(/\s+/g, " ").trim().slice(0, 60);
    if (!counter.has(key)) counter.set(key, []);
    counter.get(key)!.push(e);
  }
  for (const [key, evs] of counter) {
    if (evs.length < REPEAT_THRESHOLD) continue;
    drafts.push({
      kind: "repeated_failure",
      type: "mistake",
      title: `Repeated ${evs.length}× call: ${key.slice(key.indexOf(":") + 1, 80)}`,
      description:
        `The same call was issued ${evs.length} times in this session. ` +
        `Recurring identical calls usually signal a stuck loop or an issue ` +
        `that wasn't actually fixed each iteration. If the calls reflect a ` +
        `failure mode, record it as a mistake with a pattern_key.`,
      evidence: evs.slice(0, 5).map((e) => `${e.time} — ${e.payload.slice(0, 80)}`),
      score: Math.min(1.0, 0.4 + evs.length / 50),
    });
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// Top-level — combine, dedupe, rank.
// ---------------------------------------------------------------------------

export interface PromotionReport {
  memory_file: string;
  total_events: number;
  drafts: PromotionDraft[];
}

export function analyzeMemoryFile(
  filePath: string,
): PromotionReport {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return {
      memory_file: filePath,
      total_events: 0,
      drafts: [],
    };
  }
  const events = parseMemoryFile(content);
  const drafts = [
    ...detectDecisionCandidates(events),
    ...detectIntenseSessions(events),
    ...detectRepeatedFailures(events),
  ];
  drafts.sort((a, b) => b.score - a.score);
  return {
    memory_file: filePath,
    total_events: events.length,
    drafts,
  };
}

/**
 * Render a human-readable summary for the MCP tool output. Keeps the heavy
 * lifting (which drafts to record) in the operator's hands by listing
 * everything without recording anything.
 */
export function formatPromotionReport(report: PromotionReport): string {
  const lines: string[] = [
    `Memory file: ${report.memory_file}`,
    `Total events parsed: ${report.total_events}`,
    `Draft suggestions: ${report.drafts.length}`,
    "",
  ];
  if (report.drafts.length === 0) {
    lines.push(
      "No promotion candidates found. Either the day was quiet, or the heuristics " +
        "(architectural Wrote: lines, >50 events/hour, ≥8× repeated calls) didn't " +
        "match. Manual review is still worthwhile if you remember work happening.",
    );
    return lines.join("\n");
  }
  for (let i = 0; i < report.drafts.length; i++) {
    const d = report.drafts[i];
    lines.push(`[${i + 1}] (${d.kind}, score ${d.score.toFixed(2)}) ${d.title}`);
    lines.push(`    Suggested type: ${d.type}`);
    lines.push(`    ${d.description}`);
    if (d.evidence.length) {
      lines.push(`    Evidence:`);
      for (const ev of d.evidence) lines.push(`      • ${ev}`);
    }
    lines.push("");
  }
  lines.push(
    "These are DRAFTS only. Nothing has been recorded yet. Review each one and " +
      "call amplify_learn or amplify_decisions explicitly for anything worth keeping.",
  );
  return lines.join("\n");
}
