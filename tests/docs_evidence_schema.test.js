// Documentation drift guard: the evidence schema is canonicalized in CODE,
// and the docs must match it — never the other way around.
//
// The handler `handleVerifyClaim` (src/tools.ts) and the `amplify_verify_claim`
// tool schema (src/index.ts) are the single source of truth:
//
//   evidence_type enum = git_commit | test_run | user_confirmation
//                      | external_doc | manual_review
//   field name        = evidence_link   (NOT a bare `evidence`)
//
// Earlier docs invented a DIFFERENT enum (build_passed, test_passed,
// production_metric, independent_observation) and one SKILL.md used the wrong
// field name `evidence`. A reader who copy-pastes those examples gets an
// `Error: evidence_type must be one of ...` or a missing-required-field error.
// This test scans the user-facing docs and FAILS if any stale term or a bare
// `evidence:`/`evidence=` field reappears in a verify-claim example, so the
// drift cannot silently come back.
//
// Design discipline (design-memory-eval):
//   - deterministic fixture: the docs files themselves, read off disk;
//   - assert the structured shape (per-file, per-term location reporting);
//   - false-positive guard: prove the scan WOULD catch a stale term by feeding
//     it a synthetic stale string, AND prove a canonical example is accepted.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SKILLS_DIR = join(REPO_ROOT, ".claude", "skills");

// Stale evidence_type values that were never valid in the code. Matched as
// whole words so we don't trip over unrelated prose.
const STALE_EVIDENCE_TYPES = [
  "build_passed",
  "test_passed",
  "production_metric",
  "independent_observation",
];

// The canonical enum, for the positive assertion side.
const CANONICAL_EVIDENCE_TYPES = [
  "git_commit",
  "test_run",
  "user_confirmation",
  "external_doc",
  "manual_review",
];

/** Collect every user-facing doc the package ships or an agent reads. */
function docFiles() {
  const files = [join(REPO_ROOT, "README.md"), join(REPO_ROOT, "CLAUDE.md")];
  if (existsSync(SKILLS_DIR)) {
    for (const name of readdirSync(SKILLS_DIR)) {
      const card = join(SKILLS_DIR, name, "SKILL.md");
      if (existsSync(card)) files.push(card);
    }
  }
  return files;
}

/** Find stale evidence_type words. Returns [{ line, text }] for reporting. */
function findStaleEvidenceTypes(content) {
  const hits = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const term of STALE_EVIDENCE_TYPES) {
      // Whole-word match: stale enum literals don't appear inside other tokens.
      const re = new RegExp(`\\b${term}\\b`);
      if (re.test(lines[i])) hits.push({ line: i + 1, term, text: lines[i].trim() });
    }
  }
  return hits;
}

// The `amplify_promote_pattern` tool schema (src/tool_schemas.ts) and its
// handler `handlePromotePattern` (src/tools.ts) accept exactly ONE property:
// `pattern_key`. The title/description/example are DERIVED from the confirmed
// lessons already carrying that key — the caller does not (and cannot) pass
// them. An earlier README example invented a full `{ pattern_key, title,
// description, example }` payload; a reader who copies it gets silently-ignored
// args and a false mental model of how promotion works. Flag any property other
// than `pattern_key` inside a promote_pattern example.
const PROMOTE_PATTERN_ALLOWED_KEYS = ["pattern_key"];

/**
 * Find `amplify_promote_pattern({ ... })` example blocks that pass any property
 * other than `pattern_key`. Returns [{ line, key }] for reporting. Scans the
 * brace-delimited argument object that follows the call (handles multi-line
 * examples). Only inspects object KEYS (identifier or quoted, followed by `:`),
 * so prose mentioning the word "title" elsewhere is not flagged.
 */
