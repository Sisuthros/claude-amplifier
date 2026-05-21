/**
 * Claude Amplifier — CLI commands (init, seed, list, export, stats).
 *
 * Invoked when the binary is run with a subcommand other than `mcp`.
 * The MCP server itself stays the default behaviour for backwards compatibility.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, platform } from "node:os";

import { SQLiteStore } from "./storage.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findClaudeDesktopConfigPath(): string {
  const home = homedir();
  if (platform() === "darwin") {
    return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (platform() === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  }
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

function findClaudeCodeMcpPath(cwd: string): string {
  return join(cwd, ".mcp.json");
}

function readJsonSafe(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function writeJsonPretty(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function color(s: string, code: string): string {
  if (!process.stdout.isTTY) return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}
const green = (s: string) => color(s, "32");
const yellow = (s: string) => color(s, "33");
const cyan = (s: string) => color(s, "36");
const bold = (s: string) => color(s, "1");
const dim = (s: string) => color(s, "2");

function printHelp(): void {
  const lines = [
    "",
    bold("claude-amplifier") + dim(" — persistent memory for Claude across sessions"),
    "",
    bold("Usage:"),
    "  claude-amplifier <command> [options]",
    "",
    bold("Commands:"),
    "  " + cyan("mcp") + "                       Run the MCP server over stdio (default if no command)",
    "  " + cyan("init") + "                      Auto-detect Claude Desktop / Claude Code and wire it up",
    "  " + cyan("seed") + "                      Insert the recommended starter lessons (see README)",
    "  " + cyan("list") + " [project]            List lessons + decisions for a project (or all)",
    "  " + cyan("stats") + "                     Show storage statistics",
    "  " + cyan("export") + " <project> [--out]  Export everything for a project as JSON",
    "  " + cyan("import") + " <file.json>        Import a previously exported project bundle",
    "  " + cyan("doctor") + "                    Diagnose your setup and print actionable fixes",
    "  " + cyan("hook-install") + "              Install Claude Code SessionEnd auto-claim hook",
    "  " + cyan("hook session-end") + "          (called by Claude Code) scan transcript for claims",
    "  " + cyan("dashboard") + " [--port --open] Launch a read-only web UI on 127.0.0.1 (default port 18796)",
    "  " + cyan("help") + "                      Show this message",
    "",
    bold("Examples:"),
    "  " + dim("# First-time setup"),
    "  claude-amplifier init",
    "  claude-amplifier seed",
    "",
    "  " + dim("# Inspect what Claude remembers"),
    "  claude-amplifier list my-project",
    "  claude-amplifier stats",
    "",
    "  " + dim("# Back up before something risky"),
    "  claude-amplifier export my-project --out backup.json",
    "",
    "Docs: " + cyan("https://github.com/Sisuthros/claude-amplifier"),
    "",
  ];
  console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// `init` — set up Claude Desktop / Claude Code MCP config automatically
// ---------------------------------------------------------------------------

interface InitOptions {
  project?: string;
  target?: "desktop" | "code" | "both" | "auto";
  cwd?: string;
  writeClaudeMd?: boolean | null; // null = ask / auto, true = always, false = never
}

function detectInstallation(): { desktop: boolean; codeCwd: string | null } {
  const desktop = existsSync(findClaudeDesktopConfigPath());
  const cwd = process.cwd();
  const codeCwd = existsSync(join(cwd, ".claude")) || existsSync(join(cwd, "CLAUDE.md")) ? cwd : null;
  return { desktop, codeCwd };
}

/**
 * The marker block that `init` writes into CLAUDE.md. Idempotent — if the
 * marker is already present the block is left alone. Surrounding marker
 * comments let future versions detect + upgrade the block without
 * duplicating it.
 */
const AMPLIFIER_BLOCK_START = "<!-- claude-amplifier:start -->";
const AMPLIFIER_BLOCK_END = "<!-- claude-amplifier:end -->";

