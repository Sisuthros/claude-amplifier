# Contributing to Claude Amplifier

Thanks for considering a contribution. This document covers what we look for, how to set up the project, and how to send a change.

## Ground rules

- **Small, focused PRs.** One change per PR. If a fix touches a bug and an unrelated cleanup, send two PRs.
- **Tests are required for behaviour changes.** `npm test` must pass on Node 18, 20, and 22.
- **No new runtime dependencies without discussion.** Open an issue first; the project deliberately keeps its dependency surface tiny.
- **Backwards compatibility matters.** Stored data must remain readable after upgrades. If a migration is unavoidable, document it in CHANGELOG.md and ship a path-forward.
- **TypeScript strict mode is on.** Don't loosen it.

## Project setup

```bash
git clone https://github.com/Sisuthros/claude-amplifier.git
cd claude-amplifier
npm install
npm run build
npm test
```

The build emits to `dist/`. The CLI entrypoint is `dist/index.js`.

## Running locally against Claude Desktop / Claude Code

Point your MCP config at the built file:

```json
{
  "mcpServers": {
    "claude-amplifier-dev": {
      "command": "node",
      "args": ["/absolute/path/to/your/clone/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop / Claude Code after editing the config. `npm run dev` watches the source and rebuilds on save.

## Commit conventions

Conventional Commits — `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`. Subject line in imperative mood, max 72 characters. Body explains *why* the change was needed.

## Pull request checklist

- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] CHANGELOG.md has an entry under `## Unreleased`
- [ ] If you added a tool or changed a tool's schema, README's MCP tools section is updated
- [ ] If you changed CLI behaviour, the CLI help output and README CLI section are updated

## What we won't accept

- PRs that add a cloud sync feature without an explicit opt-in flag. Local-first is a core property of this project.
- PRs that add telemetry, analytics, or any kind of phone-home behaviour.
- PRs that introduce a new external service dependency for the default install path.

## Reporting bugs

Open an issue at https://github.com/Sisuthros/claude-amplifier/issues with:
- Node version (`node --version`)
- OS
- The output of `claude-amplifier doctor`
- A minimal reproduction (if possible, an MCP request that fails)

## Questions

If you're unsure whether a change is welcome, open an issue describing what you want to do before writing the patch. It's faster than rewriting after review.