function findPromotePatternExtraKeys(content) {
  const hits = [];
  const callRe = /amplify_promote_pattern\s*\(\s*\{/g;
  let m;
  while ((m = callRe.exec(content)) !== null) {
    // Walk forward from the opening brace, balancing nesting, to find the end
    // of the argument object. Track line numbers for reporting.
    const start = m.index + m[0].length - 1; // index of the `{`
    let depth = 0;
    let end = -1;
    for (let i = start; i < content.length; i++) {
      const ch = content[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue; // unbalanced — skip rather than false-flag
    const block = content.slice(start, end + 1);
    const blockStartLine = content.slice(0, start).split("\n").length;
    // Match object keys at any nesting depth: `key:` or `"key":` or `'key':`.
    const keyRe = /(?:^|[{,\s])["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*:/g;
    let k;
    while ((k = keyRe.exec(block)) !== null) {
      const key = k[1];
      if (!PROMOTE_PATTERN_ALLOWED_KEYS.includes(key)) {
        const lineInBlock = block.slice(0, k.index).split("\n").length - 1;
        hits.push({ line: blockStartLine + lineInBlock, key });
      }
    }
  }
  return hits;
}

/**
 * Find a BARE `evidence` field (the wrong field name) used in a verify-claim
 * example. We only flag `evidence:` / `evidence =` where it's used as a KEY —
 * i.e. immediately followed by a quoted/value, not the English word "evidence"
 * in prose, and not the legitimate field `evidence_link` / `evidence_links` /
 * `evidence_type` / `evidence_chain` / `evidence-chain`.
 */
function findBareEvidenceField(content) {
  const hits = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match `evidence:` or `evidence =` as an object/CLI key. The negative
    // lookahead rejects evidence_link / evidence_type / evidence_chain etc.
    // Allow an optional leading quote so JSON `"evidence":` is caught too.
    const re = /["']?\bevidence["']?\s*[:=]\s*["']/;
    if (re.test(line) && !/\bevidence_(link|links|type|chain)\b/.test(line)) {
      // Extra guard: only flag when the value looks like a verify-claim
      // receipt (a string), which the trailing quote in the regex already
      // ensures. Record the hit.
      hits.push({ line: i + 1, text: line.trim() });
    }
  }
  return hits;
}

describe("docs match the canonical evidence schema (code is source of truth)", () => {
  const files = docFiles();

  test("the docs files exist", () => {
    assert.ok(existsSync(join(REPO_ROOT, "README.md")), "README.md must exist");
    assert.ok(existsSync(join(REPO_ROOT, "CLAUDE.md")), "CLAUDE.md must exist");
    assert.ok(existsSync(SKILLS_DIR), ".claude/skills/ must exist");
  });

  for (const file of files) {
    const rel = file.replace(REPO_ROOT + "/", "").replace(REPO_ROOT + "\\", "");

    test(`${rel} uses no stale evidence_type values`, () => {
      const content = readFileSync(file, "utf8");
      const hits = findStaleEvidenceTypes(content);
      assert.equal(
        hits.length,
        0,
        `${rel} contains stale evidence_type term(s) — the code enum is ` +
          `${CANONICAL_EVIDENCE_TYPES.join(" | ")}. Offending lines:\n` +
          hits.map((h) => `  L${h.line} (${h.term}): ${h.text}`).join("\n"),
      );
    });

    test(`${rel} uses evidence_link, never a bare \`evidence\` field`, () => {
      const content = readFileSync(file, "utf8");
      const hits = findBareEvidenceField(content);
      assert.equal(
        hits.length,
        0,
        `${rel} uses a bare \`evidence\` field — the canonical field is ` +
          `\`evidence_link\`. Offending lines:\n` +
          hits.map((h) => `  L${h.line}: ${h.text}`).join("\n"),
      );
    });

    test(`${rel} amplify_promote_pattern examples pass only pattern_key`, () => {
      const content = readFileSync(file, "utf8");
      const hits = findPromotePatternExtraKeys(content);
      assert.equal(
        hits.length,
        0,
        `${rel} passes unsupported arg(s) to amplify_promote_pattern — the ` +
          `tool schema accepts ONLY 'pattern_key' (title/description/example ` +
          `are derived from the confirmed lessons). Offending keys:\n` +
          hits.map((h) => `  L${h.line}: ${h.key}`).join("\n"),
      );
    });
  }

  // ── False-positive guard ────────────────────────────────────────────
  // Prove the scanners actually fire on bad input and stay quiet on good
  // input — otherwise an all-green run might just mean the scan is inert.
  test("scanner WOULD catch a stale enum value (proves the guard works)", () => {
    const synthetic = `amplify_verify_claim({ evidence_type: "build_passed" })`;
    assert.equal(
      findStaleEvidenceTypes(synthetic).length,
      1,
      "stale-enum scanner must flag a known-bad evidence_type",
    );
  });

  test("scanner WOULD catch a bare `evidence` field (proves the guard works)", () => {
    const synthetic = `amplify_verify_claim({ "evidence": "I tested it" })`;
    assert.equal(
      findBareEvidenceField(synthetic).length,
      1,
      "bare-field scanner must flag a `evidence:` key",
    );
  });

  test("scanner ACCEPTS the canonical schema (no false positive)", () => {
    const good = `amplify_verify_claim({ evidence_type: "test_run", evidence_link: "npm test PASS" })`;
    assert.equal(findStaleEvidenceTypes(good).length, 0, "canonical enum must pass");
    assert.equal(findBareEvidenceField(good).length, 0, "evidence_link must not be flagged");
  });

  test("scanner WOULD catch promote_pattern extra args (proves the guard works)", () => {
    const bad = [
      "amplify_promote_pattern({",
      '  pattern_key: "avoid-x",',
      '  title: "Avoid X",',
      '  description: "...",',
      '  example: "...",',
      "})",
    ].join("\n");
    const hits = findPromotePatternExtraKeys(bad);
    assert.deepEqual(
      hits.map((h) => h.key).sort(),
      ["description", "example", "title"],
      "must flag every non-pattern_key arg",
    );
  });

  test("scanner ACCEPTS a pattern_key-only promote_pattern example", () => {
    const good = `amplify_promote_pattern({ pattern_key: "avoid-ambiguous-provider-prefix" })`;
    assert.equal(
      findPromotePatternExtraKeys(good).length,
      0,
      "the canonical single-arg example must pass",
    );
  });
});
