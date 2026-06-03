You are brainstorming architectural variants for the following epic. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Epic: Agent Surface Suite - one multi-task PR shipping eight related atomic units in two themes.

Theme A - MCP tool surface and skills economy:
1. Two-pass Brain tool catalog hydration (t_e8011a89)
2. Skills as callable MCP tools: list_skills / get_skill (t_251c6490)
3. Skill auto-attach in system prompt by deterministic relevance scoring (t_10b86707)
4. Adaptive Brain MCP tool-surface profiles with full-tool fallback (t_20dcb192)

Theme B - session lifecycle continuity:
5. Role-based capture filtering for session sync (t_e2346fe9)
6. Operator-readable session handoff notes (t_28afa4d2)
7. Session-scoped focus: per-session binding, auto-clear, context-pack wiring (t_5b478e47)
8. Scoped current-intention chains with move-to-history lifecycle (t_6d78f69e)

Full task bodies follow.

## Task t_e8011a89 (priority 3): [upstream:hermes-tool-slimmer] Two-pass Brain tool catalog hydration for large capability sets

**Source**: https://github.com/alias8818/hermes-tool-slimmer
**Upstream files studied**: `README.md`, `CHANGELOG.md`, `docs/quickstart.md`, `docs/hermes-core-integration.md`, `src/hermes_tool_slimmer/two_pass.py`, `src/hermes_tool_slimmer/integration.py`, `src/hermes_tool_slimmer/index_store.py`, `src/hermes_tool_slimmer/schemas.py`, `tests/test_two_pass.py`, `tests/test_index_metrics_anthropic.py`

## What
Hermes Tool Slimmer's experimental two-pass mode replaces a large eager schema list with a compact deterministic catalog and a hydration tool. The first pass exposes only always-included tools plus `tool_slimmer_hydrate_tools`; that tool describes available tools by name, one-line description, toolset, and tags. The model requests multiple full schemas in one batch, and the next model call exposes those hydrated schemas, optionally cached by session. The implementation keeps safety/fallback tools separate, respects disabled policy, sorts catalogs deterministically, limits catalog size, verifies live-schema checksums, and rejects stale or probe-only live snapshots by default.

## Why useful for OSB
As OSB accumulates more Brain capabilities, a binary choice between exposing every tool or a tiny static subset becomes awkward. Agents need discoverability for rare Second Brain operations such as schema repair, backlinks, watchdog checks, source ingestion, payment assets, or future graph/admin tools, but most turns only need a few core recall tools. A compact Brain tool catalog with explicit hydration would preserve discoverability while keeping full schemas out of the prompt until the agent actually needs them.

## Current OSB status
- **Verdict**: not_in_osb_useful
- **Local evidence**: OSB exposes concrete MCP tools and a capability diagnostic surface, and it has output artifact fetch for oversized results. I did not find a compact catalog/hydration mode where rare OSB tool schemas are deferred, requested in a batch, and cached by session for later turns.
- **Related existing work, not a duplicate**: MCP preview budgets and artifact fetch handle large results after execution. Context-pack ordering and repeated-context dedup optimize Brain content in prompts. This task targets the MCP tool-schema catalog itself before execution and before context-pack assembly.

## Proposal
Add a progressive Brain tool catalog mode for compatible OSB host adapters. The first version can be a dry-run/catalog surface plus integration tests; an active mode can follow where the host supports request-local schema filtering. The catalog should be deterministic, privacy-safe, and explainable, and it should hydrate full schemas only through an explicit tool-name batch request.

## Acceptance criteria
- OSB can render a compact catalog of currently eligible tools with name, short description, group/toolset, tags, and checksum.
- A hydration request can name several tools and receive a bounded next-turn schema set without executing those tools.
- Hydrated tools are scoped to a session or request and never become sticky global state.
- Disabled tools, withheld capability windows, and scope restrictions are enforced both in the catalog and during hydration.
- Stale live-schema snapshots are rejected by checksum/age, and probe events without session identity do not update production catalogs.
- Tests cover deterministic catalog ordering, hydration batching, session cache behavior, disabled-policy enforcement, missing hydrator fallback, and stale snapshot rejection.

