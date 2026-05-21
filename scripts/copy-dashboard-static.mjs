#!/usr/bin/env node
/**
 * Post-build step: copy `src/dashboard/static/` into `dist/dashboard/static/`
 * so the published package ships the dashboard HTML/CSS/JS.
 *
 * tsc only emits compiled TypeScript — static assets must be copied
 * separately. We use a tiny script (no devDeps) instead of pulling in
 * copyfiles / cpy / shx.
 */
import { mkdirSync, readdirSync, statSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const src = join(root, "src", "dashboard", "static");
const dst = join(root, "dist", "dashboard", "static");

if (!existsSync(src)) {
  console.error(`[copy-dashboard-static] missing source: ${src}`);
  process.exit(1);
}

function copyDir(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    const s = join(srcDir, name);
    const d = join(dstDir, name);
    if (statSync(s).isDirectory()) {
      copyDir(s, d);
    } else {
      copyFileSync(s, d);
    }
  }
}

copyDir(src, dst);
console.log(`[copy-dashboard-static] copied ${src} -> ${dst}`);