function buildAmplifierBlock(projectName: string): string {
  return [
    AMPLIFIER_BLOCK_START,
    "## Claude Amplifier",
    "",
    "At the **start of every session**, before any other action, call:",
    "",
    "```",
    `amplify_context_load({ project: "${projectName}", types: ["all"] })`,
    "```",
    "",
    "This restores prior decisions, lessons, and patterns for this project.",
    "Before any risky task, call `amplify_preflight({ project, task })` to",
    "check for known failure patterns. Record new insights with",
    "`amplify_record_claim`, then promote them to `confirmed` with",
    "`amplify_verify_claim` once you have evidence.",
    AMPLIFIER_BLOCK_END,
  ].join("\n");
}

/**
 * Insert (or upgrade) the amplifier block in CLAUDE.md. Returns
 * "created" | "updated" | "already-present" | "missing-file".
 */
function updateClaudeMd(
  cwd: string,
  projectName: string,
): "created" | "updated" | "already-present" | "missing-file" {
  const path = join(cwd, "CLAUDE.md");
  const block = buildAmplifierBlock(projectName);

  if (!existsSync(path)) {
    return "missing-file";
  }

  const existing = readFileSync(path, "utf-8");
  const hasStart = existing.includes(AMPLIFIER_BLOCK_START);
  const hasEnd = existing.includes(AMPLIFIER_BLOCK_END);

  if (hasStart && hasEnd) {
    // Replace the existing block in place — keeps surrounding content intact.
    const before = existing.slice(0, existing.indexOf(AMPLIFIER_BLOCK_START));
    const afterIdx = existing.indexOf(AMPLIFIER_BLOCK_END) + AMPLIFIER_BLOCK_END.length;
    const after = existing.slice(afterIdx);
    const replaced = before + block + after;
    if (replaced === existing) return "already-present";
    writeFileSync(path, replaced, "utf-8");
    return "updated";
  }

  // Append the block at the end with a separating blank line.
  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  const sep = needsLeadingNewline ? "\n\n" : existing.endsWith("\n\n") ? "" : "\n";
  writeFileSync(path, existing + sep + block + "\n", "utf-8");
  return "updated";
}

export function cmdInit(opts: InitOptions = {}): number {
  const detected = detectInstallation();
  const target = opts.target ?? "auto";
  const projectName =
    opts.project ?? process.cwd().replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "default";

  let configuredAny = false;

  const mcpEntry = {
    command: "claude-amplifier",
    args: ["mcp"],
    env: { CLAUDE_AMPLIFIER_PROJECT: projectName },
  };

  // Claude Desktop
  if ((target === "desktop" || target === "both" || target === "auto") && detected.desktop) {
    const path = findClaudeDesktopConfigPath();
    const cfg = readJsonSafe(path) as { mcpServers?: Record<string, unknown> };
    cfg.mcpServers = cfg.mcpServers ?? {};
    cfg.mcpServers["claude-amplifier"] = mcpEntry;
    writeJsonPretty(path, cfg);
    console.log(green("✓") + " Configured Claude Desktop");
    console.log(dim("  " + path));
    configuredAny = true;
  } else if (target === "desktop") {
    console.log(
      yellow("!") + " Claude Desktop config not found at " + dim(findClaudeDesktopConfigPath())
    );
  }

  // Claude Code (project-level .mcp.json)
  const cwd = opts.cwd ?? process.cwd();
  if (target === "code" || target === "both" || (target === "auto" && (detected.codeCwd || !detected.desktop))) {
    const path = findClaudeCodeMcpPath(cwd);
    const cfg = readJsonSafe(path) as { mcpServers?: Record<string, unknown> };
    cfg.mcpServers = cfg.mcpServers ?? {};
    cfg.mcpServers["claude-amplifier"] = { type: "stdio", ...mcpEntry };
    writeJsonPretty(path, cfg);
    console.log(green("✓") + " Configured Claude Code");
    console.log(dim("  " + path));
    configuredAny = true;
  }

  if (!configuredAny) {
    console.log(yellow("!") + " Nothing was configured. Pass --target=desktop or --target=code to force.");
    return 1;
  }

  // CLAUDE.md auto-update — the biggest first-run friction was that users
  // had to remember to add the `amplify_context_load` call themselves.
  // We do it automatically when CLAUDE.md exists, unless the user passed
  // `--no-write-claude-md`.
  const shouldWriteClaudeMd = opts.writeClaudeMd !== false;
  if (shouldWriteClaudeMd) {
    const result = updateClaudeMd(cwd, projectName);
    switch (result) {
      case "updated":
        console.log(green("✓") + " Added amplify_context_load block to " + cyan("CLAUDE.md"));
        break;
      case "already-present":
        console.log(dim("·") + " CLAUDE.md already has the amplify block");
        break;
      case "missing-file":
        console.log(
          yellow("!") +
            " No CLAUDE.md in " +
            dim(cwd) +
            " — create one and re-run to add the start-of-session call.",
        );
        break;
    }
  }

  console.log("");
  console.log(bold("Next steps:"));
  console.log("  1. Restart Claude Desktop or open a new Claude Code session");
  console.log("  2. Run " + cyan("claude-amplifier seed") + " to populate recommended starter lessons");
  if (opts.writeClaudeMd === false) {
    console.log("  3. Add to your " + cyan("CLAUDE.md") + " manually:");
    console.log(dim("       At the START of every session:"));
    console.log(dim("         amplify_context_load({ project: \"" + projectName + "\", types: [\"all\"] })"));
  }
  console.log("");
  return 0;
}

