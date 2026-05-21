# Release Prep Report — claude-amplifier 1.4.0

**Date:** 2026-05-21 (early morning, pre-publish)
**Prepared by:** Release-engineer subagent
**Verdict:** **GO** — safe to publish after `fix-security-pre-publish.cmd`

## 1. npm audit (before fix)

`npm-audit-before-fix.txt` — **4 vulnerabilities (1 high, 3 moderate)**, all transitive via `@modelcontextprotocol/sdk` -> HTTP-transport deps:

| Package | Severity | CVE class | Fix |
|---|---|---|---|
| `fast-uri` (<=3.1.1) | HIGH | path-traversal, host-confusion | bump to 3.1.2 |
| `hono` (<=4.12.17) | MODERATE | XSS / JWT / cache-leak / bodyLimit | bump to 4.12.21 |
| `ip-address` (<=10.1.0) | MODERATE | XSS in Address6 | bump to 10.2.0 |
| `express-rate-limit` (8.0.1-8.5.0) | MODERATE | depends on `ip-address` | bump to 8.5.2 |

**Reachability:** none of these run in Amplifier. We use `StdioServerTransport` only — the HTTP code paths are dead-loaded but never reached at runtime. Confirmed in `SECURITY_AUDIT_2026-05-21.md` (MEDIUM-1).

## 2. npm audit fix --dry-run

`npm-audit-fix-dry-run.txt` — clean transitive bump, **no major-version jumps**:

- `fast-uri`        3.1.0 -> 3.1.2  (patch)
- `hono`            4.12.15 -> 4.12.21  (patch)
- `ip-address`      10.1.0 -> 10.2.0   (minor)
- `express-rate-limit` 8.4.1 -> 8.5.2  (minor)

44 new packages added — these are `@xenova/transformers` + ONNX runtime deps that npm wants to install as **optional/peer** for the v1.5 prototype (semantic search). They will land in `node_modules` but **not in the published tarball** because they're devDependencies and `package.json` `files` only ships `dist/`, `examples/`, README/CHANGELOG/LICENSE.

`@modelcontextprotocol/sdk` itself stays at **1.29.0** (current). The four CVE'd packages are transitive — bumping them under SDK 1.29.0 is the fix.

**Breaking changes:** none expected. All bumps are patch/minor. Tests must pass after fix to confirm.

## 3. npm registry state

- `npm whoami` -> **ENEEDAUTH** (not logged in). Ville must run `npm login` (or it's already cached via `.npmrc`) before `npm publish`.
- `npm view claude-amplifier@1.4.0` -> **404 Not Found**.
- `npm view claude-amplifier versions` -> **404 Not Found** (the package name has never been published).

**Implication:** This will be the **first-ever publish** under the `claude-amplifier` name on npm. The name is free.

## 4. GO/NO-GO

**GO.** No publish-blockers.

- 45/45 tests green locally
- Package size 71.7 kB
- Security audit: SAFE_TO_PUBLISH after audit fix
- npm name available
- GitHub branch `next` + tag `v1.4.0` already pushed
- master untouched (Villen v0.2.0 sacred)

## 5. Commands Ville runs in the morning

```cmd
cd D:\projektit\claude-amplifier-oss

REM 1. apply transitive-dep bumps + rebuild + retest + dry-pack
fix-security-pre-publish.cmd

REM 2. login if not already (one-time)
npm login

REM 3. publish
npm publish

REM 4. github release (uses the body we prepared)
gh release create v1.4.0 ^
  --title "v1.4.0 - Pattern Oracle + Verification-Gated Memory" ^
  --notes-file github-release-v1.4.0-body.md ^
  --target next
```

If `fix-security-pre-publish.cmd` fails on tests after the bump, revert `package-lock.json` with `git checkout package-lock.json` and investigate — do not publish a broken build.

## 6. Files prepared in this session

- `npm-audit-before-fix.txt` — audit output
- `npm-audit-fix-dry-run.txt` — dry-run plan
- `github-release-v1.4.0-body.md` — release notes for `gh release create`
- `RELEASE_PREP_2026-05-21.md` — this report

Nothing committed. Nothing pushed. Nothing published.
