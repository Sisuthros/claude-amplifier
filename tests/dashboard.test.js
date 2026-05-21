// Hermetic tests for the read-only dashboard HTTP server.
//
// Each test gets its own temp DB and its own server bound to an
// OS-assigned port (port 0) so the suite never collides with a
// running dashboard or another test in the same suite.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { SQLiteStore } from "../dist/storage.js";
import { startDashboard } from "../dist/dashboard/server.js";

function freshDbPath() {
  return path.join(
    os.tmpdir(),
    `amp-dash-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
}

async function getJson(baseUrl, route) {
  const res = await fetch(new URL(route, baseUrl));
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

async function getRaw(baseUrl, route) {
  const res = await fetch(new URL(route, baseUrl));
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

// ---------------------------------------------------------------------------
// Single suite with a shared dashboard so we exercise the same instance the
// way a real user would.
// ---------------------------------------------------------------------------

describe("dashboard server (read-only)", () => {
  let dbPath;
  let handle;

  before(async () => {
    dbPath = freshDbPath();

    // Seed the database with a couple of lessons + a decision so the
    // /api/* endpoints have something meaningful to return.
    const store = new SQLiteStore(dbPath);
    store.addLesson({
      project: "alpha",
      type: "insight",
      title: "Check pwd before destructive ops",
      description: "Always pwd first.",
      severity: "high",
      tags: ["shell"],
      pattern_key: "verify-cwd-before-destructive-shell",
    });
    store.addLesson({
      project: "beta",
      type: "mistake",
      title: "Forgot to back up",
      description: "Lost a file.",
      severity: "critical",
      tags: ["backup"],
    });
    store.addDecision({
      project: "alpha",
      category: "tooling",
      title: "Use pnpm not npm",
      description: "Lockfile hygiene.",
      tags: ["pnpm"],
      status: "active",
    });
    store.close();

    handle = await startDashboard({ port: 0, dbPath });
  });

  after(async () => {
    if (handle) await handle.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      // sqlite WAL leftovers — fine to ignore in tests
    }
  });

  test("GET / returns the dashboard HTML", async () => {
    const res = await getRaw(handle.url, "/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    assert.match(res.text, /<title>Claude Amplifier — Dashboard<\/title>/);
    assert.match(res.text, /id="project-select"/);
  });

  test("GET /api/stats returns totals + histogram", async () => {
    const res = await getJson(handle.url, "/api/stats");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    assert.ok(res.body.totals, "totals should be present");
    assert.equal(typeof res.body.totals.lessons, "number");
    assert.equal(typeof res.body.totals.decisions, "number");
    assert.ok(res.body.totals.lessons >= 2, "should see seeded lessons");
    assert.ok(res.body.totals.decisions >= 1, "should see seeded decision");
    assert.ok(res.body.histogram, "histogram should be present");
    assert.ok(res.body.verification, "verification breakdown should be present");
  });

  test("GET /api/lessons?project=X filters by project", async () => {
    const all = await getJson(handle.url, "/api/lessons");
    const alpha = await getJson(handle.url, "/api/lessons?project=alpha");
    const beta = await getJson(handle.url, "/api/lessons?project=beta");

    assert.equal(all.status, 200);
    assert.equal(alpha.status, 200);
    assert.equal(beta.status, 200);

    assert.ok(Array.isArray(alpha.body));
    assert.ok(Array.isArray(beta.body));
    assert.ok(alpha.body.every((l) => l.project === "alpha"));
    assert.ok(beta.body.every((l) => l.project === "beta"));
    assert.ok(all.body.length >= alpha.body.length + beta.body.length);
  });

  test("GET /api/evidence/lesson/:id returns chain or not-found error", async () => {
    const lessons = (await getJson(handle.url, "/api/lessons?project=alpha")).body;
    assert.ok(lessons.length, "should have at least one alpha lesson");
    const id = lessons[0].id;

    const chain = await getJson(handle.url, `/api/evidence/lesson/${id}`);
    assert.equal(chain.status, 200);
    assert.ok(chain.body.item, "chain should include item");
    assert.equal(chain.body.item.id, id);
    assert.ok(Array.isArray(chain.body.evidence_links));

    // unknown id — handler returns 200 with {error:"not found"} from storage
    const missing = await getJson(handle.url, "/api/evidence/lesson/999999");
    assert.equal(missing.status, 200);
    assert.ok(missing.body.error, "missing record should report an error");
  });

  test("GET on an unknown path returns 404 JSON", async () => {
    const res = await getJson(handle.url, "/api/this-does-not-exist");
    assert.equal(res.status, 404);
    assert.equal(typeof res.body.error, "string");
  });

  test("Static asset serving works for the JS bundle", async () => {
    const res = await getRaw(handle.url, "/static/app.js");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/javascript/);
    assert.match(res.text, /Claude Amplifier dashboard/);
  });
});
