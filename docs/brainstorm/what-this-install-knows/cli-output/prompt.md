You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

This is one release wave bundling five kanban cards under a single spine: every question an agent or operator asks the installation about itself - which version am I, which tools can I actually call, which projects am I linked to, are my connectors reachable, is a newer release available - is answered from live state, and an unknown is named rather than presented as healthy.

The five cards, with the premise verification already performed against live source (these verdicts are facts read from the tree today, not claims to re-derive):

## Card 1 - t_dee1d1fe (priority 4): `o2b version` subcommand and `--version` flag
Add a first-class way for scripts and agent harnesses to read the installed Open Second Brain CLI version, printing `package.json` `version` (the single source of truth), honouring the inherited `--json` flag for structured output.
PREMISE CONFIRMED, with one correction that enlarges the task: there is no `--version` handling in `src/cli/main.ts` and no `version` entry in `src/cli/command-manifest.ts`. But the card says "reuse the existing pattern in `src/cli/brain/verbs/continuity.ts`" as if there were one site. There are THREE independent reads of `package.json` `version` in the tree today: `src/cli/brain/verbs/continuity.ts:40,43` (`CLI_VERSION`), `src/mcp/protocol.ts:9,14` (`SERVER_VERSION`, already reported in the MCP handshake `serverInfo.version`), and `src/core/install/opencode-plugin-asset.ts:39` (embedded in a generated plugin header). Adding a fourth read would make four. The version fact is therefore already answerable over MCP and not over the CLI.

## Card 2 - t_cf827c77 (priority 2): MCP server instructions generated from the active tool allowlist
`initialize.instructions` must be generated from the registered/allowed tool set rather than a hard-coded list, so agents are never directed to tools unavailable in the current runtime profile.
PREMISE CONFIRMED exactly. `buildInstructions` (`src/mcp/instructions.ts:159-162`) selects one of three frozen strings from `SCOPE_BODIES` by `TOOL_SCOPE` and prepends an identity line; nothing else influences it. The handshake at `src/mcp/server.ts:375-378` passes only `agent` and `scope`. The writer body (`src/mcp/instructions.ts:33`) names all five tools in prose. Meanwhile `evaluateToolCapabilities` (`src/mcp/capabilities.ts:41-62`) already computes, per tool, an `available` or `withheld` entry with a human-readable `reason`, plus `available_tool_count`, `advertised_tool_count` and a `host_ceiling` block; it is called in the server constructor (`src/mcp/server.ts:148-155`) and its result is stored on `this.capabilityReport`, so the full report IS in hand at `handleInitialize` time. No plumbing is missing - only the decision of what truthful text to render from it. Existing precedent in the same file: deprecated aliases stay callable but are deliberately not advertised in `tools/list` (`src/mcp/server.ts:383-385`), so the advertised surface differing from the callable one is already an accepted shape here.

## Card 3 - t_49315346 (priority 2): MCP project discovery for linked project contexts
Expose linked projects through a read-only MCP tool so an agent can choose the right project context before invoking memory/search/write tools.
PREMISE CONFIRMED, and the build is smaller than the card assumes. Two pure readers already exist and are typed: `listLinkedProjects` (`src/core/brain/portability/pointer.ts:231-238`, tolerant read so a hand-damaged registry degrades rather than throwing) and `linkedProjectsStatus` (`:245-262`, which additionally reports a four-value pointer state - `missing` | `malformed` | `mismatch` | `ok` - plus a `vaultExists` flag). A grep for both names across `src/` finds consumers ONLY in `src/cli/brain/verbs/project.ts:12,13,59,107`; nothing under `src/mcp` touches them. One open policy question the design must answer: the registry is keyed on ABSOLUTE host filesystem paths (`src/core/brain/portability/pointer.ts:214-216`, `:234`), while every other path this MCP server emits is vault-relative by policy - compare the sibling read-only inventory tool `brain_mcp_landscape` (`src/mcp/brain/landscape-tools.ts:13-35`), which states "Environment values are never read. Discovery is vault-relative."

