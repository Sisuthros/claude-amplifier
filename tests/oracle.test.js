// Unit tests for the Pattern Oracle (Amplifier 1.4.0).
//
// Pattern Oracle is a pure module that takes already-loaded lessons +
// decisions and scores risk against a prompt. Tests target the math, the
// matching, and the advice generation rather than touching SQLite.
//
// Run with: npm test

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { preflight, tokenize } from "../dist/oracle.js";
import { SQLiteStore } from "../dist/storage.js";

function freshStore() {
  const tmpPath = path.join(
    os.tmpdir(),
    `amp-oracle-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
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

// ── tokenize ────────────────────────────────────────────────────────

describe("tokenize", () => {
  test("strips punctuation and lowercases", () => {
    const t = tokenize("Read the NIM docs FIRST! Don't guess.");
    assert.ok(t.has("read"));
    assert.ok(t.has("nim"));
    assert.ok(t.has("docs"));
    assert.ok(t.has("first"));
    assert.ok(t.has("guess"));
  });

  test("drops stopwords", () => {
    const t = tokenize("the and that this when where");
    assert.equal(t.size, 0);
  });

  test("drops tokens shorter than 3 chars", () => {
    const t = tokenize("a b cc ddd eeeeee");
    assert.ok(!t.has("a"));
    assert.ok(!t.has("b"));
    assert.ok(!t.has("cc"));
    assert.ok(t.has("ddd"));
    assert.ok(t.has("eeeeee"));
  });

  test("handles Finnish characters via Unicode tokenizer", () => {
    const t = tokenize("Lukekaa dokumentit ennen koodausta");
    assert.ok(t.has("lukekaa"));
    assert.ok(t.has("dokumentit"));
    assert.ok(t.has("ennen"));
    assert.ok(t.has("koodausta"));
  });

  test("empty input yields empty set", () => {
    assert.equal(tokenize("").size, 0);
    assert.equal(tokenize("   ").size, 0);
  });
});

// ── preflight: empty database ───────────────────────────────────────

describe("preflight with no data", () => {
  test("returns low risk and clear advice when no lessons exist", () => {
    const result = preflight({
      project: "p",
      prompt: "refactor the auth module",
      candidateLessons: [],
      candidateDecisions: [],
    });
    assert.equal(result.risk_level, "low");
    assert.equal(result.score, 0);
    assert.equal(result.matched_patterns.length, 0);
    assert.equal(result.matched_lessons.length, 0);
    assert.equal(result.evidence_quality, "anecdotal");
    assert.match(result.suggested_approach, /normal caution/i);
  });
});

// ── preflight: matching by content ──────────────────────────────────

describe("preflight with matching lessons", () => {
  test("matches a single confirmed lesson and produces medium risk", () => {
    const { store, cleanup } = freshStore();
    try {
      store.addLesson({
        project: "p",
        type: "mistake",
        title: "Authentication tokens leaked in logs",
        description: "Sensitive auth tokens were written to stdout because Bearer header logging was on by default.",
        severity: "high",
        tags: ["security", "logging", "auth"],
        pattern_key: "no-secret-in-logs",
        verification_status: "confirmed",
        confidence: 1.0,
      });
      // Bump frequency to push score higher
      for (let i = 0; i < 4; i++) {
        store.addLesson({
          project: "p",
          type: "mistake",
          title: "Authentication tokens leaked in logs",
          description: "duplicate to bump frequency",
          severity: "high",
          tags: [],
          pattern_key: "no-secret-in-logs",
          verification_status: "confirmed",
        });
      }
      const lessons = store.getAllLessonsForProject("p");
      assert.equal(lessons.length, 1, "should have aggregated into one lesson");
      assert.equal(lessons[0].frequency, 5);

      const result = preflight({
        project: "p",
        prompt: "Add Bearer token logging to the authentication middleware",
        candidateLessons: lessons,
        candidateDecisions: [],
      });

      // Frequency 5, conf 1.0, status confirmed (weight 1.0), overlap ~0.3+
      // → score should be ≥ 1.0 (medium)
      assert.ok(result.score >= 1.0, `expected score ≥ 1.0, got ${result.score}`);
      assert.notEqual(result.risk_level, "low");
      assert.ok(result.matched_lessons.length >= 1);
      assert.ok(result.matched_patterns.length >= 1);
      assert.equal(result.matched_patterns[0].pattern_key, "no-secret-in-logs");
    } finally {
      cleanup();
    }
  });

  test("claim status weighs much less than confirmed", () => {
    const claimResult = preflight({
      project: "p",
      prompt: "deploy to production database",
      candidateLessons: [
        {
          id: 1,
          project: "p",
          type: "mistake",
          title: "production database wiped during deploy",
          description: "manually ran TRUNCATE on the prod db during a routine deploy",
          severity: "critical",
          tags: ["production", "database"],
          created_at: "2026-01-01",
          updated_at: "2026-01-01",
          frequency: 3,
          pattern_key: "no-truncate-prod",
          verification_status: "claim",
          evidence_links: [],
          confidence: 0.5,
        },
      ],
      candidateDecisions: [],
    });

    const confirmedResult = preflight({
      project: "p",
      prompt: "deploy to production database",
      candidateLessons: [
        {
          id: 1,
          project: "p",
          type: "mistake",
          title: "production database wiped during deploy",
          description: "manually ran TRUNCATE on the prod db during a routine deploy",
          severity: "critical",
          tags: ["production", "database"],
          created_at: "2026-01-01",
          updated_at: "2026-01-01",
          frequency: 3,
          pattern_key: "no-truncate-prod",
          verification_status: "confirmed",
          evidence_links: [],
          confidence: 1.0,
        },
      ],
      candidateDecisions: [],
    });

    // Claim weight = 0.2, confirmed weight = 1.0 → confirmed should score ~5× higher
    assert.ok(
      confirmedResult.score > claimResult.score * 2,
      `expected confirmed (${confirmedResult.score}) to score much higher than claim (${claimResult.score})`
    );
  });
});

// ── preflight: thresholds ───────────────────────────────────────────

describe("preflight risk thresholds", () => {
  test("score 0.5 = low", () => {
    const result = preflight({
      project: "p",
      prompt: "minor cleanup",
      candidateLessons: [
        {
          id: 1,
          project: "p",
          type: "insight",
          title: "minor cleanup safe",
          description: "minor cleanup is generally safe",
          severity: "low",
          tags: [],
          created_at: "2026-01-01",
          updated_at: "2026-01-01",
          frequency: 1,
          verification_status: "claim",
          confidence: 0.5,
        },
      ],
      candidateDecisions: [],
    });
    assert.equal(result.risk_level, "low");
  });

  test("high score classifies as critical", () => {
    // Build many strongly-matching confirmed lessons
    const lessons = [];
    for (let i = 0; i < 5; i++) {
      lessons.push({
        id: i + 1,
        project: "p",
        type: "mistake",
        title: "rate limit catastrophe",
        description: "the rate limit catastrophe happened again",
        severity: "critical",
        tags: ["rate-limit", "api"],
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
        frequency: 3,
        pattern_key: `rate-limit-${i}`,
        verification_status: "confirmed",
        confidence: 1.0,
      });
    }
    const result = preflight({
      project: "p",
      prompt: "we are about to hit the rate limit catastrophe again",
      candidateLessons: lessons,
      candidateDecisions: [],
    });
    assert.ok(result.score >= 6.0, `expected critical-range score, got ${result.score}`);
    assert.equal(result.risk_level, "critical");
  });
});

// ── preflight: decisions ────────────────────────────────────────────

describe("preflight with active decisions", () => {
  test("active decisions contribute to score; superseded ones do not", () => {
    const sharedDecisionBody = {
      id: 1,
      project: "p",
      category: "architecture",
      title: "Use PostgreSQL for primary data store",
      description: "We chose Postgres over Mongo for transactional integrity",
      rationale: "ACID, joins, JSON support",
      tags: ["database"],
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
      trade_offs: [],
      alternatives_considered: [],
      verification_status: "confirmed",
      confidence: 1.0,
    };

    const activeResult = preflight({
      project: "p",
      prompt: "should we migrate from postgres to mongodb?",
      candidateLessons: [],
      candidateDecisions: [{ ...sharedDecisionBody, status: "active" }],
    });

    const supersededResult = preflight({
      project: "p",
      prompt: "should we migrate from postgres to mongodb?",
      candidateLessons: [],
      candidateDecisions: [{ ...sharedDecisionBody, status: "superseded" }],
    });

    assert.ok(activeResult.score > 0);
    assert.equal(supersededResult.score, 0);
  });
});

// ── preflight: evidence quality ─────────────────────────────────────

describe("preflight evidence_quality", () => {
  test("two confirmed patterns → strong", () => {
    const lessons = [
      {
        id: 1, project: "p", type: "mistake", title: "issue A", description: "A failure",
        severity: "high", tags: [], created_at: "2026-01-01", updated_at: "2026-01-01",
        frequency: 2, pattern_key: "k1", verification_status: "confirmed", confidence: 1.0,
      },
      {
        id: 2, project: "p", type: "mistake", title: "issue A again", description: "Another A failure",
        severity: "high", tags: [], created_at: "2026-01-02", updated_at: "2026-01-02",
        frequency: 2, pattern_key: "k2", verification_status: "confirmed", confidence: 1.0,
      },
    ];
    const result = preflight({
      project: "p",
      prompt: "investigating issue A failure",
      candidateLessons: lessons,
      candidateDecisions: [],
    });
    assert.equal(result.evidence_quality, "strong");
  });

  test("only claims → anecdotal", () => {
    const result = preflight({
      project: "p",
      prompt: "investigating the failure",
      candidateLessons: [
        {
          id: 1, project: "p", type: "mistake", title: "failure happened",
          description: "the failure was bad", severity: "high", tags: [],
          created_at: "2026-01-01", updated_at: "2026-01-01",
          frequency: 1, pattern_key: "k1",
          verification_status: "claim", confidence: 0.5,
        },
      ],
      candidateDecisions: [],
    });
    assert.equal(result.evidence_quality, "anecdotal");
  });
});

// ── verification gate (storage layer) ───────────────────────────────

describe("verifyLesson promotion rules", () => {
  test("claim + 1 evidence → evidence (conf 0.7)", () => {
    const { store, cleanup } = freshStore();
    try {
      const lesson = store.addLesson({
        project: "p",
        type: "mistake",
        title: "fresh claim",
        description: "unverified",
        severity: "medium",
        tags: [],
        verification_status: "claim",
        evidence_links: [],
        confidence: 0.5,
      });
      const updated = store.verifyLesson(
        lesson.id,
        "git_commit",
        "abc1234"
      );
      assert.ok(updated);
      assert.equal(updated.verification_status, "evidence");
      assert.equal(updated.confidence, 0.7);
      assert.equal(updated.evidence_links?.length, 1);
    } finally {
      cleanup();
    }
  });

  test("evidence + user_confirmation → confirmed (conf 1.0)", () => {
    const { store, cleanup } = freshStore();
    try {
      const lesson = store.addLesson({
        project: "p",
        type: "mistake",
        title: "another claim",
        description: "unverified",
        severity: "medium",
        tags: [],
        verification_status: "claim",
        evidence_links: [],
        confidence: 0.5,
      });
      store.verifyLesson(lesson.id, "git_commit", "abc1234");
      const final = store.verifyLesson(lesson.id, "user_confirmation", "Ville said yes");
      assert.ok(final);
      assert.equal(final.verification_status, "confirmed");
      assert.equal(final.confidence, 1.0);
      assert.equal(final.evidence_links?.length, 2);
    } finally {
      cleanup();
    }
  });

  test("two distinct evidence types → confirmed", () => {
    const { store, cleanup } = freshStore();
    try {
      const lesson = store.addLesson({
        project: "p",
        type: "mistake",
        title: "multi-evidence claim",
        description: "u",
        severity: "low",
        tags: [],
        verification_status: "claim",
      });
      store.verifyLesson(lesson.id, "git_commit", "sha1");
      const final = store.verifyLesson(lesson.id, "test_run", "test#42");
      assert.equal(final.verification_status, "confirmed");
    } finally {
      cleanup();
    }
  });

  test("explicit promote_to overrides auto-rule", () => {
    const { store, cleanup } = freshStore();
    try {
      const lesson = store.addLesson({
        project: "p",
        type: "insight",
        title: "fast track",
        description: "u",
        severity: "low",
        tags: [],
        verification_status: "claim",
      });
      const updated = store.verifyLesson(
        lesson.id,
        "git_commit",
        "sha1",
        "confirmed"
      );
      assert.equal(updated.verification_status, "confirmed");
    } finally {
      cleanup();
    }
  });

  test("demoteLesson resets to claim and clears evidence", () => {
    const { store, cleanup } = freshStore();
    try {
      const lesson = store.addLesson({
        project: "p",
        type: "mistake",
        title: "to be demoted",
        description: "u",
        severity: "low",
        tags: [],
        verification_status: "confirmed",
        evidence_links: [
          { evidence_type: "git_commit", evidence_link: "sha1", recorded_at: "2026-01-01 00:00:00" },
        ],
        confidence: 1.0,
      });
      const demoted = store.demoteLesson(lesson.id);
      assert.ok(demoted);
      assert.equal(demoted.verification_status, "claim");
      assert.equal(demoted.confidence, 0.5);
      assert.equal(demoted.evidence_links?.length, 0);
    } finally {
      cleanup();
    }
  });

  test("verifyLesson on missing id returns null", () => {
    const { store, cleanup } = freshStore();
    try {
      const result = store.verifyLesson(99999, "git_commit", "sha");
      assert.equal(result, null);
    } finally {
      cleanup();
    }
  });
});

// ── pattern promotion ───────────────────────────────────────────────

describe("pattern promotion", () => {
  test("getPatternStats aggregates per pattern_key across projects", () => {
    const { store, cleanup } = freshStore();
    try {
      store.addLesson({
        project: "alpha",
        type: "mistake",
        title: "first",
        description: "x",
        severity: "low",
        tags: [],
        pattern_key: "k1",
        verification_status: "confirmed",
      });
      store.addLesson({
        project: "beta",
        type: "mistake",
        title: "second",
        description: "x",
        severity: "low",
        tags: [],
        pattern_key: "k1",
        verification_status: "claim",
      });

      const stats = store.getPatternStats();
      const k1 = stats.find((s) => s.pattern_key === "k1");
      assert.ok(k1);
      assert.equal(k1.projects.length, 2);
      assert.equal(k1.total_frequency, 2);
      assert.equal(k1.confirmed_count, 1);
    } finally {
      cleanup();
    }
  });

  test("recordPromotion is idempotent", () => {
    const { store, cleanup } = freshStore();
    try {
      const a = store.recordPromotion("k1", ["alpha", "beta"], 5);
      const b = store.recordPromotion("k1", ["alpha", "beta"], 5);
      assert.equal(a.id, b.id, "same row id");
      const fetched = store.getPromotion("k1");
      assert.ok(fetched);
      assert.equal(fetched.pattern_key, "k1");
      assert.equal(fetched.promoted_from_projects.length, 2);
    } finally {
      cleanup();
    }
  });

  test("getPromotion returns null for unknown key", () => {
    const { store, cleanup } = freshStore();
    try {
      assert.equal(store.getPromotion("never-promoted"), null);
    } finally {
      cleanup();
    }
  });
});

// ── evidence chain ──────────────────────────────────────────────────

describe("getEvidenceChain", () => {
  test("returns the lesson plus its evidence links", () => {
    const { store, cleanup } = freshStore();
    try {
      const lesson = store.addLesson({
        project: "p",
        type: "mistake",
        title: "with evidence",
        description: "x",
        severity: "low",
        tags: [],
        verification_status: "claim",
      });
      store.verifyLesson(lesson.id, "git_commit", "sha1");
      store.verifyLesson(lesson.id, "test_run", "test#42");

      const chain = store.getEvidenceChain(lesson.id, "lesson");
      assert.ok(chain);
      assert.equal(chain.evidence_links.length, 2);
      assert.equal(chain.item.id, lesson.id);
    } finally {
      cleanup();
    }
  });

  test("returns null for unknown id", () => {
    const { store, cleanup } = freshStore();
    try {
      assert.equal(store.getEvidenceChain(99999, "lesson"), null);
      assert.equal(store.getEvidenceChain(99999, "decision"), null);
    } finally {
      cleanup();
    }
  });
});

// ── backwards compatibility ─────────────────────────────────────────

describe("backwards compatibility with 1.3.x data", () => {
  test("lessons stored before 1.4.0 default to confirmed and load cleanly", () => {
    const { store, cleanup } = freshStore();
    try {
      // Simulate 1.3.x by NOT passing verification fields
      const lesson = store.addLesson({
        project: "p",
        type: "insight",
        title: "legacy",
        description: "no verification fields",
        severity: "low",
        tags: [],
      });
      const fetched = store.getAllLessonsForProject("p")[0];
      assert.equal(fetched.verification_status, "confirmed");
      assert.equal(fetched.confidence, 1.0);
      assert.deepEqual(fetched.evidence_links, []);
    } finally {
      cleanup();
    }
  });

  test("decisions without verification fields default to confirmed", () => {
    const { store, cleanup } = freshStore();
    try {
      const decision = store.addDecision({
        project: "p",
        category: "general",
        title: "legacy decision",
        description: "x",
        tags: [],
        status: "active",
      });
      assert.equal(decision.verification_status, "confirmed");
      assert.equal(decision.confidence, 1.0);
    } finally {
      cleanup();
    }
  });
});
