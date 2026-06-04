---
name: add-mcp-tool
description: Use when adding or modifying an MCP tool in claude-amplifier. Walks the schema → router → handler → storage → tests chain so a new tool can't ship half-wired, and warns about where tool definitions live today.
---

# Add or Modify an MCP Tool

Adding a tool touches several layers that must stay in sync. A tool that has a
schema but no router case, or a handler with no validation, ships broken. This
card is the checklist that keeps the chain complete.

## Repo reality (verify before you assume)

As of v1.5.0 the tool definitions and the request router live **together in
`src/index.ts`**:

- **Tool schemas** are defined as the `TOOLS` array in `src/index.ts`
  (each entry: `name`, `description`, `inputSchema`).
- **The router** is the `CallToolRequestSchema` handler in the same file — a
  `switch (request.params.name)` with one `case "amplify_*"` per tool.
- **Handlers** (the actual logic) live in `src/tools.ts`.
- **Storage** methods live in `src/storage.ts`.

> ⚠️ `src/index.ts` already holds 13 tool schemas and is growing. Schemas are
> **not** split into per-tool modules yet. When you add a tool, follow the
> existing in-`index.ts` pattern for consistency — but if `index.ts` is becoming
> unwieldy, do the split as its **own** dedicated, reviewable change (move the
> `TOOLS` array into `src/schemas.ts` and import it), **never** as a drive-by
> inside a feature commit. Do not bolt a new schema onto a file that someone is
> mid-way through splitting.

## Required steps

1. **Schema.** Add/update the tool entry in the `TOOLS` array in `src/index.ts`
   (`name`, a precise `description`, and a complete `inputSchema` with required
   fields and enums). The description is what the agent reads to decide when to
   call it — make it specific.
2. **Router.** Add/update the matching `case "amplify_<name>":` in the
   `CallToolRequestSchema` handler so the tool actually dispatches.
3. **Handler validation.** In `src/tools.ts`, validate inputs at the top of the
   handler (required fields present, enums in range, sane sizes). Fail with a
   clear message — never silently coerce.
4. **Storage method (if needed).** If the tool persists or queries data, add the
   method in `src/storage.ts`. If it writes, it **must** use the v1.5.0
   read-back pattern (re-read the row; throw `AmplifierWriteError` on empty) so
   it can never report a hallucinated success.
5. **Tests — both paths.** Add tests in `tests/<name>.test.js` covering a
   **success** path (returns the expected result / numeric id) **and** a
   **failure** path (invalid input rejected; on a write tool, a simulated
   read-back failure surfaces `ERROR: ... NOT recorded`). See
   `design-memory-eval` for how to structure these.
6. **Docs — only if behavior changes.** Update `README.md` / `CLAUDE.md` /
   `CHANGELOG.md` **only** when user-visible behavior or the tool list changes.
   Do not churn docs for internal refactors.

## Verification rule

Before calling the tool done: `npm test` is green, the new tool appears in the
`tools/list` response, and a manual `case` dispatch test confirms the router
reaches your handler. A tool with a schema but no reachable handler is not done.

## Anti-patterns

- ❌ Adding a schema without the router `case` (tool listed but un-callable).
- ❌ A write path that doesn't read back (re-opens the hallucinated-success bug).
- ❌ Splitting schemas out of `index.ts` *and* adding a feature in the same
   commit — make the structural move separately so it's reviewable.
- ❌ Tests for the happy path only.
