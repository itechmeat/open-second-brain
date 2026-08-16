# What the machine already has - one declaration per fact about the host

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Nine tracker items were picked together because reconnaissance against v1.49.0 showed
they are one question seen from nine sides: what does Open Second Brain know about the
machine it is installed on, where is that knowledge declared, and what proves it is true.
Three of the nine are not missing features at all - they are contracts already declared
in the type system with nothing behind them, which is the previous release's theme
surviving into this one. `InstallAdapter.sessionPaths?()` has zero implementations and
zero call sites. `export type ExportFormat` is never imported; the CLI inlines its two
literals. The four maintenance lane task names are not a vocabulary at all - they are
inline string literals in two independent lists, which is why the CLI and MCP surfaces
have drifted apart two releases running.

## Scope

Eleven atomic units across nine tracker items.

- A closed `INSTALL_TARGET_ID` vocabulary and a `RUNTIME_FACTS` population: one row per
  agent runtime carrying its tool ceiling, its declared tool profile, the session
  adapter it maps to, where that runtime stores session logs, and how a host binary can
  be probed.
- A committed vault-level configuration tier that install and hook generation read, with
  a `CONFIG_ORIGIN` vocabulary so every resolved value reports which layer produced it.
- A ceiling-aware tool profile baked into the generated MCP payload for hosts that
  publish a per-workspace limit, with the advertised count pinned under the ceiling by a
  test that cannot pass vacuously.
- A per-adapter friction comparison and a keyless host probe that replaces the blanket
  "no MCP handshake attempted" with either a real answer or a named skip reason.
- A `LANE_TASK` vocabulary, a cooperative deadline on `brain_dream` action=step, per-task
  retry on `brain_maintenance`, and a CLI-to-MCP parity census derived from source.
- A `STATE_SURFACES` population and an inventory reporting, per surface, its resolved
  path, reachability, and the override that placed it there.
- A digest-bound `state migrate` / `state rollback` pair on the established dry-run
  ladder, and a graceful drain on both MCP transports.
- A Codex CLI install adapter on the `copilot-cli` subprocess-primary precedent.
- Machine-wide session-log discovery with a found-vs-imported status report.
- A line-streaming session reader replacing whole-file reads in all five adapters.
- A session-transcript dataset export riding `ExportFormat` and the egress registry.

## Out of scope

- A `{action, args}` dispatch tool. `catalog` plus `tool_hydrate` already answers the
  token-overhead half without putting verbs behind an envelope no capability report can
  enumerate. Build it only if a host ceiling is low enough that the smallest bounded
  profile does not fit; none is.
- `.cursor/rules/*.mdc` context delivery. It is a workaround for a Cursor-side race in
  hook `additional_context`; a workaround for a bug that may be fixed is a permanent
  maintenance cost with no expiry, and the race has not been re-confirmed.
- Adapters for Cline, Continue.dev, ForgeCode, Goose, Antigravity, Pi and Copilot-CLI
  ingest. Their gate is confirming an external product's config path and registration
  shape, which is not a code question. Codex is included precisely because that gate is
  already satisfied in this repository.
- The three extra session formats named upstream (OpenClaw, ChatGPT and Claude.ai
  `conversations.json`). Separable from discovery, and discovery must not wait on them.
- Two-tier extraction routing and blog/feed ingestion. The privacy wall - deciding what a
  cheap triage model may see - is a design decision, not a routing detail.
- Widening `envOrConfig` itself across its ~55 call sites. See the design decisions.

## Chosen approach

Variant 2 of the consultant's three: two closed registries keyed by their own honest key
spaces, plus a provenance dimension cutting across both. Variant 1's single table unions
a tool ceiling, a TOML config path and a writer-lock file into one row type that
degenerates into a bag of optionals - the exact shape that produced the dead
`sessionPaths?()` seam. Variant 3's owner-local obligation is the right instinct for
adapters and structurally cannot answer the two inventory questions, because the state
surfaces nobody tracks - the search index, the maintenance lease, the hook audit - have
no owning adapter to declare them.

One graft from Variant 3 is adopted: `RUNTIME_FACTS` carries a probe specification, so a
host that can answer about its own registration is asked rather than assumed. What is
declared and what is measured stay distinct columns; neither is allowed to stand in for
the other.

## Design decisions

- **`envOrConfig` gains a sibling, not a signature change.** A provenance-returning
  `resolveWithOrigin` is added and `envOrConfig` delegates to it, returning `.value`.
  Zero call sites change. The consultant flagged a fifty-five-site mechanical sweep as
  the largest risk in the recommended variant, and it buys nothing: the callers that need
  provenance are the install, hook-generation and inventory surfaces, and they are few.

- **`unknown` is not `unbounded`.** `TOOL_CEILING_KIND` has three members. A host nobody
  has checked reports `unknown` with a reason and gets no profile baked in - the current
  behaviour - but the capability report and the install check say the ceiling is
  unchecked rather than staying silent. Collapsing `unknown` into `unbounded` would be
  the misleading fallback this project forbids, one layer up from the fail-open profile
  selection that made the original card true.

- **The profile is declared per host, not computed.** `RUNTIME_FACTS` names the profile
  and the ceiling side by side, and a census asserts the selected profile's advertised
  tool count is at or under the ceiling, pinned as an equality so a new tool cannot drift
  the surface back over the line. A selection algorithm would be cleverer and would move
  the failure from a review-time diff to a runtime surprise.

- **Reconstruction is preserved by making the new dimension a pure function of what
  `verify()` already has.** `expectedPayloadFromEnv(env)` recomputes from `InstallEnv`
  alone, and the JSON adapter body applies its spec's transform to that result, so the
  target is in scope on both the apply and the verify path. The tool profile is therefore
  derivable and byte-identical regeneration holds. The vault-level tier is readable from
  `env.vault` for the same reason.

