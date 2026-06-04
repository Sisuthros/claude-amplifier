---
name: triage-stale-memory
description: Use when amplify_context_load reports stale memory files (memory/<date>.md newer than the latest Amplifier write). Triages unrecorded work into decisions/lessons and records only the load-bearing ones, with read-back confirmation.
---

# Triage Stale Memory

`CLAUDE.md` is the doctrine. This card is the executable procedure for one
specific situation: **a session did real work in a memory-hook log but never
recorded a lesson or decision for it**, so `amplify_context_load` ends its
output with a stale-memory warning.

Stale memory is the *second* shape of memory drift (the first is hallucinated
write-success). Treat it the same way: nothing counts until Amplifier reads it
back.

## When to use

- `amplify_context_load` output ends with a stale-memory warning, OR
- you suspect a previous session logged work to `~/.claude/memory/<date>.md`
  but forgot to persist any lesson/decision.

## Procedure

1. **Audit.** Run `amplify_audit_freshness` to get the exact list of stale
   memory days (files newer than the latest Amplifier write).
2. **Draft, don't record.** For each stale file, run
   `amplify_promote_from_memory_md({ memory_file: "<path>" })`. This **records
   nothing** — it returns DRAFT suggestions only.
3. **Classify each draft** into exactly one of:
   - **decision** — an architectural / tooling / process choice → record with
     `amplify_decisions({ op: "track", ... })`.
   - **lesson** — a mistake, insight, or confirmed fix → record with
     `amplify_learn(...)` (or `amplify_record_claim` if it is an *unverified*
     inference — see `record-verified-lesson`).
   - **discard** — noise, one-off, or already captured. Do nothing.
4. **Record only load-bearing items.** A draft is load-bearing only if a future
   session would make a worse decision without it. When unsure, prefer
   `amplify_record_claim` (a claim weighs 5× less than a confirmed lesson) over
   inventing a confident lesson.
5. **Read-back gate.** After each write, confirm Amplifier actually persisted it
   (the tool re-reads the row; a real write returns a numeric id, a failure
   returns `ERROR: ... NOT recorded`). **Never claim the stale work was captured
   until read-back confirms it.** If you see an ERROR, switch to
   `investigate-write-failure` — do not retry blindly.

## Required output artifact

Write a triage record to:

```
./knowledge/stale_memory_triage_{YYYY-MM-DD}.md
```

Use today's date (run `date` first — do not assume the date). The file must list,
per stale file: each draft, its classification (decision/lesson/discard), and —
for recorded items — the returned numeric id (proof of read-back). Discards get
a one-line reason.

## Anti-patterns

- ❌ Recording every draft "to be safe" — this floods the Pattern Oracle with
  noise and dilutes real signal.
- ❌ Reporting "captured the stale day" before any read-back returned an id.
- ❌ Promoting an unverified inference as a `confirmed` lesson. Use a claim.
