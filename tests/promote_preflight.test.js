// Eval for P0 #3 — promoted patterns must affect amplify_preflight.
//
// Before this change, amplify_promote_pattern wrote a row to
// pattern_promotions but the Pattern Oracle never consulted it, so promoting
// a pattern had ZERO effect on preflight risk scoring. These tests pin the
// intended behavior:
//
//   (a) a PROMOTED + CONFIRMED pattern learned in project A raises the risk
//       score for a matching task in a DIFFERENT project B,
//   (b) an UN-promoted cross-project lesson does NOT leak into project B,
//   (c) a local-project lesson still ranks normally / dominates the cross-
//       project signal (promoted patterns must not drown out local memory),
//   (d) a weak / unconfirmed promoted signal is downweighted vs a confirmed one.
//
// Discipline: design-memory-eval — failing scenario first, deterministic
// temp-SQLite fixtures, assert BOTH the structured PreflightResult and the
// surfaced text, plus a false-positive guard (case b).
//
// Run with: npm test

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { preflight } from "../dist/oracle.js";
import { SQLiteStore } from "../dist/storage.js";
import { handlePreflight, handlePromotePattern } from "../dist/tools.js";

function freshStore() {
  const tmpPath = path.join(
    os.tmpdir(),
    `amp-promote-preflight-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  const store = new SQLiteStore(tmpPath);
  return {
    store,
    cleanup: () => {
      store.close();
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    },
  };
}

// Seed the same recurring "secrets leaked to logs" lesson in two projects and
// promote it, so it becomes a cross-project global signal. Each project sees
// the lesson several times (re-adding the same pattern_key bumps frequency),
// reflecting a genuinely recurring pattern worth promoting.
function seedPromotedSecretPattern(store) {
  for (let i = 0; i < 3; i++) {
    store.addLesson({
      project: "project-a",
      type: "mistake",
      title: "Secret API key leaked to logs via tail",
      description:
        "Printing a config file with tail exposed the API key value in plaintext logs.",
      severity: "critical",
      tags: ["security", "secrets", "logging"],
      pattern_key: "never-leak-secrets",
      verification_status: "confirmed",
      confidence: 1.0,
    });
    store.addLesson({
      project: "project-c",
      type: "mistake",
      title: "Secret token leaked to logs via cat",
      description:
        "cat of an env file dumped the token value into the build log output.",
      severity: "critical",
      tags: ["security", "secrets", "logging"],
      pattern_key: "never-leak-secrets",
      verification_status: "confirmed",
      confidence: 1.0,
    });
  }
  // Promote: ≥2 projects, ≥1 confirmed → succeeds.
  return store;
}

describe("promoted patterns affect preflight (cross-project)", () => {
  test("(a) a promoted confirmed pattern from project A raises risk in project B", async () => {
    const { store, cleanup } = freshStore();
    try {
      seedPromotedSecretPattern(store);
      const promoMsg = await handlePromotePattern(store, {
        pattern_key: "never-leak-secrets",
      });
      assert.match(promoMsg, /promoted to global/i, `promotion should succeed: ${promoMsg}`);

      // Project B has NO local lessons at all.
      const promptB = "tail the secrets config file and print the API key to logs";
      const candidateLessons = store.getAllLessonsForProject("project-b");
      assert.equal(candidateLessons.length, 0, "project-b has no local lessons");

      const promotedPatterns = store.getPromotedPatternSignals("project-b");
      assert.ok(
        promotedPatterns.length >= 1,
        "should surface the promoted cross-project signal"
      );

      const result = preflight({
        project: "project-b",
        prompt: promptB,
        candidateLessons,
        candidateDecisions: [],
        promotedPatterns,
      });

      // Structured layer: the promoted pattern lifts the score above zero and
      // surfaces as a matched pattern.
      assert.ok(result.score > 0, `expected non-zero score, got ${result.score}`);
      assert.notEqual(result.risk_level, "low");
      assert.ok(
        result.matched_patterns.some((p) => p.pattern_key === "never-leak-secrets"),
        "promoted pattern should appear in matched_patterns"
      );

      // Text layer: the rendered preflight report the agent reads must surface it.
      const text = await handlePreflight(store, { project: "project-b", prompt: promptB });
      assert.match(text, /never-leak-secrets/, "rendered report should name the promoted pattern");
      assert.doesNotMatch(text, /🟢 LOW/, "should not be rendered as LOW risk");
    } finally {
      cleanup();
    }
  });

  test("(b) FALSE-POSITIVE GUARD: an un-promoted cross-project lesson does NOT affect project B", async () => {
    const { store, cleanup } = freshStore();
    try {
      // Same recurring lesson in two other projects, but NEVER promoted.
      store.addLesson({
        project: "project-a",
        type: "mistake",
        title: "Secret API key leaked to logs via tail",
        description: "Printing a config file with tail exposed the API key value.",
        severity: "critical",
        tags: ["security", "secrets", "logging"],
        pattern_key: "never-leak-secrets",
        verification_status: "confirmed",
        confidence: 1.0,
      });
      store.addLesson({
        project: "project-c",
        type: "mistake",
        title: "Secret token leaked to logs via cat",
        description: "cat of an env file dumped the token value into the build log.",
        severity: "critical",
        tags: ["security", "secrets", "logging"],
        pattern_key: "never-leak-secrets",
        verification_status: "confirmed",
        confidence: 1.0,
      });

      const promptB = "tail the secrets config file and print the API key to logs";

      // No promotion has happened → no cross-project signal must leak.
      const promotedPatterns = store.getPromotedPatternSignals("project-b");
      assert.equal(promotedPatterns.length, 0, "nothing promoted → no signals");

      const result = preflight({
        project: "project-b",
        prompt: promptB,
        candidateLessons: store.getAllLessonsForProject("project-b"),
        candidateDecisions: [],
        promotedPatterns,
      });
      assert.equal(result.score, 0, "un-promoted cross-project memory must not affect project B");
      assert.equal(result.risk_level, "low");
      assert.equal(result.matched_patterns.length, 0);

      const text = await handlePreflight(store, { project: "project-b", prompt: promptB });
      assert.match(text, /🟢 LOW/, "un-promoted cross-project memory keeps project B at LOW");
      assert.doesNotMatch(text, /never-leak-secrets/);
    } finally {
      cleanup();
    }
  });

  test("(c) a strong local lesson still dominates the promoted cross-project signal", async () => {
    const { store, cleanup } = freshStore();
    try {
      seedPromotedSecretPattern(store);
      await handlePromotePattern(store, { pattern_key: "never-leak-secrets" });

      // Project B has its OWN strong, high-frequency local lesson on a different topic.
      for (let i = 0; i < 6; i++) {
        store.addLesson({
          project: "project-b",
          type: "mistake",
          title: "Production database migration dropped a column",
          description:
            "A destructive database migration dropped a production column without a backup.",
          severity: "critical",
          tags: ["database", "migration", "production"],
          pattern_key: "no-destructive-migration",
          verification_status: "confirmed",
          confidence: 1.0,
        });
      }

      const prompt =
        "run the production database migration that drops the legacy column";
      const candidateLessons = store.getAllLessonsForProject("project-b");
      const promotedPatterns = store.getPromotedPatternSignals("project-b");

      const result = preflight({
        project: "project-b",
        prompt,
        candidateLessons,
        candidateDecisions: [],
        promotedPatterns,
      });

      // The local pattern must be the TOP matched pattern, not the promoted one.
      assert.ok(result.matched_patterns.length >= 1);
      assert.equal(
        result.matched_patterns[0].pattern_key,
        "no-destructive-migration",
        "local high-frequency lesson must outrank cross-project promoted signal"
      );

      // And the local contribution must exceed any cross-project contribution.
      const localTop = result.matched_patterns.find(
        (p) => p.pattern_key === "no-destructive-migration"
      );
      const crossSignal = result.matched_patterns.find(
        (p) => p.pattern_key === "never-leak-secrets"
      );
      if (crossSignal) {
        assert.ok(
          localTop.weight_contribution > crossSignal.weight_contribution,
          `local (${localTop.weight_contribution}) must dominate cross-project (${crossSignal.weight_contribution})`
        );
      }
    } finally {
      cleanup();
    }
  });

  test("(d) a weak/unconfirmed promoted signal is downweighted vs a confirmed one", () => {
    // Two synthetic promoted signals matching the same prompt: one fully
    // confirmed across both source projects, one with only claim-grade support.
    // The confirmed one must contribute strictly more to the score.
    const promptText = "deploy the rate limit change to the gateway";

    const confirmedSignal = {
      pattern_key: "rate-limit-blowup",
      title: "Rate limit change caused a gateway blowup",
      total_frequency: 4,
      confirmed_count: 2,
      source_count: 2,
      best_status: "confirmed",
      best_confidence: 1.0,
      last_seen: "2026-01-02",
      text:
        "Changing the rate limit on the gateway caused a cascading blowup across the deploy.",
    };

    const weakSignal = {
      ...confirmedSignal,
      confirmed_count: 0,
      best_status: "claim",
      best_confidence: 0.5,
    };

    const strong = preflight({
      project: "project-b",
      prompt: promptText,
      candidateLessons: [],
      candidateDecisions: [],
      promotedPatterns: [confirmedSignal],
    });
    const weak = preflight({
      project: "project-b",
      prompt: promptText,
      candidateLessons: [],
      candidateDecisions: [],
      promotedPatterns: [weakSignal],
    });

    assert.ok(strong.score > 0, "confirmed promoted signal should contribute");
    assert.ok(
      strong.score > weak.score,
      `confirmed promoted signal (${strong.score}) must outscore weak one (${weak.score})`
    );
  });
});
