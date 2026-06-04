---
name: investigate-write-failure
description: Use when any Amplifier tool returns "ERROR: Lesson NOT recorded" or "ERROR: Decision NOT recorded". Diagnoses the write-verification failure instead of retrying blindly, and produces a write-failure report.
---

# Investigate a Write Failure

In v1.5.0, every `addLesson` / `addDecision` re-reads its row from SQLite before
returning. If the follow-up SELECT comes back empty, the tool returns
`ERROR: Lesson NOT recorded. Do not claim this was saved.` and appends an audit
line to `~/.claude-amplifier/write-errors.jsonl`.

This ERROR is a feature, not a flake. It means the database genuinely did **not**
get your write. The wrong move is to retry the identical call and hope; the right
move is to find out *why* the read-back failed.

## When to use

A tool returned `ERROR: Lesson NOT recorded` or `ERROR: Decision NOT recorded`
(or any `AmplifierWriteError`).

## Procedure

1. **Do not retry blindly.** One failed write, then one more identical write, is
   the stuck-loop pattern. Diagnose first.
2. **Read the audit trail.** Inspect `~/.claude-amplifier/write-errors.jsonl`
   (append-only; the failing call's arguments and timestamp are the last line).
   Look for the real cause: bad/oversized arguments, a constraint violation, a
   transient SQLite lock, a permissions/disk issue.
3. **Run the doctor.** Run `claude-amplifier doctor` — it diagnoses common setup
   issues (DB path, write permissions, schema state) and prints actionable fixes.
4. **Verify the SQLite path.** Confirm the DB the tool writes to is the one you
   expect: `~/.claude-amplifier/amplifier.db` by default (overridable via the
   storage path env). Check it exists, is writable, and is not zero-bytes or
   locked by another process.
5. **Fix root cause, then re-attempt once.** Only after you have a named cause
   (e.g. "argument exceeded a column limit", "DB was read-only") fix it and make
   **one** corrected call. Confirm it returns a numeric id (read-back passed).
6. **Never claim success without an id.** If you still cannot get a numeric id,
   report the failure honestly — do not say the lesson/decision was saved.

## Required output artifact

Write a report to:

```
./knowledge/write_failure_report_{timestamp}.md
```

Use a real timestamp (run `date` first). The report must contain: the exact
ERROR string returned, the relevant `write-errors.jsonl` line(s), the
`claude-amplifier doctor` output, the verified DB path + its state
(exists/writable/size), the identified root cause, and the result of the single
corrected re-attempt (the numeric id on success, or an honest "still failing").

## Anti-patterns

- ❌ Retrying the identical failing call (the canonical stuck loop).
- ❌ Hallucinating a hex/numeric id to match the success-message shape. This is
  the exact bug v1.5.0 was built to kill.
- ❌ Reporting "recorded ✅" when no read-back ever returned an id.
