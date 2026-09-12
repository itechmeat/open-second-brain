# What this install knows about itself - design

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain answers a great deal about the vault it owns and very
little about itself. An agent or operator asking the installation which
version it is, which of its tools are actually callable in this runtime,
which projects point at this vault, or whether the hosts it wrote
registrations into can still be reached, gets either no answer, an answer
only one of the two surfaces can hear, or - in the case of the MCP
instruction block - a confident answer that is wrong the moment a host
disables a tool.

The machinery to answer all four questions already exists in the tree as
typed readers. What is missing is the seam between those readers and the
surface that needs them. This wave builds those seams and records, with
its reason, the one question in scope that cannot be answered honestly at
all.

## Premise verification

Every card was read against live source before anything was designed.
Three premises hold, one is largely refuted, one is refuted outright.

### t_dee1d1fe - `o2b version` and `--version` - CONFIRMED, enlarged

No `--version` handling exists in `src/cli/main.ts` and no `version`
entry exists in `src/cli/command-manifest.ts`. The card's "reuse the
existing `packageJson.version` import pattern" is correct but understates
the problem: there are three independent reads of `package.json`
`version` in the tree today - `src/cli/brain/verbs/continuity.ts:40,43`
(`CLI_VERSION`), `src/mcp/protocol.ts:9,14` (`SERVER_VERSION`), and
`src/core/install/opencode-plugin-asset.ts:39`. Adding a fourth would
make four copies of a fact the repository declares has exactly one
source. The correction enlarges the card: hoist first, then build on the
hoisted constant.

A second consequence of that reading: `SERVER_VERSION` is already
reported in the MCP handshake as `serverInfo.version`, so the version
fact is answerable over MCP today and not over the CLI. Only the CLI half
is missing.

### t_cf827c77 - instructions from the capability window - CONFIRMED

`buildInstructions` (`src/mcp/instructions.ts:159-162`) selects one of
three frozen strings from `SCOPE_BODIES` (`:145-148`) by `TOOL_SCOPE` and
prepends an identity line. Nothing else influences it. The handshake
(`src/mcp/server.ts:375-378`) passes only `agent` and `scope`. The writer
body (`:33`) names all five writer tools in prose; the full body (`:87`)
names nine tools across three paragraphs.

Meanwhile `evaluateToolCapabilities` (`src/mcp/capabilities.ts:41-62`)
already computes, per tool, an `available` or `withheld` entry carrying a
human-readable reason, and the server evaluates it in its constructor
(`src/mcp/server.ts:148-155`) and stores the result on
`this.capabilityReport` (`:155`). The report is therefore in hand at
`handleInitialize` time with no plumbing to add. What is missing is only
the decision about what truthful text to render from it.

### t_49315346 - linked projects on the MCP surface - CONFIRMED, smaller than stated

`listLinkedProjects` (`src/core/brain/portability/pointer.ts:231-238`)
and `linkedProjectsStatus` (`:245-262`) are both pure, typed, tolerant
readers; the second already answers the harder question, reporting a
four-value pointer state and a `vaultExists` flag. A grep for both names
across `src/` finds consumers only in `src/cli/brain/verbs/project.ts`.
Nothing under `src/mcp` touches either. The build is a seam, not a
feature.

### t_09d7e9e9 - connector health - LARGELY REFUTED

The card asks for a connector health view that bounds its checks by a
deadline and never presents an unverified connector as healthy. Every
substantive property it asks for already ships, and so does the aggregate
view the card's own validator believed was the remaining gap:

- Per-target status is a closed vocabulary on both sides: `AdapterStatus`
  (`src/core/install/types.ts:21-27`) and `VerifyStatus` (`:39-45`).
- Unverified is already a named member carrying its reason, never an
  assumed `ok`: `HOST_PROBE_RESULT`
  (`src/core/install/host-probe.ts:87-93`), under a module header stating
  that "a probe that reports success when it could not run is the
  misleading default this module exists to remove" (`:17-22`).
- The deadline is already enforced: `HOST_PROBE_TIMEOUT_MS = 10_000`
  (`:158`), with the wait bounded in the runner (`:174-181`) and the
  timeout becoming one more named outcome rather than a hang.
- The aggregate already exists: `runCheck`
  (`src/cli/install/install.ts:452-489`) iterates every registered
  adapter, collects `VerifyResult[]`, renders a table
  (`src/cli/install/render.ts:176-188`) or structured JSON (`:190-198`),
  and returns an exit code distinguishing drift from unreachable
  (`:492-506`).

The genuine residue is narrower and of a different shape than the card
states: all of it is CLI-only. An agent on the MCP surface cannot ask
whether the hosts this install wired up can still be reached. That is the
same gap shape as t_49315346, which is why the two ship as one tool.