## Card 4 - t_09d7e9e9 (priority 1): dynamic connector health dashboard with unverified-state labelling
Show connector status, deadline failures and inspection results, and never present an unverified connector as healthy.
PREMISE LARGELY REFUTED - more so than the card's own validator concluded. Everything substantive the card asks for already ships, AND so does the aggregate view the validator believed was the residue:
 - Per-target status is a closed vocabulary on both sides: `AdapterStatus` (`not-installed` | `installed` | `drift` | `unsupported-on-this-platform`, `src/core/install/types.ts:21-27`) and `VerifyStatus` (`ok` | `drift` | `not-installed` | `mcp-unreachable`, `:39-45`).
 - Unverified is already named, never assumed healthy: `HOST_PROBE_RESULT` (`answered` | `binary-missing` | `probe-failed` | `not-declared`, `src/core/install/host-probe.ts:87-93`), whose module header states "A probe that reports success when it could not run is the misleading default this module exists to remove" (`:17-22`).
 - The deadline is already enforced: `HOST_PROBE_TIMEOUT_MS = 10_000` (`src/core/install/host-probe.ts:158`) with the wait bounded in the runner (`:174-181`); the timeout becomes one more named outcome rather than a hang. The probe is keyless, starts no model turn, writes nothing, and spawns under the adapter's injected environment rather than the ambient one.
 - The aggregate exists: `runCheck` (`src/cli/install/install.ts:452-489`) iterates EVERY registered adapter (`defaultRegistry.list()`), collects `VerifyResult[]`, renders a table (`renderVerifyTable`, `src/cli/install/render.ts:176-188`) or structured JSON (`renderVerifyJson`, `:190-198`), and returns an exit code that distinguishes drift from unreachable from ok (`exitCodeForVerify`, `:492-506`).
The genuine residue is therefore narrow and of a different shape than the card states: this whole aggregate is CLI-only. An agent on the MCP surface cannot ask whether the hosts this install wrote registrations into can still be reached. That is the same gap shape as Card 3.

## Card 5 - t_c64b7cab (priority 1): explicit opt-in release awareness
Report whether a newer Open Second Brain version is available, reading only cached update state, producing an upgrade plan on demand, never blocking, auto-installing, or making hidden network checks.
PREMISE REFUTED AS SPECIFIED. There is no producer for the cache the card depends on: a grep across `src/` for `latestVersion`, `latest_version`, `update-check`, `updateCheck`, `registry.npmjs` returns nothing. Nothing in this tree ever learns what the latest release is, so "cached update state" would have to be populated by a network check - which is exactly what the data-ownership statement promises the operator does not happen: `src/core/install/ownership.ts:794` renders, verbatim, "this tool has no account of its own, no server it phones home to, no sync endpoint and no update check", via `renderDataOwnership` at `:786`. A further collision the card did not see: `o2b update` ALREADY EXISTS (`src/cli/update.ts`, `src/core/install/update.ts`) and means something entirely different - re-applying managed-file install blocks to host configs - so the obvious verb is taken. The upgrade-plan half has a substrate (`src/core/brain/upgrade.ts`, a plan/apply managed-file migrator). Only the "is there a newer version" fact is missing, and it is the part that carries the policy cost.

The variants you produce must cover how to ship cards 1-4 coherently AND how to handle card 5 honestly. Recording a refuted card as a refusal with its reason, rather than building it, is an acceptable and expected deliverable in this project - but the variants should differ in how they treat card 5's residue.

# Project context

Open Second Brain - a second brain for AI agents over Obsidian-compatible Markdown vaults. TypeScript on the Bun runtime, ~1.55.0, shipped as an `o2b` CLI plus an MCP server (three tool scopes: full, writer, catalog) plus install adapters for a dozen agent runtimes.

