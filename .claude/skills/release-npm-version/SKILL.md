---
name: release-npm-version
description: Use before publishing a new npm version of claude-amplifier. Runs build, tests, a pack smoke test, a fresh temp-install test, and CLI/MCP startup checks before any npm publish, and records a release check artifact.
---

# Release an npm Version

`npm publish` is irreversible after 72 hours and ships to everyone who installs
the package. This card is the gate that catches the usual release breakers
(missing `dist`, a CLI that won't start, an MCP server that won't speak stdio)
**before** they reach users.

## When to use

Before bumping the version and running `npm publish`.

## Procedure

1. **Build.** `npm run build` (runs `tsc` + copies dashboard static assets).
   Zero errors.
2. **Test.** `npm test` — all tests green. (`test` already runs `build` first.)
3. **Pack smoke test.** `npm pack` to produce the tarball. Inspect its contents:
   ```
   tar -tzf claude-amplifier-<version>.tgz
   ```
   Confirm it includes `dist/`, `README.md`, `CHANGELOG.md`, `CLAUDE.md`,
   `LICENSE`, and `examples/` — and **excludes** `node_modules/`, `*.db`,
   `tests/`, and source `.ts`. Match this against the `files` field in
   `package.json`.
4. **Fresh temp-install test.** In a clean temp dir, install the packed tarball
   (not the workspace), e.g.:
   ```
   npm i -g ./claude-amplifier-<version>.tgz     # or into a temp project
   ```
   This catches "works on my machine" issues (missing files, native
   `better-sqlite3` rebuild problems).
5. **Verify CLI starts.** `claude-amplifier help` and `claude-amplifier doctor`
   run and print sane output from the installed binary.
6. **Verify MCP stdio starts.** Launch the server in MCP mode
   (`claude-amplifier mcp`) and confirm it speaks MCP over stdio — e.g. it
   responds to a `tools/list` request and lists all expected tools. A server
   that builds but won't initialize over stdio is a broken release.
7. **Update CHANGELOG.** Add a dated section for the new version (Added / Fixed /
   Changed). Keep the existing format.
8. **Verify package files one last time.** Re-confirm `package.json` `files`
   includes `dist`, `README.md`, `CLAUDE.md`, `LICENSE` (and the
   `prepublishOnly` script will re-run build+test on publish).
9. **Publish.** Only now: bump version, tag, `npm publish`. Publishing requires
   the maintainer's npm auth/2FA — if you are an agent, stop here and hand the
   final `npm publish` to the human.

## Required output artifact

Write a release check to:

```
./knowledge/release_check_{version}.md
```

It must record: build result, test count + pass/fail, the tarball file list, the
fresh-install result, CLI start output, MCP stdio `tools/list` result, and a
final ✅/❌ go decision per step. A release proceeds only if every step is ✅.

## Anti-patterns

- ❌ Publishing from the workspace without a `npm pack` + fresh-install check
   (the classic "forgot a file in `files`" release).
- ❌ Skipping the MCP stdio startup check because the CLI worked — they are
   different entry paths.
- ❌ An agent running `npm publish` itself instead of handing off the
   auth/2FA-gated final step.
