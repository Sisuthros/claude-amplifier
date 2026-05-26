// v1.5.0 — Stale-memory detection.
//
// Background: a session can do hours of work that gets logged by some
// other system (e.g. ~/.claude/memory/<YYYY-MM-DD>.md hooks) without ever
// calling amplify_learn / amplify_decisions. Next session loads
// Amplifier context and sees nothing about yesterday's work — looks like
// "nothing happened" even though the filesystem has 294 tool calls logged.
//
// This module compares a project's most-recent Amplifier write timestamp
// against the mtimes of YYYY-MM-DD-named files in a memory directory.
// Anything newer than the latest Amplifier write is "stale": worth
// reviewing, but not yet captured as a lesson/decision.

import fs from "fs";
import path from "path";

import type { SQLiteStore } from "./storage.js";

export interface StaleMemoryFile {
  /** Absolute path to the memory file. */
  path: string;
  /** Date portion of the filename (YYYY-MM-DD). */
  date: string;
  /** File mtime as ISO string. */
  mtime: string;
  /** File size in bytes — coarse signal for "how much work happened". */
  size_bytes: number;
}

export interface FreshnessReport {
  project: string;
  memory_dir: string;
  /** ISO string of the latest amplifier write, or null if project is empty. */
  latest_amplifier_write: string | null;
  /** Memory files newer than latest_amplifier_write, oldest first. */
  stale_files: StaleMemoryFile[];
  /** True when memory_dir does not exist — different signal from "no stale". */
  memory_dir_missing: boolean;
}

/**
 * Pull the most recent updated_at across this project's lessons and decisions.
 * Returns null if the project has no rows yet (a brand-new project should not
 * trigger stale warnings — there's nothing to be stale against).
 */
export function latestAmplifierWrite(
  store: SQLiteStore,
  project: string,
): string | null {
  // Reach into the underlying db handle. SQLiteStore exposes prepared queries
  // for full-row reads but not for "max(updated_at)" — adding a one-off prepared
  // statement here keeps this module standalone.
  const db = (store as unknown as { db: any }).db;
  if (!db) return null;
  const row = db
    .prepare(
      `SELECT MAX(updated_at) AS latest FROM (
         SELECT updated_at FROM lessons WHERE project = ?
         UNION ALL
         SELECT updated_at FROM decisions WHERE project = ?
       )`,
    )
    .get(project, project) as { latest: string | null } | undefined;
  return row?.latest ?? null;
}

/**
 * Resolve the default memory directory. Honours CLAUDE_AMPLIFIER_MEMORY_DIR
 * (test override), then $HOME/.claude/memory (the convention used by the
 * project's own hooks), then <projectPath>/memory if a project_path is hinted.
 */
export function resolveMemoryDir(projectPath?: string): string {
  if (process.env.CLAUDE_AMPLIFIER_MEMORY_DIR) {
    return process.env.CLAUDE_AMPLIFIER_MEMORY_DIR;
  }
  if (projectPath) {
    return path.join(projectPath, "memory");
  }
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return path.join(home, ".claude", "memory");
}

const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})(?:-[A-Za-z0-9._-]+)?\.md$/;

/**
 * Scan memory_dir for files named YYYY-MM-DD.md (or YYYY-MM-DD-suffix.md).
 * Returns an array of {path, date, mtime, size_bytes} sorted by mtime ascending.
 */
function scanMemoryDir(memoryDir: string): StaleMemoryFile[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(memoryDir);
  } catch {
    return [];
  }
  const out: StaleMemoryFile[] = [];
  for (const name of entries) {
    const m = name.match(DATE_FILE_RE);
    if (!m) continue;
    const full = path.join(memoryDir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    out.push({
      path: full,
      date: m[1],
      mtime: stat.mtime.toISOString(),
      size_bytes: stat.size,
    });
  }
  out.sort((a, b) => a.mtime.localeCompare(b.mtime));
  return out;
}

/**
 * Compute which memory files are newer than the latest Amplifier write.
 * If the project has no Amplifier writes yet, the report includes ALL
 * memory files as candidates — there's potentially weeks of unrecorded
 * work to triage on first run.
 */
export function freshnessReport(
  store: SQLiteStore,
  project: string,
  opts: { memory_dir?: string; project_path?: string } = {},
): FreshnessReport {
  const memoryDir = opts.memory_dir ?? resolveMemoryDir(opts.project_path);
  const memoryExists = fs.existsSync(memoryDir);
  if (!memoryExists) {
    return {
      project,
      memory_dir: memoryDir,
      latest_amplifier_write: null,
      stale_files: [],
      memory_dir_missing: true,
    };
  }

  const latest = latestAmplifierWrite(store, project);
  const all = scanMemoryDir(memoryDir);
  // Normalise both sides to ISO milliseconds for safe comparison. SQLite
  // stores timestamps like "2026-05-26 12:34:56" — replace space with T and
  // append Z to interpret as UTC (matches the now() helper in storage.ts).
  const latestMs = latest
    ? Date.parse(latest.replace(" ", "T") + (latest.endsWith("Z") ? "" : "Z"))
    : null;

  const stale =
    latestMs === null
      ? all
      : all.filter((f) => Date.parse(f.mtime) > latestMs);

  return {
    project,
    memory_dir: memoryDir,
    latest_amplifier_write: latest,
    stale_files: stale,
    memory_dir_missing: false,
  };
}

/**
 * Render a short human-readable warning block to splice into context-load
 * output. Returns null when there's nothing to warn about, so callers can
 * conditionally include it without an extra null check.
 */
export function formatFreshnessWarning(
  report: FreshnessReport,
): string | null {
  if (report.memory_dir_missing) return null;
  if (report.stale_files.length === 0) return null;

  const lines: string[] = [
    `\n⚠ Stale memory files — ${report.stale_files.length} newer than latest Amplifier write`,
  ];
  if (report.latest_amplifier_write) {
    lines.push(`  Latest Amplifier write: ${report.latest_amplifier_write}`);
  } else {
    lines.push(`  (Project has no Amplifier writes yet — all memory files are unrecorded.)`);
  }
  // Show up to 5 most-recent stale files. Anything more is noise in a
  // session-start summary; the audit tool can dump the rest.
  const recent = [...report.stale_files].slice(-5).reverse();
  for (const f of recent) {
    const kb = (f.size_bytes / 1024).toFixed(1);
    lines.push(`  • ${f.date}.md (${kb} KB, mtime ${f.mtime})`);
  }
  if (report.stale_files.length > 5) {
    lines.push(`  ... and ${report.stale_files.length - 5} more.`);
  }
  lines.push(
    `  Review with amplify_audit_freshness, then call amplify_decisions/amplify_learn for anything load-bearing.`,
  );
  return lines.join("\n");
}
