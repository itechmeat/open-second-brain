# Agent Surface Suite - adaptive tool catalog, skills over MCP, session lifecycle continuity

**Status:** approved
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain's MCP surface keeps growing (Brain tools, search, schema admin, watchdog, pay-memory), and every connected agent pays the full schema list on every turn even when it needs three tools. At the same time the project ships five agent skills in `skills/` that MCP-connected agents cannot discover at all. On the session side, capture imports every turn role indiscriminately, search focus is one global file with no session binding, the current-task scratchpad (`Brain/pinned.md`) is a single unversioned global document, and a finished session leaves no operator-readable handoff artifact.

## Scope

Eight atomic units over two shared kernels.

Kernel A - surface descriptor and scoring kernel (`src/core/surface/`):

- `descriptor.ts` - one uniform `SurfaceDescriptor` record (kind `tool` | `skill`, name, one-line description, group, tags) built from `ToolDefinition[]` and from skill scans.
- `lexical-score.ts` - one deterministic BM25-style scorer over descriptor fields (name boost, description, tags), no LLM, parameterised so tool-vs-skill tuning cannot drift.
- `skills.ts` - skill discovery: scan the repo `skills/` root plus optional `<vault>/Brain/skills/`, parse `SKILL.md` (first `# heading` as title, first paragraph as description), path-traversal-guarded file access inside a skill directory.

Theme A features on Kernel A:

1. **Skills as MCP tools** (t_251c6490) - `list_skills` (names + descriptions + paths) and `get_skill` (SKILL.md content, optional `file_path` for auxiliary files inside the skill directory) in a new `src/mcp/skill-tools.ts`, registered in `buildToolTable`.
2. **Two-pass tool catalog hydration** (t_e8011a89) - new `ToolScope` member `"catalog"`: `tools/list` advertises only the diagnostic tool, the writer five, and a new `tool_hydrate` tool; every other tool keeps `hidden: true` semantics (callable via `tools/call`, not advertised). `tool_hydrate` with no args returns the compact deterministic catalog (sorted descriptors); with `names: [...]` it returns the full `inputSchema`/`outputSchema` for the requested tools. This is the closest faithful mapping of upstream two-pass hydration onto a static-per-process MCP server (no `listChanged`).
3. **Adaptive tool-surface profiles** (t_20dcb192) - named profiles in `src/mcp/profiles.ts` (`full`, `writer`, `catalog`, `recall`, `minimal`) each resolving to a scope plus a `RuntimeCapabilityWindow`; selected via config key `mcp_tool_profile` or `o2b mcp --tool-profile <name>`. Unknown profile fails OPEN to the full surface with a withheld-reason note in the capability report. Every non-full profile always retains `second_brain_capabilities` and `tool_hydrate` so the agent can discover and reach withheld tools instead of inventing substitutes (the upstream `request_full_tools` recovery contract, adapted to a static server).
4. **Skill auto-attach** (t_10b86707) - `skill-attach.ts` scores skills against the current turn text with the Kernel A scorer and returns a token-budgeted block of top-k skill summaries. Exposed as MCP tool `skills_attach` (input: `query`, optional `max_skills`); gated by config key `skill_auto_attach` (default off -> `{enabled: false, block: ""}`). `plugins/hermes/provider.py` `prefetch()` adds one fail-soft bridge call to `skills_attach` and appends the returned block - the injection point the upstream plugin uses, with zero new Python logic.

Kernel B - session-scope kernel (`src/core/brain/session-scope.ts`):

- `resolveSessionScope(raw)` - normalise a session identifier or workstream label into a safe scope slug (lowercase, `[a-z0-9-]`, length-capped); shared by focus binding, intention chains, and handoff note naming.

Theme B features on Kernel B:

5. **Role-based capture filtering** (t_e2346fe9) - config key `session_capture_roles` (comma-separated subset of `user,assistant,system,tool,meta`; absent/empty = capture all, bit-identical). Parsed by a new `resolveSessionCaptureRoles(configPath)` in `src/core/config.ts`; the import CLI and the session-capture hook pass it as the `ImportSessionOptions.filterRoles` default when no explicit flag is given. Core `importSession` stays pure - the config read happens at the CLI/hook seam.
6. **Operator-readable handoff notes** (t_28afa4d2) - `src/core/brain/handoff.ts`: `buildHandoffNote(turns, opts)` deterministically extracts Request (first user turn), Completed work, Files changed (paths in Write/Edit tool calls), Learned context (fact-shaped lines), and Next steps (next/todo/remaining-shaped lines) via regex - no LLM. Writes `Brain/handoffs/<date>-<scope>.md`. CLI verb `o2b brain handoff <session-file>` reuses the session adapters; the SessionEnd lifecycle path generates one automatically when config `session_handoff` is `true` (default off).
7. **Session-scoped focus** (t_5b478e47) - `session-focus.ts` gains an optional scope: per-session focus files at `search-focus/<scope>.json` beside the global `search-focus.json`; session focus wins over global when both exist. `o2b search focus set|status|clear --session <id>`; MCP `brain_search` gains optional `focus_session` input. SessionEnd lifecycle capture auto-clears that session's focus file. Context-pack wiring: when config `search_focus_context_pack` is `true` (default off), `brain_context_pack` boosts candidates with `scoreSessionFocusTarget` using the active focus.
8. **Scoped intention chains** (t_6d78f69e) - `src/core/brain/intentions.ts`: per-scope now-documents at `Brain/intentions/<scope>.md` with frontmatter (`scope`, `version`, `updated_at`) and an append-only `## History` trail of prior versions (timestamped one-liners); `move-to-history` retires a chain to `Brain/intentions/history/<scope>-<date>.md` and clears the active file. CLI `o2b brain intention set|show|list|move`; one consolidated MCP tool `brain_intention` (operation: `set` | `show` | `list` | `move`) mirroring the `brain_pinned_context` pattern. `Brain/pinned.md` stays untouched as the scope-free default.

