You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Ship a first-class, native Open Second Brain integration for the Grok Build CLI (`grok`, xAI; verified against the locally installed grok 0.2.45 and its bundled docs at `~/.grok/docs/user-guide/`). Match the depth of the existing Claude Code, OpenAI Codex, and opencode integrations: register the two Open Second Brain MCP servers, install lifecycle hooks (active-context injection at session start, post-write logging nudge after file-mutating tools, and session capture), and import Grok sessions into the Brain.

The single most important architectural question: given that Grok ALREADY reads Claude Code and Cursor config automatically (see "Grok surface" below), what is the right native delivery strategy that (a) serves pure-grok users who have no `~/.claude`, (b) is the marketplace-publishable first-class unit, (c) maximally reuses the existing install-adapter / session-adapter / hook seams, and (d) adds no do-nothing fallbacks or stubs? Produce 3 distinct architectural variants for HOW to structure and deliver this integration, then recommend one.

# Grok surface (authoritative, grok 0.2.45)

- MCP servers: native `~/.grok/config.toml` `[mcp_servers.<name>]` (TOML; stdio = `command`/`args`/`env`/`enabled`/timeouts, HTTP = `url`/`headers`). CLI helper `grok mcp add <name> --command <cmd> --args ... --env K=V` writes to config.toml but cannot pass args starting with a hyphen. Grok ALSO auto-merges MCP from `~/.claude.json` (Claude format) and `.cursor/mcp.json` via `[compat.<vendor>]`; merge priority config.toml > Claude > Cursor > project `.mcp.json`.
- Hooks: `~/.grok/hooks/*.json` in the Claude-compatible JSON shape `{"hooks":{"<Event>":[{"matcher","hooks":[{"type":"command","command","timeout","env"}]}]}}`. Events: SessionStart, UserPromptSubmit, PreToolUse (only blocking one), PostToolUse, PostToolUseFailure, PermissionDenied, Stop, StopFailure, Notification, SubagentStart/Stop, PreCompact, PostCompact, SessionEnd. Grok auto-reads `~/.claude/settings.json` hooks. stdin payload uses camelCase: `{hookEventName: "pre_tool_use", sessionId, cwd, workspaceRoot, toolName, toolInput, timestamp}` (Claude Code uses snake_case `hook_event_name`/`session_id`/`tool_name`/`tool_input` and a `transcript_path` that grok does NOT provide). Hook env: GROK_HOOK_EVENT, GROK_HOOK_NAME, GROK_SESSION_ID, GROK_WORKSPACE_ROOT, CLAUDE_PROJECT_DIR alias; plugin hooks also get GROK_PLUGIN_ROOT, GROK_PLUGIN_DATA. Matcher tool-name aliases: Bash->run_terminal_command, Edit/Write/MultiEdit->search_replace, Read->read_file, etc.
- Plugins: a directory with optional `plugin.json` manifest plus convention components: `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json` (MCP standard format), `.lsp.json`. Installed via `grok plugin install <git|user/repo|local path> --trust` into `~/.grok/plugins/` (auto-trusted) or `.grok/plugins/` (needs trust). Plugins are DISABLED by default unless installed with `--trust`, force-enabled via `[plugins] enabled=[...]` in config.toml, or on an explicit config path. Marketplace via `[[marketplace.sources]]` in config.toml or `extraKnownMarketplaces` in `~/.grok/settings.json`. `grok plugin validate`, `grok plugin tag`, `grok inspect --json`.
- Sessions: `~/.grok/sessions/<encoded-cwd>/<session-id>/` (base overridable by `GROK_HOME`). `updates.jsonl` = authoritative newline-delimited ACP session update stream (prompts, responses, tool calls). `summary.json` = metadata incl. `parent_session_id` (lineage), `agent_name`, model id, timestamps, counts. Also `chat_history.jsonl`. `grok export <id>` emits Markdown; `grok sessions list --json`; headless `grok -p ... --output-format json` returns `sessionId`.

# Project context

- Open Second Brain: an agent-owned Markdown second brain. TypeScript on Bun for the core; a Python shim for the Hermes memory provider. `dependencies = []` (no YAML/TOML lib shipped today).
- Recent commits:
  - 3e7e233 fix(hermes): serialize handle_tool_call result to a string (v1.3.1)
  - 96f1ff4 feat: native opencode integration - config-correct install, bundled plugin, session capture (#88)
  - 0340560 feat: Continuity, Hygiene & Freshness Suite - session lineage, memory hygiene (v1.3.0)
- Existing seams to reuse (NOT rebuild):
  - `src/core/install/json-merge.ts`: canonical MCP keys `OSB_KEY_FULL="open-second-brain"`, `OSB_KEY_WRITER="open-second-brain-writer"`; canonical `McpServerEntry` is `{command, args, env?}`; `serializeEntry` injection point already exists for non-default on-disk shapes.
  - `src/core/install/adapters/_json-mcp.ts` + `opencode.ts`: adapter factory with detect/plan/apply/verify/uninstall, manifest-tracked `owned_paths`, drift detection.
  - `src/core/install/opencode-plugin-asset.ts`: version-stamped bundled-plugin asset module pattern.
  - `src/core/brain/sessions/registry.ts` + `opencode.ts`: `SessionAdapter` registry; add an adapter = drop `sessions/<id>.ts` + append to `SESSION_ADAPTERS` + extend `SessionAdapterId`. Detect on structural fields; a newer unknown shape must fail with a versioned PARSE error.
  - `hooks/lib/stdin.ts` + `detect.ts`: shared hook stdin parser + runtime detection used by the Claude Code / Codex layers (currently keyed to Claude snake_case payload).
  - `o2b-hook` PATH shim: `o2b-hook active-inject` renders the active Brain context; opencode and the Claude/Codex layers call it rather than reimplementing vault resolution and quiet-failure semantics.
- The opencode precedent (#88) delivered BOTH a config write (MCP into opencode.json) AND a bundled plugin (hooks/capture) AND a session adapter. Consider whether grok should mirror that two-pronged shape or collapse into one.

# Conventions

- SOLID, KISS, DRY. Everything that can be lifted into a local/global constant is.
- No fallbacks that silently do nothing and mislead: surface errors explicitly. No stubs. No crutches. Maximally native, no workarounds.
- No hardcoded natural-language phrase lists in any language; English-only source; handle other languages abstractly.
- Adapters stay offline-unit-testable (the project's other adapters are tested without the target binary installed).
- TDD: failing test first, then implement.

# Constraints

- Do not fork the shared install/session/hook seams; extend them.
- Do not add a heavy dependency (no new TOML/YAML library) unless a variant makes an explicit, justified case for it.
- One PR, one CHANGELOG version. Version bump via `package.json` + `bun run scripts/sync-version.ts` (mirrors several manifests).
- Reuse the canonical MCP entry payload so grok never drifts from the other targets.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
