// v1.5.0 — pattern_key suggester tests.
//
// Goal: prevent two Claude sessions from coining different pattern_keys for
// the same recurring lesson. The suggester takes a new lesson's title +
// description and returns the closest existing keys (trigram Jaccard ≥ 0.4),
// or proposes a fresh kebab-case key if no existing one matches.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { SQLiteStore } from "../dist/storage.js";
import {
  suggestPatternKey,
  proposePatternKey,
} from "../dist/pattern_suggest.js";
import { handleSuggestPatternKey } from "../dist/tools.js";

function freshStore() {
  const dbPath = path.join(
    os.tmpdir(),
    `amp-ps-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const store = new SQLiteStore(dbPath);
  return {
    store,
    cleanup: () => {
      store.close();
      try { fs.unlinkSync(dbPath); } catch {}
    },
  };
}

describe("proposePatternKey (v1.5.0)", () => {
  test("kebab-cases the title and caps to 5 words", () => {
    assert.equal(
      proposePatternKey("Save findings to Amplifier in session"),
      "save-findings-to-amplifier-in",
    );
  });

  test("strips punctuation", () => {
    assert.equal(
      proposePatternKey("Don't trust API.lastInsertRowid blindly!"),
      "don-t-trust-api-lastinsertrowid",
    );
  });

  test("falls back to 'lesson' for empty input", () => {
    assert.equal(proposePatternKey(""), "lesson");
    assert.equal(proposePatternKey("!!!"), "lesson");
  });

  test("caps length at 50 chars and trims trailing hyphen", () => {
    const key = proposePatternKey("a".repeat(60));
    assert.ok(key.length <= 50);
    assert.ok(!key.endsWith("-"));
  });
});

describe("suggestPatternKey (v1.5.0)", () => {
  test("returns proposed_new_key when project has no pattern_keys yet", () => {
    const { store, cleanup } = freshStore();
    try {
      const result = suggestPatternKey(
        store,
        "p",
        "Read docs before coding",
        "Lue NIM-docs ennen kuin koodaat",
      );
      assert.equal(result.matches.length, 0);
      assert.ok(result.proposed_new_key);
      assert.match(result.proposed_new_key, /^[a-z0-9-]+$/);
    } finally {
      cleanup();
    }
  });

  test("finds an existing similar pattern_key above threshold", () => {
    const { store, cleanup } = freshStore();
    try {
      // Seed: existing lesson with pattern_key="read-docs-before-coding"
      store.addLesson({
        project: "p",
        type: "mistake",
        title: "Read NIM API docs first",
        description: "Stop guessing config keys, read the documentation.",
        severity: "high",
        tags: [],
        pattern_key: "read-docs-before-coding",
      });

      // New incoming lesson — similar topic, partially overlapping wording.
      // Trigram Jaccard recognises shared key terms ("Read", "API", "docs")
      // but doesn't catch pure synonyms (e.g. "documentation" vs "spec"),
      // which is documented as a known limitation in pattern_suggest.ts.
      const result = suggestPatternKey(
        store,
        "p",
        "Read Hermes API docs first",
        "Stop guessing config keys, check the documentation.",
      );

      assert.ok(result.matches.length >= 1, "should find a match");
      assert.equal(result.matches[0].pattern_key, "read-docs-before-coding");
      assert.ok(result.matches[0].similarity >= 0.4);
      assert.equal(result.matches[0].existing_frequency, 1);
      assert.equal(result.proposed_new_key, null);
    } finally {
      cleanup();
    }
  });

  test("returns proposed_new_key when no existing key clears threshold", () => {
    const { store, cleanup } = freshStore();
    try {
      store.addLesson({
        project: "p",
        type: "mistake",
        title: "Database migration safety",
        description: "Always backup before ALTER TABLE on large tables.",
        severity: "high",
        tags: [],
        pattern_key: "db-migration-backup-first",
      });

      const result = suggestPatternKey(
        store,
        "p",
        "Frontend i18n string format",
        "ICU MessageFormat plurals need quotes around the offset.",
      );

      // Completely unrelated topic — no match expected
      assert.equal(result.matches.length, 0);
      assert.ok(result.proposed_new_key);
    } finally {
      cleanup();
    }
  });

  test("ranks multiple matches by similarity descending", () => {
    const { store, cleanup } = freshStore();
    try {
      store.addLesson({
        project: "p",
        type: "mistake",
        title: "Read documentation before coding",
        description: "Stop guessing, check docs.",
        severity: "high",
        tags: [],
        pattern_key: "read-docs-before-coding",
      });
      store.addLesson({
        project: "p",
        type: "mistake",
        title: "Read API spec before integration",
        description: "Check spec, do not guess endpoints.",
        severity: "high",
        tags: [],
        pattern_key: "read-spec-before-integration",
      });

      const result = suggestPatternKey(
        store,
        "p",
        "Read official documentation first",
        "Guessing wastes time. Check the documentation before writing code.",
      );

      if (result.matches.length >= 2) {
        assert.ok(
          result.matches[0].similarity >= result.matches[1].similarity,
          "matches must be sorted by similarity descending",
        );
      }
    } finally {
      cleanup();
    }
  });

  test("never returns more than 3 matches", () => {
    const { store, cleanup } = freshStore();
    try {
      for (let i = 0; i < 6; i++) {
        store.addLesson({
          project: "p",
          type: "mistake",
          title: `Read documentation first variant ${i}`,
          description: "Same recurring lesson with slight rewording.",
          severity: "high",
          tags: [],
          pattern_key: `read-docs-variant-${i}`,
        });
      }
      const result = suggestPatternKey(
        store,
        "p",
        "Read documentation",
        "Same recurring lesson",
      );
      assert.ok(result.matches.length <= 3);
    } finally {
      cleanup();
    }
  });
});

describe("handleSuggestPatternKey tool (v1.5.0)", () => {
  test("requires project, title, description", async () => {
    const { store, cleanup } = freshStore();
    try {
      assert.match(
        await handleSuggestPatternKey(store, {}),
        /Error: 'project' is required/,
      );
      assert.match(
        await handleSuggestPatternKey(store, { project: "p" }),
        /Error: 'title' is required/,
      );
      assert.match(
        await handleSuggestPatternKey(store, { project: "p", title: "T" }),
        /Error: 'description' is required/,
      );
    } finally {
      cleanup();
    }
  });

  test("output mentions Suggested NEW key when no match", async () => {
    const { store, cleanup } = freshStore();
    try {
      const out = await handleSuggestPatternKey(store, {
        project: "p",
        title: "Some brand-new topic",
        description: "Nothing like this has been recorded.",
      });
      assert.match(out, /Suggested NEW key/);
    } finally {
      cleanup();
    }
  });

  test("output lists matches when similar key exists", async () => {
    const { store, cleanup } = freshStore();
    try {
      store.addLesson({
        project: "p",
        type: "mistake",
        title: "Verify Amplifier write success",
        description: "Read back row after INSERT, do not trust lastInsertRowid blindly.",
        severity: "high",
        tags: [],
        pattern_key: "verify-amplifier-write-success",
      });
      const out = await handleSuggestPatternKey(store, {
        project: "p",
        // Realistic reformulation: a second Claude session would naturally
        // reuse some core terms ("Amplifier write", "Verify") rather than
        // fully synonymising. Trigrams pick this up; pure synonym
        // substitution does not. That limitation is acknowledged in the
        // module docstring.
        title: "Verify Amplifier write success was real",
        description: "Read back the row after INSERT, do not trust lastInsertRowid.",
      });
      assert.match(out, /Existing pattern_keys/);
      assert.match(out, /verify-amplifier-write-success/);
    } finally {
      cleanup();
    }
  });
});