### t_c64b7cab - release awareness - REFUTED, not built

The card asks for a surface that reports whether a newer Open Second
Brain version is available by "reading only cached update state". There
is no producer for that cache. A grep across `src/` for `latestVersion`,
`latest_version`, `update-check`, `updateCheck` and `registry.npmjs`
returns nothing: nothing in this tree ever learns what the latest release
is. A cache with no producer would have to be filled by a network check,
and `src/core/install/ownership.ts:794` renders to the operator, verbatim,
that this tool has "no account of its own, no server it phones home to,
no sync endpoint and no update check". Building the card as written means
either making that statement false or shipping a surface whose only
possible answer is that it has nothing to report.

A collision the card did not see: `o2b update` already exists
(`src/cli/update.ts`, `src/core/install/update.ts`) and means re-applying
managed install blocks to host configs, so the obvious verb is taken and
the obvious name would mislead about an existing one.

**Verdict: refused as specified.** Nothing is built for this card in this
wave. The two honest alternatives - registering an outbound release check
in the egress registry as a network site like every other outbound path,
or reading a version fact some other component already fetched and saying
where it came from - both amend an operator-facing promise about network
behaviour. That is an operator policy decision, not an engineering one,
and it is recorded here for the operator to take rather than taken on
their behalf. The upgrade-plan half of the card needs nothing:
`src/core/brain/upgrade.ts` is already a plan/apply migrator.

## Scope

- One shared version constant, with the three existing readers repointed
  at it.
- `o2b version` subcommand and a root `--version` flag, both honouring
  the inherited `--json` flag.
- `initialize.instructions` rendered from the live capability report:
  guidance for a withheld tool is not emitted, and every withheld tool is
  named with the reason the evaluator already computed.
- One read-only MCP tool, `second_brain_wiring`, with two views:
  `projects` (linked project registry with its health) and `hosts` (the
  per-adapter verify aggregate).
- Docs, CHANGELOG and the version bump that CLAUDE.md requires inside the
  feature pull request.
- The recorded refusal of t_c64b7cab above, carried into the CHANGELOG
  notes and the card's handoff summary.

## Out of scope

- Any network call, cached or otherwise, and any change to the data
  ownership statement (t_c64b7cab).
- A second HTTP surface. The loopback explorer
  (`src/core/brain/explorer.ts:345-356`) already exists for live views and
  is not extended here.
- Duplicating the version or the capability report inside the new MCP
  tool: `serverInfo.version` and `second_brain_capabilities` already
  answer both on that surface.
- Any schema migration, search reindex, or ranking change.
- Rewriting the CLI dispatcher. `version` joins the existing `switch`.

## Chosen approach

The consultant's Variant 2 - one coherent model over live state, every
absent answer a named vocabulary member, both surfaces served - with
three project-context overrides recorded under "Design decisions" below.

Each of the four buildable cards is a seam onto a reader that already
exists. Nothing new computes connector health, project health, tool
availability, or the version; four surfaces start reading what four
readers already produce.

## Design decisions

- **One version constant, hoisted before anything is built on it.**
  `src/core/version.ts` exports `OPEN_SECOND_BRAIN_VERSION` from the
  single `package.json` import; `CLI_VERSION`, `SERVER_VERSION` and the
  opencode plugin header read it. Adding a fourth independent read to
  serve `o2b version` would be the defect this wave exists to remove,
  written into the change that removes it.

- **The new MCP tool covers only what is missing.** Variant 2 proposed a
  four-section installation report including `version` and `tools`. Both
  are already answered on the MCP surface - `serverInfo.version`
  (`src/mcp/protocol.ts:14`) and `second_brain_capabilities`
  (`src/mcp/tools.ts:461`, always available and never withheld) - so the
  report would have been two new copies of two shipped answers. Override
  recorded: the tool carries `projects` and `hosts` only.

- **One tool with a required `view`, not two tools.** The house idiom for
  consolidated reads is demonstrably a `view` parameter -
  `brain_brief`, `brain_analytics` and `schema_inspect` all take one, and
  `src/mcp/brain/landscape-tools.ts:26` names the reason (token diet).
  Both views answer the same question class, "what is this install wired
  into", so they belong on one tool. `view` is required with no aggregate
  member, keeping every payload bounded, exactly as `brain_brief` does.

