You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

This is a multi-task PR scope selected from the open-second-brain Hermes triage board.

## Task t_4acb2c72 - [upstream:core] Agent runtime capability verification and constraint window

**Source**: https://github.com/RedPlanetHQ/core/releases/tag/0.7.12
**Repo**: RedPlanetHQ/core (1600 stars)
**Released**: 0.7.12 (2026-05-19T06:23:06Z)

### What

CORE introduced a runtime window and capability check system that verifies what actions and integrations are available at runtime before attempting execution. The gateway checks runtime constraints and capability availability dynamically rather than relying on static configuration.

### Why useful for OSB

OSB MCP tool exposure uses a static ToolScope (full or writer) to filter which tools are available to agents. A dynamic runtime capability check would allow OSB to adapt tool availability based on current context, resource constraints, and agent identity. This would improve the safety and relevance of tool exposure in multi-agent scenarios.

### Status in OSB

- **Verdict**: present_weaker
- **Codegraph hints**: src/mcp/tools.ts:193 (ToolScope type), src/mcp/tools.ts:57 (ToolDefinition interface), src/mcp/server.ts:56 (tools property on MCPServer), src/mcp/tools.ts:207 (buildToolTable with scope parameter). OSB has static tool scoping but no dynamic runtime capability verification.

### Notes

The upstream system checks capabilities at runtime versus OSB static scope. Could complement OSB existing ToolScope by adding a runtime check layer on top of the static tool table.

### Board comments

- osb-triage-validator @ 2026-05-27T11:28Z: sanity clean; no cluster; priority set to 2 from 4. present_weaker, but dynamic capability model is design-heavy on top of static ToolScope; needs an ADR before build.
- osb-triage-validator @ 2026-05-29T07:07Z: sanity clean; no cluster; priority set to 3 from 2. present_weaker with concrete hints; dynamic capability verification is clear scope, about one week.

## Task t_01810c33 - [upstream:mem0] Uniform --json flag across all o2b CLI commands for machine-readable output

**Source**: https://github.com/mem0ai/mem0/releases/tag/openclaw-v1.0.8
**Repo**: mem0ai/mem0 (56777 stars)
**Released**: openclaw-v1.0.8 (2026-04-22T11:46:36Z) - "Mem0 OpenClaw Plugin v1.0.8"

### What

mem0's OpenClaw plugin v1.0.8 added a uniform `--json` flag to all 16 CLI commands for machine-readable output, plus a `cli/json-helpers.ts` module providing `jsonOut`, `jsonErr`, and `redactSecrets` utilities for consistent structured output. Quote from release notes: "Agents can call `openclaw mem0 help --json` to discover every command and flag". The flag standardizes envelope shape (data + errors) across the surface so agents can parse outputs without per-command exception handling.

### Why useful for OSB

The `o2b` CLI is invoked by agents (Claude Code router, Hermes profiles) as much as by humans. Agents currently consume stdout text and either rely on per-command parsing or fall back to MCP for structured output. A uniform `--json` flag on all o2b subcommands (brain doctor/note/feedback/query/scan-inline/import-session/digest/dream, payment ..., snapshot, etc.) would let any agent script the CLI reliably without needing the MCP surface for read-only ops. The OSB-side helper module would centralize secret-redaction (Brain crypt passwords, etc.) so each command doesn't reimplement it.

### Status in OSB

- **Verdict**: not_in_osb_useful
- **Codegraph hints**: src/cli/argparse.ts:19 (FlagSpec interface), src/cli/argparse.ts:38 (parseFlags - parses argv against per-command schemas). Each subcommand declares its own FlagsSchema; no global helper. Some commands surface JSON output by hardcoded format flag; uniform contract is absent.

### Notes

Two-part implementation: (1) add `json` as an inheritable FlagSpec mixed into every CLI subcommand's schema at parse time; (2) add `src/cli/json-helpers.ts` with `jsonOut(data)`, `jsonErr(error)`, `redactSecrets(obj)` (strips known secret-shaped strings like crypt passwords, API keys). Every command short-circuits to the JSON branch when `--json` is set. Existing tests for individual commands need a `--json` round-trip check.

