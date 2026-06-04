---
name: record-verified-lesson
description: Use when the agent believes it has learned something. Routes the belief through claim → evidence → confirmed instead of recording a confident guess. Prefers amplify_record_claim for unverified inferences and promotes only with real evidence.
---

# Record a Verified Lesson

The core failure this product exists to prevent: **an inference silently becomes
a memory, the memory becomes a "fact," and the fact never gets verified.** This
card is the procedure that keeps a new belief honest about its own status.

Every lesson lives at one of three statuses:

```
claim (0.5 confidence)  →  evidence (0.7)  →  confirmed (1.0)
```

A `claim` weighs **5× less** than a `confirmed` lesson when the Pattern Oracle
scores risk. So a wrong guess recorded as a claim is cheap; a wrong guess
recorded as a confirmed lesson is the exact bug we are avoiding.

## When to use

Any time you are about to write down something you "learned" — a fix, a gotcha,
a rule of thumb, a cause→effect.

## Procedure

1. **Is it verified right now?**
   - **No (an inference, a theory, "this probably fixed it")** → record it as a
     claim: `amplify_record_claim({ project, title, description, ... })`. Stop
     here. Do not dress a guess up as a confirmed lesson.
   - **Yes (you have real evidence in hand)** → continue.
2. **Pick the pattern_key carefully.** Before inventing a new `pattern_key`, run
   `amplify_suggest_pattern_key({ text })`. If it returns a close existing key,
   reuse it so the same mistake-in-different-words aggregates into one lesson
   with a frequency counter, instead of fragmenting.
3. **Promote with evidence.** Promote a claim to confirmed with
   `amplify_verify_claim(...)` **only** after attaching real evidence. Valid
   evidence types:
   - `test_run` — a test you actually ran and saw pass.
   - `git_commit` — a commit hash where the fix landed.
   - `user_confirmation` — the user explicitly confirmed it.
   - `external_doc` — an authoritative doc/spec you read (link it).
   - `manual_review` — you re-read the code/output and verified directly.
   Two distinct evidence types auto-promote a claim to `confirmed`.
4. **Link the evidence exactly.** Include the concrete reference — the test name
   and result, the commit hash, the doc URL, the quoted user message. "I tested
   it" without the receipt is not evidence.
5. **Read-back gate.** Confirm the write returned a numeric id. On
   `ERROR: ... NOT recorded`, go to `investigate-write-failure`.

## Examples

**claim** (unverified inference):

```json
amplify_record_claim({
  "project": "my-app",
  "title": "Strict config validators crash on unknown keys",
  "description": "Adding a misspelled key to the gateway config seemed to crash startup. Not yet reproduced cleanly.",
  "pattern_key": "read-config-schema-before-editing"
})
// → status: claim (0.5). Weighs 5× less in the Oracle.
```

**evidence** (one receipt attached):

```json
amplify_verify_claim({
  "id": 42,
  "evidence_type": "external_doc",
  "evidence_link": "configuration-reference.md §strict-mode: unknown keys are a hard error."
})
// → status: evidence (0.7).
```

**confirmed** (a second, distinct receipt → auto-promote):

```json
amplify_verify_claim({
  "id": 42,
  "evidence_type": "test_run",
  "evidence_link": "npm test -- config.test: 'rejects unknown key' PASS"
})
// → status: confirmed (1.0). Now full-weight in the Oracle.
```

## Anti-patterns

- ❌ `amplify_learn` with a confident description for something you only inferred.
- ❌ A brand-new `pattern_key` when `amplify_suggest_pattern_key` offered a match.
- ❌ "Verified ✅" with no linkable receipt.
