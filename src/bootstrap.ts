import path from "path";
import { SQLiteStore } from "./storage.js";
import { handleContextLoad } from "./tools.js";

/**
 * Resolve the project name from environment variables or the current
 * working directory.  Priority:
 *   1. CLAUDE_AMPLIFIER_PROJECT env var (treated as a path if it contains a
 *      separator, otherwise as a bare project name)
 *   2. process.cwd()
 */
export function resolveProject(): { name: string; source: string } {
  const envVal = process.env.CLAUDE_AMPLIFIER_PROJECT;

  if (envVal) {
    // Could be a bare name ("my-project") or a full path ("/home/user/code/my-project")
    const hasPathSep = envVal.includes("/") || envVal.includes("\\");
    if (hasPathSep) {
      const parts = envVal.replace(/\\/g, "/").split("/");
      const name = parts.filter(Boolean).pop() || envVal;
      return { name, source: `CLAUDE_AMPLIFIER_PROJECT (path: ${envVal})` };
    }
    return { name: envVal, source: "CLAUDE_AMPLIFIER_PROJECT (name)" };
  }

  const cwd = process.cwd();
  const parts = cwd.replace(/\\/g, "/").split("/");
  const name = parts.filter(Boolean).pop() || cwd;
  return { name, source: `cwd (${cwd})` };
}

/**
 * Warm-start: load context for the resolved project and return a summary
 * string that can be emitted as a server startup message.
 */
export async function bootstrap(store: SQLiteStore): Promise<string> {
  const { name, source } = resolveProject();

  try {
    const ctx = await handleContextLoad(store, {
      project: name,
      types: ["lessons", "decisions", "patterns"],
    });

    return [
      `Claude Amplifier started.`,
      `Auto-loaded context for project '${name}' (source: ${source}).`,
      ``,
      ctx,
    ].join("\n");
  } catch (err) {
    return `Claude Amplifier started. Could not auto-load context for '${name}': ${
      (err as Error).message
    }`;
  }
}
