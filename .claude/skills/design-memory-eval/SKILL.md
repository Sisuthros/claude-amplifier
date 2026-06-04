---
name: design-memory-eval
description: Use when adding or changing Pattern Oracle, stale-memory detection, verification-gated memory, or write-verification. Forces an eval-first, fixture-driven test with a false-positive guard, so trust-critical behavior is proven, not asserted in prose.
---

# Design a Memory Eval

The trust-critical paths — Pattern Oracle risk scoring, stale-memory detection,
verification-gated promotion, write-verification — are exactly the places where
a silent regression does the most damage (a wrong risk score, a missed stale
day, a hallucinated-success that slips through). Changes here must be proven by
a deterministic test, not described in a commit message.

## When to use

You are adding or modifying any of:

- the **Pattern Oracle** (pre-task risk scan / scoring),
- **stale-memory detection** (`amplify_audit_freshness`, promote-from-memory),
- **verification-gated memory** (claim → evidence → confirmed, 5× weighting),
- **write-verification** (read-back, `AmplifierWriteError`).

## Procedure

1. **Write the failing scenario first.** Before the implementation, add a test
   that encodes the behavior you want and currently fails (red). This proves the
   test actually exercises the new behavior rather than passing vacuously.
2. **Use deterministic fixture data.** No wall-clock, no randomness, no network.
   Seed an in-memory or temp SQLite store with fixed rows; pin dates as literal
   strings. The same input must always produce the same score/verdict so the
   test can't flake. (The existing `oracle.test.js`, `freshness.test.js`, and
   `write_verification.test.js` are the templates — match their style.)
3. **Assert both layers.** Where the feature returns both human-readable text and
   structured data, assert **both**: the structured field (e.g. a numeric risk
   score, a `status: "confirmed"`, a thrown `AmplifierWriteError`) **and** the
   surfaced text the agent actually reads. A score that's right internally but
   rendered wrong still misleads the agent.
4. **Include at least one false-positive guard.** Add a test proving the feature
   does **not** fire when it shouldn't:
   - Oracle: a benign task scores low / surfaces nothing.
   - Stale detection: a memory file *older* than the latest write is **not**
     flagged stale.
   - Verification gate: a bare claim with no evidence stays a claim (does **not**
     auto-promote to confirmed).
   - Write-verification: a genuinely successful write returns a numeric id and
     does **not** raise `AmplifierWriteError`.
   Without this guard, a change that makes the detector fire on everything would
   still pass.

## Required output

This skill must produce **tests or fixtures, not just prose** — concrete
`tests/*.test.js` (and fixture data) that fail before the change and pass after,
including the false-positive guard. Run them with `npm test` and confirm the
red→green transition.

## Anti-patterns

- ❌ Asserting only the internal value while the rendered text the agent sees is
   wrong (or vice-versa).
- ❌ Time- or random-dependent fixtures that flake.
- ❌ Only happy-path assertions with no false-positive guard — the most common
   way a detector silently starts over-firing.
- ❌ "Manually verified, looks right" with no committed test.
