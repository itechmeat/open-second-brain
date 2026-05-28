You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Multi-task feature-release scope selected by the operator from the Open Second Brain kanban board.

## Task t_8e4fe118: [upstream:obsidian-second-brain] Core memory pinning for transient session context

**Source**: https://github.com/eugeniughelbur/obsidian-second-brain/releases/tag/v4.0.0
**Repo**: eugeniughelbur/obsidian-second-brain (726 stars)
**Released**: v4.0.0 (2026-04-09T12:56:58Z)

## What
Upstream introduced PINNED.md, a scratchpad loaded at L0 (alongside identity context) for task-specific critical facts. During complex multi-turn sessions, the agent suggests pinning key facts so they survive context window rotation. The user can also manually pin. The file is cleared when the task completes. This sits below the full vault context, providing a focused, cheap way to keep current-task state available.

## Why useful for OSB
OSB's brain_context loads active preferences at session start, but there's no mechanism for an agent to pin transient task-specific facts that shouldn't become permanent preferences. During long debugging sessions, code reviews, or multi-step workflows, agents need to remember facts like "the bug is in the auth middleware, not the controller" without polluting the permanent preference store. A PINNED.md equivalent would give agents a focused, low-token-cost scratchpad for current-session context.

## Status in OSB
- **Verdict**: present_weaker
- **Codegraph hints**: OSB has brain_context (loads active preferences), brain_feedback (records signals), and memory tools. No transient session-scoped pinning mechanism exists. src/mcp/brain-tools.ts handles context loading and signal recording.

## Notes
This is lighter-weight than a full preference — it's session-scoped, not vault-scoped. OSB could implement as a Brain/pinned.md file with a simple MCP tool to read/write/clear it, loaded alongside active prefs in brain_context.

Triage comment: clean; priority 4; clear drop-in with Brain/pinned.md plus read/write/clear MCP tool loaded alongside active prefs in brain_context; low-risk additive session scratchpad.

## Task t_06058a8c: [upstream:obsidian-wiki] Configurable markdown link output format

**Source**: https://github.com/Ar9av/obsidian-wiki/releases/tag/v2026.05
**Repo**: Ar9av/obsidian-wiki (977★)
**Released**: v2026.05 (2026-05-06T05:56:13Z)

## What
Set `OBSIDIAN_LINK_FORMAT=markdown` in config to output `[page](path/to/page.md)` instead of `[[wikilinks]]`. Useful for publishing wikis outside Obsidian or using them in standard Markdown renderers that don't understand wikilinks.

## Why useful for OSB
OSB already parses both wikilinks and markdown links internally (LinkType in src/core/search/links.ts), but the output format is not configurable. Some consumers of OSB's vault (CI pipelines, GitHub rendering, non-Obsidian tools) would benefit from standard markdown link output. This is a small but impactful configuration option.

## Status in OSB
- **Verdict**: present_weaker
- **Codegraph hints**: src/core/search/links.ts:15 (LinkType = "wikilink" | "markdown_link" | "tag") — parser supports both. No configurable output format exists. src/core/brain/migrate-frontmatter.ts:123 — frontmatter rewriting already handles format migration.

## Notes
Straightforward config addition. Could be a `link_output_format` setting in OSB's config.yaml. The internal parsing already handles both formats so this is purely an output formatting concern.

Triage comment: cleanest drop-in; priority 4; links.ts already parses both wikilink and markdown_link; only an output formatter plus config flag is needed, low risk.

## Task t_b3995e58: [upstream:contextlattice] Agent boundary contract enforcement for MCP output

**Source**: https://github.com/sheawinkler/contextlattice/releases/tag/v3.3.28
**Repo**: sheawinkler/contextlattice (61★)
**Released**: v3.3.28 (2026-05-25T17:39:06Z)

## What
ContextLattice v3.3.28 enforces machine-readable output contracts across agent boundary surfaces. It adds generated contract constants for Go and Rust consumers, and public agent-context gate coverage for contract registry changes. This ensures that any agent producing output through the lattice layer must conform to pre-declared contracts, with compile-time validation for Go/Rust consumers.