// ---------------------------------------------------------------------------
// `seed` — insert recommended starter lessons
// ---------------------------------------------------------------------------

const STARTER_LESSONS: Array<Record<string, unknown>> = [
  {
    type: "insight",
    title: "Check the clock at session start",
    description:
      "Run `date` (or equivalent) on the first bash call of every session. Don't assume the time is the same as the previous message — the user may have slept, the day may have rolled over. If there is an 8h+ gap or a date change, mention it before continuing the work.",
    trigger:
      "Session begins or resumes, and time is being inferred from the previous message instead of measured.",
    resolution:
      "First bash command of every session = `date`. Compare to the previous message timestamp if visible. If the gap is significant, surface it.",
    prevention:
      "Cheap, free, paints a realistic situational picture and catches the case where the user stepped away.",
    severity: "medium",
    tags: ["session-start", "time-awareness", "workflow"],
    pattern_key: "check-time-at-session-start",
  },
  {
    type: "insight",
    title: "Confirm cwd before running anything destructive",
    description:
      "Before `rm`, `git reset`, `docker compose down`, or any command whose blast radius depends on the working directory: run `pwd` first. Claude has been known to assume the previous shell's cwd carried over when it did not.",
    trigger:
      "About to run a destructive shell command and have not just printed pwd.",
    resolution: "First instinct on any destructive op: pwd. The two-second check has saved real repos.",
    prevention: "Cheap, fast, makes one entire category of accidents go away.",
    severity: "high",
    tags: ["shell", "safety"],
    pattern_key: "verify-cwd-before-destructive-shell",
  },
  {
    type: "insight",
    title: "Read the docs before guessing config keys",
    description:
      "When configuring an unfamiliar tool, search its documentation for the exact key/flag name before guessing. Strict-validation tools will crash; permissive ones will silently register the wrong setting and look fine until they don't.",
    trigger: "About to write a config value for a tool whose schema is unclear.",
    resolution:
      "Find the docs (or the source), search for the key name. If it isn't there, the key probably isn't real.",
    prevention: "Two minutes of reading saves two hours of debugging a silently-misconfigured system.",
    severity: "medium",
    tags: ["config", "documentation"],
    pattern_key: "read-docs-before-coding",
  },
];

export function cmdSeed(opts: { project?: string } = {}): number {
  const store = new SQLiteStore();
  const project =
    opts.project ?? process.cwd().replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "default";

  let added = 0;
  let bumped = 0;
  for (const seed of STARTER_LESSONS) {
    const result = store.recordLesson({ ...seed, project } as Parameters<
      SQLiteStore["recordLesson"]
    >[0]);
    if (result.created) {
      added++;
      console.log(green("+") + " " + (seed.title as string));
    } else {
      bumped++;
      console.log(dim("· ") + (seed.title as string) + dim(" (already present, frequency now " + result.lesson.frequency + ")"));
    }
  }
  console.log("");
  console.log(bold(`Seeded ${added} new lesson(s), ${bumped} already present.`));
  console.log("Project: " + cyan(project));
  return 0;
}