- **An unreadable vault configuration refuses rather than defaults.** v1.49.0 established
  that an unreadable config resolves to the strict fallback for readers, and found the
  one writer wired to that rationale by mistake. Generated install and hook content is a
  writer: it cannot infer an operator's intent from a file it could not parse, so it names
  the parse failure and stops.

- **State surfaces extend the ownership population rather than starting a parallel one.**
  `OUT_OF_VAULT_STATE` already declares out-of-vault state with a source sweep demanding
  every home, XDG or temp-rooted path builder be attributed to a row or excused with a
  written reason, and `SearchIndexVerdict` is already a tri-state-with-reason. The
  in-vault population is the missing half of the same instrument, and the two render
  through one value with two renderings, never two hand-written copies.

- **`sessionPaths()` becomes required, but its return type is corrected first.** Its
  orphan `format` union is the only occurrence of those literals in the tree and is
  disjoint from the live `SESSION_ADAPTER_ID` vocabulary. It is replaced by that
  vocabulary rather than a sixth one, and the roots come from `RUNTIME_FACTS` so
  `src/core/discipline/transcripts/` and `src/core/brain/sessions/` stop knowing
  different halves of the same fact.

- **Discovery reports coverage; it does not import by default.** A bare invocation
  reports what would import. The privacy posture of the existing importer is matched, not
  relaxed: redaction before write, no tool payloads in pages.

- **The lane vocabulary is the fix; the two parameters are consequences.** Adding
  `retry_tasks` to the MCP tool without closing the vocabulary would leave the same two
  inline lists free to disagree on the next addition. The parity census derives the CLI
  flag set from source and the MCP property set from the tool definition and requires
  each to map or carry a declared exemption, so a third divergence fails a test rather
  than shipping.

## File changes

New:
- `src/core/runtime/host-facts.ts` - `INSTALL_TARGET_ID`, `TOOL_CEILING_KIND`,
  `RUNTIME_FACTS`, accessors. A leaf module; importing it back from the install
  aggregator would close a cycle the architecture ratchet gates.
- `src/core/state/surfaces.ts` - `STATE_SURFACE_ID`, `STATE_SURFACES`,
  `inventoryStateSurfaces`.
- `src/core/state/migrate.ts` - digest manifest, plan, apply, rollback.
- `src/core/install/adapters/codex.ts` - Codex adapter with injectable runner.
- `src/core/brain/sessions/discover.ts` - root walk and found-vs-imported classification.
- `src/core/brain/sessions/read-lines.ts` - streaming line reader.
- `src/core/brain/export-transcripts.ts` - dataset renderer.
- `src/cli/brain/verbs/state.ts`, `src/cli/state-render.ts`.
- Tests mirroring each, plus `tests/core/architecture/host-facts-census.test.ts`,
  `tests/core/architecture/state-surface-census.test.ts`,
  `tests/mcp/maintenance-parity-census.test.ts`.

Modified:
- `src/core/install/types.ts` - `sessionPaths` required, return type retyped, target id
  typed from the new vocabulary.
- `src/core/install/adapters/_json-mcp.ts`, `cursor.ts`, `opencode.ts`, `grok.ts`,
  `copilot-cli.ts`, `all.ts`, `payload.ts`, `payload-equals.ts`, `ownership.ts`.
- `src/core/validate.ts`, `src/core/config.ts`, `src/core/brain/policy/load.ts`.
- `src/core/brain/safeguard.ts` (one new `Operation` member), `dream-step.ts`,
  `dream-scan.ts`, `heal-run.ts`, `maintenance/lane.ts`.
- `src/mcp/brain/feedback-tools.ts`, `admin-tools.ts`, `capabilities.ts`, `http.ts`,
  `stdio.ts`, `tools.ts`.
- `src/core/brain/sessions/` - `types.ts`, `registry.ts`, `import.ts` and five adapters.
- `src/core/brain/export.ts`, `src/cli/brain/verbs/export.ts`, `src/core/egress/registry.ts`.
- `src/core/discipline/transcripts/index.ts` - roots read from `RUNTIME_FACTS`.
- `src/cli/main.ts`, `command-manifest.ts`, `brain/help-text.ts`, `install/`.
- `docs/mcp.md`, `docs/cli-reference.md`, `install/codex.md`, `install/cursor.md`,
  `README.md`, `CHANGELOG.md`.

## Risks and open questions

- The generated Cursor payload changes. Any operator with an existing Cursor install sees
  drift on the next `--check` until they re-apply. The drift message must name the profile
  as the cause; a silent re-apply would hide a surface narrowing from the operator.
- Making `sessionPaths` required is a compile-time break for every adapter in one commit.
  It lands in the discovery unit together with all ten implementations, so no
  intermediate commit is broken, but it cannot be split further. A runtime that stores no
  session logs - `generic`, `aider`, `pi` - returns `null`, which is a stated answer
  rather than an absent member.
- A new `Operation` member must satisfy both the safeguard resolver and the progress
  emitter census, including a drivable entry point with a fixture. If the discovery sweep
  turns out too fast to be worth a progress rail, the honest outcome is no safeguard and
  no sink rather than an emitter that fires once.
- `state migrate` moves live state. It refuses on symlinks, special files, destination
  conflicts, insufficient space and reserved namespaces before it commits anything, and
  the writer lock must be observed - a migration racing a reindex is the one failure that
  digests cannot undo.
- The transcript dataset export is a new bulk egress path opened immediately after a
  release spent on egress. It enters through `ExportFormat` and the census, never as a
  standalone pipeline.
