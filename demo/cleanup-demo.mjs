#!/usr/bin/env node
// Cleanup the demo database created by prep-demo-db.mjs.
// Safe to run multiple times — silently skips if the file doesn't exist.

import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const DEMO_DB = resolve(homedir(), ".claude-amplifier-demo.db");

let removed = 0;
for (const ext of ["", "-shm", "-wal"]) {
  const path = DEMO_DB + ext;
  if (existsSync(path)) {
    rmSync(path);
    removed++;
    console.log(`✓ Removed ${path}`);
  }
}

if (removed === 0) {
  console.log("Nothing to clean — demo DB not found.");
}