// ---------------------------------------------------------------------------
// `list` — show lessons + decisions for a project
// ---------------------------------------------------------------------------

export function cmdList(opts: { project?: string } = {}): number {
  const store = new SQLiteStore();
  const project = opts.project;

  const lessons = project ? store.getLessons(project) : store.getAllLessons();
  const decisions = project ? store.getDecisions(project) : store.getAllDecisions();

  console.log(bold(`Lessons (${lessons.length}):`));
  for (const l of lessons.slice(0, 50)) {
    const freq = (l.frequency ?? 1) > 1 ? dim(` ×${l.frequency}`) : "";
    const sev = l.severity === "critical" ? color("[CRIT]", "31") : l.severity === "high" ? yellow("[HIGH]") : dim("[" + l.severity + "]");
    console.log("  " + sev + " " + l.title + freq + dim(" — " + l.project));
  }
  if (lessons.length > 50) console.log(dim(`  …and ${lessons.length - 50} more`));

  console.log("");
  console.log(bold(`Decisions (${decisions.length}):`));
  for (const d of decisions.slice(0, 50)) {
    const status = d.status === "superseded" ? dim("[superseded]") : green("[active]");
    console.log("  " + status + " " + d.title + dim(" — " + d.project));
  }
  if (decisions.length > 50) console.log(dim(`  …and ${decisions.length - 50} more`));

  console.log("");
  console.log(
    dim(`Hint: run \`claude-amplifier stats\` for storage details, or \`claude-amplifier export ${project ?? "<project>"} --out backup.json\` to back this up.`)
  );
  return 0;
}

// ---------------------------------------------------------------------------
// `stats` — storage info
// ---------------------------------------------------------------------------

