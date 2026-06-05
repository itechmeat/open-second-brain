# Release 1.0.0 - Stability & Trust: API freeze, deprecation sweep, hardening

**Status:** accepted
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain is natively integrable with Hermes and its surface has been stable across many release cycles, but nothing formalizes that stability. Nine deprecated MCP aliases linger from the token-diet pass, no document states what counts as a breaking change for schemas and on-disk formats, long-running operations have no hang protection, the self-improvement loop applies changes inline with only post-hoc rollback, timestamps render in UTC regardless of the operator's locale, and periodic reports cannot say what changed since the previous run. Version 1.0.0 is the moment to fix all six: a major bump is the only legitimate point to drop deprecated surfaces, and the hardening work earns the "production-ready" label the version number claims.

## Scope

Five atomic units in one PR (epic t_a77ade0a):

1. **API freeze + deprecation sweep** (epic-level): remove the 18 `deprecatedAlias` MCP tools (10 brain aliases of `brain_brief`/`brain_analytics` views, 8 schema aliases of `schema_inspect` views), replace them with server-side tombstones that return a precise migration error, pin the public contracts in a stability policy document, and write the 0.x -> 1.0.0 upgrade guide. A doctor check flags vault-side references to removed tool names.
2. **Operation safeguard** (t_06784b8d): cooperative deadline + output-cap layer around the long-running brain operations (dream, reindex, bridge discovery, communities, maintenance lane), config-resolvable timeouts, clean-abort semantics, `timed_out` surfaced in lane metrics.
3. **Staged dream pipeline** (t_ae8a8ec0): `stage -> validate -> apply` lifecycle over a persisted, discardable proposal bundle, with `dream()` remaining the single promotion engine.
4. **Timezone presentation layer** (t_2ccadc6a): user/LLM-facing timestamp rendering honors the configured IANA timezone; storage stays canonical UTC.
5. **Dual-output reports** (t_00eece5d): digest and brief surfaces persist a machine-diffable JSON snapshot per run and report a deterministic "since last run" delta.

## Out of scope

- UI surfaces (inbox pill, voice chat) - dashboard-plugin material.
- Artifact ingest with OCR (t_77f9d89b), subagent tool loop (t_8bf27494), OTel LLM tracing (t_281c3edc), PDF export (t_64d65fb7) - each its own minor after 1.0.
- Copilot/Pi session adapters - blocked on external format reverse-engineering.
- Renaming the writer MCP server (deferred since v0.10.10) - a rename is breaking for client configs and the cost/benefit does not clear the bar even at a major.
- Preemptive cancellation of synchronous SQLite work - the safeguard is cooperative by design (see decisions).

## Chosen approach

Variant 1 from the consultant pass: independent vertical slices. Each unit lands as a self-contained module with its own atomic commits, sharing only existing primitives (`atomicWriteFileSync`, the `o2b.metrics.v1` writer, `time.ts`, `resolveTimezone`). The safeguard is a thin cooperative deadline object checked at iteration boundaries; the staged dream pipeline adds a persistence-and-gate mode around the existing `dream()` engine rather than a second mutation path; the timezone formatter and the snapshot-diff helper are local utilities threaded through their own render/persist sites. No new cross-unit abstraction is extracted up front; if units 3 and 5 converge on identical bundle mechanics during implementation, a small shared helper is extracted opportunistically inside the slice work.

## Design decisions