Recent commits:
5f415267 feat: who wrote what, and how to take it back (v1.55.0) (#184)
dc552590 feat: private is not a suggestion (v1.54.0) (#183)
23e6b81e fix(brain): merged pages leave the dedup pool, and the write seam refuses cycles (v1.53.1) (#182)
c2e13f9d fix(hermes): make prefetch recall query-aware (#181)
5102f142 fix(hermes): record context-pack receipts and explicit outcomes (#179)
323e2f09 feat: nothing writes silently, nothing degrades silently (v1.52.0) (#178)
6d3e8b23 feat: what earns its keep (v1.51.0) (#177)
86544b9b fix(hermes): the bridge child inherits a PATH that can find Bun (v1.50.3) (#176)
ba1a9678 fix(hermes): preserve context-pack recall (v1.50.2) (#172)
4ba335d4 ci: adopt Bun 1.4.0 - pin the toolchain and rebuild the bundle it gates (#175)
1e8792cb fix: a provider the host cannot read is not an unconfigured one (v1.50.1) (#171)
962228ae fix(mcp): the pairing one tool declared and the other only enforced (v1.50.0) (#169)
aa73af4b feat: what the machine already has (v1.50.0) (#168)
b49af81e feat: a label is not a boundary (v1.49.0) (#166)
280469d2 feat: nothing runs unwatched (v1.48.0) (#165)
aa818084 feat: wiring what exists (v1.47.0) (#164)
a6d10dab feat: evidence at the boundary (v1.46.0) (#162)
29ea0099 fix: the flush that never landed (v1.45.1) (#158)
8d05a62a feat: silence is not an answer (v1.45.0) (#159)
34f96b84 fix: reuse and reap Hermes MCP bridges (v1.44.1) (#156)

Related files:
- src/cli/main.ts (1168 lines; dispatcher is a plain `switch` on `argv[0]` at :495-501, help/`-h` handled at :495)
- src/cli/command-manifest.ts (declarative manifest of ~140 commands; root carries only the inherited `--json` flag)
- src/cli/brain/verbs/continuity.ts:40,43 (`CLI_VERSION`)
- src/mcp/protocol.ts:9,14 (`SERVER_VERSION`, used in handshake `serverInfo`)
- src/core/install/opencode-plugin-asset.ts:39 (third version read)
- src/mcp/instructions.ts (162 lines; `WRITER_INSTRUCTIONS` :33, `FULL_INSTRUCTIONS` :87, `CATALOG_INSTRUCTIONS`, `SCOPE_BODIES` :145-148, `buildInstructions` :159-162)
- src/mcp/capabilities.ts (162 lines; `RuntimeCapabilityWindow` :14-17, `evaluateToolCapabilities` :41-62, report shape :70-83, `hostCeiling` :100-121)
- src/mcp/server.ts:148-155 (constructor evaluation), :357-380 (`handleInitialize`), :383-385 (hidden aliases not advertised)
- src/core/brain/portability/pointer.ts:214-216, :231-238, :245-262
- src/cli/brain/verbs/project.ts:12,13,59,107 (only consumers today)
- src/mcp/brain/landscape-tools.ts (sibling read-only inventory tool `brain_mcp_landscape`)
- src/core/install/types.ts:21-45, src/core/install/host-probe.ts, src/cli/install/install.ts:452-506, src/cli/install/render.ts:176-198
- src/core/install/ownership.ts:786, :794
- src/cli/update.ts, src/core/install/update.ts, src/core/brain/upgrade.ts
- docs/cli-reference.md, docs/mcp.md, docs/updating.md, CHANGELOG.md

Conventions:
- `package.json` `version` is the single source of truth, mirrored into eight manifests plus `pyproject.toml` by `bun run scripts/sync-version.ts`; CI gates on `--check`. Never hand-edit a mirrored file.
- Tests are Bun tests under `tests/`, mirroring `src/` layout. `bun run validate` = typecheck + lint + test. Formatter `bun run fmt` (oxfmt), linter `bun run lint` (oxlint). Both must be green before every commit.
- House style, visible throughout the tree: an absent answer is a NAMED member of a closed vocabulary carrying its reason, never an assumed success. Frozen constant objects (`Object.freeze`) with a derived union type are the idiom for such vocabularies.
- Module headers carry a short prose rationale explaining why the module exists and which wrong default it removes.
- Public prose uses the full product name "Open Second Brain", never an abbreviation; no exclamation marks; no AI-authorship markers.

Constraints:
- SOLID, KISS, DRY. Repeated literals hoist into named constants. Match the surrounding idiom.
- No fallback that silently does nothing and misleads; errors surface explicitly and by name. No stubs. No hardcoded values that belong in constants.
- No hardcoded natural-language phrases in any language other than English; other-language cases must be handled abstractly, because the project cannot enumerate the languages of the world.
- Do not change existing public CLI or MCP contracts in a breaking way. Deprecated surfaces stay callable.
- No new external runtime dependencies.
- No schema migration and no search reindex in this wave.
- Everything added here must be read-only with respect to user content.
- One pull request, one CHANGELOG version.

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
