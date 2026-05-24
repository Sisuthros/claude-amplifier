# claude-amplifier v1.4.0 — Pattern Oracle + Verification-Gated Memory

Pattern Oracle + Verification-Gated Memory. The MCP gains **five new tools** that together address the most-cited Claude memory failure modes: agents walking into known landmines (no preflight) and agents recording unverified guesses as facts (confabulation feedback loop, [anthropics/claude-code#27430](https://github.com/anthropics/claude-code/issues/27430)).

## Install

```bash
npm install -g claude-amplifier@1.4.0
```

- **npm:** https://www.npmjs.com/package/claude-amplifier/v/1.4.0
- **GitHub source:** https://github.com/Sisuthros/claude-amplifier/tree/v1.4.0
- **Tarball:** see Assets below

## What's new

### Five new MCP tools

- **`amplify_preflight`** — risk check before a task. Tokenises the task description (English + Finnish stopwords), matches against stored lessons and active decisions, scores each match by `frequency × confidence × statusWeight × token-overlap`, and returns a risk level (`low` / `medium` / `high` / `critical`) plus the matched patterns and suggested approach. Thresholds tunable via `AMPLIFIER_ORACLE_THRESHOLD_MEDIUM` / `_HIGH` / `_CRITICAL`.

- **`amplify_record_claim`** — log an unverified guess as a lesson with `verification_status: "claim"` and `confidence: 0.5`. Claims appear in preflight at 0.2x weight so they cannot drown out confirmed lessons.

- **`amplify_verify_claim`** — promote a claim to `evidence` (confidence 0.7) or `confirmed` (confidence 1.0) by attaching `{ evidence_type, evidence_link, notes }` records. Evidence types: `build_passed`, `test_passed`, `user_confirmation`, `independent_observation`, `external_doc`, `production_metric`.

- **`amplify_promote_pattern`** — graduate a recurring lesson to a cross-project pattern. Refuses promotion unless the `pattern_key` exists in >=2 distinct projects *and* at least one occurrence is `confirmed`.

- **`amplify_evidence_chain`** — audit trail for a single lesson or decision. Returns the original claim plus every evidence record attached over its lifetime.

### Schema additions (additive, backwards-compatible)

- New columns on `lessons` and `decisions`: `verification_status` (`claim` / `evidence` / `confirmed`), `evidence_links` (JSON array), `confidence` (REAL 0.0-1.0). Wrapped in try/catch ALTER TABLE migrations — safe to upgrade in place.
- New table: `pattern_promotions` (pattern_key, projects, freq, promoted_at).

### Pattern Oracle output (example)

```
Risk: HIGH (score 0.84)
Matched: 3 confirmed lessons, 1 active decision
- "read-docs-before-coding" (confirmed, freq=5, 2 projects)
- "avoid-ambiguous-provider-prefix" (confirmed, freq=3)
- DECISION: "Pin runtime image to exact tag, not :latest"
Suggested approach: read your runtime's model-routing docs
before touching agents.defaults.model.
```

*(Screenshot placeholder: TBD — insert real preflight output from Pattern Oracle here before publishing.)*

## Tests

- `tests/oracle.test.js` — **45 hermetic tests**, all green in ~625ms. Covers tokenisation (English + Finnish + edge cases), preflight scoring math at every risk level, claim/evidence/confirmed promotion rules, pattern-stat aggregation, evidence-chain retrieval, and full backwards compatibility with 1.3.x rows.

## Backwards compatibility

- Existing 1.3.x databases load unchanged. New columns are populated with `confirmed` / `1.0` / `[]` for legacy rows on first read.
- All eight pre-existing MCP tools keep their input and output shape. Verification fields are additive — callers that ignore them see the same behaviour as before.

## Security

Audit report: `SECURITY_AUDIT_2026-05-21.md`. Verdict: **SAFE_TO_PUBLISH** after `npm audit fix`. Transitive HTTP-stack advisories in the MCP SDK do not reach this package — Amplifier only uses `StdioServerTransport`.

## Full changelog

See `CHANGELOG.md` in the repo.
