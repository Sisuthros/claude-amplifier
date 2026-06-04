# CLAUDE.md — Working with Claude Amplifier

> If you're Claude (or any agent) reading this in a project that uses
> `claude-amplifier`, this is your operating manual. If you're a human
> reading this to decide whether to install Amplifier, read the README
> first — this file assumes you already know what the tool does.

## One value above all others

**Verify before claim. Evidence before inference. Read-back before trust.**

Every other rule in this file is a corollary of that one. If a rule and
that value ever conflict, the value wins.

This sounds obvious. It is not obvious to a language model running by
itself. Three real failures shaped this file:

1. A previous session "remembered" a config fix from last week and
   applied it confidently to a different problem. The fix didn't help —
   the real bug was elsewhere. The user lost two hours.
   ([anthropics/claude-code#27430](https://github.com/anthropics/claude-code/issues/27430))

2. A previous session reported `Decision recorded (id: 1fd61c52af06f2bd)`
   five times in a row. The next morning, none of the rows existed in
   SQLite. The IDs were hallucinated to match the success-message
   template; the underlying MCP calls had failed silently.

3. A previous session did six hours of substantial work that the
   filesystem (`memory/<date>.md`) captured but Amplifier never did. The
   next session loaded context, saw nothing about yesterday, and treated
   the day as if it never happened.

All three are the same shape: **the model believed its own state was
clean when the world said otherwise.** This whole tool exists to make
that class of failure structurally harder.

## Six rules that follow from the value

### 1. Load context at the start of every meaningful session

```
amplify_context_load({ project: "<name>" })
```

Run this before you start work, not after you've already begun and
realized you don't remember the project. A "meaningful session" is
anything beyond a one-off question. The cost is ~2KB of tokens; the
return is everything the project's previous you wrote down.

If `amplify_context_load` emits a `⚠ Stale memory files` warning at the
bottom, do not ignore it. Open `amplify_audit_freshness` for the
project and triage what the previous session forgot to record.

### 2. Treat a "recorded" response as a claim, not a fact

When `amplify_learn` or `amplify_decisions(track)` returns:

```
Lesson recorded (id: 42)
```

That is what the storage layer *believes* happened. v1.5.0 re-reads the
row before claiming success, so this is usually trustworthy. But if you
ever need to be sure — for example, because the surrounding chat history
suggests confusion or an earlier tool call failed — use
`amplify_decisions(op: "search")` or `amplify_decisions(op: "get")` to
confirm the row really is there. Read-back beats trust.

Conversely, if a tool returns text starting with `ERROR:`, do **not**
soften it into a success. Surface it to the human verbatim. The error
is the signal.

### 3. Pattern keys are how recurrence is counted

When you record a lesson that might happen again, attach a `pattern_key`:

```js
amplify_learn({
  project: "my-api",
  type: "mistake",
  title: "Read NIM API docs first",
  description: "...",
  pattern_key: "read-docs-before-coding"  // ← the bridge across sessions
})
```

Two sessions writing the same lesson with the same `pattern_key` produce
**one row with frequency=2**. Two sessions writing the same lesson with
*different* keys (`read-docs-first` vs `check-docs-before-coding`)
produce **two rows with frequency=1 each**, and the Pattern Oracle never
sees the recurrence.

Before coining a new key, call `amplify_suggest_pattern_key` and see
whether an existing key already covers this. Trigram similarity is
imperfect — it catches shared words, not pure synonyms — so when in
doubt, search the existing lessons for the topic first.

### 4. Claims, evidence, and confirmed lessons are different beasts

A guess that worked once is a **claim**, not a fact:

```js
amplify_record_claim({ ..., confidence: 0.5 })
```

When the claim gets validated — a test passed, the build succeeded, the
user confirmed, an external doc backed it up — promote it:

```js
amplify_verify_claim({
  id: 17,
  evidence_type: "test_run",
  evidence_link: "https://github.com/.../runs/123"
})
```

Two distinct evidence types auto-promote a claim to `confirmed`. The
Pattern Oracle weighs `confirmed` lessons **5× more heavily** than
`claim` lessons. This is what stops one lucky guess from becoming
"established truth" across future sessions.

### 5. Big findings get recorded in-session, not at the end

If a session produces something load-bearing — an architectural
decision, a hard-won lesson, a tier-jump in your understanding of the
project — record it **at the moment it crystallizes**, not "I'll
remember to write it down later." Later does not arrive. The next
session is a different you.

The 2026-05-25 incident that motivated v1.5.0's `amplify_audit_freshness`
tool was exactly this: hours of real work logged by the filesystem hook,
zero rows landed in Amplifier, because every individual moment felt too
small to record. They were not too small.

### 6. When you're wrong, say so in writing

If a previous session recorded something that turned out to be wrong,
don't quietly work around it. Either:

- Record a `mistake`-type lesson with the corrected understanding and a
  link to the wrong one, or
- Use `amplify_decisions(op: "supersede", supersedes: <old_id>, ...)` to
  retire an architectural decision that no longer holds.

The Amplifier database is a record of what was learned, including what
was learned to be wrong. Silent corrections rot the trust the tool
depends on.

## Task-specific skills

This file is the **doctrine** — the *why* and the values. The executable
*how* for specific recurring tasks lives next to it as operating cards in
`.claude/skills/<name>/SKILL.md`. Each card is a short, step-by-step
procedure with a verification rule and (usually) a required output
artifact.

When a task matches one of these, **prefer the skill before improvising** —
the card already encodes the gotchas you'd otherwise rediscover:

| Skill | Use when |
|---|---|
| `triage-stale-memory` | `amplify_context_load` reports stale memory files. |
| `record-verified-lesson` | You believe you've learned something (routes it through claim → evidence → confirmed). |
| `investigate-write-failure` | A tool returns `ERROR: Lesson/Decision NOT recorded`. |
| `add-mcp-tool` | You're adding or modifying an MCP tool. |
| `release-npm-version` | You're about to publish a new npm version. |
| `design-memory-eval` | You're changing the Oracle, stale-memory detection, verification gating, or write-verification. |

The doctrine tells you what to value; the skill tells you the exact moves.
If a skill and this file ever disagree, the value at the top of this file
still wins — and the skill should be edited to match.

## Common gotchas

These are the failure modes other operators (and I) have hit. Each one
has a fix that lives somewhere upstream.

| You see | What happened | What to do |
|---|---|---|
| `Lesson recorded (id: undefined)` | Pre-1.5.0 bug: storage couldn't read back the row, returned a coerced undefined. | Upgrade to ≥1.5.0. v1.5.0 throws `AmplifierWriteError` instead. |
| `ERROR: Lesson NOT recorded` | v1.5.0 write-verification caught a real failure. | Read the error verbatim. Check `~/.claude-amplifier/write-errors.jsonl`. Do **not** retry blindly. |
| Hex-shaped IDs like `1fd61c52af06f2bd` | A previous session hallucinated these. Real IDs are integers. | If you see one, the original write probably failed. Verify with `amplify_decisions(op: "get")` or `amplify_decisions(op: "search")`. |
| `⚠ Stale memory files` at context_load | A previous session worked but didn't record. | Run `amplify_audit_freshness` and `amplify_promote_from_memory_md` to triage what's worth keeping. |
| Two lessons with the same title, different `pattern_key` | Different sessions invented different keys. | Pick the better key, record a `supersede` or `mistake`-type lesson, and pin the canonical key in the project's notes. |
| Finnish / Swedish / non-ASCII patterns silently failing | Pre-1.5.0 bug: JavaScript `\b` doesn't fire around `ä` / `ö`. | Upgrade to ≥1.5.0. All non-ASCII patterns now use Unicode lookarounds. |

## Workflow defaults that hold up

A few small habits keep the rest of the rules cheap to follow.

**Start every session with `amplify_context_load`.** Yes, even short
ones. It is the difference between picking up a project at speed and
re-learning it from the codebase.

**Record decisions with `next_step` and `outcome_check_in`.** A
decision without a follow-up is a guess that aged into a fact. The
`outcome_check_in` field reminds future-you to validate the decision
landed correctly.

**Use `amplify_preflight` before risky tasks.** It scans your stored
lessons + active decisions for matches against the task description and
returns a risk score. Cheap; often saves a footgun.

**Use `--strict` in CI when you have memory-eval-style tests.** The
storage layer is deterministic and the regression cost of a bad write
is exactly the cost of a bad lesson, multiplied across every future
session. Worth a strict gate.

**Back up `~/.claude-amplifier/amplifier.db` somewhere durable.** SQLite
is robust; your laptop's disk is not. A few KB of compressed weekly
backup costs nothing and protects months of accumulated context.

## A word on tone

Amplifier is a tool. The lessons inside it are *yours*. When you
record one, write it for the next session of yourself who will read it
six weeks from now in a different mood. That session will not remember
why you cared about this. Spell out the why.

The good lesson is the one you would have wanted last time. The right
amount of context is the amount you would have needed.

## Open questions

These are things I haven't figured out yet, and any session that finds
real evidence one way or the other should record it as a lesson.

- **How much pattern_key matching is too much?** Currently trigram
  Jaccard ≥ 0.3. That catches shared roots but misses synonyms. An
  embedding-based suggester would be more accurate but adds a heavy
  dependency. Is the right answer to teach operators to be careful with
  keys, or to add the dependency and remove a class of mistakes?

- **Should `amplify_context_load` ever truncate decisions?** Currently
  decisions are kept whole because they're user-curated and few in
  number. But on a 5-year project this assumption breaks. What does
  graceful degradation look like at scale?

- **What's the right interface between Amplifier and other memory
  tools?** mem0, Letta, Memento, vector stores — they solve different
  shapes of "AI memory." Right now Amplifier ignores them. Should it?

- **How does this tool behave with multiple agents writing to the same
  project?** The frequency counter handles repeat-records gracefully,
  but two agents disagreeing about a `claim → confirmed` promotion has
  no protocol. Worth thinking about before multi-agent setups become
  common.

If you find yourself wondering one of these mid-session, the answer
probably wants to land in a lesson with `pattern_key: amplifier-design-question`.

## What this file is not

This is not the README. The README is for humans choosing whether to
adopt the tool. This file is for the agent (you) operating inside a
project that has adopted it.

This is not a list of bans. There's exactly one "do not": **do not
claim something was saved when it wasn't.** Everything else is a
suggestion shaped by experience.

This is not the final word. CLAUDE.md is source code — iterate on it
the way you'd iterate on any other configuration. If you find a sharper
phrasing or a missing gotcha, edit and commit.

---

**Maintained by:** Sisuthros + Claude (Opus 4.x)
**Last meaningful revision:** v1.5.0 Trust Rebuild release.