### Board comments

- osb-triage-validator @ 2026-05-26T17:30Z: sanity clean; no cluster; priority set to 1: ergonomic-only, value depends on agent/operator usage of o2b CLI; most traffic via MCP.

## Task t_93bd0cc1 - [upstream:iwe] Shell completions for o2b CLI

**Source**: https://github.com/iwe-org/iwe/releases/tag/iwe-v0.1.4
**Repo**: iwe-org/iwe (1086 stars)
**Released**: iwe-v0.1.4 (2026-05-15T11:36:55Z)

### What

iwe added `iwe completions <SHELL>` subcommand that prints a shell-completion script to stdout for `bash`, `elvish`, `fish`, `nushell`, `powershell`, or `zsh`. Generated via clap's bundled completion generator (standard pattern in Rust CLIs).

### Why useful for OSB

The `o2b` CLI exposes long subcommand trees (`brain doctor`, `brain note`, `brain feedback`, `brain query`, `brain scan-inline`, `brain import-session`, `payment ...`) that humans occasionally invoke. Tab-completion would lower the friction of remembering subcommands and option flags during manual operator work. Low priority - most o2b traffic flows through MCP, not interactive shells.

### Status in OSB

- **Verdict**: not_in_osb_useful
- **Codegraph hints**: no shell-completion subcommand exists. CLI verbs live under src/cli/.

### Notes

Whichever JS CLI framework `o2b` uses has a built-in completion generator. Simplest pattern: `o2b completions <bash|zsh|fish>` prints the script to stdout; user pipes to their shell's completions dir. Pure ergonomic add - no behavior change to existing commands.

### Board comments

- osb-triage-validator @ 2026-05-26T17:30Z: sanity clean; no cluster; priority set to 1: ergonomic-only, value depends on whether operators use o2b CLI manually; MCP-first usage means low impact.

# Project context

Project: Open Second Brain, TypeScript on Bun, package version 0.22.0. It is an Obsidian-native memory layer for AI agents. The core is deterministic and no-LLM; MCP is optional; CLI remains the supported baseline. Package dependencies are intentionally small: runtime dependency proper-lockfile, optional sqlite-vec, TypeScript/Bun tooling.

Recent commits:

- a085bfa (HEAD -> main, tag: v0.22.0, origin/main, origin/HEAD) feat: vault portability + session economy - codec, sources dashboard, vault-map tokens, multi-vault profiles, graph export/import (#49)
- 73e4a28 (tag: v0.21.0) feat: brain lifecycle suite - mutation audit, multi-phase dream, reconcile domains, morning brief, temporal extraction, heal enrichment (#48)
- bd49cd5 (tag: v0.20.0) feat: recall and ranking quality - Weibull recency, query intent, synonym expansion, recall budgets, query cache, pre-compress pack (#47)
- cbbe18f (tag: v0.19.0) feat: typed graph semantics - typed relations, visibility scoping, MCP landscape (#46)
- 5fa7eb0 (tag: v0.18.0) feat: MCP context economy - preview budget, artifact fetch, recall hint (#45)
- 2bd3f48 (tag: v0.17.0) v0.17.0 - Brain Lifecycle Review Suite: intent review, retention, monthly synthesis, complexity warning (#44)
- 9b87838 (tag: v0.16.0) v0.16.0 - Agent boundary control surfaces: pinned context, Markdown links, MCP output contracts (#43)
- 66980b2 ci: drop bun version floor, track latest only (#42)
- feca6a7 (tag: v0.15.0) v0.15.0 - Cross-agent query foundation: source-agent provenance retrieval and comparison (#41)
- ffde4ac (tag: v0.14.1) chore(release): v0.14.1 (#40)
- bc97b38 refactor: add validation toolchain and normalize project formatting (#39)
- b76199a (tag: v0.14.0) v0.14.0 - Semantic Brain Health and Self-Maintenance: contradiction detection, concept gaps, stale claims, edit-history, remediation (#38)
- 2147640 (tag: v0.13.0) v0.13.0 - Hybrid Search and Recall Quality: explainable recall, MMR, link traversal, entity boost, header anchoring (#37)
- 84886d1 (tag: v0.12.0) v0.12.0 - Brain Integrity Suite: typed collision detection, content-hash drift, durable dream workruns (#36)
- c002268 (tag: v0.11.0) v0.11.0 - Brain-centric vault layout: one agent-owned root, opt-in user notes (#35)
- a8d4803 (tag: v0.10.18) v0.10.18 - temporal axis: timeline, belief evolution, stale watch, daily brief, weekly synthesis (#34)
- d0598af (tag: v0.10.17) v0.10.17 - link graph surfaces (aliases, anchors, mentions, synthesis, MOC audit, property filter, vault instruction) (#33)
- 3b7dfe9 (tag: v0.10.16) v0.10.16: trust and operator surfaces - verification, verdict, dashboard (#32)
- d045ea1 (tag: v0.10.15) chore: bump version to 0.10.15 (#31)
- 5755200 v0.10.15: vault care bundle - metadata, dedup, lint, context-pack, actions (#30)

Related files:

- src/mcp/tools.ts: ToolDefinition, ServerContext, ToolScope = "full" | "writer", WRITER_TOOL_NAMES, buildToolTable(scope), findTool(). Today filtering is static: full returns all, writer returns selected names.
- src/mcp/server.ts: MCPServer constructor stores scope and tools = buildToolTable(this.scope). tools/list returns this static array. tools/call uses findTool(this.tools, name).
- src/cli/argparse.ts: small dependency-free parser. parseFlags(argv, schema) rejects unknown flags, applies defaults, checks required fields. No global/inheritable flags.
- src/cli/main.ts: root CLI dispatcher. Some root commands have hardcoded `json` flags, some do not. `mcp --probe` reports static tool count. `tool-call` always prints JSON. HELP is a static string.
- src/cli/brain.ts and src/cli/brain/helpers.ts: brain verb dispatcher and parse wrapper used by brain verbs. This is a likely seam for adding shared flags to brain verbs without sweeping every implementation.
- src/cli/search.ts, src/cli/vault/_, src/cli/pay-memory/_, src/cli/update.ts: existing scattered JSON branches.
- src/cli/output.ts: existing okJson/writeJson/failWith helpers but no uniform JSON envelope/redactor module.
- tests/helpers/run-cli.ts: subprocess helper for CLI tests.
- tests/mcp/output-contract.test.ts and other tests/mcp/\*: existing MCPServer tests.
- docs/mcp.md: documents optional MCP server and static writer split; full server currently advertises 46 tools.
- docs/cli-reference.md: documents that JSON is available via `--json` on read verbs and most write verbs, not yet uniform.
- README.md and CHANGELOG.md: release convention is capability-first, bundled features, deterministic defaults/no-op default behavior.

Conventions:

- Keep core deterministic and dependency-light; avoid new runtime dependencies unless strongly justified.
- MCP server is optional; CLI remains the supported baseline.
- Default install should remain no-op/byte-identical when a feature is not configured.
- Secrets must be redacted in config/output surfaces; never print token or secret values.
- CLI grammar is intentionally small and dependency-free; no commander/yargs unless the benefit is overwhelming.
- Mutating Brain commands generally snapshot before writes and expose dry-run where meaningful.
- Public docs use full project name, not abbreviations, in release artifacts.
- Tests run with Bun; validation commands include `bun test`, `bun run typecheck`, `bun run lint`, `bun run sync-version:check`.

Constraints:

- Do not change existing public APIs unless backward-compatible.
- Do not add a new CLI framework dependency just for completions.
- Avoid hardcoding natural-language phrases for specific languages; keep language handling abstract.
- Do not make dynamic MCP capability checks silently hide tools without a transparent diagnostic/probe path.
- Respect the existing writer scope behavior; runtime capability filtering should layer on top of static scope, not replace it.
- Keep shell completions generated from a registry or manifest so help/completions do not drift.
- User requested version bump before GitHub push, overriding the universal playbook default that usually bumps during release.

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