- **Tombstones instead of silent removal.** Removing the 18 aliases makes `tools/call` on an old name fail with a generic "unknown tool". A static `REMOVED_TOOLS` map (name -> `{removedIn: "1.0.0", replacement: "brain_brief", view: "digest"}`) lets the server return one precise INVALID_PARAMS error: `brain_digest was removed in 1.0.0; call brain_brief with view="digest"`. Zero token cost (tombstones are never listed), maximal migration clarity. The `deprecatedAlias` helper itself is deleted - nothing uses it after the sweep.
- **The advertised tool count stays 77; the callable surface shrinks 95 -> 77.** The 18 aliases were `hidden: true` - absent from `tools/list` but callable. The sweep makes the advertised list and the callable surface identical, which is itself a 1.0 property (no shadow API). The staged dream lifecycle rides the existing `brain_dream` tool via an optional `action` parameter (`run` default | `stage` | `validate` | `apply` | `discard` | `list`); timezone and snapshots ride existing brief/digest tools. No new tools.
- **Stability policy is prose, not a registry.** Variant 3's machine-readable contract registry is heavyweight scaffolding for surfaces that are already stable. `docs/stability.md` lists the frozen contracts (MCP tool surface, CLI verb tree, config keys + env vars, search schema ladder, on-disk format schemas) and defines what counts as breaking for each class. The upgrade guide lands as a 0.x -> 1.0.0 section in `docs/updating.md` with the full alias -> replacement table.
- **Doctor check scopes to what doctor can see.** Doctor cannot inspect remote client configs; it scans vault-side surfaces it already reads (installed skill files, openclaw config block, `Brain/` notes) for the 9 removed names and emits a warning naming the replacement. Best-effort, fail-soft, no false authority.
- **Safeguard is cooperative, not preemptive.** Bun + synchronous SQLite cannot be preempted honestly; wrapping sync calls in fake async timeouts would lie about cancellation. `createSafeguard({timeoutMs})` returns a deadline object whose `checkpoint()` throws `SafeguardTimeoutError` when the deadline passes; long operations call `checkpoint()` at natural iteration boundaries (per file in `indexVault`, per candidate in `discoverBridges`, per propagation sweep in `detectCommunities`, per phase in `dream`, per task in the maintenance lane). Abort is clean: the operation stops at a boundary, partial artifacts are not half-written (writes stay atomic), and the caller reports `timed_out: true`.
- **Safeguard config is flat keys with a global fallback.** `safeguard_timeout_seconds` (global default 600) plus per-operation overrides (`safeguard_timeout_dream_seconds`, `_reindex_`, `_bridges_`, `_clusters_`, `_maintenance_`), env mirror `OPEN_SECOND_BRAIN_SAFEGUARD_TIMEOUT`. Resolution order mirrors mirage: per-op override -> global -> built-in fallback. `0` disables (no deadline). Existing lane metrics gain a `timed_out` payload field; exit codes keep the repo convention (timeout is an operational failure: exit 1, `{ok:false, timed_out:true}`).
- **Output caps live where output is unbounded.** The maintenance lane captures per-task output; it gains `max_bytes`-style caps with an explicit `truncated` marker. List-style verbs already have `--max` style limits; no blanket stream wrapper.
- **Staged dream never forks the promotion engine.** `stageDream()` runs the existing engine in dry-run mode and persists the planned summary as a bundle under `Brain/dream/staged/<run-id>/`: `manifest.json` (schema `o2b.dream-stage.v1`, input fingerprint = hash over inbox signals + preference files the plan read), `REPORT.md` (human-readable, deterministic projection), `sources.jsonl` (scanned signals), `proposals.jsonl` (planned mutations as data). `validateDreamBundle()` recomputes the dry-run plan and compares it to the staged proposals - identical means the vault has not drifted. `applyDreamBundle()` re-validates, then runs `dream()` live; determinism guarantees the live run performs exactly the staged plan. Drift at any point aborts with a mismatch report and the operator re-stages. Apply records a `dream_stage` metric (o2b.metrics.v1).
- **Timezone is presentation-only and additive.** `resolveTimezone()` already exists (env `VAULT_TIMEZONE` -> config `timezone` -> null). A new `formatLocalTimestamp(isoUtc, tz)` helper (Intl.DateTimeFormat, no dependencies) renders `YYYY-MM-DDTHH:MM:SS+HH:MM`. When a timezone is configured, human-readable CLI output renders local time and JSON/MCP envelopes gain additive `*_local` fields plus a top-level `timezone` echo; when unset, output is byte-identical to 0.45.0. Storage, frontmatter, log headings, and run ids stay canonical UTC - `time.ts` is untouched.
- **Report snapshots are opt-in and fail-soft.** Brief/digest runs persist `Brain/reports/<surface>/<ISO-date>.json` (schema `o2b.report-snapshot.v1`, atomic write) when `report_snapshots_enabled` is set (env `OPEN_SECOND_BRAIN_REPORT_SNAPSHOTS`). The next run loads the most recent prior snapshot (fail-soft: torn or missing reads as none) and computes a deterministic diff (added/removed/changed per section) appended to the report as a "Since last run" block and a `delta` JSON field. Surfaces: digest, daily brief, weekly synthesis.
- **A vault that enables nothing behaves bit-identically** - except for calls to the 9 removed aliases, which is the one documented break of the release.

## File changes

New files:
- `src/core/brain/safeguard.ts` - createSafeguard, SafeguardTimeoutError, output-cap helper, config resolution.
- `src/core/brain/dream-stage.ts` - stage/validate/apply/discard/list over the bundle layout.
- `src/core/brain/present-time.ts` - formatLocalTimestamp + envelope localization helpers.
- `src/core/brain/report-snapshot.ts` - snapshot persist/load/diff engine.
- `docs/stability.md` - frozen contracts + semver policy.
- Tests mirroring each new module plus integration coverage.

Modified files:
- `src/mcp/brain-tools.ts` (remove 10 alias registrations; brain_dream action param; localized fields), `src/mcp/schema-tools.ts` (remove 8 alias registrations), `src/mcp/tools.ts` (delete deprecatedAlias; REMOVED_TOOLS support), `src/mcp/server.ts` (tombstone dispatch).
- `src/core/brain/dream.ts` (safeguard checkpoints; plan capture reuse), `src/core/search/indexer.ts`, `src/core/brain/link-graph/bridge-discovery.ts`, `src/core/brain/link-graph/communities.ts` (checkpoints).
- `src/cli/brain/verbs/maintenance.ts` (per-task timeouts, output caps, timed_out metric field), dream/brief/digest/timeline CLI verbs (stage actions, local time, snapshots), `src/cli/command-manifest.ts`, help-text.
- `src/core/brain/doctor.ts` (removed-name scan), `src/core/config.ts` (safeguard + snapshot key resolution).
- `tests/mcp/mcp.test.ts` (tool count 77 -> 68 and related pins), affected verb/tool tests.
- `README.md`, `CHANGELOG.md`, `docs/cli-reference.md`, `docs/mcp.md`, `docs/how-it-works.md`, `docs/updating.md`, `docs/metrics.md` (dream_stage surface).

## Risks and open questions

- **Hidden alias dependencies in tests/skills.** Some tests or shipped skill files may call alias names; the sweep must update them to the consolidated forms. Grep before removal.
- **Dream determinism is the load-bearing wall for validate-then-apply.** Any nondeterminism (clock, iteration order) between recompute and live run breaks the equality gate. The dry-run plan comparison must normalize clock-derived fields (run ids, timestamps) out of the equality check.
- **Checkpoint placement granularity.** Too coarse and timeouts overshoot; too fine and hot loops pay overhead. Place at I/O-adjacent boundaries only; benchmark-sensitive paths (recall) are out of safeguard scope.
- **Intl.DateTimeFormat offset formatting** varies for exotic zones; the formatter must be covered by tests pinned to fixed zones (UTC, Europe/Berlin, America/New_York) and fail-soft to UTC on invalid zone names.
- **Snapshot diff stability.** The diff must key on stable section identities (paths, pref ids), not array order, or every run reports spurious changes.
