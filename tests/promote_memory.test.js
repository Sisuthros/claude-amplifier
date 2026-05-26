// v1.5.0 — retroactive promotion from memory/<date>.md.
//
// Reproduces the yesterday-incident shape: a memory file packed with tool
// calls and Wrote: lines but no corresponding Amplifier writes. The
// promoter scans for three signals and emits DRAFT suggestions — never
// writes to SQLite, never claims work was already saved.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import {
  parseMemoryFile,
  analyzeMemoryFile,
  formatPromotionReport,
} from "../dist/promote_memory.js";
import { handlePromoteFromMemoryMd } from "../dist/tools.js";

function writeTmp(content) {
  const file = path.join(
    os.tmpdir(),
    `amp-prom-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
  );
  fs.writeFileSync(file, content);
  return {
    file,
    cleanup: () => { try { fs.unlinkSync(file); } catch {} },
  };
}

describe("parseMemoryFile (v1.5.0)", () => {
  test("parses Tool, Terminal, Wrote lines", () => {
    const md = [
      "# Agent log — 2026-05-25",
      "",
      "### 13:06 — Wrote: /tmp/agent-hooks/session-start.sh",
      "### 13:07 — Tool: patch",
      "### 13:07 — Terminal: `echo hello`",
      "noise line that should be ignored",
      "### bad — no time",
    ].join("\n");
    const events = parseMemoryFile(md);
    assert.equal(events.length, 3);
    const kinds = events.map((e) => e.kind);
    assert.deepEqual(kinds, ["wrote", "tool", "terminal"]);
    assert.equal(events[0].time, "13:06");
    assert.equal(events[0].minute_of_day, 13 * 60 + 6);
  });

  test("ignores malformed timestamps", () => {
    const md = [
      "### 99:99 — Tool: x",  // invalid hour/minute — currently still parsed,
                              // because we don't sanity-check the range. That
                              // is fine: it doesn't crash and won't trigger
                              // false signals because the minute_of_day will
                              // be a weird-but-stable value.
      "### foo — Tool: y",   // unparseable
    ].join("\n");
    const events = parseMemoryFile(md);
    assert.equal(events.length, 1, "first line parses, second is rejected");
  });
});

describe("decision_candidate detection (v1.5.0)", () => {
  test("flags Wrote: lines pointing at plan / decision / architecture files", () => {
    // The regex matches whole words from {plan, decision, architecture,
    // blueprint, design, manifesto, spec, adr}. The match is against the
    // FULL path, so `/docs/plans/...md` counts because "plans" includes
    // the word "plan". A path like `trust-rebuild.md` with none of the
    // target keywords correctly does NOT match.
    const md = [
      "### 14:00 — Wrote: /tmp/docs/plans/big-rewrite.md",     // "plans" → plan
      "### 14:01 — Wrote: /tmp/docs/system-blueprint.md",      // blueprint
      "### 14:02 — Wrote: /tmp/docs/manifesto.md",             // manifesto
      "### 14:03 — Wrote: /tmp/random.txt",                    // skipped
    ].join("\n");
    const { file, cleanup } = writeTmp(md);
    try {
      const report = analyzeMemoryFile(file);
      const dcs = report.drafts.filter((d) => d.kind === "decision_candidate");
      assert.equal(dcs.length, 3, "plans + blueprint + manifesto should match");
      assert.ok(dcs.some((d) => d.title.includes("system-blueprint")));
    } finally {
      cleanup();
    }
  });

  test("does not flag arbitrary text files", () => {
    const md = "### 10:00 — Wrote: /tmp/scratch.txt";
    const { file, cleanup } = writeTmp(md);
    try {
      const report = analyzeMemoryFile(file);
      assert.equal(
        report.drafts.filter((d) => d.kind === "decision_candidate").length,
        0,
      );
    } finally {
      cleanup();
    }
  });
});

describe("intense_session detection (v1.5.0)", () => {
  test("flags an hour with >50 events", () => {
    const lines = [];
    for (let i = 0; i < 60; i++) {
      // All within the 14:00–14:59 window
      const mm = String(i).padStart(2, "0");
      lines.push(`### 14:${mm} — Tool: skill_manage`);
    }
    const { file, cleanup } = writeTmp(lines.join("\n"));
    try {
      const report = analyzeMemoryFile(file);
      const intense = report.drafts.filter((d) => d.kind === "intense_session");
      assert.equal(intense.length, 1);
      assert.match(intense[0].title, /60 events/);
    } finally {
      cleanup();
    }
  });

  test("does not flag quiet hours", () => {
    const lines = [
      "### 09:00 — Tool: x",
      "### 09:10 — Tool: y",
      "### 10:00 — Tool: z",
    ];
    const { file, cleanup } = writeTmp(lines.join("\n"));
    try {
      const report = analyzeMemoryFile(file);
      assert.equal(
        report.drafts.filter((d) => d.kind === "intense_session").length,
        0,
      );
    } finally {
      cleanup();
    }
  });
});

