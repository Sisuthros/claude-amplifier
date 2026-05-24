# Claude Amplifier

[![npm version](https://img.shields.io/npm/v/claude-amplifier.svg)](https://www.npmjs.com/package/claude-amplifier)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/claude-amplifier.svg)](https://www.npmjs.com/package/claude-amplifier)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue.svg)](https://modelcontextprotocol.io)

> Pattern Oracle preflight + verification-gated lessons for Claude.<br>
> So unverified guesses can't quietly become "memories" Claude treats as facts.

### A real five-minute story

A week ago, Claude told me an agent runtime config was broken because the model name had another provider's prefix substring in it. The fix worked. I let Claude write that down as a lesson.

A week later — different session, different model, similar config — Claude "remembered" the fix and applied it again. Except the *real* problem this time was a TPM cap. Claude never tested its theory; it just trusted last week's confidently-recorded fix. I lost two hours.

That's the bug. It's [filed as `anthropics/claude-code#27430`](https://github.com/anthropics/claude-code/issues/27430). It happens to everyone who lets Claude keep notes across sessions. **An inference becomes a memory. The memory becomes a "fact." The fact never gets verified.**

Claude Amplifier 1.4.0 fixes this *structurally*. Every lesson lives at one of three statuses:

```
claim (0.5 confidence)   →   evidence (0.7)   →   confirmed (1.0)
```

A guess starts as a `claim` and weighs **5× less** than a `confirmed` lesson when the Pattern Oracle scores risk. To promote, you attach evidence: `build_passed`, `test_passed`, `user_confirmation`, `production_metric`, `external_doc`, `independent_observation`. Two distinct evidence types auto-promote a claim to `confirmed`. Without evidence, the guess stays a guess — and stays quiet.

The Pattern Oracle runs *before* each task, scans your stored lessons + active decisions, and surfaces the top matches with their risk score and verification status. You see the receipts; Claude sees the receipts; nothing gets treated as gospel just because it got written down once.

### Demo

```
$ claude-amplifier preflight --project demo \
    --task "Configure agent endpoint with vendor-a/vendor-b/model-x"

🟠 HIGH RISK   score 4.20   evidence: STRONG

Matched patterns (3):
  • [confirmed] Avoid model names containing another provider's prefix
    seen 3× across 2 projects, severity: critical
  • [confirmed] Read /v1/models before configuring fallback chains
    seen 5× across 3 projects, severity: high
  • [confirmed] Heartbeat needs TPM >= 30k
    seen 2×, severity: high

Suggested approach: The 'vendor-b/' substring is parsed as vendor-b at
startup but routed as vendor-a at runtime — every heartbeat returns
"Invalid API Key". Try 'vendor-a/model-x' instead.
```

A 45-second asciinema cast of the full claim → evidence → confirmed loop lives in [`demo/`](./demo/). Render it locally with `agg amplifier-demo.cast amplifier-demo.gif` once you've recorded the cast — see [`demo/README.md`](./demo/README.md).

---

Claude is brilliant inside one conversation and **shockingly oblivious** across sessions. Claude Amplifier is an [MCP](https://modelcontextprotocol.io) server that gives Claude persistent memory in a local SQLite database — decisions you've made, lessons you've learned, patterns you keep tripping over — so the next session starts where the last one left off.

---

## The problem

These are real moments. They happen to everyone who uses Claude regularly:

> 💤 **Claude told me to *"get some sleep"* — at 6 PM.** I had just come home from work. The previous session had run from 02:00 to 06:00 and Claude assumed the conversation was continuous.

> 🗃️ **Claude keeps suggesting MongoDB.** We switched to Postgres three months ago. I've explained why four times this week.

> 🪓 **Claude `rm -rf`'d a directory it thought was in `/tmp`.** It was the project root. The pwd had changed two prompts earlier.

> 🪞 **The same bug keeps re-appearing in code review.** Three different sessions, three nearly-identical mistakes. Claude has no memory that any of them happened.

> 🌀 **Claude wrote down a "lesson" that wasn't true.** It guessed a config key was wrong, the build still failed for an unrelated reason, and now that guess is in memory — feeding back into every future session as if it were verified. ([#27430](https://github.com/anthropics/claude-code/issues/27430))

Claude Amplifier doesn't fix Claude. It gives Claude a **place to remember** so you don't have to be the memory — and as of **v1.4.0**, a **Pattern Oracle** that warns Claude *before* it walks into a known landmine, plus **Verification-Gated Memory** that distinguishes between *claimed*, *evidenced*, and *confirmed* lessons so guesses can't quietly poison future advice.

---

## What it actually does

```
   ┌─────────────────────────────────────────────────────────┐
   │  Session 1 — Monday morning                             │
   │  > Claude tries to mock the DB in an integration test   │
   │  You: "no, mock divergence burned us last quarter"      │
   │  → amplify_learn({ title: "Don't mock the DB", ... })   │
   └─────────────────────────────────────────────────────────┘
                            ↓
              [ SQLite DB in ~/.claude-amplifier/ ]
                            ↓
   ┌─────────────────────────────────────────────────────────┐
   │  Session 2 — Friday afternoon                           │
   │  > amplify_context_load({ project: "my-api" })          │
   │  Claude already knows: integration tests use real DB.   │
   │  No re-explanation needed.                              │
   └─────────────────────────────────────────────────────────┘
```

Ten MCP tools, five SQLite tables, zero cloud — your memory stays on your disk.

### New in v1.4.0 — Pattern Oracle + Verification-Gated Memory

```
   ┌─────────────────────────────────────────────────────────┐
   │  Before Claude starts a task                            │
   │  > amplify_preflight({ task: "Configure agent endpoint" })│
   │  ⚠️  HIGH RISK (score 4.2)                              │
   │  Matched patterns:                                      │
   │    • "Ambiguous provider-prefix in model name"          │
   │      (seen 3× across 2 projects, CONFIRMED)             │
   │  Evidence quality: STRONG                               │
   │  Suggested approach: Read docs first, single-prefix names │
   └─────────────────────────────────────────────────────────┘
                            ↓
   ┌─────────────────────────────────────────────────────────┐
   │  When Claude records a lesson it just inferred          │
   │  > amplify_record_claim({ ... })          status: claim │
   │                                                         │
   │  Later, after the build passes:                         │
   │  > amplify_verify_claim({ id: 17,                       │
   │      evidence_type: "build_passed", ... })              │
   │                                              → evidence │
   │  Then you confirm:                                      │
   │  > amplify_verify_claim({ id: 17,                       │
   │      evidence_type: "user_confirmation" })              │
   │                                             → confirmed │
   └─────────────────────────────────────────────────────────┘
```

The Oracle weights matches by status: a `confirmed` lesson at score 1.0 counts five times as much as a raw `claim` at 0.2, so unverified guesses can't drown out hard-won truth.

---

## Quick start

```bash
# 1. Install
npm install -g claude-amplifier

# 2. Wire up Claude Desktop + Claude Code + your CLAUDE.md — all at once
claude-amplifier init

# 3. Plant the recommended starter lessons (see "Recommended starter lessons" below)
claude-amplifier seed

# 4. Restart Claude. That's it.
```

`init` auto-detects Claude Desktop and Claude Code, registers the MCP server in their config, **and inserts the `amplify_context_load` call into your project's `CLAUDE.md`** between two marker comments so future runs upgrade in place. If you'd rather wire CLAUDE.md yourself, pass `--no-write-claude-md`.

---

## How does this compare to other memory tools?

Different products solve different shapes of "AI memory." This table is honest about which tool wins which axis — claude-amplifier is *not* a vector store, *not* an agent runtime, and *not* a knowledge graph. It's a queryable log of **decisions, lessons, and recurrence patterns** that Claude can consult before it acts.

| Feature                              | claude-amplifier      | `@mcp/server-memory` | mem0                  | Letta / MemGPT       | Vector-memory MCPs    |
| ------------------------------------ | :-------------------: | :------------------: | :-------------------: | :------------------: | :-------------------: |
| Local-only / no telemetry            | ✅ SQLite              | ✅                    | partial (self-host)   | partial (self-host)  | varies                |
| Persistent storage                   | ✅                     | ✅                    | ✅                     | ✅                    | ✅                     |
| Decisions w/ rationale + lifecycle   | ✅ (v1.1.0)            | ❌                    | ❌                     | partial (free-form)  | ❌                     |
| Recurrence counter + pattern grouping| ✅ (`pattern_key`)     | ❌                    | partial (dedup)       | ❌                    | ❌                     |
| Knowledge graph between items        | ✅ (decision-level)    | ✅ (entity-relation)  | ✅ (graph store)       | ❌                    | ❌                     |
| Semantic / embedding retrieval       | ❌ (token-overlap)     | ❌                    | ✅                     | ✅                    | ✅                     |
| Self-editing agent memory blocks     | ❌                     | ❌                    | ❌                     | ✅ (core feature)     | ❌                     |
| Preflight risk check before a task   | ✅ Pattern Oracle      | ❌                    | ❌                     | ❌                    | ❌                     |
| Verification-gated (claim → confirmed)| ✅ (v1.4.0)           | ❌                    | ❌                     | ❌                    | ❌                     |
| Cross-project pattern promotion      | ✅ (v1.4.0)            | ❌                    | partial (multi-user)  | ❌                    | ❌                     |
| MCP-compatible out of the box        | ✅                     | ✅                    | ✅ (mem0-plugin)       | partial (via API)    | ✅                     |
| CLI for setup / inspection / backup  | ✅                     | ❌                    | ❌ (SaaS dashboard)    | ❌ (web UI)           | varies                |

### When to use which

- **mem0** — when you need a production-grade memory layer with embeddings, hybrid retrieval, and entity linking for an AI agent already in production. Best paired with LangGraph / CrewAI / a chatbot serving real users.
- **Letta / MemGPT** — when memory itself is a reasoning task and you're building a full-stack agent with a self-editing OS-style memory tier. You adopt Letta's runtime, not just its memory.
- **`@modelcontextprotocol/server-memory`** — when you want the official Anthropic-shipped option for an entity-relation knowledge graph and don't need lifecycle, recurrence, or verification.
- **Vector memory MCPs** (community SQLite-vec, Chroma-backed, etc.) — when the job is semantic search over a pile of notes or lessons and similarity is the only retrieval signal you need.
- **claude-amplifier** — when you want Claude to **remember *why* you decided this, *what* keeps going wrong, and *when* you scheduled a follow-up** — and to *warn you before* it walks into a pattern that has burned you three times already. Optimised for solo / small-team engineering, not for serving end-users.

---

## Your first 5 minutes

After `init` + `seed`, try this:

1. Open a fresh Claude session in a project where Claude Amplifier is configured.
2. Tell Claude something architectural:

   > "We use Postgres for transactional data and ClickHouse for analytics. Don't ever suggest one for the other."

3. Watch Claude call `amplify_decisions`:

   ```json
   amplify_decisions({
     op: "track",
     project: "my-project",
     category: "architecture",
     title: "Postgres for tx, ClickHouse for analytics",
     description: "...",
     rationale: "..."
   })
   ```

4. Close the session. Open a new one tomorrow. First thing Claude does (per your `CLAUDE.md`):

   ```
   amplify_context_load({ project: "my-project", types: ["all"] })
   ```

5. Now ask: *"Should we put the order events in MongoDB?"*

   Claude already knows the answer — and **why**.

Run `claude-amplifier list my-project` from your terminal at any time to see exactly what Claude is remembering.

---

## Recommended starter lessons

The `claude-amplifier seed` command plants three battle-tested insights that cover ~80% of *"why is Claude doing this?"* moments. Each one is recorded with a `pattern_key` so future occurrences bump a counter instead of duplicating.

### 1. Check the clock at session start

> *True story: Claude told one of our testers to "go get some sleep" — at 6 PM. They had just come home from work. Claude assumed the conversation was a continuation of the previous night's marathon at 06:00. Without knowing what time it is, an AI happily talks past you for hours.*

This one teaches Claude to run `date` as the first bash call of every session and flag big gaps before continuing the work.

### 2. Verify cwd before running anything destructive

`pwd` before `rm`. `pwd` before `git reset`. `pwd` before `docker compose down`. Two seconds of typing has saved real repos.

### 3. Read the docs before guessing config keys

Strict-validation tools crash. Permissive ones silently misconfigure. The fix in both cases is the same: read the docs *before* writing the key, not after the deploy fails.

Run `claude-amplifier seed` to install all three. Custom seeds? See [`examples/`](./examples/).

---

## CLI commands

```bash
claude-amplifier init             # Auto-wire Claude Desktop / Claude Code
claude-amplifier seed             # Plant the starter lessons
claude-amplifier list [project]   # Show what Claude remembers
claude-amplifier stats            # Storage totals + recurring patterns
claude-amplifier export <project> # JSON backup for one project
claude-amplifier import <file>    # Restore from a JSON backup
claude-amplifier doctor           # Diagnose your setup
claude-amplifier mcp              # Run the MCP server (default when no args)
claude-amplifier help             # All of the above, with examples
```

The CLI is opt-in — Claude Desktop and Claude Code only ever call the MCP server. Use the CLI when you want to **see what's in there** or **back it up before something risky**.

---

## Manual configuration (if `init` doesn't fit your setup)

### Claude Desktop

```json
// macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
// Windows: %APPDATA%\Claude\claude_desktop_config.json
// Linux:   ~/.config/Claude/claude_desktop_config.json

{
  "mcpServers": {
    "claude-amplifier": {
      "command": "claude-amplifier",
      "args": ["mcp"],
      "env": { "CLAUDE_AMPLIFIER_PROJECT": "my-project" }
    }
  }
}
```

### Claude Code

Put `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "claude-amplifier": {
      "type": "stdio",
      "command": "claude-amplifier",
      "args": ["mcp"]
    }
  }
}
```

If `CLAUDE_AMPLIFIER_PROJECT` is not set, the project name is inferred from the current working directory's basename.

---

## MCP tools (reference)

### `amplify_context_load` — warm up Claude's memory

Call this at the start of every session.

```js
amplify_context_load({ project: "my-api", types: ["all"] })
// or load specific types
amplify_context_load({ project: "my-api", types: ["decisions", "lessons"] })
// or pass a path — project name is inferred from the basename
amplify_context_load({ project_path: "/home/user/code/my-api" })
```

**`types` options:** `lessons` | `decisions` | `patterns` | `bootstrap` | `all`

The response also surfaces two lifecycle sections automatically:

- **⏰ Overdue outcome check-ins** — decisions you scheduled a follow-up for that have passed their date.
- **🔧 Restore steps for active decisions** — concrete recovery actions if the system was reset.

### `amplify_learn` — record a lesson

```js
amplify_learn({
  project: "my-api",
  type: "mistake",                    // mistake | success | insight | warning
  title: "Never use floats for currency",
  description: "Rounding errors caused €0.01 discrepancies at scale.",
  resolution: "Switched to integer cents everywhere.",
  prevention: "Always store money as integers (cents). Never float.",
  severity: "high",                   // low | medium | high | critical
  tags: ["money", "types"],
  trigger: "when storing monetary values in any database column",
})
```

#### Recurrence tracking

If you record the same lesson twice (same `project + title + type`), Claude Amplifier **bumps a `frequency` counter** instead of creating a duplicate. Seeing *"(seen 3×)"* next to a lesson is a strong signal to fix the root cause.

#### `pattern_key` — fuzzy pattern grouping (v1.2.0)

Recurring patterns rarely surface with identical wording. *"Read provider docs first,"* *"Check the API spec,"* and *"Look at the runtime config reference"* are three separate lessons, but they're all the same underlying pattern. Setting `pattern_key` makes Claude Amplifier treat them as one:

```js
amplify_learn({
  project: "my-api",
  type: "mistake",
  title: "Read provider docs first",
  description: "...",
  pattern_key: "read-docs-before-coding",  // ← same key for all variants
  severity: "high",
})
```

Future lessons with the same `pattern_key` in the same project bump the existing frequency, regardless of title wording.

| Field         | Required | Notes                                                       |
| ------------- | :------: | ----------------------------------------------------------- |
| `project`     | ✓        | Project name                                                |
| `title`       | ✓        | Short descriptive title                                     |
| `description` | ✓        | What happened and why it matters                            |
| `type`        | —        | Default: `insight`                                          |
| `severity`    | —        | Default: `medium`                                           |
| `context`     | —        | Surrounding circumstances                                   |
| `resolution`  | —        | How it was fixed                                            |
| `prevention`  | —        | How to avoid it next time                                   |
| `tags`        | —        | String array for filtering                                  |
| `trigger`     | —        | What state causes this pattern to surface                   |
| `pattern_key` | —        | Explicit pattern grouping for fuzzy recurrence (v1.2.0)     |

### `amplify_decisions` — track architectural decisions

```js
// Record
amplify_decisions({
  op: "track",
  project: "my-api",
  category: "architecture",
  title: "Use event sourcing for the order domain",
  description: "All order state changes stored as immutable events.",
  rationale: "Audit trail required by compliance. Also enables replay for debugging.",
  tags: ["orders", "eventsourcing"],
})

// List active
amplify_decisions({ op: "get", project: "my-api" })

// Search
amplify_decisions({ op: "search", query: "database", project: "my-api" })

// Replace when things change
amplify_decisions({ op: "supersede", id: 3 })
```

**Operations:** `track | get | search | supersede | revert | update | update_outcome | overdue`

#### `op: "update"` — refine without superseding (v1.2.0)

`supersede` is for replacing a decision with a *different* choice (Postgres → CockroachDB). When you just want to add a follow-up step, mark an outcome, or fix a typo, use `update`:

```js
amplify_decisions({
  op: "update",
  id: 42,
  next_step: "Now blocked on AWS organization approval",
  blocked_on: "Platform team to enable cross-account replication",
  outcome_check_in: "+14d",
})
```

This avoids 5-link supersede chains when the underlying choice never changed.

#### Lifecycle metadata (v1.1.0)

```js
amplify_decisions({
  op: "track",
  project: "my-api",
  title: "Switch image hosting to S3",
  description: "...",
  rationale: "Cheaper at scale, CDN-ready.",

  outcome_check_in: "+30d",        // surfaces in context_load when due
  restore_step: "terraform apply in infra/s3-images/ — secrets in Vault",
  next_step: "Migrate the last 10% of legacy URLs",
  blocked_on: "AWS Org admin must enable cross-account replication",
  trade_offs: ["Lose local-only debugging", "Adds AWS bill ~€30/mo"],
  alternatives_considered: ["Cloudflare R2", "Self-hosted MinIO"],
  supersedes: 7,
  relations: {
    triggered_by: [3],
    caused: [],
    relates_to: [12],
  },
})
```

#### `amplify_link_decisions` — knowledge graph links (v1.2.0)

```js
amplify_link_decisions({ from: 42, to: 38, relation: "triggered_by" })
```

Relations: `triggered_by` (`from` was caused by `to`), `caused` (`from` led to `to`), `relates_to` (loose association). Idempotent.

### `amplify_preflight` — risk check before a task (v1.4.0)

Run this *before* Claude touches anything you'd rather not break. The Oracle scans your stored lessons and active decisions for matches on the task description, then returns a risk level and the patterns it matched.

```js
amplify_preflight({
  project: "my-api",
  task: "Configure agent endpoint with new model name",
  context: "production agent setup",
})
```

Response shape:

```
⚠️  HIGH RISK (score 4.20)
Evidence quality: STRONG

Matched patterns (3):
  • [confirmed] Avoid model names containing another provider's prefix
    seen 3× across 2 projects, severity: critical
  • [confirmed] Read provider /v1/models before configuring fallback chains
    seen 5× across 3 projects, severity: high
  • [evidence] Heartbeat models need TPM ≥ 30k
    seen 2×, severity: high

Active decisions referenced (1):
  • Agent heartbeat primary: high-TPM provider/model

Suggested approach: Read your runtime's model-routing docs before
choosing the model string. Verify the chosen name against `GET /v1/models`.
```

Risk levels: `low` (score < 1.0), `medium` (< 3.0), `high` (< 6.0), `critical` (≥ 6.0). Thresholds are tunable via `AMPLIFIER_ORACLE_THRESHOLD_MEDIUM` / `_HIGH` / `_CRITICAL`.

Confirmed lessons count five times as much as raw claims — see *Verification-Gated Memory* below.

### `amplify_record_claim` — log an unverified guess (v1.4.0)

When Claude infers a fix but hasn't actually verified it works yet, record it as a `claim`. Claims show up in preflight at reduced weight (0.2× vs 1.0× for confirmed) so unverified guesses can't poison future advice.

```js
amplify_record_claim({
  project: "my-api",
  type: "mistake",
  title: "Suspect: missing CORS header on /api/upload",
  description: "Build failed after refactor. CORS header was removed in commit abc123.",
  severity: "medium",
})
// → returns { id: 17, status: "claim", confidence: 0.5 }
```

### `amplify_verify_claim` — promote claim → evidence → confirmed (v1.4.0)

```js
// First evidence — promotes claim → evidence (confidence 0.7)
amplify_verify_claim({
  id: 17,
  evidence_type: "build_passed",
  evidence_link: "https://github.com/.../actions/runs/12345",
  notes: "CI green after re-adding the header",
})

// User confirmation — promotes evidence → confirmed (confidence 1.0)
amplify_verify_claim({
  id: 17,
  evidence_type: "user_confirmation",
  notes: "User confirmed: 'yes that was it'",
})
```

**Promotion rules:**
- `claim + 1 evidence` → `evidence` (confidence 0.7)
- `evidence + user_confirmation` → `confirmed` (confidence 1.0)
- `claim + 2 distinct evidence types` → `confirmed` (confidence 1.0)
- Explicit `promote_to` overrides the auto-rule

Evidence types: `build_passed` | `test_passed` | `user_confirmation` | `independent_observation` | `external_doc` | `production_metric`.

### `amplify_promote_pattern` — graduate a recurring lesson to global (v1.4.0)

When the same `pattern_key` has produced `confirmed` lessons in ≥2 projects, it has earned the right to a global pattern. This tool requires:
- The `pattern_key` exists in ≥2 distinct projects
- At least one confirmed lesson with that key

```js
amplify_promote_pattern({
  pattern_key: "avoid-ambiguous-provider-prefix",
  title: "Avoid model names containing another provider's prefix",
  description: "Some agent runtimes parse the model string by substring to infer the provider. A name like 'vendor-a/vendor-b/model-x' may route as vendor-b at runtime but authenticate as vendor-a at startup, returning 'Invalid API Key' on every heartbeat.",
  example: "Use 'vendor-a/model-x' (single, unambiguous prefix) instead.",
})
```

Refuses promotion when the threshold isn't met — pattern_keys with only one project of evidence are *not* generalizable yet.

### `amplify_evidence_chain` — show why a lesson is trusted (v1.4.0)

```js
amplify_evidence_chain({ id: 17, kind: "lesson" })
// or
amplify_evidence_chain({ id: 42, kind: "decision" })
```

Returns the full chain: original claim → each evidence link with type, link URL, who recorded it, and when → final status. Useful when you want to audit *why* the Oracle scored a task as high-risk.

### `amplify_global_patterns` — cross-project rules

```js
amplify_global_patterns({
  op: "add",
  title: "Always back up before destructive operations",
  description: "Before any rm -rf, DROP TABLE, or file overwrite: make a backup first.",
  example: "cp -r ./data ./data.bak.$(date +%s)",
  tags: ["safety", "ops"],
})
```

---

## FAQ

**Q: How is this different from putting things in `CLAUDE.md`?**

`CLAUDE.md` is a *prompt* — read fully every session, costs tokens, and grows linearly forever. Claude Amplifier is a *queryable database* — Claude pulls in only what's relevant when it's relevant, and lessons that have happened three times look different from lessons that happened once.

**Q: Is anything sent to a server?**

No. Everything is in `~/.claude-amplifier/amplifier.db` on your own disk. No telemetry, no cloud, no syncing.

**Q: Why not [mem0 / Letta / MemGPT]?**

Those are full-stack memory systems with embeddings, retrieval, and orchestration. Great for production agents. Claude Amplifier is an opinionated *toolkit* for "I want Claude to remember things and tell me when patterns recur" — same SQLite the official MCP memory server uses, with a few features that matter for actual engineering work (`pattern_key`, decision lifecycles, recurrence counters).

**Q: Can I use this in Claude Code AND Claude Desktop simultaneously?**

Yes. They share the same SQLite database, so a lesson recorded in one is visible from the other.

**Q: Will my lessons survive a Claude Amplifier upgrade?**

Yes — the SQLite schema is forward-compatible. The `migrate()` step adds new columns without touching existing rows. Backup with `claude-amplifier export <project>` if you want to be cautious.

**Q: What's the performance like?**

Reading: indexed SQLite + WAL mode. Sub-millisecond up to ~50,000 rows. Writing: same order. The bottleneck is Claude reading the context, not the database serving it.

**Q: Can I share lessons across machines or teammates?**

Use `claude-amplifier export <project> --out lessons.json`, share the file, then `claude-amplifier import lessons.json` on the other side. Cloud sync is intentionally not built in — your team's hard-won architectural decisions probably shouldn't leave the building.

---

## Roadmap

The next things on the table — open an issue if any of these matter to you and you'd like it to jump:

- **Semantic search** — embed lessons + decisions for fuzzy "do we have anything like this?" lookups (Oracle currently uses token-overlap matching)
- **Multi-project linking** — a decision in `frontend-app` can reference a constraint from `infra-platform`
- **Claude Code SessionStart hook** — auto-call `context_load` without needing CLAUDE.md instruction
- **Web dashboard** — read-only browser view of what Claude remembers (still local-only)
- **Project archetypes** — `claude-amplifier seed --archetype=nodejs-saas` plants 20+ stack-specific lessons
- **Auto-claim recording** — Claude-Code hook that wraps lessons-from-conversation into `record_claim` automatically

---

## Data storage

```
~/.claude-amplifier/amplifier.db
```

Five tables: `lessons`, `decisions`, `patterns`, `preferences`, `pattern_promotions`. WAL mode enabled.

Lessons and decisions carry three v1.4.0 columns each: `verification_status` (`claim` / `evidence` / `confirmed`), `confidence` (0.0–1.0), and `evidence_links` (JSON array of evidence records).

Inspect directly with any SQLite tool:

```bash
sqlite3 ~/.claude-amplifier/amplifier.db ".tables"
sqlite3 ~/.claude-amplifier/amplifier.db "SELECT title, frequency FROM lessons WHERE frequency > 1 ORDER BY frequency DESC LIMIT 10;"
sqlite3 ~/.claude-amplifier/amplifier.db "SELECT id, title, status FROM decisions WHERE status='active';"
```

---

## Configuration

### `CLAUDE_AMPLIFIER_PROJECT`

Auto-bootstraps context on server startup.

```bash
# Path (project name inferred from the directory basename)
CLAUDE_AMPLIFIER_PROJECT=/home/user/projects/my-app

# Or bare project name
CLAUDE_AMPLIFIER_PROJECT=my-app
```

If not set, falls back to `process.cwd()`.

---

## Contributing

Found a real-world pattern that should be a starter lesson? PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Build from source

```bash
git clone https://github.com/Sisuthros/claude-amplifier
cd claude-amplifier
npm install
npm run build
npm test            # 45 tests, all should pass
node dist/index.js help
```

## License

MIT — see [LICENSE](./LICENSE).
