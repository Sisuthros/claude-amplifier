# Security Audit Report: claude-amplifier 1.4.0

**Date:** 2026-05-21
**Auditor:** Security Engineer (subagent)
**Scope:** src/{storage,tools,oracle,cli,index,bootstrap}.ts + package.json

## Severity Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 0 |
| MEDIUM | 2 |
| LOW | 3 |
| INFO | 2 |

## Verdict

**FIX_FIRST (soft)** → Run `npm audit fix` to clear transitive deps before publish. Once that runs, package is **SAFE_TO_PUBLISH**. Core code is well-written:

- All SQL is parameterized except internal-literal `db.exec()` calls
- No `child_process`, no `eval`, no shell execution
- No filesystem traversal vectors exposed via MCP
- ReDoS audit clean
- Stdio-only transport sidesteps the audit-flagged HTTP CVEs

Use **`./fix-security-pre-publish.cmd`** (or `.sh`) to run the recommended sequence before `npm publish`.

## Findings

### MEDIUM-1: Transitive dep vulnerabilities in `@modelcontextprotocol/sdk` (CWE-22, CWE-79, CWE-436)

`npm audit` reports 4 issues (1 high, 3 moderate) in `fast-uri`, `ip-address`, `express-rate-limit` — all transitive via the MCP SDK's HTTP transport. **Amplifier only uses `StdioServerTransport`**, so the vulnerable code paths are dead-loaded but not reachable at runtime. `fixAvailable: true`.

**Mitigation:** Run `npm audit fix` and bump `@modelcontextprotocol/sdk`. Not a publish-blocker because the attack surface (HTTP) is not enabled by this package.

### MEDIUM-2: LIKE-wildcard injection / DoS in search (CWE-1333)

**Files:** `storage.ts:438, 567, 932`

`searchLessons`, `searchDecisions`, and `getPatterns` build `LIKE '%${query}%'` patterns from user-supplied strings without escaping `%` or `_`. SQL is properly parameterized so this is **not SQL injection**, but a malicious caller can submit `%`-heavy patterns to force expensive full-table scans (the DB also has up to 1000-row limit). Low real-world impact since the MCP server is local-only.

**Mitigation (optional, v1.4.1):** Escape `%` `_` `\` with `ESCAPE '\'` clause in LIKE queries.

### LOW-1: `addColumnIfMissing` uses string interpolation in `db.exec()` (CWE-89)

**Files:** `storage.ts:352`

`this.db.exec(\`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}\`)` — interpolates table/column/ddl. **Verified safe** in v1.4.0: only called from `migrate()` with hardcoded string literals. **Future risk** if anyone refactors this to accept caller args.

**Mitigation:** Add a comment + lint rule, or use an allowlist guard.

### LOW-2: Project name → no length/charset validation (CWE-20)

**Files:** `tools.ts` throughout

`args.project`, `args.title`, `args.description`, `pattern_key`, `evidence_link` accept arbitrary-length strings with no max-length or charset enforcement. No filesystem use, so no path traversal — but a caller could insert MB-sized blobs and bloat the SQLite file (DoS).

The `dbPath` constructor param could break out of `~/.claude-amplifier/`, but it's **never exposed to MCP**, only used internally.

**Mitigation (optional, v1.4.1):** Cap inputs at ~10KB each.

### LOW-3: `project_path` from MCP → directory basename without sanitization

**Files:** `tools.ts:359`

`handleContextLoad` derives project name from `project_path` via `split("/").pop()`. Result is stored as `project` text in DB only; not used as filesystem path. Safe in practice but worth a regex sanity-check.

### INFO-1: `prepublishOnly` script (package.json:47)

`npm run build && npm test` — only invokes local tsc + node test. No injection vector. Safe.

### INFO-2: ReDoS audit — none found

`oracle.ts:tokenize` uses `\p{Letter}\p{Number}` Unicode classes with linear `.replace().split().filter()`. No nested quantifiers, no catastrophic backtracking. `storage.ts:547` regex `/^\+(\d+)d$/` is anchored and bounded. Safe.

## Recommended pre-publish actions

```cmd
cd /path/to/claude-amplifier
fix-security-pre-publish.cmd
```

This will:
1. Run `npm audit` to show the issues
2. Run `npm audit fix` to bump transitive deps
3. Re-build TypeScript
4. Re-run tests (should be 45/45 green)
5. Dry-run pack to confirm package integrity

Then proceed with `npm publish`.

## Out-of-scope items (deferred to v1.4.1 or later)

- LIKE-wildcard escaping in search functions
- Input length caps (10KB per string field)
- Allowlist guard on `addColumnIfMissing`
- Project name regex sanity-check

None of these block 1.4.0 publication.

---

*Auditor: Claude subagent (security-engineer), 2026-05-21 ~05:00*