## Out of scope

- Hermes-host skill directories (`~/.hermes/skills/`) - the skill surface serves only the repo `skills/` root and the optional vault root.
- Live per-turn re-advertising of MCP tools (`listChanged`) - the server stays static per process; hydration returns schemas as data.
- LLM-based scoring, classification, or summarisation anywhere in the suite.
- Embedding-based skill relevance (the BM25-style scorer is the deliberate v1; an embedding lane can register later).
- Per-session binding for `Brain/pinned.md` (intention chains are the scoped surface; pinned stays global).
- Watching live transcripts (anticipatory cache, t_4cee9df5) - separate task.

## Chosen approach

Consultant Variant 1 (two theme kernels), accepted without override. One catalog/scoring kernel feeds two-pass hydration, the skill tools, auto-attach, and the profile selector, so descriptors and relevance scoring cannot drift between features. One session-scope kernel gives focus binding, intention chains, and handoff naming the same identifier semantics. The kernels stay decoupled across the theme boundary; each of the eight units remains independently testable and off by default.

## Design decisions

- **`hidden` flag is the hydration substrate** - the v0.35.0 token-diet mechanism (callable but unadvertised) already implements "schema not in the prompt until requested"; the catalog scope reuses it instead of inventing a second visibility channel.
- **Unknown profile fails open** - upstream Tool Slimmer fails open to the original schema list on selector errors; a typo in `mcp_tool_profile` must degrade to the full surface (with a report entry), never lock an agent out.
- **`skills_attach` gates inside the tool, not in Python** - the Hermes provider always makes the (fail-soft) call; the TS side returns an empty block unless `skill_auto_attach` is on. The Python diff stays at one call, and the default Hermes injection is bit-identical.
- **Config reads stay at the seams** - `importSession` and `buildHandoffNote` stay pure; CLI verbs and lifecycle hooks resolve config and pass plain options. This keeps the core testable without config fixtures.
- **Session focus wins over global** - a bound session focus is more specific; merging would average two intents. Absent a session file the global file applies, so PR #54 behaviour is unchanged.
- **Intention history is in-file then archived** - the active chain keeps a short timestamped trail (cheap diffing, single read); `move` archives the whole document. No SQLite involvement - intentions are operator-readable Markdown first.
- **One consolidated `brain_intention` tool** - four CLI verbs collapse to one MCP tool with an `operation` input, matching `brain_pinned_context` and respecting the token diet.

## File changes

New (src): `src/core/surface/descriptor.ts`, `src/core/surface/lexical-score.ts`, `src/core/surface/skills.ts`, `src/core/surface/skill-attach.ts`, `src/mcp/skill-tools.ts`, `src/mcp/hydrate-tool.ts`, `src/mcp/profiles.ts`, `src/core/brain/session-scope.ts`, `src/core/brain/handoff.ts`, `src/core/brain/intentions.ts`.

Modified (src): `src/mcp/tools.ts` (register skill/hydrate tools, `ToolScope` + `"catalog"`), `src/mcp/server.ts` (catalog advertising), `src/mcp/instructions.ts` (catalog-scope instructions), `src/cli/main.ts` (`--tool-profile`), `src/core/config.ts` (`resolveSessionCaptureRoles`, `resolveBoolFlag` helpers), `src/core/search/session-focus.ts` (scoped files), `src/core/search/search.ts` + `src/cli/search.ts` (`--session`), `src/mcp/search-tools.ts` (`focus_session`), `src/core/brain/context-pack.ts` (gated focus boost), `src/core/brain/session-lifecycle.ts` (SessionEnd: focus auto-clear + gated handoff), `src/cli/brain.ts` (handoff + intention verbs), `src/mcp/brain-tools.ts` (`brain_intention`), `src/cli/command-manifest.ts`, `plugins/hermes/provider.py` (one `skills_attach` call).

New (tests): one suite per new module plus `tests/integration/agent-surface.integration.test.ts`.

## Risks and open questions

- **Catalog scope vs existing clients** - a client configured with `--tool-profile catalog` sees five advertised tools; agents unaware of `tool_hydrate` may under-use the Brain. Mitigation: catalog-scope `initialize.instructions` explain the hydration contract explicitly.
- **`brain_search` input growth** - `focus_session` is one optional string; the schema cost is small but real. Accepted: session focus without a search-side key would be unreachable over MCP.
- **Handoff extraction quality** - regex extraction will miss prose-shaped facts; acceptable for v1 (the note links the session file for full fidelity).
- **SKILL.md heterogeneity** - descriptions derive from the first paragraph; a skill without one degrades to an empty description (never a crash).