export function cmdStats(): number {
  const store = new SQLiteStore();
  const lessons = store.getAllLessons();
  const decisions = store.getAllDecisions();
  const patterns = store.getAllPatterns();

  const byProject = new Map<string, { lessons: number; decisions: number }>();
  for (const l of lessons) {
    const slot = byProject.get(l.project) ?? { lessons: 0, decisions: 0 };
    slot.lessons++;
    byProject.set(l.project, slot);
  }
  for (const d of decisions) {
    const slot = byProject.get(d.project) ?? { lessons: 0, decisions: 0 };
    slot.decisions++;
    byProject.set(d.project, slot);
  }

  console.log(bold("Claude Amplifier — storage stats"));
  console.log(dim(`Database: ${store.dbPath}`));
  console.log("");
  console.log(`  Total lessons:    ${cyan(String(lessons.length))}`);
  console.log(`  Total decisions:  ${cyan(String(decisions.length))}`);
  console.log(`  Global patterns:  ${cyan(String(patterns.length))}`);
  console.log(`  Projects:         ${cyan(String(byProject.size))}`);
  console.log("");
  console.log(bold("Per-project breakdown:"));
  const sorted = Array.from(byProject.entries()).sort((a, b) => (b[1].lessons + b[1].decisions) - (a[1].lessons + a[1].decisions));
  for (const [proj, n] of sorted.slice(0, 20)) {
    console.log(`  ${proj}: ${n.lessons} lesson(s), ${n.decisions} decision(s)`);
  }
  if (sorted.length > 20) console.log(dim(`  …and ${sorted.length - 20} more projects`));

  // Recurring patterns (frequency > 1)
  const recurring = lessons
    .filter((l) => (l.frequency ?? 1) > 1)
    .sort((a, b) => (b.frequency ?? 1) - (a.frequency ?? 1));
  if (recurring.length > 0) {
    console.log("");
    console.log(bold(`Top recurring patterns (frequency > 1):`));
    for (const l of recurring.slice(0, 10)) {
      console.log(`  ×${l.frequency}  ${l.title} ${dim("(" + l.project + ")")}`);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// `export` / `import`
// ---------------------------------------------------------------------------

export function cmdExport(opts: { project: string; out?: string }): number {
  const store = new SQLiteStore();
  const lessons = store.getLessons(opts.project);
  const decisions = store.getDecisions(opts.project);

  const bundle = {
    format: "claude-amplifier-export-v1",
    exported_at: new Date().toISOString(),
    project: opts.project,
    lessons,
    decisions,
  };

  const out = opts.out ?? `${opts.project}-amplifier-export.json`;
  writeFileSync(out, JSON.stringify(bundle, null, 2) + "\n", "utf-8");
  console.log(green("✓") + " Exported " + bold(opts.project) + " to " + cyan(out));
  console.log(`  ${lessons.length} lesson(s), ${decisions.length} decision(s)`);
  return 0;
}

export function cmdImport(opts: { file: string }): number {
  if (!existsSync(opts.file)) {
    console.error(yellow("!") + " File not found: " + opts.file);
    return 1;
  }
  const bundle = JSON.parse(readFileSync(opts.file, "utf-8"));
  if (bundle.format !== "claude-amplifier-export-v1") {
    console.error(yellow("!") + " Unrecognised export format: " + bundle.format);
    return 1;
  }
  const store = new SQLiteStore();
  let lessonsAdded = 0;
  let decisionsAdded = 0;
  for (const l of bundle.lessons ?? []) {
    const result = store.recordLesson(l);
    if (result.created) lessonsAdded++;
  }
  for (const d of bundle.decisions ?? []) {
    store.addDecision(d);
    decisionsAdded++;
  }
  console.log(green("✓") + " Imported from " + bold(opts.file));
  console.log(`  ${lessonsAdded} new lesson(s), ${decisionsAdded} new decision(s)`);
  return 0;
}

// ---------------------------------------------------------------------------
// `doctor` — diagnose common setup issues
// ---------------------------------------------------------------------------

export function cmdDoctor(): number {
  console.log(bold("Claude Amplifier — doctor"));
  console.log("");

  // Node version
  const nodeVer = process.versions.node;
  const major = parseInt(nodeVer.split(".")[0], 10);
  if (major >= 18) {
    console.log(green("✓") + ` Node.js ${nodeVer}`);
  } else {
    console.log(yellow("✗") + ` Node.js ${nodeVer} is too old. Need >= 18.`);
  }

  // Database
  try {
    const store = new SQLiteStore();
    const lessons = store.getAllLessons();
    console.log(green("✓") + ` Database OK: ${store.dbPath}`);
    console.log(dim(`  ${lessons.length} lesson(s) total`));
  } catch (e) {
    console.log(yellow("✗") + " Database error: " + (e as Error).message);
  }

  // Claude Desktop config
  const desktopPath = findClaudeDesktopConfigPath();
  if (existsSync(desktopPath)) {
    const cfg = readJsonSafe(desktopPath) as { mcpServers?: Record<string, unknown> };
    if (cfg.mcpServers && (cfg.mcpServers as Record<string, unknown>)["claude-amplifier"]) {
      console.log(green("✓") + " Claude Desktop has claude-amplifier configured");
    } else {
      console.log(yellow("?") + " Claude Desktop installed but no claude-amplifier entry.");
      console.log(dim("  Fix: claude-amplifier init"));
    }
  } else {
    console.log(dim("·") + " Claude Desktop not detected at " + desktopPath);
  }

  // Claude Code .mcp.json in cwd
  const codePath = findClaudeCodeMcpPath(process.cwd());
  if (existsSync(codePath)) {
    const cfg = readJsonSafe(codePath) as { mcpServers?: Record<string, unknown> };
    if (cfg.mcpServers && (cfg.mcpServers as Record<string, unknown>)["claude-amplifier"]) {
      console.log(green("✓") + " .mcp.json in cwd has claude-amplifier");
    } else {
      console.log(dim("·") + " .mcp.json in cwd has no claude-amplifier entry");
    }
  } else {
    console.log(dim("·") + " No .mcp.json in current directory (only relevant for Claude Code)");
  }

  // CLAUDE_AMPLIFIER_PROJECT env var
  if (process.env.CLAUDE_AMPLIFIER_PROJECT) {
    console.log(green("✓") + " CLAUDE_AMPLIFIER_PROJECT=" + process.env.CLAUDE_AMPLIFIER_PROJECT);
  } else {
    console.log(dim("·") + " CLAUDE_AMPLIFIER_PROJECT not set (will fall back to cwd basename)");
  }

  console.log("");
  console.log("If everything is ✓ or ·, you're good to go.");
  console.log("If any ✗ or ?, follow the fix hint or open an issue.");
  return 0;
}

// ---------------------------------------------------------------------------
// Argv parser (tiny, no dependencies)
// ---------------------------------------------------------------------------

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        flags[a.slice(2)] = args[++i];
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

export async function runCli(rawArgs: string[]): Promise<number> {
  const [cmd, ...rest] = rawArgs;
  const { positional, flags } = parseFlags(rest);

  switch (cmd) {
    case "init": {
      // `--write-claude-md` / `--no-write-claude-md` toggle the
      // auto-update of CLAUDE.md. Default (undefined) = write if file exists.
      let writeClaudeMd: boolean | null = null;
      if (flags["write-claude-md"] === true) writeClaudeMd = true;
      else if (flags["no-write-claude-md"] === true || flags["write-claude-md"] === false) {
        writeClaudeMd = false;
      }
      return cmdInit({
        project: (flags.project as string) || undefined,
        target: (flags.target as InitOptions["target"]) || "auto",
        writeClaudeMd,
      });
    }
    case "seed":
      return cmdSeed({ project: (flags.project as string) || undefined });
    case "list":
      return cmdList({ project: positional[0] });
    case "stats":
      return cmdStats();
    case "export":
      if (!positional[0]) {
        console.error("Usage: claude-amplifier export <project> [--out file.json]");
        return 1;
      }
      return cmdExport({ project: positional[0], out: (flags.out as string) || undefined });
    case "import":
      if (!positional[0]) {
        console.error("Usage: claude-amplifier import <file.json>");
        return 1;
      }
      return cmdImport({ file: positional[0] });
    case "doctor":
      return cmdDoctor();
    case "hook-install": {
      const { cmdHookInstall } = await import("./cli_hook.js");
      const scope = (flags.scope as "project" | "user") || "project";
      return cmdHookInstall({ scope, dryRun: flags["dry-run"] === true });
    }
    case "hook": {
      // `claude-amplifier hook session-end` — dispatched by Claude Code itself.
      const sub = positional[0];
      if (sub !== "session-end") {
        console.error("Usage: claude-amplifier hook session-end (called by Claude Code)");
        return 1;
      }
      const { runHookSessionEnd } = await import("./cli_hook.js");
      return await runHookSessionEnd();
    }
    case "dashboard": {
      const { startDashboard } = await import("./dashboard/server.js");
      const port = flags.port ? parseInt(String(flags.port), 10) : 18796;
      if (Number.isNaN(port) || port <= 0 || port > 65535) {
        console.error("Invalid --port (expected 1-65535).");
        return 1;
      }
      const open = flags.open === true || flags.open === "true";
      try {
        const handle = await startDashboard({ port, open });
        console.log(green("✓") + " Dashboard running at " + cyan(handle.url));
        console.log(dim("  Bound to 127.0.0.1 only (read-only, no auth needed)."));
        console.log(dim("  Press Ctrl+C to stop."));
        // Keep the process alive until SIGINT.
        await new Promise<void>((resolveStop) => {
          const stop = () => {
            console.log("\n" + dim("Shutting down…"));
            handle.close().finally(() => resolveStop());
          };
          process.on("SIGINT", stop);
          process.on("SIGTERM", stop);
        });
        return 0;
      } catch (err) {
        console.error("Dashboard failed to start: " + (err as Error).message);
        return 1;
      }
    }
    case "help":
    case "-h":
    case "--help":
      printHelp();
      return 0;
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error("Run `claude-amplifier help` for a list of commands.");
      return 1;
  }
}
