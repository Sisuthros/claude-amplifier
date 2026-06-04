// Packaging smoke test: the .claude/skills/*/SKILL.md operating cards are the
// executable "how" that complements the CLAUDE.md doctrine. They only help real
// npm users if they're actually IN the published tarball.
//
// `skills_present.test.js` checks the cards exist on disk in this repo. That is
// necessary but NOT sufficient: a card can exist in the source tree yet be
// excluded from the published package by an incomplete package.json `files`
// field. This test closes that gap by asking npm exactly what it would ship.
//
// We drive `npm pack --dry-run --json` (which never writes a tarball) and assert
// every required SKILL.md path appears in the reported file list. Before the
// `files` field includes ".claude", this test goes RED; after, GREEN.
//
// Design discipline (design-memory-eval): deterministic fixture (npm's own
// resolved file list, not a guess), assert the structured shape (.files[].path
// entries), and a false-positive guard (a path that must NOT be packaged).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const REQUIRED_SKILLS = [
  "triage-stale-memory",
  "record-verified-lesson",
  "investigate-write-failure",
  "add-mcp-tool",
  "release-npm-version",
  "design-memory-eval",
];

/**
 * Ask npm what it would publish, without writing a tarball. Returns the list of
 * POSIX-style relative paths npm reports in `.files[].path`.
 */
function packedFilePaths() {
  const raw = execSync("npm pack --dry-run --json", {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    // pack can be a touch slow on first run (it shells out to git); be generous.
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed = JSON.parse(raw);
  // npm pack --json returns an array with one object describing the tarball.
  assert.ok(Array.isArray(parsed) && parsed.length >= 1, "npm pack --json should return an array");
  const files = parsed[0].files;
  assert.ok(Array.isArray(files), "npm pack --json entry must have a files[] array");
  // Normalize to forward slashes so the assertions are OS-independent.
  return files.map((f) => String(f.path).replace(/\\/g, "/"));
}

describe("npm pack ships the .claude/skills operating cards", () => {
  // Resolve the file list once — npm pack is the slow part.
  let paths;
  test("npm pack --dry-run --json yields a file list", () => {
    paths = packedFilePaths();
    assert.ok(paths.length > 0, "tarball should contain files");
  });

  for (const name of REQUIRED_SKILLS) {
    test(`includes .claude/skills/${name}/SKILL.md`, () => {
      const want = `.claude/skills/${name}/SKILL.md`;
      assert.ok(
        paths.includes(want),
        `published tarball must contain ${want} — add ".claude" to package.json "files". Got entries: ${paths
          .filter((p) => p.includes(".claude"))
          .join(", ") || "(none)"}`,
      );
    });
  }

  // False-positive guard: the test only passes because the cards are genuinely
  // packaged — not because every path matches. A repo-only file that is NOT in
  // the `files` allowlist must stay out of the tarball. If this ever fails, the
  // packaging rule changed and the positive assertions above are no longer
  // meaningful.
  test("does NOT ship repo-only files like tsconfig.json or the tests dir", () => {
    paths = paths || packedFilePaths();
    assert.ok(
      !paths.includes("tsconfig.json"),
      "tsconfig.json should not be published",
    );
    assert.ok(
      !paths.some((p) => p.startsWith("tests/")),
      "the tests/ directory should not be published",
    );
  });
});
