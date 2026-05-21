/**
 * Claude Amplifier — read-only web dashboard.
 *
 * A localhost-only HTTP server that exposes the SQLite store as JSON +
 * serves a single-page vanilla HTML/CSS/JS dashboard. No frameworks,
 * no build step, no dependencies beyond Node's stdlib + better-sqlite3
 * (which the rest of Amplifier already uses).
 *
 * Security model: bound to 127.0.0.1, no auth. Anyone with shell access
 * to the user's machine can already read ~/.claude-amplifier/amplifier.db
 * directly, so the dashboard adds no new attack surface.
 *
 * Usage:
 *   claude-amplifier dashboard               # default port 18796
 *   claude-amplifier dashboard --port 9000
 *   claude-amplifier dashboard --open        # auto-launch browser
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { platform } from "node:os";

import { SQLiteStore } from "../storage.js";

const DEFAULT_PORT = 18796;
const HOST = "127.0.0.1";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

// ---------------------------------------------------------------------------
// Static asset resolution — find the bundled `static/` directory whether we
// are running from `src/` (dev, via ts-node) or `dist/` (published).
// ---------------------------------------------------------------------------

function resolveStaticDir(): string {
  // ESM-safe equivalent of __dirname
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "static"),                // dist/dashboard/static (published)
    join(here, "..", "..", "src", "dashboard", "static"), // dev fallback
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // last-resort: alongside server.js
  return join(here, "static");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

function send404(res: ServerResponse, msg = "Not found"): void {
  sendJson(res, 404, { error: msg });
}

function send500(res: ServerResponse, err: unknown): void {
  sendJson(res, 500, { error: (err as Error).message ?? String(err) });
}

function getQueryParam(req: IncomingMessage, key: string): string | undefined {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const v = url.searchParams.get(key);
  return v == null ? undefined : v;
}

function serveStatic(res: ServerResponse, staticDir: string, relPath: string): void {
  // normalize and verify the resolved path is still inside staticDir
  const safe = normalize(relPath).replace(/^([\\/]|\.\.)+/g, "");
  const fullPath = resolve(staticDir, safe);
  if (!fullPath.startsWith(resolve(staticDir))) {
    send404(res, "Forbidden");
    return;
  }
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    send404(res, `Static asset not found: ${safe}`);
    return;
  }
  const ext = extname(fullPath).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";
  const body = readFileSync(fullPath);
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// API endpoint handlers
// ---------------------------------------------------------------------------

function apiLessons(store: SQLiteStore, project?: string): unknown {
  return project ? store.getLessons(project, 500) : store.getAllLessons();
}

function apiDecisions(store: SQLiteStore, project?: string): unknown {
  if (!project) return store.getAllDecisions();
  // The default getDecisions filters to status='active'. The dashboard wants
  // both active + superseded, so we walk getAllDecisions and filter in JS.
  return store.getAllDecisions().filter((d) => d.project === project);
}

function apiPatterns(store: SQLiteStore): unknown {
  return store.getAllPatterns();
}

function apiPromotions(store: SQLiteStore): unknown {
  const stats = store.getPatternStats();
  // For each pattern_key that has been promoted, fetch the audit row.
  return stats
    .map((s) => {
      const promotion = store.getPromotion(s.pattern_key);
      if (!promotion) return null;
      return { ...promotion, current_stats: s };
    })
    .filter(Boolean);
}

function apiStats(store: SQLiteStore): unknown {
  const lessons = store.getAllLessons();
  const decisions = store.getAllDecisions();
  const patterns = store.getAllPatterns();
  const promotions = store.getPatternStats().filter((s) => store.getPromotion(s.pattern_key));

  // Per-project counts
  const byProject = new Map<string, { lessons: number; decisions: number }>();
  for (const l of lessons) {
    const slot = byProject.get(l.project) ?? { lessons: 0, decisions: 0 };
    slot.lessons++;
    byProject.set(l.project, slot);
  }
  for (const d of decisions) {
    const slot = byProject.get(d.project) ?? { lessons: 0, decisions: 0 };
    slot.decisions++;
    byProject.set(d.project, slot);
  }

  // Verification breakdown
  const verification = { claim: 0, evidence: 0, confirmed: 0 };
  for (const l of lessons) {
    const v = l.verification_status ?? "confirmed";
    verification[v] = (verification[v] ?? 0) + 1;
  }

  // Frequency histogram — bucket lessons by their `frequency` value, capped at 10+.
  const histogram: Record<string, number> = {};
  for (const l of lessons) {
    const f = l.frequency ?? 1;
    const bucket = f >= 10 ? "10+" : String(f);
    histogram[bucket] = (histogram[bucket] ?? 0) + 1;
  }

  return {
    totals: {
      lessons: lessons.length,
      decisions: decisions.length,
      patterns: patterns.length,
      projects: byProject.size,
      promotions: promotions.length,
    },
    verification,
    histogram,
    projects: Array.from(byProject.entries())
      .map(([name, n]) => ({ name, ...n }))
      .sort((a, b) => b.lessons + b.decisions - (a.lessons + a.decisions)),
  };
}

function apiEvidence(
  store: SQLiteStore,
  kind: "lesson" | "decision",
  id: number
): unknown {
  const chain = store.getEvidenceChain(id, kind);
  return chain ?? { error: "not found" };
}

function apiProjects(store: SQLiteStore): unknown {
  const set = new Set<string>();
  for (const l of store.getAllLessons()) set.add(l.project);
  for (const d of store.getAllDecisions()) set.add(d.project);
  return Array.from(set).sort();
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function route(
  store: SQLiteStore,
  staticDir: string,
  req: IncomingMessage,
  res: ServerResponse
): void {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const pathName = url.pathname;

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return;
  }

  try {
    // Root → index.html
    if (pathName === "/" || pathName === "/index.html") {
      serveStatic(res, staticDir, "index.html");
      return;
    }

    // Static assets (CSS, JS, SVG, …)
    if (pathName.startsWith("/static/")) {
      serveStatic(res, staticDir, pathName.replace(/^\/static\//, ""));
      return;
    }

    // API routes
    if (pathName === "/api/projects") {
      sendJson(res, 200, apiProjects(store));
      return;
    }
    if (pathName === "/api/lessons") {
      sendJson(res, 200, apiLessons(store, getQueryParam(req, "project")));
      return;
    }
    if (pathName === "/api/decisions") {
      sendJson(res, 200, apiDecisions(store, getQueryParam(req, "project")));
      return;
    }
    if (pathName === "/api/patterns") {
      sendJson(res, 200, apiPatterns(store));
      return;
    }
    if (pathName === "/api/promotions") {
      sendJson(res, 200, apiPromotions(store));
      return;
    }
    if (pathName === "/api/stats") {
      sendJson(res, 200, apiStats(store));
      return;
    }
    // /api/evidence/:kind/:id
    const evidenceMatch = pathName.match(/^\/api\/evidence\/(lesson|decision)\/(\d+)$/);
    if (evidenceMatch) {
      const kind = evidenceMatch[1] as "lesson" | "decision";
      const id = parseInt(evidenceMatch[2], 10);
      sendJson(res, 200, apiEvidence(store, kind, id));
      return;
    }

    send404(res, `No route for ${pathName}`);
  } catch (err) {
    send500(res, err);
  }
}

// ---------------------------------------------------------------------------
// Browser launcher (cross-platform, no deps)
// ---------------------------------------------------------------------------

function openBrowser(url: string): void {
  const p = platform();
  const cmd = p === "win32" ? "cmd" : p === "darwin" ? "open" : "xdg-open";
  const args = p === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // best effort — don't crash the server if the OS lacks a default browser
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface DashboardOptions {
  port?: number;
  open?: boolean;
  dbPath?: string;
  /** When true, start() resolves with `{ server, close }` instead of blocking. Used by tests. */
  returnServer?: boolean;
}

export interface DashboardHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

export async function startDashboard(
  opts: DashboardOptions = {}
): Promise<DashboardHandle> {
  const requestedPort = opts.port ?? DEFAULT_PORT;
  const store = new SQLiteStore(opts.dbPath);
  const staticDir = resolveStaticDir();

  const server = createServer((req, res) => route(store, staticDir, req, res));

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(requestedPort, HOST, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  // Pull the actual bound port (matters when caller passes 0 to let the OS
  // pick a free port, e.g. in tests).
  const addr = server.address();
  const actualPort =
    typeof addr === "object" && addr ? addr.port : requestedPort;
  const url = `http://${HOST}:${actualPort}/`;

  if (opts.open) {
    openBrowser(url);
  }

  return {
    port: actualPort,
    url,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => {
          store.close();
          resolveClose();
        });
      }),
  };
}
