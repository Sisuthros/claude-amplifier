#!/usr/bin/env node
// Seed a clean demo database for the asciinema recording.
//
// Run before recording:  node demo/prep-demo-db.mjs
// Run after recording:   node demo/cleanup-demo.mjs

import { mkdirSync, existsSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { SQLiteStore } from "../dist/storage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DB = resolve(homedir(), ".claude-amplifier-demo.db");

// Wipe any previous demo DB so the recording is reproducible.
if (existsSync(DEMO_DB)) {
  rmSync(DEMO_DB);
  // Also wipe -shm and -wal sidecars from WAL mode if they exist.
  for (const ext of ["-shm", "-wal"]) {
    const sidecar = DEMO_DB + ext;
    if (existsSync(sidecar)) rmSync(sidecar);
  }
}

mkdirSync(dirname(DEMO_DB), { recursive: true });

const store = new SQLiteStore(DEMO_DB);

// Three confirmed, real-feeling lessons that match the demo prompt
// "Configure agent endpoint with vendor-a/vendor-b/model-x" via token overlap.
const lessons = [
  {
    project: "demo",
    title: "Avoid model names containing another provider's prefix",
    description:
      "Some agent runtimes parse the model string by substring to infer the provider. A name like 'vendor-a/vendor-b/model-x' may route as vendor-b at runtime but authenticate as vendor-a at startup. Result: every heartbeat returns Invalid API Key.",
    type: "mistake",
    severity: "critical",
    pattern_key: "avoid-ambiguous-provider-prefix",
    tags: ["agent-runtime", "model-routing", "config"],
    trigger: "Choosing a model name for an agent runtime",
    prevention: "Use single-prefix names like 'vendor-a/model-x' — anything without an embedded second provider.",
    verification_status: "confirmed",
    confidence: 1.0,
  },
  {
    project: "demo",
    title: "Read provider /v1/models before configuring fallback chains",
    description:
      "Provider model catalogs change frequently. Hardcoding a model name without checking GET /v1/models first leads to 404s in production.",
    type: "insight",
    severity: "high",
    pattern_key: "read-v1-models-first",
    tags: ["provider", "config", "process"],
    trigger: "Setting up a fallback chain on any provider-backed agent",
    prevention: "Always curl /v1/models with the same API key first. Never trust documentation alone.",
    verification_status: "confirmed",
    confidence: 1.0,
  },
  {
    project: "demo",
    title: "Heartbeat needs TPM >= 30k and 40k context",
    description:
      "Heartbeat models with <30k TPM enter a permanent 413 loop when the agent's contexts exceed 40k tokens. The model never recovers — the loop just gets faster.",
    type: "mistake",
    severity: "high",
    pattern_key: "heartbeat-tpm-threshold",
    tags: ["heartbeat", "rate-limit", "tpm"],
    trigger: "Picking a heartbeat model under <30k TPM",
    prevention: "Verify TPM × context-window fits your agent's 40k+ token contexts before installing as primary.",
    verification_status: "confirmed",
    confidence: 1.0,
  },
];

const ids = [];
for (const lesson of lessons) {
  const result = store.recordLesson(lesson);
  ids.push(result.lesson.id);
}

// Bump frequency on the openai-prefix lesson 3x to make it the strongest match.
for (let i = 0; i < 2; i++) {
  store.recordLesson(lessons[0]);
}
// Bump NIM lesson to freq 5
for (let i = 0; i < 4; i++) {
  store.recordLesson(lessons[1]);
}
// Heartbeat lesson freq 2
store.recordLesson(lessons[2]);

console.log(`✓ Seeded demo DB at: ${DEMO_DB}`);
console.log(`  Lessons: ${ids.length}`);
console.log("");
console.log("To use this DB for the demo, set:");
console.log(`  export CLAUDE_AMPLIFIER_DB=${DEMO_DB}`);
console.log("");
console.log("Or prepend each command:");
console.log(`  CLAUDE_AMPLIFIER_DB=${DEMO_DB} claude-amplifier preflight ...`);

store.close();