## Why useful for OSB
OSB exposes MCP tools to connected agents but has no mechanism to validate or constrain the format of tool output. A contract enforcement layer would allow OSB to declare output schemas for brain_search, brain_query, and other tools, ensuring downstream agents receive structured, machine-parseable results. This would improve reliability in multi-agent pipelines where OSB output feeds into other systems.

## Status in OSB
- **Verdict**: not_in_osb_useful
- **Codegraph hints**: src/mcp/tools.ts:57 (ToolDefinition interface), src/mcp/tools.ts:193 (ToolScope type), src/mcp/tools.ts:207 (buildToolTable). OSB defines tool metadata but has no output contract validation or schema enforcement on tool results.

## Notes
Upstream uses a contract registry with generated constants for compiled languages. OSB could implement a lighter-weight version: JSON Schema output contracts validated at the MCP tool boundary, or typed result envelopes for brain tools.

Triage comment: priority 3; JSON Schema validation at MCP tool boundary; additive, lighter-weight than upstream registry, clear scope.

## Conditional task t_c12e0e9c: [upstream:cavemem] Privacy-aware memory capture with region stripping

Include this task only if it can remain a small shared redaction helper reused by write/import boundaries without pulling in real-time session lifecycle hooks or path-glob exclusion.

**Source**: https://github.com/JuliusBrussee/cavemem/releases/tag/v0.1.0
**Repo**: JuliusBrussee/cavemem (446★)
**Released**: v0.1.0 (2026-04-18T00:48:33Z)

## What
cavemem strips content inside <private>...</private> tags at the write boundary before anything reaches storage. Path globs (excludePatterns) exclude entire directories from capture. The worker binds to 127.0.0.1 only. Privacy filtering happens synchronously in the hook handler, before compression.

## Why useful for OSB
OSB already has SECRET_ASSIGNMENT_RE in src/core/event-log.ts:17 that catches KEY=VALUE secret patterns, but has no mechanism for agents to mark specific regions of conversation as private, nor path-based exclusion for memory capture. A private tag stripping system would let agents and users explicitly control what enters the brain, complementing the existing secret redactor. Path exclusion would prevent sensitive directories from being captured during session imports.

## Status in OSB
- **Verdict**: not_in_osb_useful
- **Codegraph hints**: src/core/event-log.ts:17 (SECRET_ASSIGNMENT_RE — regex-based secret detection, no region-based stripping), src/core/event-log.ts:23 (redactText function), src/mcp/pay-memory-tools.ts:355 (receipt redactor). No XML-tag-based region stripping or path-glob exclusion exists.

## Notes
The private tag approach is agent-friendly — agents can wrap sensitive content themselves. Path exclusion via globs complements this for directory-level control. Both are simpler and more deterministic than pattern-based secret detection.

Triage comment: priority 3; child of real-time session-capture group; concrete hints, but needs design on region stripping.

# Project context

Project: Open Second Brain, TypeScript on Bun, deterministic Obsidian-vault memory layer exposed via CLI and MCP.

