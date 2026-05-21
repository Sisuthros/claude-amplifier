# Examples

Ready-to-use lesson and decision templates for Claude Amplifier.

Each `.json` file in this folder is a payload you can pass directly to the corresponding MCP tool — either by asking Claude ("record the lesson in `examples/lesson-read-docs-first.json`") or by piping through the CLI.

## Lesson templates

| File | Category | What it teaches |
|------|----------|-----------------|
| `lesson-read-docs-first.json` | process | Read docs/specs before writing code, not after the bug |
| `lesson-verify-cwd.json` | safety | Confirm working directory before any destructive shell command |
| `lesson-check-time-at-session-start.json` | process | Get the wall-clock time at the start of a session before any time-sensitive work |
| `lesson-no-mock-db-in-integration.json` | testing | Integration tests must hit a real database, not mocks |
| `lesson-no-secret-in-config.json` | security | Secrets belong in env vars, never in checked-in config files |
| `lesson-rename-via-tooling.json` | refactoring | Use the language server for renames, not find/replace |
| `lesson-validate-at-boundary.json` | architecture | Validate untrusted input at the system boundary, trust internal code |
| `lesson-prefer-fewer-deps.json` | dependencies | New dependencies are a long-term tax; prefer the stdlib when reasonable |
| `lesson-rate-limit-recovery.json` | reliability | Diversify LLM providers and treat 429 as a per-provider cooldown, not a per-request retry |
| `lesson-windows-path-quirks.json` | portability | `$HOME` vs `%USERPROFILE%` and `/` vs `\` — use `path.join` and the platform home helper |

## Decision templates

| File | Category | What it records |
|------|----------|------------------|
| `decision-database-choice.json` | architecture | Database engine choice with rationale and tradeoffs |
| `decision-deploy-target.json` | infrastructure | Deployment target choice (e.g. Docker on a single VPS vs. k8s) |
| `decision-database-choice-postgres.json` | architecture | Full Postgres-vs-SQLite decision with evidence, 90-day check-in, and `triggered_by` / `caused` relations |
| `decision-deploy-vercel-vs-fly.json` | infrastructure | Split frontend (Vercel) / backend (Fly.io) deployment with `restore_step` and a `relates_to` link to the database decision |

## Pattern templates

| File | Scope | What it captures |
|------|-------|------------------|
| `pattern-conventional-commits.json` | all projects | Commit message format convention |
| `pattern-no-emoji-in-code.json` | all projects | Disallow emoji in source files |
| `pattern-llm-credentials.json` | all projects | Never store LLM provider tokens in CLAUDE.md or committed configs; env-var precedence chain |

## v1.4.0 — Pattern Oracle + Verification flows

| File | Tools used | What it demonstrates |
|------|------------|----------------------|
| `lesson-claim-flow.json` | `amplify_record_claim` → `amplify_verify_claim` (×2) | Three-step claim → evidence → confirmed lifecycle for a CORS regression |
| `decision-with-evidence.json` | `amplify_decisions` (track) + `amplify_verify_claim` | Decision recorded with initial evidence, confirmed after a 30-day production check-in |
| `pattern-promotion-zeptoclaw.json` | `amplify_preflight` + `amplify_promote_pattern` | Cross-project pattern promotion when the same `pattern_key` is confirmed in ≥2 projects |
| `preflight-task-example.json` | `amplify_preflight` | Sample input and the expected risk-output shape, with matched patterns and decisions |

## Using a template

Ask Claude in any session:

> Record the lesson described in `examples/lesson-read-docs-first.json` for project `my-app`.

Claude will load the file and call `amplify_learn` with those fields. Override `project` to whatever you want.
