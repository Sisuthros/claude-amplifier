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

