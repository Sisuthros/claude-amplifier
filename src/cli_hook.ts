/**
 * CLI hook handler — Amplifier 1.4.1
 *
 * Implements the `claude-amplifier hook session-end` subcommand. Reads
 * the Claude Code SessionEnd payload from stdin, locates the transcript,
 * runs the deterministic heuristic analyzer, and prints structured
 * JSON suggestions on stdout. Exit code 0 always — SessionEnd hooks
 * cannot block, this is suggestion-only.
 *
 * Output schema (printed to stdout, also rendered as the hook
 * `systemMessage` so the user sees it inside Claude Code):
 *
 *   {
 *     "version": 1,
 *     "session_id": "abc...",
 *     "suggestions": [ { kind, type, title, description, ... }, ... ],
 *     "suggestion_count": N
 *   }
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";

import { analyzeTranscript, type ClaimSuggestion } from "./hooks/auto_claim_session_end.js";

interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  exit_reason?: string;
}

interface HookResult {
  version: 1;
  session_id?: string;
  transcript_path?: string;
  suggestions: ClaimSuggestion[];
  suggestion_count: number;
  note: string;
}

/** Read stdin to completion (text). */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return new Promise<string>((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

export async function runHookSessionEnd(): Promise<number> {
  const raw = await readStdin();
  let payload: HookPayload = {};
  try {
    payload = JSON.parse(raw || "{}") as HookPayload;
  } catch {
    payload = {};
  }

  const result: HookResult = {
    version: 1,
    session_id: payload.session_id,
    transcript_path: payload.transcript_path,
    suggestions: [],
    suggestion_count: 0,
    note: "",
  };

  if (!payload.transcript_path || !existsSync(payload.transcript_path)) {
    result.note = "No transcript_path provided or file missing. Skipping analysis.";
    emit(result);
    return 0;
  }

  let jsonl: string;
  try {
    jsonl = readFileSync(payload.transcript_path, "utf-8");
  } catch (err) {
    result.note = `Could not read transcript: ${(err as Error).message}`;
    emit(result);
    return 0;
  }

  const suggestions = analyzeTranscript(jsonl, { maxSuggestions: 3 });
  result.suggestions = suggestions;
  result.suggestion_count = suggestions.length;
  if (suggestions.length === 0) {
    result.note =
      "No high-signal lesson candidates found in this session. Nothing to claim.";
  } else {
    result.note =
      `Found ${suggestions.length} candidate lesson(s). ` +
      "To save them: call amplify_record_claim with the fields below in your next session.";
  }
  emit(result);
  return 0;
}

function emit(result: HookResult): void {
  // SessionEnd hooks support an optional JSON envelope with `systemMessage`
  // so the user can see the summary inside Claude Code. We emit BOTH the
  // raw result on stdout (machine-parseable) and a compact systemMessage.
  const summary = formatSummary(result);
  const envelope = {
    systemMessage: summary,
    suppressOutput: false,
    _amplifier: result, // namespaced so we don't collide with hook spec
  };
  process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
}

function formatSummary(r: HookResult): string {
  if (r.suggestion_count === 0) return `Amplifier auto-claim: ${r.note}`;
  const lines: string[] = [
    `Amplifier auto-claim — ${r.suggestion_count} candidate lesson(s) from session ${r.session_id ?? "(unknown)"}:`,
  ];
  for (const s of r.suggestions) {
    lines.push(`  [${s.kind} · ${s.severity}] ${s.title}`);
  }
  lines.push("");
  lines.push("To save a candidate next session:");
  lines.push("  amplify_record_claim({ project, type, title, description, severity, tags })");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// `hook-install` — write SessionEnd entry into project or user settings.json
// ---------------------------------------------------------------------------

function findClaudeUserSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

function findClaudeProjectSettingsPath(cwd: string): string {
  return join(cwd, ".claude", "settings.json");
}

export interface HookInstallOptions {
  scope?: "project" | "user";
  cwd?: string;
  /** If true, just print what would change. */
  dryRun?: boolean;
}

export function cmdHookInstall(opts: HookInstallOptions = {}): number {
  const scope = opts.scope ?? "project";
  const cwd = opts.cwd ?? process.cwd();
  const path =
    scope === "user" ? findClaudeUserSettingsPath() : findClaudeProjectSettingsPath(cwd);

  let cfg: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      cfg = JSON.parse(readFileSync(path, "utf-8"));
    } catch (e) {
      console.error(`! Could not parse existing settings at ${path}: ${(e as Error).message}`);
      console.error("  Manual fix required. Aborting to avoid clobbering.");
      return 1;
    }
  }

  const hooks = ((cfg.hooks as Record<string, unknown>) ??= {});
  const sessionEnd = (((hooks as Record<string, unknown>).SessionEnd as unknown[]) ??= []);
  const arr = sessionEnd as Array<Record<string, unknown>>;

  const alreadyInstalled = arr.some((entry) => {
    const hookList = entry.hooks as Array<Record<string, unknown>> | undefined;
    if (!hookList) return false;
    return hookList.some((h) => {
      const cmd = typeof h.command === "string" ? h.command : "";
      return cmd.includes("claude-amplifier") && cmd.includes("session-end");
    });
  });

  if (alreadyInstalled) {
    console.log("· Amplifier SessionEnd hook already present. Nothing to do.");
    console.log(`  ${path}`);
    return 0;
  }

  const entry = {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: "claude-amplifier hook session-end",
        timeout: 30,
        statusMessage: "Scanning transcript for lesson candidates...",
      },
    ],
  };
  arr.push(entry);
  (hooks as Record<string, unknown>).SessionEnd = arr;
  cfg.hooks = hooks;

  if (opts.dryRun) {
    console.log("--- DRY RUN ---");
    console.log(`Would write to: ${path}`);
    console.log(JSON.stringify(cfg, null, 2));
    return 0;
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  } catch (e) {
    console.error(`! Could not write ${path}: ${(e as Error).message}`);
    console.error("  Add this to your settings.json manually under \"hooks.SessionEnd\":");
    console.error(JSON.stringify(entry, null, 2));
    return 1;
  }

  console.log(`✓ Installed Amplifier SessionEnd hook (${scope} scope)`);
  console.log(`  ${path}`);
  console.log("");
  console.log("Next steps:");
  console.log("  1. Restart Claude Code (or open a new session)");
  console.log("  2. End any session normally — the hook runs automatically");
  console.log("  3. The summary appears as a system message in your terminal");
  console.log("");
  // Hint about the alternative scope
  if (scope === "project") {
    console.log("To install globally instead: claude-amplifier hook-install --scope user");
  }
  // Touch unused-import to keep readdirSync available for future expansion
  void readdirSync;
  return 0;
}
