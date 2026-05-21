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
// "Configure NIM endpoint with openai/gpt-oss-120b" via token overlap.
const lessons = [
  {
    project: "demo",
    title: "Avoid model names containing 'openai/' on ZeptoClaw",
    description:
      "ZeptoClaw 0.9.2 parses 'openai/' substring as the openai provider at startup but routes it as nvidia at runtime. Result: every heartbeat returns Invalid API Key.",
    type: "mistake",
    severity: "critical",
    pattern_key: "avoid-openai-prefix-on-zeptoclaw",
    tags: ["zeptoclaw", "model-routing", "config"],
    trigger: "Choosing a NIM model name for ZeptoClaw",
    prevention: "Use 'nvidia/gpt-oss-120b' or 'moonshotai/kimi-k2.6' — anything without 'openai/'.",
    verification_status: "confirmed",
    confidence: 1.0,
  },
  {
    project: "demo",
    title: "Read NIM /v1/models before configuring fallback chains",
    description:
      "The NIM model catalog changes weekly. Hardcoding a model name without checking GET /v1/models first leads to 404s in production.",
    type: "insight",
    severity: "high",
    pattern_key: "read-nim-v1-models-first",
    tags: ["nim", "config", "process"],
    trigger: "Setting up a fallback chain on any NIM-backed agent",
    prevention: "Always curl /v1/models with the same API key first. Never trust documentation alone.",
    verification_status: "confirmed",
    confidence: 1.0,
  },
  {
    project: "demo",
    title: "Heartbeat needs TPM >= 30k and 40k context",
    description:
      "Heartbeat models with <30k TPM enter a permanent 413 loop because Lumen's contexts exceed 40k tokens. The model never recovers — the loop just gets faster.",
    type: "mistake",
    severity: "high",
    pattern_key: "no-mickey-mouse-heartbeat",
    tags: ["heartbeat", "rate-limit", "tpm"],
    trigger: "Picking a heartbeat model under <30k TPM",
    prevention: "Verify TPM × context-window fits Lumen's 40k+ token contexts before installing as primary.",
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
