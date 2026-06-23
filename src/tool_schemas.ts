/**
 * tool_schemas.ts — MCP tool definitions advertised to Claude in the tool list.
 *
 * Extracted verbatim from index.ts (P1 #6 structural split). This file is the
 * single source of truth for what `tools/list` returns; index.ts imports
 * `TOOLS` and hands it to the MCP server unchanged. Zero behavior change from
 * the previous inline definition.
 */

export const TOOLS = [
  {
    name: "amplify_learn",
    description:
      "Records a confirmed lesson — a mistake, success, insight, or warning — into the project's durable lesson log so future sessions inherit it instead of repeating the same error. Writes the lesson immediately at full confidence and returns a confirmation including the assigned lesson id, title, and resolved pattern_key; the write is read-back-verified, so on failure it returns an explicit 'ERROR: Lesson NOT recorded' string rather than a fabricated success — never claim a lesson was saved without that confirmation. Pass pattern_key to aggregate a recurring lesson (same key → frequency bump, no duplicate) and call amplify_suggest_pattern_key first when unsure which key to reuse. Use this for already-confirmed takeaways; for an unproven 'I just learned X' hunch use amplify_record_claim instead (then promote it with amplify_verify_claim), and for architectural choices use amplify_track_decision. Loaded back into context at session start by amplify_bootstrap / amplify_context_load.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description:
            "Required. Project name namespacing the lesson (e.g. 'my-app' or 'work/api-service'); should match the name used with amplify_bootstrap.",
        },
        type: {
          type: "string",
          enum: ["mistake", "success", "insight", "warning"],
          description:
            "Optional. Lesson category: 'mistake' | 'success' | 'insight' | 'warning'. Defaults to 'insight'.",
        },
        title: {
          type: "string",
          description:
            "Required. Short, descriptive one-line title; also used (with pattern_key) for dedup/frequency-bump matching.",
        },
        description: {
          type: "string",
          description:
            "Required. What happened and why it matters, in enough detail to act on the lesson later.",
        },
        context: {
          type: "string",
          description: "Surrounding circumstances (optional).",
        },
        resolution: {
          type: "string",
          description: "How the issue was resolved (optional).",
        },
        prevention: {
          type: "string",
          description: "How to avoid this in future (optional).",
        },
        severity: {
          type: "string",
          enum: ["low", "medium", "high", "critical"],
          description: "Impact level. Defaults to 'medium'.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for filtering (optional).",
        },
        trigger: {
          type: "string",
          description:
            "The specific situation or action that triggers this lesson — useful for pattern detection (optional).",
        },
        pattern_key: {
          type: "string",
          description:
            "v1.2.0 — explicit pattern grouping key (e.g. 'read-docs-before-coding'). When set, recording another lesson with the same key for this project bumps a frequency counter instead of creating a duplicate. Use this when the same lesson recurs with different wording each time. (optional)",
        },
      },
      required: ["project", "title", "description"],
    },
  },
  {
    name: "amplify_decisions",
    description:
      "Record and query a project's architectural and design decisions in a durable, write-verified decision log, so future sessions inherit the reasoning behind past choices instead of re-deriving or contradicting them. A single multiplexed tool selected by the `op` field: track (add a new decision), get (list active decisions), search (full-text query), update (refine fields in place without superseding, v1.2.0), supersede/revert (replace a decision — supersede also auto-marks the older one), update_outcome (mark a decision's check-in as validated/failed/pending), and overdue (list decisions whose outcome check-in date has passed). On success returns a confirmation including the assigned decision id and key fields; reads return formatted decision records; writes are read-back-verified, so on failure it returns an explicit 'ERROR: Decision NOT recorded …' string rather than a fabricated success — never claim a decision was saved without this confirmation. Use op=track when you make a real architectural/tooling/security choice worth remembering; use op=update (not a new track with supersedes) when merely refining the SAME choice's fields; only use supersedes when a genuinely DIFFERENT choice replaces an old one. For knowledge-graph links between two existing decisions use amplify_link_decisions instead; for mistakes/insights use amplify_learn_from_mistake; load all of these at session start via amplify_bootstrap.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: [
            "track",
            "get",
            "search",
            "supersede",
            "revert",
            "update",
            "update_outcome",
            "overdue",
          ],
          description:
            "Operation selector (required). One of: 'track' (add a new decision — needs project/title/description), 'get' (list active decisions for a project), 'search' (full-text search — needs query), 'update' (refine fields of an existing decision in place without superseding, preserving id/created_at — needs id; use this when the same choice is unchanged), 'supersede' (mark a decision superseded; combine with the 'supersedes' field on a new track when a different choice replaces it — needs id), 'revert' (mark a decision reverted — needs id), 'update_outcome' (set a decision's outcome to validated/failed/pending — needs id), 'overdue' (list decisions whose outcome_check_in date has passed). Defaults to 'track'. Example: op=\"track\".",
        },
        project: {
          type: "string",
          description:
            "Project name namespacing the decision log (e.g. 'chimera-prime'). Required for op=track and op=get; optional filter for op=search and op=overdue (omit to span all projects). Should match the name used with amplify_bootstrap. Example: project=\"chimera-prime\".",
        },
        category: {
          type: "string",
          description:
            "Decision category (e.g. 'architecture', 'tooling', 'security'). Defaults to 'general'.",
        },
        title: {
          type: "string",
          description: "Short decision title. Required for track.",
        },
        description: {
          type: "string",
          description: "Full description. Required for track.",
        },
        rationale: {
          type: "string",
          description: "Why this decision was made (optional).",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags (optional).",
        },
        query: {
          type: "string",
          description: "Text to search for. Required for op=search.",
        },
        id: {
          type: "number",
          description:
            "Decision id. Required for supersede/revert/update/update_outcome.",
        },
        outcome_check_in: {
          type: "string",
          description:
            "When to follow up on this decision. Relative ('+7d', '+30d') or ISO date. Surfaces in 'overdue' when past due.",
        },
        outcome_status: {
          type: "string",
          enum: ["pending", "validated", "failed"],
          description:
            "For op=update_outcome: mark whether the decision worked. Defaults to 'validated'.",
        },
        restore_step: {
          type: "string",
          description:
            "How to restore this decision if the system gets reset (e.g. container recreate, image pull). Surfaces in active reminders every session.",
        },
        next_step: {
          type: "string",
          description: "Concrete next action when this decision is unblocked.",
        },
        blocked_on: {
          type: "string",
          description:
            "What this decision is waiting on (person, event, dependency).",
        },
        trade_offs: {
          type: "array",
          items: { type: "string" },
          description: "Tradeoffs accepted when choosing this decision.",
        },
        alternatives_considered: {
          type: "array",
          items: { type: "string" },
          description: "Alternatives considered and rejected.",
        },
        supersedes: {
          type: "number",
          description:
            "ID of an older decision this one replaces. The old one is automatically marked 'superseded'.",
        },
        relations: {
          type: "object",
          properties: {
            triggered_by: { type: "array", items: { type: "number" } },
            caused: { type: "array", items: { type: "number" } },
            relates_to: { type: "array", items: { type: "number" } },
          },
          description:
            "Knowledge-graph links to other decision IDs by relation type.",
        },
      },
      required: ["op"],
    },
  },
  {
    name: "amplify_context_load",
    description:
      "Loads a project's accumulated memory (recorded decisions, lessons, global patterns) at the start of a session so the assistant can resume with prior context instead of starting cold. Resolves the project by `project` name or by deriving it from `project_path`, then returns a single formatted text block: a header with project name and load timestamp, Active Decisions, Lessons (ranked and token-budget-truncated), Global Patterns, Preferences, overdue outcome check-ins, restore steps for active decisions, and a stale-memory warning if memory/<date>.md files are newer than the latest Amplifier write. Lessons are ranked by `priority` and trimmed to fit `max_tokens`; if anything is dropped, the output states 'Showed top N of M' and suggests a larger budget. Use this at session start when you want context without creating the project; prefer amplify_bootstrap (1.5.4+) for the canonical session-start flow since it also creates missing project context. After loading, record new work with amplify_learn_from_mistake (lessons) and amplify_track_decision (decisions); if the freshness warning fires, follow up with amplify_audit_freshness.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description:
            "Project name to load context for. Provide either this OR project_path (if both are given, project wins). Example: \"chimera-prime\".",
        },
        project_path: {
          type: "string",
          description:
            "Absolute path to the project root; the final directory segment becomes the project name (e.g. \"D:/projektit/chimera-prime\" → \"chimera-prime\"). Use instead of project when you only have the path. Also enables the path-aware stale-memory freshness check.",
        },
        types: {
          oneOf: [
            {
              type: "array",
              items: {
                type: "string",
                enum: ["lessons", "decisions", "patterns", "bootstrap", "all"],
              },
            },
            { type: "string", enum: ["all"] },
          ],
          description:
            "Which data categories to load. Accepts an array of [\"lessons\",\"decisions\",\"patterns\",\"bootstrap\"] or the string/array \"all\". Defaults to [\"lessons\",\"decisions\",\"patterns\"]; pass \"all\" to also include bootstrap data. Example: [\"decisions\",\"lessons\"].",
        },
        max_tokens: {
          type: "number",
          description:
            "v1.4.1 — soft token budget (number) for the rendered output. Default 4000. " +
            "When exceeded, lower-priority lessons are dropped and the output notes 'Showed top N of M'. " +
            "Use ~20000 to see everything in a large project. Example: 8000.",
        },
        priority: {
          type: "string",
          enum: ["smart", "recent", "frequency"],
          description:
            "v1.4.1 — ranking used when lessons must be truncated to fit the budget. One of: " +
            "'smart' (default; frequency × 2 + confidence × 3 + recency_bonus + status_weight), " +
            "'recent' (newest first), 'frequency' (most-repeated first).",
        },
      },
    },
  },
  {
    name: "amplify_link_decisions",
    description:
      "v1.2.0 — Add a knowledge-graph link between two existing decisions. Lightweight: one call = one link. Idempotent.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "number",
          description: "ID of the decision that holds the link.",
        },
        to: {
          type: "number",
          description: "ID of the decision being linked to.",
        },
        relation: {
          type: "string",
          enum: ["triggered_by", "caused", "relates_to"],
          description:
            "Relation type: triggered_by=this was caused by `to`; caused=this led to `to`; relates_to=loose association.",
        },
      },
      required: ["from", "to", "relation"],
    },
  },
  {
    name: "amplify_global_patterns",
    description:
      "Manage the cross-project pattern library — reusable best practices, conventions, and coding standards meant to apply across all (or several) Amplifier projects, so hard-won knowledge is not relearned per project. With op=\"get\" it returns the full list of stored global patterns (each shown with id, title, applies_to scope, description, and optional example/tags), or \"No global patterns recorded yet.\" if empty. With op=\"add\" it persists a new pattern (requires title + description; optional example, tags, applies_to) and returns a confirmation containing the assigned id, title, and scope; missing title or description returns an error string instead of writing. Use this for durable, project-agnostic guidance (e.g. \"always parameterize SQL\", \"use pnpm not npm\"); for one-off mistakes or single-project insights use amplify_learn_from_mistake instead, and for architecture choices use amplify_track_decision. Note: op=\"get\" lists every pattern regardless of the applies_to filter.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["get", "add"],
          description:
            "Operation to perform (required). \"get\" lists all stored global patterns; \"add\" records a new one. Defaults to \"get\" if omitted.",
        },
        title: {
          type: "string",
          description:
            "Short, descriptive name of the pattern (e.g. \"Use parameterized SQL queries\"). Required for op=add; ignored for op=get.",
        },
        description: {
          type: "string",
          description:
            "What the pattern is and when to apply it, in enough detail to act on later. Required for op=add; ignored for op=get.",
        },
        example: {
          type: "string",
          description:
            "Optional concrete code snippet or command illustrating the pattern (e.g. \"db.prepare('SELECT * FROM t WHERE id = ?').get(id)\"). Used only with op=add.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional array of free-text tags for grouping/searching (e.g. [\"security\", \"sql\"]). Used only with op=add.",
        },
        applies_to: {
          type: "string",
          description:
            "Project scope for op=add: \"all\" (default) for every project, or a comma-separated list of project names (e.g. \"chimera-prime,Dorafix\") to limit it. Ignored by op=get, which always returns every pattern.",
        },
      },
      required: ["op"],
    },
  },

  // -----------------------------------------------------------------------
  // v1.4.0 — Pattern Oracle + Verification Gate
  // -----------------------------------------------------------------------
  {
    name: "amplify_preflight",
    description:
      "v1.4.0 — Pre-task risk gate: before starting work, scans this project's stored lessons, active decisions, and promoted pattern signals for ones that match the task description, so you can surface known failure modes before repeating them. It tokenizes the prompt (plus optional context), weights matches by frequency and verification status, and returns risk_level (low/medium/high/critical), a numeric score, evidence_quality, the matched patterns/lessons/decisions (top 5 each), and a suggested_approach advice string. Call this FIRST when a task touches a familiar or previously-problematic area; skip it for trivial work or when there is no relevant project history yet. It is read-only and complements amplify_bootstrap (full session context) — use preflight for a fast, targeted 'have I broken this before?' check rather than loading everything. Requires 'project' and a task description ('prompt' or its alias 'task').",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description:
            "Required. Name of the Amplifier project whose stored lessons, active decisions, and promoted patterns to scan (e.g. \"chimera-prime\"). Must match an existing project context.",
        },
        prompt: {
          type: "string",
          description:
            "Required (this or 'task'). Free-text description of the task about to be executed. The oracle tokenizes it and matches against prior issues; more specific wording yields better matches. Example: \"Edit Lumen's Hetzner openclaw.json to change the primary model\".",
        },
        task: {
          type: "string",
          description:
            "Alias for 'prompt' — provide either one (not both needed). Same free-text task description; used when 'prompt' is omitted.",
        },
        context: {
          type: "string",
          description:
            "Optional. Extra signals that sharpen matching, such as touched file paths, recent commit messages, or component names (e.g. \"src/tool_router.ts, config hot-reload\"). Appended to the prompt before tokenization.",
        },
      },
      required: ["project"],
    },
  },
  {
    name: "amplify_record_claim",
    description:
      "v1.4.0 — Records a lesson as an UNVERIFIED claim so that 'I just learned X' insights are captured immediately without being treated as confirmed truth. Use this for any takeaway not yet backed by tests, commits, docs, or explicit user confirmation; it inserts the lesson with verification_status=\"claim\" at confidence 0.5 (override via initial_confidence). Returns the new lesson id, its status/confidence, title, resolved pattern_key, and a ready-to-use amplify_verify_claim hint; if a matching claim already exists (deduped by pattern_key/title) it frequency-bumps that one instead of creating a duplicate. Promote it later with amplify_verify_claim once evidence appears (1 evidence → confidence 0.7, user_confirmation or ≥2 evidence types → confirmed 1.0). Prefer amplify_learn only for already-confirmed or legacy records; pass pattern_key to aggregate recurring lessons across differently-worded variants.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description:
            "Required. Project context name the claim belongs to (e.g. 'chimera-prime'), as used by amplify_bootstrap.",
        },
        type: {
          type: "string",
          enum: ["mistake", "success", "insight", "warning"],
          description:
            "Optional. Lesson category: 'mistake' | 'success' | 'insight' | 'warning'. Defaults to 'insight'.",
        },
        title: {
          type: "string",
          description:
            "Required. Short one-line summary of the claim; also used (with pattern_key) for dedup/frequency-bump matching.",
        },
        description: {
          type: "string",
          description:
            "Required. Full explanation of what was learned, including enough detail to act on it later.",
        },
        context: {
          type: "string",
          description:
            "Optional. Where/when this came up — the situation that produced the claim.",
        },
        resolution: {
          type: "string",
          description: "Optional. What fixed or resolved the situation, if applicable.",
        },
        prevention: {
          type: "string",
          description:
            "Optional. How to avoid the mistake / reproduce the success next time.",
        },
        severity: {
          type: "string",
          enum: ["low", "medium", "high", "critical"],
          description:
            "Optional. Impact level: 'low' | 'medium' | 'high' | 'critical'. Defaults to 'medium'.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional. Array of free-form string tags for filtering and search.",
        },
        trigger: {
          type: "string",
          description:
            "Optional. The signal or condition that should surface this lesson again later (e.g. an error string or task type).",
        },
        pattern_key: {
          type: "string",
          description: "Explicit pattern grouping key for aggregation across worded variants.",
        },
        initial_confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description:
            "Optional. Starting confidence 0–1, clamped to that range. Defaults to 0.5 (unverified claim). Raise only when you have partial but not full proof.",
        },
      },
      required: ["project", "title", "description"],
    },
  },
  {
    name: "amplify_verify_claim",
    description:
      "v1.4.0 — Attach a piece of evidence to an existing lesson and (re)compute its verification status, raising Amplifier's confidence in what it 'knows'. Each call appends one evidence link to the lesson's evidence chain, then promotes status by these rules: any evidence → 'evidence' (confidence 0.7); a 'user_confirmation' evidence OR ≥2 distinct evidence types → 'confirmed' (confidence 1.0); pass promote_to to override the auto-rule. Returns the lesson id, its new status and confidence, the total number of accumulated evidence links, and the latest evidence just added; returns an error if the lesson id does not exist. Use it when a claim gets backed by reality — tests pass, a commit lands, a doc confirms it, or the user explicitly confirms. The target lesson must already exist (created via amplify_record_claim for unverified claims, or amplify_learn_from_mistake); use amplify_evidence_chain afterward to audit why a lesson reached 'confirmed'.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description:
            "Required. Id of the existing lesson to verify (positive integer; accepts a numeric string too). Must reference a lesson already created via amplify_record_claim or amplify_learn_from_mistake — a non-existent id returns an error.",
        },
        evidence_type: {
          type: "string",
          enum: [
            "git_commit",
            "test_run",
            "user_confirmation",
            "external_doc",
            "manual_review",
          ],
          description:
            "Required. The kind of proof being attached, one of: 'git_commit', 'test_run', 'user_confirmation', 'external_doc', 'manual_review'. Attaching a 'user_confirmation' (or reaching ≥2 distinct types across all evidence) auto-promotes the lesson to 'confirmed'.",
        },
        evidence_link: {
          type: "string",
          description:
            "Required. The concrete proof itself — a git SHA, test id/name, doc URL, or short note (e.g. 'a1b2c3d', 'test_verifyLesson_promotes', 'https://docs…', 'Ville confirmed in chat').",
        },
        promote_to: {
          type: "string",
          enum: ["evidence", "confirmed"],
          description:
            "Optional. Force the resulting status to 'evidence' (confidence 0.7) or 'confirmed' (confidence 1.0), bypassing the auto-promotion rules. Omit to let evidence-count/type rules decide.",
        },
      },
      required: ["id", "evidence_type", "evidence_link"],
    },
  },
  {
    name: "amplify_promote_pattern",
    description:
      "v1.4.0 — Promotes a per-project pattern_key (a recurring lesson signature, e.g. \"read-docs-before-coding\") to GLOBAL scope so it counts more heavily in cross-project Pattern Oracle scoring and applies across all Amplifier projects. Validates eligibility before acting: the key must exist in stored lessons, appear in ≥2 distinct projects, and have ≥1 lesson with verification_status 'confirmed' — otherwise it returns a specific error (e.g. only-1-project, or \"verify a lesson first via amplify_verify_claim\") and promotes nothing. On success it records the promotion (idempotent: re-calling the same key returns the existing record, never duplicates) and returns a text summary with the pattern key, the source projects it was promoted from, the aggregated total frequency, and the new promotion id. Use this once a pattern has clearly proven itself across multiple projects and you want it to influence guidance everywhere; do NOT use it for project-specific lessons (those stay local via amplify_learn_from_mistake with a pattern_key). To author a brand-new global rule directly without project history, use amplify_global_patterns instead; to inspect a lesson's supporting evidence before promoting, use amplify_evidence_chain.",
    inputSchema: {
      type: "object",
      properties: {
        pattern_key: {
          type: "string",
          description:
            "The pattern signature string to promote to global scope (the same value passed as pattern_key to amplify_learn_from_mistake, e.g. \"read-docs-before-coding\"). Required, string. Must already exist in stored lessons, span ≥2 distinct projects, and have ≥1 confirmed lesson, or the call returns an error and promotes nothing. Promotion is idempotent — passing a key that was already promoted simply returns its existing record.",
        },
      },
      required: ["pattern_key"],
    },
  },
  {
    name: "amplify_evidence_chain",
    description:
      "v1.4.0 — Audit WHY Amplifier trusts a stored lesson or decision by surfacing its evidence chain. Read-only: looks up the record by id, then returns a formatted text report with its title, verification_status (claim → evidence → confirmed), confidence score, and every linked piece of evidence (each shown as evidence_type @ recorded_at: link, where evidence_type is one of git_commit, test_run, user_confirmation, external_doc, or manual_review). Use this when you need to justify or double-check a claim before relying on it, or to investigate why a record reached 'confirmed' status; pre-1.4.0 records have no links and are reported as confirmed-by-default. This inspects existing records only — it does not add or verify evidence (use amplify_verify_claim to promote a claim), and it pairs with amplify_get_lessons / amplify_get_decisions to fetch the id you pass in. Returns an error string if the id is missing/non-numeric or the record is not found.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description:
            "Required. Numeric id of the lesson or decision to audit (e.g. 42). Obtain it from amplify_get_lessons, amplify_get_decisions, or amplify_search_decisions.",
        },
        kind: {
          type: "string",
          enum: ["lesson", "decision"],
          default: "lesson",
          description:
            "Which record type the id refers to: \"lesson\" or \"decision\". Optional, defaults to \"lesson\".",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "amplify_promote_from_memory_md",
    description:
      "v1.5.0 — Retroactively triage a single memory/<YYYY-MM-DD>.md session log into reviewable amplify_learn / amplify_decisions drafts, so work that was logged but never recorded (the classic 'previous session did 200+ tool calls but called no Amplifier tool') isn't silently lost. It parses the file's event lines (`### HH:MM — Tool/Terminal/Wrote: …`) and applies three heuristics: architectural Wrote: paths (plan/decision/architecture/blueprint/design/manifesto/spec/adr) become decision candidates, any hour with >50 events becomes an intense-session insight, and the same tool/terminal call repeated ≥8× becomes a possible repeated-failure mistake. Returns a human-readable report listing each draft with its kind, confidence score, suggested type (decision/insight/mistake), description, and evidence lines, ranked by score — and explicitly writes NOTHING to SQLite. Use it after amplify_audit_freshness flags a stale day (or whenever you suspect unrecorded work); then YOU review the drafts and call amplify_learn_from_mistake or amplify_track_decision for the ones worth keeping. If no lines match the heuristics it reports zero candidates rather than inventing entries.",
    inputSchema: {
      type: "object",
      properties: {
        memory_file: {
          type: "string",
          description:
            "Required. Absolute path to a single memory/<YYYY-MM-DD>.md session log (or any file using the same `### HH:MM — Tool|Terminal|Wrote: <payload>` line format); lines that don't match this format are ignored. Example: \"D:/projektit/chimera-prime/memory/2026-05-25.md\". A missing/unreadable file yields a zero-event report, not an error.",
        },
      },
      required: ["memory_file"],
    },
  },
  {
    name: "amplify_suggest_pattern_key",
    description:
      "v1.5.0 — Before recording a recurring lesson, suggest which existing pattern_key to reuse (or propose a fresh one) so that the frequency counter actually aggregates instead of splitting one lesson across two near-duplicate keys. Read-only: it queries the project's stored lessons, scores every existing pattern_key by trigram (character-3-gram) Jaccard similarity against your title+description, and returns up to 3 matches above the 0.3 threshold — each with its similarity score, current frequency, and an example title. If nothing clears the threshold it returns a single proposed new key (a boring, hyphenated slug of the title, max 5 words). Call this immediately before amplify_learn_from_mistake whenever the mistake is a recurring pattern you suspect a previous session may have already coined a key for; then pass the chosen key as that tool's pattern_key argument. Skip it for clearly one-off lessons. It never writes to the database — it only advises.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description:
            "Required. The Amplifier project name whose existing lessons are searched for matching pattern_keys (the same name used in amplify_bootstrap / amplify_learn_from_mistake). Only keys recorded under this project are considered.",
        },
        title: {
          type: "string",
          description:
            "Required. The lesson title you intend to record. Used as the primary text for trigram similarity scoring and as the basis for the proposed new key if no existing key matches. Example: \"Verify Amplifier write success before claiming saved\".",
        },
        description: {
          type: "string",
          description:
            "Required. The fuller lesson description. Concatenated with the title to improve disambiguation when scoring similarity against existing keys; does not affect the proposed new key. Example: \"amplify_learn can fail silently; re-read the row back before reporting the lesson as recorded.\"",
        },
      },
      required: ["project", "title", "description"],
    },
  },
  {
    name: "amplify_audit_freshness",
    description:
      "v1.5.0 — Audits a project for unrecorded work by listing memory/<YYYY-MM-DD>.md files whose mtime is newer than the project's latest Amplifier write, so sessions that did real work but never called amplify_learn/amplify_decisions can be caught and triaged retroactively. Compares each dated memory file's mtime against MAX(updated_at) across the project's lessons and decisions; files newer than that cutoff are 'stale'. Read-only — it scans the filesystem and queries the DB but writes nothing. Returns a human-readable report: stale files oldest-first with date, size in KB, and mtime, plus a next-step prompt; or '✓ all fresh', or a 'memory directory not found' note. Edge case: if the project has no Amplifier writes yet, ALL dated memory files are surfaced as candidates (potentially weeks of backlog on first run). Use it when amplify_bootstrap surfaces a stale-memory warning (this tool dumps the full list the warning truncates), or when you suspect a previous session worked without recording; for each flagged day, open the file and follow up with amplify_promote_from_memory_md (to draft suggestions), then amplify_learn / amplify_track_decision to persist.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description:
            "Project name to audit. Provide either this OR project_path (at least one is required); if both are given, project takes precedence.",
        },
        project_path: {
          type: "string",
          description:
            "Absolute path to the project root; the final directory name is used as the project name (e.g. \"D:/projektit/chimera-prime\" → \"chimera-prime\"). When memory_dir is omitted, the memory directory defaults to <project_path>/memory. Provide this OR project.",
        },
        memory_dir: {
          type: "string",
          description:
            "Optional explicit directory to scan for YYYY-MM-DD[-suffix].md files. If omitted, defaults to <project_path>/memory when project_path is given, otherwise $HOME/.claude/memory (or the CLAUDE_AMPLIFIER_MEMORY_DIR override). A missing directory is reported as a benign \"nothing to audit\" note, not an error.",
        },
      },
    },
  },
];