Recent commits:
66980b2 (HEAD -> main, origin/main, origin/HEAD) ci: drop bun version floor, track latest only (#42)
feca6a7 (tag: v0.15.0) v0.15.0 - Cross-agent query foundation: source-agent provenance retrieval and comparison (#41)
ffde4ac (tag: v0.14.1) chore(release): v0.14.1 (#40)
bc97b38 refactor: add validation toolchain and normalize project formatting (#39)
b76199a (tag: v0.14.0) v0.14.0 - Semantic Brain Health and Self-Maintenance: contradiction detection, concept gaps, stale claims, edit-history, remediation (#38)
2147640 (tag: v0.13.0) v0.13.0 - Hybrid Search and Recall Quality: explainable recall, MMR, link traversal, entity boost, header anchoring (#37)
84886d1 (tag: v0.12.0) v0.12.0 - Brain Integrity Suite: typed collision detection, content-hash drift, durable dream workruns (#36)
c002268 (tag: v0.11.0) v0.11.0 - Brain-centric vault layout: one agent-owned root, opt-in user notes (#35)
a8d4803 (tag: v0.10.18) v0.10.18 - temporal axis: timeline, belief evolution, stale watch, daily brief, weekly synthesis (#34)
d0598af (tag: v0.10.17) v0.10.17 - link graph surfaces (aliases, anchors, mentions, synthesis, MOC audit, property filter, vault instruction) (#33)
3b7dfe9 (tag: v0.10.16) v0.10.16: trust and operator surfaces - verification, verdict, dashboard (#32)
d045ea1 (tag: v0.10.15) chore: bump version to 0.10.15 (#31)
5755200 v0.10.15: vault care bundle - metadata, dedup, lint, context-pack, actions (#30)
9d9636b (tag: v0.10.14) feat: index fastpath, PEM/JWT redaction, vault connection health (v0.10.14) (#29)
7d81f0b (tag: v0.10.13) feat: codegraph-partner skill + o2b doctor check (v0.10.13) (#28)
0462b91 (tag: v0.10.12) feat: v0.10.12 operational friction reduction (#27)
9d8af95 (tag: v0.10.11) Merge pull request #26 from itechmeat/feature/v0.10.11-multi-runtime-install
852c9b5 v0.10.11: address CodeRabbit review
f819f32 v0.10.11: Multi-runtime install orchestrator + Most-applied in digest
88bce1f (tag: v0.10.10) Merge pull request #25 from itechmeat/feature/v0.10.10-pull-channels

Related files:
- src/mcp/tools.ts: ToolDefinition, buildToolTable, writer/full scope filtering.
- src/mcp/server.ts: MCPServer.handleToolsCall and toolResult generate content + structuredContent envelopes.
- src/mcp/brain-tools.ts: brain_context, brain_feedback, brain_note, brain_query and Brain tool definitions.
- src/mcp/search-tools.ts and src/mcp/pay-memory-tools.ts: sibling MCP slices.
- src/core/brain/paths.ts: canonical Brain paths and root constants.
- src/core/brain/wikilink.ts: normaliseWikilinkTarget, parseWikilink, renderPrefLink.
- src/core/search/links.ts: LinkType includes wikilink and markdown_link; parser already sees both.
- src/core/config.ts: simple YAML config parsing/discovery and redaction of secret-looking config keys.
- src/core/redactor.ts: redactRawOutput, normaliseTextField, sanitiseTextField shared by Brain/Pay Memory writers.
- tests/mcp/mcp.test.ts: handshake, tool listing, JSON-RPC/tool call envelope coverage.
- tests/mcp/brain.test.ts: Brain MCP integration tests around brain_context, feedback, query, digest.
- tests/core/brain.wikilink.test.ts: wikilink/renderPrefLink tests.
- tests/core/redactor.test.ts: redactor and normaliseTextField tests.
- docs/mcp.md, docs/how-it-works.md, docs/cli-reference.md, README.md, CHANGELOG.md.

Conventions:
- Deterministic, dependency-light TypeScript; avoid LLM-dependent runtime behavior.
- Data lives as plain Markdown under Brain/ in the user's Obsidian vault.
- MCP tool responses include `content` text plus `structuredContent` JSON.
- Writer MCP server includes `brain_feedback`, `brain_apply_evidence`, `brain_note`, and `brain_context` because `brain_context` must be available at session start.
- Configuration is a simple `key: value` YAML subset via `src/core/config.ts`; no new YAML dependency.
- Existing redaction is best-effort and deterministic; never promise perfect secrecy.
- Tests use `bun:test`; common verification commands are `bun test`, `bun run typecheck`, `bun run lint`, `bun run validate`, and `bun run sync-version:check`.
- Public artifacts should use the full name Open Second Brain, not abbreviations.

Constraints:
- Keep public APIs backward compatible unless unavoidable.
- Prefer small additive surfaces over broad refactors.
- Do not add runtime dependencies unless the benefit is clear.
- Do not pull the real-time session lifecycle task into this PR.
- Version bump is explicitly required by the operator before GitHub push, despite the generic playbook default that usually bumps during release.
- Implement with TDD feature-by-feature after design is accepted by the orchestrator.
- Self-review must compare all changes against main before push.

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