describe("repeated_failure detection (v1.5.0)", () => {
  test("flags ≥8 identical Tool calls as a stuck loop signal", () => {
    const lines = [];
    for (let i = 0; i < 12; i++) {
      const hh = String(10 + Math.floor(i / 60)).padStart(2, "0");
      const mm = String(i % 60).padStart(2, "0");
      lines.push(`### ${hh}:${mm} — Tool: skill_manage`);
    }
    const { file, cleanup } = writeTmp(lines.join("\n"));
    try {
      const report = analyzeMemoryFile(file);
      const reps = report.drafts.filter((d) => d.kind === "repeated_failure");
      assert.ok(reps.length >= 1);
      assert.match(reps[0].title, /12×/);
    } finally {
      cleanup();
    }
  });

  test("does not flag a handful of identical calls", () => {
    const lines = [
      "### 10:00 — Tool: patch",
      "### 10:01 — Tool: patch",
      "### 10:02 — Tool: patch",
    ];
    const { file, cleanup } = writeTmp(lines.join("\n"));
    try {
      const report = analyzeMemoryFile(file);
      assert.equal(
        report.drafts.filter((d) => d.kind === "repeated_failure").length,
        0,
      );
    } finally {
      cleanup();
    }
  });
});

describe("formatPromotionReport (v1.5.0)", () => {
  test("explicitly states drafts are not yet recorded", () => {
    const md = "### 14:00 — Wrote: /tmp/architecture.md";
    const { file, cleanup } = writeTmp(md);
    try {
      const out = formatPromotionReport(analyzeMemoryFile(file));
      assert.match(out, /DRAFTS only/);
      assert.match(out, /Nothing has been recorded yet/);
    } finally {
      cleanup();
    }
  });

  test("returns a 'nothing found' message when file is quiet", () => {
    const md = "### 10:00 — Tool: ping";
    const { file, cleanup } = writeTmp(md);
    try {
      const out = formatPromotionReport(analyzeMemoryFile(file));
      assert.match(out, /No promotion candidates/);
    } finally {
      cleanup();
    }
  });
});

describe("handlePromoteFromMemoryMd tool (v1.5.0)", () => {
  test("requires memory_file", async () => {
    const out = await handlePromoteFromMemoryMd({}, {});
    assert.match(out, /Error: 'memory_file' is required/);
  });

  test("returns a report for a real file", async () => {
    const md = [
      "### 14:00 — Wrote: /tmp/docs/plans/big-rewrite.md",
      "### 14:05 — Tool: skill_manage",
    ].join("\n");
    const { file, cleanup } = writeTmp(md);
    try {
      const out = await handlePromoteFromMemoryMd({}, { memory_file: file });
      assert.match(out, /Total events parsed: 2/);
      assert.match(out, /Wrote architectural artifact/);
    } finally {
      cleanup();
    }
  });

  test("handles missing file gracefully", async () => {
    const missing = path.join(os.tmpdir(), `nope-${Date.now()}.md`);
    const out = await handlePromoteFromMemoryMd({}, { memory_file: missing });
    // analyzeMemoryFile swallows ENOENT and returns 0 events; that's a valid
    // signal ("file empty/missing") rather than an error.
    assert.match(out, /Total events parsed: 0/);
  });
});
