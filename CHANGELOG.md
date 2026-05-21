# Changelog

All notable changes to Claude Amplifier are documented here.

## [Unreleased]

### Added

- **Read-only web dashboard.** New `claude-amplifier dashboard` CLI command
  launches a localhost-only HTTP server (default port `18796`, bind
  `127.0.0.1`) that serves a vanilla HTML/CSS/JS dashboard for browsing
  stored lessons, decisions, patterns, and the v1.4.0 evidence chains and
  pattern-promotion history. Pass `--port N` to override and `--open` to
  auto-launch the browser. Vanilla JS + SVG-rendered frequency histogram,
  zero build step, no extra runtime dependencies.
- **SessionEnd auto-claim hook.** A new Claude Code SessionEnd hook
  (`claude-amplifier hook session-end`) reads the session transcript on
  exit and uses deterministic string heuristics to suggest up to three
  lesson candidates for `amplify_record_claim`. Detects three signal
  families: user corrections ("no, don't do that"), enduring rules
  ("always X", "never Y"), and success confirmations ("perfect, that
  worked"). No LLM call, no API key, no network — pure regex over the
  JSONL transcript. The hook installs in one command:
  `claude-amplifier hook-install` (`--scope user` for global). Output is
  printed as a SessionEnd `systemMessage` plus a machine-parseable
  `_amplifier` block on stdout. Suggestions are suggestions only — the
  user (or the next session's Claude) decides whether to record them.
  Implemented in `src/hooks/auto_claim_session_end.ts` (~200 LOC pure
  module) and `src/cli_hook.ts` (CLI plumbing). 15 hermetic tests in
  `tests/auto_claim.test.js`.

- **`amplify_context_load` auto-truncation + smart priority.** Large
  projects (100+ lessons) no longer flood the session with thousands
  of tokens at startup. New optional arguments on the tool:
  - `max_tokens` (default `4000`) — soft token budget for the rendered
    context. Token cost is estimated cheaply with `Math.ceil(len/4)`.
  - `priority` (default `"smart"`; also `"recent"` and `"frequency"`)
    — how lessons are ranked before truncation.
- Smart-priority scoring (in `src/tools.ts` → `smartScore`):
  `score = frequency × 2.0 + confidence × 3.0 + recency_bonus + status_weight`,
  where `recency_bonus` is `1.5` for lessons under 14 days old and
  `status_weight` is `1.5 / 1.0 / 0.3` for
  `confirmed / evidence / claim`.
- Output header now declares `Budget: <n> tokens · priority=<mode>`,
  and appends `Showed top N of M lessons. Use max_tokens=… to see more.`
  whenever truncation actually dropped items.
- New hermetic test file `tests/context_load_truncation.test.js` (6 tests):
  budget enforcement, default budget, three priority modes, and the
  truncation marker.

### Changed

- `SQLiteStore.loadContext()` accepts an optional `lessonsPoolLimit` so
  the handler can pull a wider pool (now `200`) for ranking. Calls that
  omit the argument keep the legacy `LIMIT 30` behaviour, so existing
  callers are unaffected.

### Documentation

- **README**: expanded comparison table covering mem0, Letta / MemGPT,
  `@modelcontextprotocol/server-memory`, and the broader vector-memory
  MCP category. Adds a "When to use which" guide that positions
  claude-amplifier honestly as a *why / what / when* memory — not a
  vector store, not an agent runtime, and not a knowledge graph.

### Notes

- API is fully backwards compatible: calls that omit `max_tokens` and
  `priority` still work. The only visible change for existing callers
  is the one-line `Budget:` header and a smarter default ordering for
  lessons (smart-priority instead of pure recency).

## [1.4.0] — 2026-05-21

Pattern Oracle + Verification-Gated Memory. The MCP gains five new tools
that together address the most-cited Claude memory failure modes: agents
walking into known landmines (no preflight) and agents recording
unverified guesses as facts (confabulation feedback loop,
[anthropics/claude-code#27430](https://github.com/anthropics/claude-code/issues/27430)).

### Added

- **`amplify_preflight`** — risk check before a task. Tokenises the task
  description (English + Finnish stopwords), matches against stored
  lessons and active decisions, scores each match by
  `frequency × confidence × statusWeight × token-overlap`, and returns
  a risk level (`low` / `medium` / `high` / `critical`) plus the matched
  patterns and suggested approach. Thresholds tunable via
  `AMPLIFIER_ORACLE_THRESHOLD_MEDIUM` / `_HIGH` / `_CRITICAL`.

- **`amplify_record_claim`** — log an unverified guess as a lesson with
  `verification_status: "claim"` and `confidence: 0.5`. Claims appear in
  preflight at 0.2× weight so they cannot drown out confirmed lessons.

- **`amplify_verify_claim`** — promote a claim to `evidence` (confidence
  0.7) or `confirmed` (confidence 1.0) by attaching one or more
  `{ evidence_type, evidence_link, notes }` records. Evidence types:
  `build_passed`, `test_passed`, `user_confirmation`,
  `independent_observation`, `external_doc`, `production_metric`.
  Promotion rules:
  - `claim + 1 evidence` → `evidence`
  - `evidence + user_confirmation` → `confirmed`
  - `claim + 2 distinct evidence types` → `confirmed`
  - Explicit `promote_to` overrides the auto-rule

- **`amplify_promote_pattern`** — graduate a recurring lesson to a
  cross-project pattern. Refuses promotion unless the `pattern_key`
  exists in ≥2 distinct projects *and* at least one occurrence is
  `confirmed`. Records the promotion in a new `pattern_promotions`
  table so callers can see when and why a pattern was elevated.

- **`amplify_evidence_chain`** — audit trail for a single lesson or
  decision. Returns the original claim plus every evidence record
  attached over its lifetime, used when the Oracle's verdict is
  surprising.

- **New SQLite columns on `lessons` and `decisions`:**
  `verification_status` (`claim` / `evidence` / `confirmed`),
  `evidence_links` (JSON array), `confidence` (REAL 0.0–1.0).
  Added via additive `ALTER TABLE` migrations wrapped in
  try/catch — safe to upgrade in place.

- **New table:** `pattern_promotions` (pattern_key, projects, freq,
  promoted_at).

- **`SQLiteStore` methods:** `verifyLesson(id, evidence_type,
  evidence_link, promote_to?)`, `demoteLesson(id)`, `getPatternStats()`,
  `recordPromotion(key, projects, freq)`, `getPromotion(key)`,
  `getEvidenceChain(id, kind)`, `getLessonsByPatternKey(key)`,
  `getAllLessonsForProject(project)`.

- **`src/oracle.ts`** — pure module, no I/O. Exports `preflight(input)`
  and `tokenize(text)`. Bilingual stopwords (English + Finnish).
  Active decisions add 0.5 × statusWeight to score when matched.
  ~330 LOC, fully unit-tested.

- **`examples/`** new templates:
  - `lesson-claim-flow.json` — three-step claim → evidence → confirmed
    example for a real CORS bug.
  - `decision-with-evidence.json` — decision recorded with initial
    verification status and outcome-check evidence.
  - `pattern-promotion-zeptoclaw.json` — full pattern-promotion payload
    for the openai/-prefix bug seen across multiple projects.
  - `preflight-task-example.json` — a sample input to `amplify_preflight`
    with the expected risk-output shape.

### Changed

- Server version reported to MCP clients bumped to `1.4.0`.
- `addLesson()` and `addDecision()` now default to
  `verification_status: "confirmed"` and `confidence: 1.0` when the
  caller does not specify, preserving 1.3.x behaviour.
- `parseLesson()` and `parseDecision()` return the three new fields with
  the same defaults when reading rows that pre-date 1.4.0.

### Testing

- `tests/oracle.test.js` — 45 hermetic tests covering tokenisation
  (English + Finnish + edge cases), preflight scoring math at every
  risk level, claim/evidence/confirmed promotion rules, pattern-stat
  aggregation, evidence-chain retrieval, and full backwards compatibility
  with 1.3.x rows. `npm test` runs 45 tests in ~625ms with zero failures.

### Backwards compatibility

- Existing 1.3.x databases load unchanged. New columns are populated
  with `confirmed` / `1.0` / `[]` for legacy rows on first read.
- All eight pre-existing MCP tools keep their input and output shape.
  Verification fields are additive — callers that ignore them see the
  same behaviour as before.

## [1.3.0] — 2026-05-20

First-run experience overhaul. The MCP surface area is unchanged — all
new functionality lives in a CLI that ships in the same binary, plus a
rewritten README and a real `examples/` directory.

### Added

- **CLI subcommands.** The `claude-amplifier` binary now routes argv:
  - No args (or `mcp`) → MCP stdio server, as before.
  - Anything else → CLI. Subcommands available:
    - `init` — detect Claude Desktop and Claude Code, print the exact
      config snippet to paste, and run a doctor check.
    - `seed` — pre-populate a project with three high-leverage starter
      lessons (check-time-at-session-start, verify-cwd-before-destructive-shell,
      read-docs-before-coding).
    - `list` — show recent lessons / decisions / patterns from the
      command line without opening Claude.
    - `stats` — counts per project, frequency histogram.
    - `export` / `import` — JSON dump and restore for backups or moving
      between machines.
    - `doctor` — environment + database sanity check.
    - `help` — usage reference.

  All commands are zero-dependency (no `commander`, no `chalk`) to keep
  the install footprint identical to v1.2.x.

- **`examples/` folder** ships with the npm package: 8 lesson templates,
  2 decision templates, 2 global-pattern templates, all real-world rules
  you can adapt by replacing `REPLACE_ME` with your project name.

- **`SQLiteStore.recordLesson(...)`** — public helper returning
  `{ created: boolean, lesson }` so callers (CLI, future hooks) can tell
  whether a lesson is new or an existing one bumped its frequency.

- **`SQLiteStore.getAllLessons()` / `getAllDecisions()` / `getAllPatterns()`**
  — cross-project listing for CLI `list` and `stats`. Bounded by a
  configurable limit to keep large databases responsive.

- **Public `SQLiteStore.dbPath`** — used by `doctor` and `stats` to show
  the resolved database path.

### Changed

- **README full rewrite.** Problem-first opening, ASCII data-flow diagram,
  side-by-side comparison vs. `@modelcontextprotocol/server-memory`, a
  5-minute walkthrough, FAQ (CLAUDE.md, telemetry, mem0, multi-Claude,
  upgrade safety, performance, team sharing), full MCP tool reference,
  CLI commands reference, and a roadmap.

- **`package.json`** populated for npm publish: `author: "Sisuthros"`,
  proper `repository`, `bugs`, `homepage`, expanded keywords, and `files`
  now includes `examples`, `README.md`, `CHANGELOG.md`, `LICENSE`.

- Server version reported to MCP clients bumped to `1.3.0`.

### Tests

- Build and the v1.2.0 test suite continue to pass unchanged. CLI is
  covered by `doctor` smoke output and manual end-to-end runs documented
  in CONTRIBUTING.md.

### Migration

`npm install -g claude-amplifier@1.3.0`. No database changes. The MCP
surface is wire-compatible with 1.2.x. Existing Claude Desktop / Claude
Code configs continue to work unmodified.

## [1.2.1] — 2026-05-19

Docs-only patch release. No code changes.

### Added

- **README section: "Recommended starter lessons"** — three one-line
  `amplify_learn` snippets that fix the most common cross-session
  blind spots. Run them once into a fresh database and Claude
  immediately stops:
  1. Telling you to "get some sleep" at 6 PM because it didn't check the
     clock.
  2. Running destructive shell commands in the wrong working directory.
  3. Guessing strict-validation config keys instead of reading the docs.

  Real-world origin: same author's Claude told them to go to bed at 6 PM
  on a Tuesday because the previous session had run from 02:00 to 06:00
  and Claude assumed the conversation was a continuation. A two-line
  `amplify_learn` call would have stopped this from being awkward.

## [1.2.0] — 2026-05-18

Polish release derived from real-world dogfooding of v1.1.0 the same day:
five updates to one decision (Lumen model choice) revealed a missing
"refine without replacing" operation, and three near-duplicate lessons
revealed that exact-title matching was too strict for pattern detection.

### Added

- **`op: "update"`** on `amplify_decisions` — refine an existing decision
  without superseding it. Preserves `id` and `created_at`, only changes
  fields you pass in. Use this when adding a follow-up step, marking an
  outcome, or correcting a typo — *not* when replacing the decision with
  a different choice (use `supersede` for that).

- **`pattern_key` on `amplify_learn`** — explicit grouping key for pattern
  detection. When you record a lesson with `pattern_key: "read-docs-first"`,
  any future lesson with the same key for the same project bumps a
  frequency counter instead of creating a duplicate, even if the title
  is worded differently. Title-based matching is still the fallback.

- **`amplify_link_decisions`** — new lightweight MCP tool for adding
  knowledge-graph links between existing decisions after the fact:
  ```
  amplify_link_decisions({ from: 42, to: 38, relation: "caused" })
  ```
  Idempotent — calling twice with the same args is a no-op.

- **One-line summary at the top of `amplify_context_load`** — orients
  Claude before scanning the full payload. Shows counts plus
  attention-required items (overdue check-ins, recurring patterns,
  restore steps):
  ```
  Summary: [chimera-prime] 24 active decisions · 47 lessons ·
           8 high/critical · 3 recurring (seen 3x+) ·
           ⏰ 2 overdue check-ins · 🔧 5 restore steps
  ```

### Tests

Added the project's first test suite (`tests/storage.test.js`) using
`node:test` — no extra runtime dependencies. Covers:

- `pattern_key`-based frequency aggregation across different titles
- Per-project isolation of `pattern_key`
- v1.1.0 title-fallback still working without `pattern_key`
- `updateDecision` preserving id and `created_at`, accepting empty patches,
  array-field serialisation
- `linkDecisions` idempotency, multi-target stacking, self-link rejection,
  missing-id null return
- `supersedes_id` auto-marking the older decision
- Summary line composition in `loadContext`
- Backwards compatibility with v1.0 data

Run with `npm test`.

### Migration

Run `npm install -g claude-amplifier@1.2.0`. The `pattern_key` column is
added automatically via `ALTER TABLE` on first launch. No data loss.

## [1.1.0] — 2026-05-18

Decision-lifecycle and pattern-detection upgrade. Fully backwards compatible
with v1.0.0 databases — new columns are added automatically on first run.

### Added

- **Decision lifecycle metadata**. `amplify_decisions({ op: "track", ... })`
  now accepts:
  - `outcome_check_in` — ISO date or relative (`"+7d"`, `"+30d"`). Decisions
    that pass this date with status still `pending` surface as overdue.
  - `restore_step` — recovery instructions shown every session a decision is
    active. Useful for "if the container is rebuilt, run this".
  - `next_step`, `blocked_on` — workflow hints when a decision waits on
    something or someone.
  - `trade_offs`, `alternatives_considered` — record the path not taken.
  - `supersedes` — knowledge-graph link to the older decision being replaced.
    The old decision is auto-marked `superseded`.
  - `relations` — explicit links to other decision IDs by relation type
    (`triggered_by`, `caused`, `relates_to`).

- **`op: "update_outcome"`** — mark a decision's check-in as `validated` or
  `failed` once you've confirmed whether it worked.

- **`op: "overdue"`** — list all decisions whose check-in date has passed
  without resolution.

- **Lesson `trigger` and `frequency`**. `amplify_learn` now accepts a
  `trigger` (the specific situation that surfaces this lesson) and
  automatically counts repeat occurrences:
  - Recording the same lesson (same project + title + type) bumps an
    integer `frequency` counter instead of creating a duplicate.
  - When you see `(seen 3x)` in a lesson, that's a recurring pattern worth
    fixing at the root.

- **Auto-surfaced lifecycle in `amplify_context_load`**. The response now
  includes two new sections:
  - ⏰ **Overdue Outcome Check-ins** — past-due decisions with their
    follow-up action.
  - 🔧 **Restore Steps for Active Decisions** — concrete recovery actions
    every session.

### Changed

- Bumped server version reported to MCP client from `1.0.0` to `1.1.0`.

### Migration

Run `npm install -g claude-amplifier@1.1.0`. On first launch the SQLite
database adds the new columns via `ALTER TABLE` — no data loss, no manual
migration. Pre-existing decisions and lessons continue to work; their new
fields simply default to `null` / empty array / frequency=1.

---

## [1.0.0] — 2026-05-01

Initial public release.

- `amplify_learn` — record mistakes, successes, insights, warnings.
- `amplify_decisions` — track / get / search / supersede / revert.
- `amplify_context_load` — bulk-load saved context for a session.
- `amplify_global_patterns` — cross-project conventions.
- SQLite storage in `~/.claude-amplifier/amplifier.db`, WAL mode.
- MIT license.
