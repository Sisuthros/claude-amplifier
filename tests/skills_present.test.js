// Static check: the Karpathy-style operating cards under .claude/skills/
// exist and are well-formed. These cards are the executable "how" that
// complements the CLAUDE.md doctrine (the "why"). A missing or malformed
// card is a silent gap in the agent's operating manual, so we gate on it.
//
// This is intentionally lightweight — it checks structure, not prose
// quality: YAML frontmatter with name + description, a procedure/steps
// section, and either a required-output artifact or a verification rule.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, "..", ".claude", "skills");

const REQUIRED_SKILLS = [
  "triage-stale-memory",
  "record-verified-lesson",
  "investigate-write-failure",
  "add-mcp-tool",
  "release-npm-version",
  "design-memory-eval",
];

/** Pull the `key: value` out of a leading `---` YAML frontmatter block. */
function parseFrontmatter(md) {
  // Normalize line endings so the parser is robust regardless of the
  // checkout's autocrlf setting (CRLF on Windows, LF on CI/Linux). A stray
  // \r at end-of-line would otherwise break the value regex below.
  const text = md.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (kv) fm[kv[1].trim()] = kv[2].trim();
  }
  return fm;
}

describe(".claude/skills operating cards", () => {
  test("the skills directory exists", () => {
    assert.ok(
      existsSync(SKILLS_DIR),
      `.claude/skills/ must exist at ${SKILLS_DIR}`,
    );
  });

  for (const name of REQUIRED_SKILLS) {
    describe(name, () => {
      const file = join(SKILLS_DIR, name, "SKILL.md");

      test("SKILL.md file exists", () => {
        assert.ok(existsSync(file), `${name}/SKILL.md must exist`);
      });

      test("has frontmatter with name + description", () => {
        const md = readFileSync(file, "utf8");
        const fm = parseFrontmatter(md);
        assert.ok(fm, `${name}: missing --- frontmatter --- block`);
        assert.ok(fm.name, `${name}: frontmatter missing 'name'`);
        assert.equal(
          fm.name,
          name,
          `${name}: frontmatter name '${fm.name}' must match dir name`,
        );
        assert.ok(
          fm.description && fm.description.length >= 20,
          `${name}: frontmatter needs a substantive 'description'`,
        );
      });

      test("describes a procedure / steps", () => {
        const md = readFileSync(file, "utf8").toLowerCase();
        assert.ok(
          /## procedure|## required steps|\n1\.\s/.test(md),
          `${name}: must contain a Procedure/Steps section or a numbered list`,
        );
      });

      test("specifies a required output artifact or a verification rule", () => {
        const md = readFileSync(file, "utf8").toLowerCase();
        assert.ok(
          /required output|verification rule|read-back|npm test|tests or fixtures/.test(
            md,
          ),
          `${name}: must state a required output artifact or a verification rule`,
        );
      });
    });
  }
});