- **Instruction bodies become tool-tagged segments.** Variant 2 proposed a
  per-tool paragraph map. That fits the writer body, whose five bullets
  are already one per tool, and not the full body, which is prose naming
  nine tools across three paragraphs. Override recorded: each scope body
  becomes an ordered list of segments, each declaring the tool names its
  text depends on. A segment renders when every tool it names is
  available; a segment naming no tool always renders. The full body's
  memory-contract paragraph decomposes into one segment per writer tool,
  which is the shape its semicolon-joined clauses already have. The
  withheld list is appended from the report's own `withheld` entries and
  their reasons, so no second vocabulary is invented.

- **Withheld guidance is removed, not contradicted.** Appending a
  withheld-tools block beneath prose that still instructs the agent to
  call those tools leaves the first text every agent reads
  self-contradicting. The segment model is what makes removal possible.

- **The `hosts` view reuses the existing verify path and declares its
  cost.** `verify()` per adapter is exactly what `o2b install --check`
  calls; reusing it means one implementation of connector health, not
  two. Two of the ten registered targets declare a `hostProbe`
  (`src/core/runtime/host-facts.ts:509`, `:530`), so the worst case adds
  two bounded ten-second probes. The tool description states that it may
  ask host CLIs and that the wait is bounded, because a diagnostic that
  can take twenty seconds and does not say so is a surprise.

- **Paths follow the contract that already governs them.** The registry
  is keyed on absolute host paths
  (`src/core/brain/portability/pointer.ts:214-216`), and this server has a
  shipped policy for that: `vaultPathField`
  (`src/mcp/vault-path-field.ts`) emits an opaque stable reference
  (`vault://<hex>`, keyed by the device-local installation secret) unless
  `expose_host_paths` is set. `vaultStoreReference`
  (`src/core/config.ts:614-621`) takes any path, so project directories
  render through the same function under the same flag. No second path
  policy is invented, and
  `tests/core/architecture/vault-path-census.test.ts` keeps the new site
  honest.

- **A degraded field carries its reason.** Following
  `unresolvedField` (`src/mcp/vault-path-field.ts`), a reference that
  cannot be computed because the config is unreadable renders as
  `{ error }` rather than falling back to the raw host path, which would
  breach the policy the field exists to enforce.

- **`--version` is handled before the dispatcher, `version` inside it.**
  The root flag joins the existing `-h`/`--help` check at
  `src/cli/main.ts:495`; the subcommand joins the `switch` at `:501`. No
  new dispatch mechanism.

## File changes

New:

- `src/core/version.ts` - the single version constant.
- `src/cli/version.ts` - the `o2b version` verb and its renderers.
- `src/mcp/instruction-segments.ts` - the segment type, the three scope
  bodies as segment lists, and the renderer.
- `src/mcp/wiring-tools.ts` - `second_brain_wiring` and its two views.
- `tests/core/version.test.ts`, `tests/cli/version.test.ts`,
  `tests/mcp/instruction-segments.test.ts`, `tests/mcp/wiring-tools.test.ts`.

Modified:

- `src/cli/brain/verbs/continuity.ts`, `src/mcp/protocol.ts`,
  `src/core/install/opencode-plugin-asset.ts` - read the shared constant.
- `src/cli/main.ts` - `--version` flag, `version` case.
- `src/cli/command-manifest.ts` - the `version` command and the root
  `--version` flag.
- `src/mcp/instructions.ts` - `buildInstructions` gains the capability
  report input and renders segments.
- `src/mcp/server.ts` - pass `this.capabilityReport` into
  `buildInstructions`.
- `src/mcp/tools.ts` - register the wiring tool.
- `src/mcp/registry-guard.ts` - the preview-budget rationale row for the
  new tool.
- `README.md`, `CHANGELOG.md`, `docs/cli-reference.md`, `docs/mcp.md`.
- `package.json` plus the eight mirrored manifests and `pyproject.toml`,
  via `bun run scripts/sync-version.ts`.

## Risks and open questions

- **Instruction text is the first thing every agent reads.** Rewriting
  three bodies into segments risks changing meaning, not only shape. The
  mitigation is a test pinning that a full capability window renders text
  byte-identical to today's for each of the three scopes, so only the
  withheld case differs.
- **The `hosts` view spawns host CLI subprocesses.** Bounded by
  `HOST_PROBE_TIMEOUT_MS` per probing target and limited to two such
  targets today, but a future adapter declaring a probe raises the
  ceiling. The description states the behaviour rather than hiding it.
- **`verify()` needs a resolved vault.** `runCheck` refuses with a usage
  error when the vault is unset (`src/cli/install/install.ts:456-462`);
  the MCP view must refuse by name in the same case rather than reporting
  every target as not-installed off a bogus path.
- **Open question deferred to the operator, not to implementation:**
  whether Open Second Brain should ever learn what its latest release is,
  and at what cost to the data ownership statement (t_c64b7cab).