> Validator comment: osb-triage-validator @ 2026-06-03T10:04Z:
- sanity: clean
- cluster: no cluster
- priority: set to 3: overriding origin-unknown priority 1 (no reprioritized event in history) - not_in_osb_useful but clear scope, two-pass tool catalog with hydration fits one week of work.

## Task t_251c6490 (priority 3): [upstream:core] Expose skills as callable MCP tools (list_skills, get_skill)

**Source**: https://github.com/RedPlanetHQ/core/releases/tag/0.7.15
**Repo**: RedPlanetHQ/core (1600★)
**Released**: 0.7.15 (2026-06-01T12:15:14Z)

## What
RedPlanet core exposes skills as MCP tools: list_skills and get_skill become callable via the MCP protocol. Connected agents can discover available skills and fetch their content without shell access. PR #886.

## Why useful for OSB
OSB has a rich skill system (skill_view, skills_list, skill_manage) accessible via Hermes CLI but NOT exposed as MCP tools. Connected agents (Claude Code, Codex, etc.) talking to OSB via MCP cannot discover or load skills — they must guess skill names or ask the user. Exposing skills as MCP tools would let any MCP-connected agent self-discover available skills, read their content, and follow their instructions without prior knowledge.

## Status in OSB
- **Verdict**: present_weaker
- **Codegraph hints**: src/mcp/server.ts:76 (tools method), src/mcp/tools.ts:60 (ToolDefinition), src/mcp/tools.ts:283 (ToolScope). Skills live in ~/.hermes/skills/ and ~/.hermes/profiles/*/skills/, loaded by skill_view/skills_list CLI. No MCP tool surface for skill discovery or retrieval.

## Notes
The list_skills tool would return skill names + descriptions (like skills_list output). The get_skill tool would accept a skill name and optional file_path (like skill_view). This bridges the gap between OSB's skill system and MCP-connected agents.

> Validator comment: Validation pass 2026-06-02: scope caveat - skill_view/skills_list and ~/.hermes/skills/ belong to the Hermes host, not to Open Second Brain. An OSB-side list_skills/get_skill MCP surface would either need OSB to own a skills directory concept, or this belongs upstream in Hermes (expose skills via the memory-provider/MCP surface). Decide ownership before implementation; the upstream pattern (RedPlanetHQ/core 0.7.15) is still a good reference.

> Validator comment: osb-triage-validator @ 2026-06-03T10:05Z:
- sanity: clean
- cluster: no cluster
- priority: set to 3: overriding origin-unknown priority 3 (no reprioritized event in history) - present_weaker with concrete hints (src/mcp/server.ts:76, tools.ts:60/283), clear scope, fits one week of work.

## Task t_10b86707 (priority 3): [upstream:yantrikdb-hermes-plugin] Skill auto-attach in system prompt without explicit search

**Source**: https://github.com/yantrikos/yantrikdb-hermes-plugin/releases/tag/v0.5.0
**Repo**: yantrikos/yantrikdb-hermes-plugin (27★)
**Released**: v0.5.0 (2026-05-31T07:10:31Z)

## What
YantrikDB v0.5 introduced automatic skill attachment: skills surface in the system prompt on every turn without requiring an explicit skill_search call. The plugin scans active skills against the current turn context and injects relevant skill guidance proactively. First Hermes memory provider to do this.

## Why useful for OSB
OSB skills are loaded on-demand via skill_view when the agent decides to load one. There is no automatic per-turn skill relevance scoring that proactively surfaces applicable skills. Auto-attaching skills would reduce the cognitive load on the agent to remember which skills exist and when to load them, ensuring relevant procedural guidance is always present in context without explicit discovery calls.

## Status in OSB
- **Verdict**: present_weaker
- **Codegraph hints**: Skills are in ~/.hermes/skills/ and loaded via skill_view/skills_list. No per-turn skill relevance scoring or auto-attachment mechanism exists. brain_context_pack injects memories but not skills. The procedural memory index (brain_procedural_memory) tracks usage but does not drive auto-injection.

## Notes
Implementation could use BM25 or embedding-based scoring of skill content against the current turn message, with a token-budget cap similar to context_pack. The yantrikdb approach uses the system_prompt_block hook for injection — OSB could integrate via the same hook or via brain_context_pack.

> Validator comment: Validation pass 2026-06-02: same ownership caveat as t_251c6490 - the skills being auto-attached live in the Hermes host, not in OSB. Note v0.32.0 shipped the native Hermes memory provider with system_prompt_block(), which is exactly the injection point the upstream plugin uses; an OSB implementation would score skills per-turn and extend that block (deterministic BM25-style scoring preferred, no LLM in the loop).

> Validator comment: osb-triage-validator @ 2026-06-03T10:04Z:
- sanity: clean
- cluster: no cluster
- priority: set to 3: overriding origin-unknown priority 2 (no reprioritized event in history) - present_weaker with clear hints, skill auto-attach via BM25 scoring fits one week of work.

## Task t_20dcb192 (priority 2): [upstream:hermes-tool-slimmer] Adaptive Brain MCP tool-surface profiles with full-tool fallback

**Source**: https://github.com/alias8818/hermes-tool-slimmer
**Upstream files studied**: `README.md`, `CHANGELOG.md`, `docs/quickstart.md`, `docs/hermes-core-integration.md`, `docs/dashboard-plugin.md`, `docs/privacy.md`, `src/hermes_tool_slimmer/selector.py`, `src/hermes_tool_slimmer/integration.py`, `src/hermes_tool_slimmer/config.py`, `src/hermes_tool_slimmer/policy.py`, `src/hermes_tool_slimmer/tools.py`, `tests/test_selector.py`, `tests/test_config.py`

## What
Hermes Tool Slimmer selects a request-local tool schema subset before the model call. It ranks eligible schemas with deterministic BM25 plus explicit boosts, keeps `always_include` tools hot, respects disabled tools/toolsets and MCP/native origin policy, applies platform profiles such as CLI, Slack, Telegram, cron, and webhook, skips low-information turns, enforces minimum estimated reduction guardrails, supports dry-run mode, and fails open to the original schema list on selector errors. It also keeps a `tool_slimmer_request_full_tools` fallback available so a model can recover the full schema set on the next turn instead of inventing substitute workflows.

## Why useful for OSB
OSB's MCP surface is growing: core Brain tools, search, schema administration, watchdog probes, pay-memory tools, future source connectors, and host-specific integrations all compete for the same model tool-schema budget. OSB currently has static tool scopes and runtime capability reporting, plus output preview budgets for large tool results, but it does not adapt the advertised Brain tool surface to the current task, host, or entry point. A profile-aware selector would make OSB more comfortable as a Second Brain for agents: the right memory tools stay visible, irrelevant or risky tools are quieter, and the full Brain surface remains recoverable when needed.

## Current OSB status
- **Verdict**: present_weaker
- **Local evidence**: CodeGraph and local reads show `ToolScope` (`full`/`writer`), `ToolCapabilityReport`, MCP preview budgets, and `brain_artifact_get`. Those manage static availability and output size. I did not find a per-turn, query-aware MCP tool-surface selector, platform profile overlay, dry-run decision path, or full-tool fallback recovery mechanism for OSB's own tools.
- **Related existing work, not a duplicate**: `t_89da8db4` protects context from oversized tool results after a tool runs. This task reduces request-side schema overhead before the model chooses tools. Runtime capability verification reports what can be exposed; this task decides what should be exposed for this turn and entry point.

## Proposal
Add an optional OSB tool-surface selection layer for hosts that support request-local tool filtering, plus a CLI/dry-run advisor for hosts that do not. Keep the default MCP server behavior unchanged unless enabled. The selector should use OSB tool metadata, task text, host/platform, configured profiles, and safety policy to propose a small Brain tool set while keeping explicit recovery available.

## Acceptance criteria
- OSB can compute a request-local tool subset for a user message without mutating the canonical MCP tool registry.
- Config supports always-include, disabled tools, disabled tool groups, platform profiles, minimum reduction guardrails, dry-run mode, and fail-open behavior.
- A full-tool fallback path is always available when slimming is active, and tests cover the retry lifecycle after fallback is requested.
- Selection explanations include selected tools, skipped tools, score details, guardrail skip reason, and estimated schema bytes/tokens before and after.
- Existing scope/capability checks still run before selection, so slimming cannot expose tools that OSB would otherwise withhold.
- Tests cover low-information prompts, disabled-tool policy, platform profiles, no-match behavior, selector exceptions, and compatibility with the current static `full`/`writer` scopes.

> Validator comment: osb-triage-validator @ 2026-06-03T10:05Z:
- sanity: clean
- cluster: no cluster
- priority: set to 2: overriding origin-unknown priority 2 (no reprioritized event in history) - present_weaker, tool-surface selector needs design before implementation.

## Task t_e2346fe9 (priority 3): [upstream:mnemosyne] Role-based autosave filtering for selective memory sync

**Source**: https://github.com/AxDSan/mnemosyne/releases/tag/v3.3.0
**Repo**: AxDSan/mnemosyne (629★)
**Released**: v3.3.0 (2026-06-01T02:21:51Z)

## What
Mnemosyne v3.3.0 introduced sync_roles config for role-based autosave filtering. The provider filters which conversation content gets persisted based on role configuration, enabling selective memory sync (e.g., only user messages and tool outputs, not raw assistant reasoning).

## Why useful for OSB
OSB session capture imports full conversation turns including assistant reasoning, tool calls, and intermediate thinking. A role-based filter would let operators configure which turn types become Brain evidence — for example, capturing user requests and final answers but excluding verbose intermediate reasoning or tool call internals. This would reduce noise in the Brain and focus memory on the most actionable content.

## Status in OSB
- **Verdict**: present_weaker
- **Codegraph hints**: src/core/brain/sessions/types.ts:27 (SessionTurn), src/core/brain/sessions/import.ts:117 (importSession). Session import processes all turn types without role-based filtering. The session ignore patterns (from existing task t_0532ed5a) filter by session-level patterns, not by turn role.

## Notes
Could be implemented as a config key in _brain.yaml (session_capture.role_filter) that specifies which TurnSignal roles to persist. The Mnemosyne approach uses a config file (sync_roles) — OSB could follow the same pattern with YAML-based role allowlists/denylists.

> Validator comment: osb-triage-validator @ 2026-06-03T10:04Z:
- sanity: clean
- cluster: no cluster
- priority: set to 3: overriding origin-unknown priority 2 (no reprioritized event in history) - present_weaker with clear hints (sessions/types.ts:27, import.ts:117), role-based filter is a straightforward config addition.

## Task t_28afa4d2 (priority 2): [upstream:ClawMem] Operator-readable session handoff notes

**Source**: https://github.com/yoloshii/ClawMem
**Upstream files studied**: `README.md`, `src/hooks/handoff-generator.ts`, `src/observer.ts`, `src/profile.ts`

## What
ClawMem generates a handoff note when an agent session ends. The hook reads the transcript tail, extracts a structured summary when possible, falls back to deterministic regex extraction when not, and saves a Markdown note with sections for request, investigation, learned context, completed work, files changed, and what the next session should do. Later session bootstrap/profile code can reuse these notes to keep continuity without replaying an entire transcript.

## Why useful for OSB
OSB already has session import adapters, conversation fact extraction, morning briefs, pre-compress packs, and a proposed session summary DAG. Those are valuable for recall and compression, but they do not give the operator a concise, inspectable end-of-session handoff artifact that answers: what changed, what was learned, where did we stop, and what should the next agent pick up first? Handoffs are especially useful when work crosses context compaction, agent changes, or a human pause between sessions.

## Current OSB status
- **Verdict**: not_in_osb_useful
- **Local evidence**: Existing OSB session work focuses on importing turns, extracting facts, preserving lossless source, and generating session-start summaries. I did not find a dedicated stop-session handoff note format linked to session IDs and designed for human/operator review.
- **Related existing work, not a duplicate**: `t_772706ee` is about a lossless summary DAG with drill-down recall. This task is about a small, durable, operator-readable handoff document that records state and next steps at the end of a work session.

## Proposal
Add a handoff generator that can be run from session-stop hooks, manually from the CLI, or after importing a transcript. Store handoffs as filesystem-first Brain artifacts linked to the session timeline and make the latest relevant handoff available to session-start context.

## Suggested design
- Add `brain handoff generate --session <id> --transcript <path>` plus an MCP/session-hook entry point.
- Store generated notes under a stable path such as `Brain/sessions/handoffs/YYYY-MM-DD-SESSION.md` with frontmatter linking source agent, transcript hash, files changed, source turns, and generation mode.
- Prefer structured extraction from existing session/fact pipelines, then fall back to deterministic transcript heuristics when extraction is unavailable.
- Include sections for request, current state, decisions, files changed, unresolved blockers, next steps, and validation status.
- Link handoffs from session index/timeline queries and optionally include the most recent relevant handoff in `brain_morning_brief` or session bootstrap.

## Acceptance criteria
- [ ] A session-stop or manual command creates a valid Markdown handoff without requiring full transcript replay.
- [ ] The handoff links back to the source session/transcript and lists changed files when available.
- [ ] The next session can retrieve the latest relevant handoff through CLI/MCP.
- [ ] Duplicate stop-hook invocations do not create unbounded duplicate handoffs for the same session.
- [ ] Tests cover structured extraction, fallback extraction, idempotency, and missing-transcript handling.

## Out of scope
- Replacing full session import or lossless transcript storage.
- Treating generated handoffs as confirmed preferences without review.
- Summarizing every historical session by default.

> Validator comment: osb-triage-validator @ 2026-06-03T10:04Z:
- sanity: clean
- cluster: no cluster
- priority: set to 2: overriding origin-unknown priority 1 (no reprioritized event in history) - not_in_osb_useful, handoff note generator fits one week of focused work, clear scope.

## Task t_5b478e47 (priority 2): [follow-up:t_ff693b7f] Session-scoped focus: per-session binding, auto-clear, and context-pack/bootstrap wiring

## Remaining scope (after PR #54 foundation slice)

PR #54 shipped global search focus steering (`o2b search focus set/status/clear`, persisted focus file, ranking boost/demotion, MCP `focus_query`/`focus_path_prefix`). The original upstream scope (ClawMem session-scoped focus topic) still needs:

- **Per-session-ID binding** — focus keyed to a session identifier rather than a single global file.
- **Auto-clear on session end** — focus lifecycle tied to session teardown, not manual `clear`.
- **Context-pack / session-bootstrap wiring** — focus automatically influences `brain_context_pack` and session bootstrap, not only explicit search calls.

## Foundation shipped

Global focus steering in PR #54 (v0.27.0). Build on `o2b search focus` and the MCP focus inputs.

## Source

Foundation: PR #54. Original assessment: t_ff693b7f (closed as foundation slice).

> Validator comment: osb-triage-validator @ 2026-06-03T10:05Z:
- sanity: clean
- cluster: no cluster
- priority: set to 2: overriding origin-unknown priority 2 (no reprioritized event in history) - follow-up task, inherits not-until-parent semantics from t_ff693b7f.

## Task t_6d78f69e (priority 2): [upstream:keep] Scoped current-intention chains with move-to-history lifecycle

**Source**: https://github.com/generalbusiness-ai/keep
**Upstream files studied**: `README.md`, `SKILL.md`, `docs/KEEP-NOW.md`, `docs/VERSIONING.md`, `docs/KEEP-MOVE.md`, `docs/AGENT-GUIDE.md`, `keep/workstream.py`, `keep/integrations.py`

## What
Keep has a `now` document for the current working intention. Every update creates a version, and `--auto-scope` routes parallel sessions into per-workstream chains such as `now:project/branch` instead of one global scratchpad. When work pivots or completes, `keep move` can transfer selected versions into a named history item, optionally filtered by tags, so the active intention stays clean while the past trajectory remains searchable and inspectable.

## Why useful for OSB
OSB already imports agent sessions, supports focus steering, and can create handoff notes, but it lacks a first-class current-intention chain that agents update during work and then deliberately retire into named project histories. A Second Brain benefits from knowing not only final outcomes, but also the evolving intention trail: what was being attempted, where the work pivoted, which project/branch the work belonged to, and what should be carried into the next session.

## Current OSB status
- **Verdict**: present_weaker
- **Local evidence**: Existing tasks cover session import, focus topics, handoff notes, pre-compaction decision capture, and session summary DAGs. I did not find a scoped `now`-style Brain document with version history, auto-derived workstream identity, and an explicit move/archive lifecycle for selected intention versions.
- **Related existing work, not a duplicate**: a focus topic steers retrieval for one session; this task creates a durable, versioned intention chain that can be resumed, filtered, and moved into project history.

## Proposal
Add OSB-native current-intention chains under the Brain, with scoped IDs derived from project/worktree/branch or explicit operator scope. Provide CLI/MCP commands to read, update, list history, and move selected versions into a named note or session handoff.

## Suggested design
- Add `brain now` or equivalent MCP operations for get/set/history/move.
- Store scoped chains as Markdown/YAML documents with version records or append-only sidecars.
- Derive default scope from repository root and branch, with an explicit override for non-git work.
- Surface current intention, previous intention, open loops, and related Brain items in context packs.
- Support tag-filtered move so mixed sessions can split project-specific versions into separate histories.

## Acceptance criteria
- [ ] Agents can update a scoped current-intention chain without clobbering other workstreams.
- [ ] Intention history is inspectable and searchable by time, scope, and tags.
- [ ] Selected versions can be moved into a named Brain note while preserving provenance.
- [ ] Session/context packs can include the active intention and recent intention history.
- [ ] Tests cover auto-scope derivation, explicit scope override, move semantics, and mixed-project filtering.

> Validator comment: osb-triage-validator @ 2026-06-03T10:05Z:
- sanity: clean
- cluster: no cluster
- priority: set to 2: overriding origin-unknown priority 2 (no reprioritized event in history) - present_weaker, current-intention chains need design discussion before implementation.


# Project context

Open Second Brain - local-first second-brain memory layer for AI agents. TypeScript on Bun (plus a thin Python Hermes provider in plugins/hermes/provider.py). Storage: plain Markdown vault + SQLite (search index). MCP server over stdio JSON-RPC in src/mcp/.

Recent commits:
eda202d feat: Embedding Provider Suite - local embedder, provider registry, cost gate, RRF fusion (#67)
dee5ab7 feat: Memory Integrity Suite - canonical entities, conflict-free log shards, capture boundaries, fact extraction (#66)
5066e71 feat: Token Diet - budgeted injection, reminder cadence, consolidated MCP surface (#65)
c494fd8 feat(search): Recall Trust Suite - relation polarity, learned weights, time-aware and verified recall (#64)
23ff4fb refactor(hermes): single intentional self-bootstrap for the plugin entrypoint (#63)
0952dfc feat: become a native Hermes memory provider (#62)
6fbab0b feat: hands-off post-upgrade migration (v0.31.2) (#61)
496dd2d fix: make plugin updates self-healing (v0.31.1) (#60)
09c0592 chore(release): v0.31.0 (#59)
b81335c Feat/procedural attention suite (#58)
1f3a218 Feat/self learning skill proposals (#57)
0162d13 feat(brain): add context continuity and receipts suite (#56)
3b7b3a5 feat(brain): add safety governance foundations (#55)
794ee45 feat(search): ship recall control and trust surfaces (#54)
40d4e2b feat: cjk schema lifecycle recovery - CJK search, schema admin, lifecycle hooks, watchdog (#53)
f62918c feat: runtime schema packs foundation - schema vocabulary, artifact taxonomy, schema inspection (#52)
14d1ee1 feat: brain model semantics foundation - typed preference relations, memory labels, dry-run backfill (#51)
3a5d5c3 feat: agent capability CLI integration - runtime MCP capabilities, inherited JSON, completions (#50)
a085bfa feat: vault portability + session economy - codec, sources dashboard, vault-map tokens, multi-vault profiles, graph export/import (#49)
73e4a28 feat: brain lifecycle suite - mutation audit, multi-phase dream, reconcile domains, morning brief, temporal extraction, heal enrichment (#48)

Related files (verified current state):
- src/mcp/tools.ts - buildToolTable(scope) assembles ToolDefinition[]; ToolScope = "full" | "writer"; ToolDefinition has optional `hidden` flag: hidden tools stay callable via tools/call but are omitted from tools/list (token-diet precedent, shipped v0.35.0).
- src/mcp/capabilities.ts - evaluateToolCapabilities applies RuntimeCapabilityWindow {allowedTools, disabledTools, maxTools}; report lists available/withheld with reasons; second_brain_capabilities diagnostic tool always available.
- src/mcp/server.ts - MCPServer constructor takes scope + capabilityWindow; handleToolsList filters hidden; instructions built per scope.
- src/mcp/instructions.ts - per-scope initialize.instructions text.
- skills/ - the repo ALREADY ships five agent skills as skills/<name>/SKILL.md (brain-memory, codegraph-partner, embeddings-setup, open-second-brain, schema-author). Ownership question from the task comments is resolved: Open Second Brain owns these plugin skills; list_skills/get_skill can serve them (plus optional vault-level skill roots).
- plugins/hermes/provider.py - native Hermes memory provider; system_prompt_block() returns brain_context content; prefetch(query) gates recall via brain_recall_gate then calls brain_context_pack; all via bridge tool calls into the TS core.
- src/core/brain/sessions/import.ts - ImportSessionOptions ALREADY has filterRoles + filterTextIncludes (per-call); what is missing is a config-level default (e.g. session_capture_roles in the vault config) applied by capture paths and the import CLI when no explicit flag is given.
- src/core/brain/sessions/types.ts - SessionTurn.role: "user" | "assistant" | "system" | "tool" | "meta"; adapters: claude, codex, hermes.
- src/core/search/session-focus.ts - search focus today is ONE global file (search-focus.json next to the index) with query/pathPrefix/expiresAt; ranker boost via scoreSessionFocusTarget; CLI o2b search focus set/status/clear; MCP brain_search focus_query/focus_path_prefix inputs (PR #54 foundation).
- src/core/brain/pinned.ts - Brain/pinned.md scratchpad (read/write/append/clear) via brain_pinned_context tool - the closest existing surface to a "now" document, currently a single unversioned global file.
- src/core/brain/context-pack.ts - budgeted context pack with lanes (directives/constraints/consider), tiers, receipts.
- src/core/brain/session-lifecycle.ts - captureSessionLifecycleEvent invoked by hooks/session-capture.ts; hooks.json wires SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd events for Claude Code/Codex.
- src/core/config.ts - parseSimpleYaml flat string config (_brain.yaml style); discoverConfig; resolveVault/resolveAgentName.
- src/cli/command-manifest.ts - typed command tree for help/completions.
- src/core/search/index.ts - resolveSearchConfig precedent for config key parsing with env overrides.

Conventions:
- Conventional commits; one feature per commit; TDD (failing test first).
- bun test (3,379 tests), tsc typecheck, oxlint (baseline 111 warnings, must not grow), oxfmt.
- Everything that could change existing behaviour ships off by default; defaults are bit-identical to the previous release.
- Closed unions stay closed; new config keys are parsed fail-fast with SearchError/CliError; runtime surfaces fail soft (a broken optional file never crashes a session).
- Deterministic logic preferred: no LLM in the loop for scoring/extraction (BM25-style lexical scoring, regex extraction are the house style).
- No new external dependencies. Bun + node: builtins only.
- MCP server is static per process: no listChanged notifications; the hidden-tool flag is the shipped mechanism for callable-but-not-advertised.

Constraints:
- Do not change existing public APIs or MCP tool contracts; additive only.
- Hermes-host internals (~/.hermes/skills) are out of scope; skill surfaces serve the repo's own skills/ directory plus optional configured roots.
- The eight units must share kernels where natural (e.g. one skill-discovery module feeding both list_skills/get_skill and auto-attach scoring; one session-scope concept feeding focus binding and handoff notes) - avoid eight disconnected mini-features.
- Python provider changes minimal: call new TS tools over the existing bridge; no new Python logic beyond a tool call.

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
