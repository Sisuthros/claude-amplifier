# Claude Amplifier

**Persistent memory for Claude across sessions — via MCP.**

Claude forgets everything when a conversation ends. Claude Amplifier fixes that. It's an [MCP server](https://modelcontextprotocol.io/) that gives Claude a persistent SQLite memory store for decisions, lessons, and patterns — so it remembers your preferences, past mistakes, and architectural choices every time you start a new session.

---

## The Problem

Every time you start a new Claude session you re-explain:

- "We decided to use Postgres, not MongoDB, because..."
- "Don't use that library — we had a circular dependency issue last month."
- "Our API follows resource/action naming, not CRUD verbs."

With Claude Amplifier, Claude already knows these things.

---

## Requirements

- **Node.js >= 22.5** (uses the built-in `node:sqlite` module — no native compilation)
- No other runtime dependencies

## Install

```bash
npm install -g claude-amplifier
```

Or run directly with npx (no install):

```bash
npx claude-amplifier
```

---

## Add to Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "claude-amplifier": {
      "command": "claude-amplifier",
      "env": {
        "CLAUDE_AMPLIFIER_PROJECT": "/path/to/your/project"
      }
    }
  }
}
```

Restart Claude Desktop. You'll see the amplifier tools available in the tool picker.

### Add to Claude Code (CLI)

In your project directory, add to `.mcp.json`:

```json
{
  "mcpServers": {
    "claude-amplifier": {
      "type": "stdio",
      "command": "claude-amplifier",
      "env": {
        "CLAUDE_AMPLIFIER_PROJECT": "${workspaceFolder}"
      }
    }
  }
}
```

---

## Quick Start

Once connected, add this to your CLAUDE.md (or system prompt):

```
At the START of every session, call amplify_context_load with the project name
to load relevant decisions and lessons.

At the END of every session (or when something important is decided), call
amplify_learn or amplify_decisions to persist it.
```

That's it. Claude will now remember what matters.

---

## Tools

### `amplify_learn` — record a lesson

Capture a mistake, success, or insight so Claude remembers it next session.

```
amplify_learn({
  project: "my-api",
  type: "mistake",           // mistake | success | insight | warning
  title: "Never use floats for currency",
  description: "Rounding errors in checkout caused €0.01 discrepancies at scale.",
  resolution: "Switched to integer cents everywhere.",
  prevention: "Always store money as integer (cents/pence). Never float.",
  severity: "high",          // low | medium | high | critical
  tags: ["money", "types"]
})
```

**Parameters:**

| Field | Required | Description |
|-------|----------|-------------|
| `project` | Yes | Project name |
| `title` | Yes | Short descriptive title |
| `description` | Yes | What happened and why it matters |
| `type` | No | `mistake` / `success` / `insight` / `warning` (default: `insight`) |
| `severity` | No | `low` / `medium` / `high` / `critical` (default: `medium`) |
| `context` | No | Surrounding circumstances |
| `resolution` | No | How it was fixed |
| `prevention` | No | How to avoid it next time |
| `tags` | No | Array of strings for filtering |

---

### `amplify_decisions` — track architectural decisions

```
// Record a decision
amplify_decisions({
  op: "track",
  project: "my-api",
  category: "architecture",
  title: "Use event sourcing for the order domain",
  description: "All order state changes stored as immutable events.",
  rationale: "Audit trail required by compliance. Also enables replay for debugging.",
  tags: ["orders", "eventsourcing"]
})

// List active decisions for a project
amplify_decisions({ op: "get", project: "my-api" })

// Search decisions
amplify_decisions({ op: "search", query: "database", project: "my-api" })

// Mark a decision as superseded
amplify_decisions({ op: "supersede", id: 3 })
```

**Operations:** `track` | `get` | `search` | `supersede` | `revert`

---

### `amplify_context_load` — load context at session start

Call this at the beginning of every session to warm Claude's memory.

```
amplify_context_load({
  project: "my-api",
  types: ["lessons", "decisions", "patterns"]
})

// Or pass a path — project name is inferred from the final directory
amplify_context_load({
  project_path: "/home/user/code/my-api"
})

// Load everything
amplify_context_load({ project: "my-api", types: "all" })
```

**`types` options:** `lessons` | `decisions` | `patterns` | `bootstrap` | `all`

---

### `amplify_global_patterns` — cross-project patterns

Patterns that apply to all your projects — conventions, non-negotiable rules, workflow preferences.

```
// Add a global pattern
amplify_global_patterns({
  op: "add",
  title: "Always back up before destructive operations",
  description: "Before any rm -rf, database DROP, or file overwrite, create a backup.",
  example: "cp -r ./data ./data.bak && rm -rf ./data",
  tags: ["safety", "ops"]
})

// List all patterns
amplify_global_patterns({ op: "get" })

// Pattern scoped to specific projects
amplify_global_patterns({
  op: "add",
  title: "Use pnpm, never npm",
  description: "This monorepo uses pnpm workspaces.",
  applies_to: "my-monorepo,my-shared-lib"
})
```

---

## Configuration

### `CLAUDE_AMPLIFIER_PROJECT`

Set this env var to auto-bootstrap context on startup.

```bash
# As a path (final directory name becomes the project name)
CLAUDE_AMPLIFIER_PROJECT=/home/user/projects/my-app

# As a bare project name
CLAUDE_AMPLIFIER_PROJECT=my-app
```

If not set, falls back to `process.cwd()`.

---

## Data Storage

All data is stored in a local SQLite database:

```
~/.claude-amplifier/amplifier.db
```

- No cloud sync, no external services, no telemetry
- Data is yours, stored locally, readable with any SQLite tool
- Four tables: `lessons`, `decisions`, `patterns`, `preferences`
- WAL mode enabled for safe concurrent access

To inspect your data directly:

```bash
sqlite3 ~/.claude-amplifier/amplifier.db

> SELECT * FROM lessons ORDER BY created_at DESC LIMIT 10;
> SELECT * FROM decisions WHERE status = 'active';
> SELECT * FROM patterns;
```

---

## Build from Source

```bash
git clone https://github.com/YOUR_USERNAME/claude-amplifier
cd claude-amplifier
npm install
npm run build
node dist/index.js
```

---

## Why `node:sqlite`?

Claude Amplifier uses Node's built-in SQLite module (`node:sqlite`, available since Node 22.5). This means:

- **No native compilation** — no `node-gyp`, no C++ compiler, no prebuild pain
- **Zero runtime dependencies** — `npm install` takes seconds
- **Works on every platform** — Windows, macOS, Linux, ARM
- **Survives process crashes** — WAL mode enabled by default
- **Single file** — easy to back up, copy, or inspect with any SQLite tool

---

## License

MIT
