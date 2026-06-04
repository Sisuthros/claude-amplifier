# Changelog

All notable changes to Claude Amplifier are documented here.

## [1.5.3] — 2026-06-05 — Official MCP Registry

Publishes Claude Amplifier to the [official MCP Registry](https://registry.modelcontextprotocol.io).
No code or tool signatures changed from 1.5.2 — this release only corrects the
registry namespace casing so the package can be verified and listed.

### Fixed

- **`mcpName` namespace casing** corrected to `io.github.Sisuthros/claude-amplifier`
  (capital `S`, matching the GitHub account). The registry's namespace
  authentication is case-sensitive; the previous lowercase value was rejected
  with HTTP 403. `package.json` and `server.json` now agree on the exact name.

### Added

- **`server.json`** — registry manifest pointing at the npm package
  (`registryType: npm`, `transport: stdio`, no spurious env vars). Validated
  against the `2025-12-11` registry schema.

## [1.5.2] — 2026-06-05 — Trust everywhere

Extends the write-verification guarantee from inserts to **every** mutation,
ships the operating cards to npm users, and makes promoted patterns actually
influence risk scoring. No tool signatures changed; every public API is
identical to 1.5.1.

### Added

- **`.claude/skills/` ships with the package.** The six operating cards
  (triage-stale-memory, record-verified-lesson, investigate-write-failure,
  add-mcp-tool, release-npm-version, design-memory-eval) are now in the npm
  tarball, with a pack smoke test asserting all six are included.
- **`mcpName`** (`io.github.sisuthros/claude-amplifier`) for the official MCP
  registry.
- **Lightweight validation helpers** (`src/validation.ts`) wired into the write
  handlers — ids, enums, required strings, arrays, relation payloads — with no
  new dependency.

### Changed

- **Write-verification now covers all mutation paths**, not just inserts. The
  frequency-bump, `updateOutcomeStatus`, `updateDecisionStatus`,
  `updateDecision`, `linkDecisions`, `verifyLesson`, and `demoteLesson` paths
  now verify rowcount / read-back. A mutation targeting a non-existent id can no
  longer report a fake success.
- **`addDecision` is atomic.** Insert + read-back + supersede-old run in a
  single transaction: a failed read-back leaves the old decision active, no
  partial supersede.
- **Promoted patterns now affect `amplify_preflight`.** A promoted, confirmed
  cross-project pattern can influence risk scoring in another project,
  down-weighted so it never drowns out local lessons.
- **Evidence schema canonicalized** across README, CLAUDE.md, and all skills to
  match the code exactly (`git_commit | test_run | user_confirmation |
  external_doc | manual_review`, field `evidence_link`). A guard test fails if
  docs drift back to stale terms.
- **`src/index.ts` split** into `src/tool_schemas.ts` (the TOOLS array) and
  `src/tool_router.ts` (dispatch); index.ts is now a thin entrypoint.

### Security

- SQL-injection audit (clean) re-run on the new code: the only dynamic SQL is
  hardcoded migration literals, an `as const` column allowlist with `?`-bound
  values, and interpolation inside a bound LIKE value — never user-controlled
  identifiers.

### Tests

- 277 tests pass (was 162). New suites: pack-includes-skills, docs-evidence-
  schema, promote-preflight, atomic-decision, mutation-readback, tool-split,
  validation.

### Backwards compatibility

- Fully compatible with 1.5.x databases and config. Type/reliability changes
  only; no schema migration, no tool signature changes.

## [1.5.1] — 2026-06-04 — Hardening & discoverability

A type-safety, concurrency, and discoverability pass. No behavior changes to
any tool — every public API is identical to 1.5.0. This release exists to make
the storage layer harder to break under real concurrent use and to make the
package findable from the official MCP registry.

### Added

- **`mcpName` field** (`io.github.sisuthros/claude-amplifier`) so the package
  can be published to the official MCP registry
  (`registry.modelcontextprotocol.io`), which downstream directories sync from.
- **`SQLiteStore.pragmas()`** — exposes the live connection's `busy_timeout`,
  `journal_mode`, and `foreign_keys` for diagnostics (`doctor`) and tests, so
  the concurrency hardening can be verified rather than assumed.
- **`safeRowid()`** — converts a BigInt `lastInsertRowid` to a JS number,
  throwing rather than silently truncating above 2^53. A wrong id that looks
  right is exactly the failure class this tool exists to prevent.

### Changed

- **Concurrency hardening.** The SQLite connection now opens with
  `{ timeout: 5000 }` plus a `busy_timeout = 5000` pragma. With two writers
  (Claude Desktop + Claude Code, or a SessionEnd hook firing mid-session) a
  same-instant write previously risked `SQLITE_BUSY`; the driver now retries
  for up to 5s before failing. WAL mode is unchanged.
- **UTF-8-aware token estimate.** `estimateTokens` now counts UTF-8 *bytes* / 4
  instead of `string.length` / 4. Finnish ä/ö, emoji, CJK, and dense code paths
  were badly under-counted before — the dangerous direction, since it let
  `context_load` overfill the budget. Still dependency-free.
- **Type safety in `storage.ts`.** All 23 `as any` casts on SQLite query
  results replaced with precise row interfaces (`LessonRow`, `DecisionRow`,
  `PatternRow`, …). No new dependency — still exactly
  `@modelcontextprotocol/sdk` + `better-sqlite3`.

### Security

- **SQL-injection audit (clean).** Every dynamic SQL construction site was
  reviewed before this release. The three interpolated sites use only hardcoded
  literals (migrations), an `as const` column allowlist with `?`-bound values
  (decision update), or interpolation inside a bound LIKE *value* — never
  user-controlled identifiers. All other queries are parameterized.

### Tests

- 162 tests pass (was 152). New: `sqlite_concurrency.test.js` (2),
  `safe_rowid.test.js` (4), `token_estimate.test.js` (4).

### Backwards compatibility

- Fully compatible with 1.5.0 databases and config. Type-only and
  reliability changes; no schema migration, no tool signature changes.

## [1.5.0] — 2026-05-26 — Trust Rebuild

### Why this release exists

A 2026-05-25 Claude session reported back five decisions and eight lessons
"recorded" with hex-style IDs like `1fd61c52af06f2bd`. None of them were
actually persisted — the storage layer returned undefined from a follow-up
`SELECT` after `INSERT`, a non-null assertion (`!`) coerced that into a
typed object, and the caller stringified the result as
`Lesson recorded (id: undefined)`. The IDs in the chat were hallucinations
on top of silent failures.

v1.5.0 makes that class of failure structurally impossible.

### Added

- **`AmplifierWriteError` + write-verification.** Every `addLesson` /
  `addDecision` re-reads the inserted row via `SELECT WHERE id = ?` before
  returning. If the row cannot be read back, storage throws a typed
  `AmplifierWriteError` and appends a structured audit line to
  `~/.claude-amplifier/write-errors.jsonl`. `handleLearn` /
  `handleDecisions(track)` catch the error and return a clear
  `ERROR: ... Do not claim this was saved` string instead of a fake
  success. (`src/storage.ts`, `src/tools.ts`,
  `tests/write_verification.test.js` — 8 tests)
- **`amplify_audit_freshness` tool + automatic context_load warning.**
  Compares `memory/<YYYY-MM-DD>.md` file mtimes against the latest
  Amplifier write for a project. If memory files are newer than the
  latest write, `amplify_context_load` emits a `⚠ Stale memory files`
  block at the end of its output, and the new tool surfaces the same
  list on demand. Catches the "session did real work but recorded
  nothing" failure mode that triggered this release.
  (`src/freshness.ts`, `tests/freshness.test.js` — 13 tests)
- **`amplify_suggest_pattern_key` tool.** Trigram Jaccard similarity
  against existing `pattern_key` values for a project. Returns up to 3
  matches above 0.3 similarity, or proposes a fresh kebab-case key if
  none match. Prevents the "two sessions invent two keys for the same
  recurring lesson" failure mode where the frequency counter never
  aggregates. Documents a known limitation: trigrams don't catch pure
  synonyms (verify ≠ confirm). (`src/pattern_suggest.ts`,
  `tests/pattern_suggest.test.js` — 12 tests)
- **`amplify_promote_from_memory_md` tool.** Reads a session-hook
  memory file (`### HH:MM — Tool/Terminal/Wrote: ...` format) and
  returns DRAFT suggestions for `amplify_learn` / `amplify_decisions`
  follow-up calls. Three heuristics: architectural filenames
  (`plan`, `decision`, `architecture`, `blueprint`, `manifesto`, etc.,
  including plurals), intense activity windows (>50 events/hour), and
  repeated identical calls (≥8×). Records nothing — the operator
  chooses what to keep. Verified against the real 2026-05-25 memory
  file: 5 candidates surfaced from 233 events. (`src/promote_memory.ts`,
  `tests/promote_memory.test.js` — 13 tests)
- **Assistant-side SessionEnd detection.** The auto-claim hook now
  detects three additional signal kinds when scanning the transcript:
  `assistant_correction` ("I was wrong", "olin väärässä"),
  `assistant_insight` ("this is a tier jump", "tason hyppy"), and
  `architecture_decision` (long writeups with arch vocabulary and
  structural markers like `next step:` / `rationale:`). Catches the
  yesterday-incident shape: a multi-thousand-word architecture review
  that should have produced a decision row but didn't.
  (`src/hooks/auto_claim_session_end.ts`,
  `tests/auto_claim_assistant_side.test.js` — 9 tests)

### Fixed

- **Unicode word boundaries for Finnish patterns.** ASCII `\b` does not
  fire around `ä` / `ö` in JavaScript regex, so existing Finnish
  patterns like `\bälä\b` silently failed for utterances starting with
  `Ä`. All Finnish-language detection patterns now use Unicode
  lookarounds (`(?<![\p{L}\p{N}])...(?![\p{L}\p{N}])` with the `u`
  flag). User-facing impact: corrections / rules / success confirmations
  in Finnish now match where they previously didn't.

### Test counts

- Before this release: 65 tests across 11 suites.
- After: 127 tests across 48 suites (62 new). All pass on Node 18/20/22
  × Linux/macOS/Windows.

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
  - `pattern-promotion-prefix-bug.json` — full pattern-promotion payload
    for an ambiguous provider-prefix bug seen across multiple projects.
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

  Real-world origin: a long Claude session can drift into an assumed
  continuation across actual calendar days. A two-line `amplify_learn`
  call that pins "check the clock at session start" stops Claude from
  recommending sleep at inappropriate hours.

## [1.2.0] — 2026-05-18

Polish release derived from real-world dogfooding of v1.1.0 the same day:
five updates to one decision (LLM model selection) revealed a missing
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
  Summary: [my-project] 24 active decisions · 47 lessons ·
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
