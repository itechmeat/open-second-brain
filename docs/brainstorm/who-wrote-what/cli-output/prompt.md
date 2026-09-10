You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation. You are running inside the project repository and MAY read files to ground your variants; cite file paths you relied on.

# Task

This is an EPIC of five related kanban tasks that ship as ONE feature branch, ONE pull request and ONE release of Open Second Brain. Produce variants for the architecture of the whole suite (how the five pieces share primitives, in what order they land, where the seams are), not five separate mini-designs.

## Task A (t_662f4e82, priority 4): Every note write emits an attributable log event

**Source**: https://github.com/tonydzi/agent-leash (README "fleet layer": Replay - "a causal log attributable per agent and per machine"; docs/leash-8.md Domain 1 Identity, Domain 7 Observability)
**Repo**: tonydzi/agent-leash (2★, MIT, prose-only: 721 lines of Markdown, no code)
**Released**: v0.1.2 (2026-09-05)

## What
Every action an agent takes lands in an append-only log outside the agent's own write scope, stamped with agent, machine and task, so an operator can replay what happened and attribute each write. agent-leash publishes the requirement, not the format.

For Open Second Brain: every note write emits one attributable log event. Today `brain_create_note` / `update_note` / `append_note` / `write_batch` emit no log event at all (CHANGELOG 1.52.0: "caller-named note writes emit no log event"; `docs/observability.md`: "brain_create_note file creation emits no telemetry event today and is not counted"), and `origin_channel` is stamped on note creation only (`src/core/brain/notes/create-note.ts:495-505`). The event carries: write id, `agent` (caller-asserted, marked as such), `origin_channel` (server-derived), device id, session/turn ids when present, target path, content hash before and after, and the write kind. The per-preference audit line (`src/core/brain/pref-audit.ts`: `agent`, `reason`, `revision_before/after`, `hash_before/after`) is the shape to generalise; the write-session engine already emits one log event per terminal transition with `target` (`src/core/brain/write-session/engine.ts:414-428`).

## Why useful for Open Second Brain
`brain_agent_query` / `brain_agent_diff` attribute only `signal | preference | log` (`src/core/brain/agent-source/types.ts:1`); note bodies, the bulk of what agents write, are invisible to attribution. Without a per-write record with before/after hashes there is nothing for a per-agent revert to act on (see t_924129c5), `brain_event_trace` cannot join a note change to the session that made it, and the only history is git, which is absent on non-repo vaults (`brain_note_history` returns `available: false`).

## Status in Open Second Brain
- **Verdict**: present_weaker
- **Codegraph hints**: unstamped writers `src/core/brain/notes/create-note.ts`, `src/core/brain/write-batch.ts` (:20-26 documents the no-rollback contract), append/update verbs in `src/mcp/brain/*-tools.ts`; log appender `src/core/brain/log.ts:335` (`origin_channel` stamp site); event kinds `src/core/brain/types.ts` (`BRAIN_LOG_EVENT_KIND`); the write-site census `tests/core/architecture/write-site-census.test.ts` is the standing list of the unstamped remainder and must shrink to zero for note writes.

## Notes
Priority 4 by the triage rubric: internal, every target file named, the event shape already exists for preferences and write-sessions. Keep the caller-asserted nature of `agent` explicit in the record (the write-binding docblock `src/core/write-binding/index.ts:11-25` is the standing rule: identity is a claim, `origin_channel` is the fact). A hash-chained log (tamper evidence) is a separate follow-up task, not part of this one.

## Task B (t_1814b9bf, priority 4): Per-device shards for every append-only ledger, not only Brain/log

**Source**: https://github.com/tonydzi/agent-leash (README "fleet layer", templates/approval-design-checklist.md §7)
**Repo**: tonydzi/agent-leash (2★, MIT, prose-only: 721 lines of Markdown, no code)
**Released**: v0.1.2 (2026-09-05)

## What
agent-leash reports, from a 6-machine live operation, the failure that a single synced file holding shared counters was overwritten by two machines "inside an hour" (checklist §7). The recommendation is that every append-only ledger an agent writes must be sharded per machine so peers never contend for one file, with the merged view computed at read time.

Open Second Brain already does exactly this for `Brain/log/<date>.<deviceId>.jsonl|.md` (`src/core/brain/log-jsonl.ts:1-62`: per-device shard suffix, deterministic merge by `(timestamp, shardId, line)`, `*.sync-conflict-*` copies excluded, doctor lint `sync-conflict-log` at `src/core/brain/diagnostics.ts:239`). Every other append-only ledger in the vault is still one synced file per period or per key:

- continuity store `Brain/log/continuity/<YYYY-MM>.jsonl` (`src/core/brain/continuity/store.ts:98`)
- idempotency ledger `Brain/logs/idempotency/<YYYY-MM>.jsonl` (`src/core/brain/idempotency-ledger.ts:126`)
- preference audit `Brain/log/pref-audit/<pref-id>.jsonl` (`src/core/brain/pref-audit.ts:6`)
- metrics `Brain/metrics/<surface>.jsonl` (`src/core/brain/metrics.ts:69`)
- session lineage `Brain/.state/session-lineage.jsonl` + gaps file (`src/core/brain/lineage/ledger.ts:122-123`) - this one carries sequence numbers and a hash chain, so two devices appending concurrently produce a fork the verifier can only report

Extend the shard discipline to all of them: `<name>.<deviceId>.jsonl` written, merged at read, sync-conflict copies excluded and reported by `brain_doctor`, `resolveDeviceId()` (`src/core/config.ts:425-570`) as the only shard-id source, a one-shot migration that renames the existing unsharded file into the empty-shard slot (the log reader already treats the bare name as "shard with the empty id", `log-jsonl.ts:6`).

## Why useful for Open Second Brain
The vault is replicated with Syncthing across devices. Two machines appending to the same monthly continuity or idempotency file in the same sync window yield a `.sync-conflict-*` copy that no reader merges, so context receipts, idempotency decisions and preference audit lines silently split across two files. The log layer solved this in v0.10.8; the remaining ledgers inherited the bug the log fixed.

## Status in Open Second Brain
- **Verdict**: present_weaker
- **Codegraph hints**: shard pattern to reuse `src/core/brain/log-jsonl.ts:52-62` (`LOG_FILE_RE`, `SYNC_CONFLICT_SHARD_PREFIX`); device id `src/core/config.ts:425-570`; unsharded writers listed above; surfaces catalogue `src/core/state/surfaces.ts` (42 durable locations) is the checklist for "did we miss one".

## Notes
The upstream repo ships no code for this; the pattern to copy is the project's own `log-jsonl.ts`. Priority 4 by the triage rubric: internal, every target file named, no open design question (the shard-name grammar and merge rule already exist). Coordinate with t_25afa1ba (timestamp-aware bundle import) only if bundle export enumerates ledger files by exact name.

## Task C (t_109fa94d, priority 4): Fleet kill switch: a synced frozen write mode honoured at the write seam by every MCP tool and CLI verb

**Source**: https://github.com/tonydzi/agent-leash (README "fleet layer": Kill / Cap / Replay; docs/leash-8.md Domain 8 Incident response)
**Repo**: tonydzi/agent-leash (2★, MIT, prose-only: 721 lines of Markdown, no code)
**Released**: v0.1.2 (2026-09-05)

## What
A fleet-wide kill switch for agent writes: one operator action stops every agent on every machine from mutating the memory, with a measured time-to-disable, an "autonomy downgrade" mode (reads and proposals continue, writes hold), and scheduled drills that prove the path still works. agent-leash describes it as the first of three fleet controls (Kill, Cap, Replay) and publishes only the description.

For Open Second Brain: a `frozen` write mode that lives in the vault so Syncthing carries it to every device, is honoured at the write seam by every MCP tool and CLI verb that mutates `Brain/` (create/update/append note, write_batch, write-session commit, delete_by_source, dream/hygiene/lifecycle apply, page-dedup merge), refuses with a named reason and a log event, leaves reads and dry-runs untouched, and is reported by `brain_doctor` / `brain_status`. `o2b brain freeze [--reason] / unfreeze` as the operator verbs, plus an env override for the case where the vault itself is unreachable.

## Why useful for Open Second Brain
Today there is no single stop. `o2b brain protect` (`src/core/brain/protect.ts`) patches two runtimes' own permission files and is bypassed by MCP tools, which are the actual write path. `write_approval.enabled` (`src/core/brain/pending.ts:37-38`) stages extracted signals only, not note writes. A write binding with no prefixes (`src/core/write-binding/index.ts`) is inert, not deny-all. `grep kill.switch src/core` hits only search-index toggles. An operator who sees a runaway agent on one of several machines has to find and stop each process.

## Status in Open Second Brain
- **Verdict**: not_in_osb_useful
- **Codegraph hints**: chokepoint inventory already exists as the destructive-site census `src/core/brain/destructive-sites.ts` + `tests/core/architecture/destructive-site-census.test.ts` and the write-site census `tests/core/architecture/write-site-census.test.ts`; policy block to extend `src/core/brain/policy/blocks/write-binding.ts`; refusal shape to reuse `src/mcp/reach-refusal.ts` (named-reason refusals, v1.54.0); vault-identity guard `src/core/brain/vault-identity.ts` (`assertVaultIdentityForWrite`) is the same "check before any byte" position.

## Notes
Priority 4 by the triage rubric: internal, the seam and the census that enumerates every write site exist, and the only design choice (marker file under `Brain/.state/` vs a `_brain.yaml` key) is small; a marker file is recommended because `_brain.yaml` is operator-authored config and a freeze is runtime state. "Cap" (spend/capability budgets) from the same upstream section is deliberately not filed: t_0bed79f3 already covers cost caps for the one metered path.

## Task D (t_924129c5, priority 3): Per-agent / per-session revert: plan-seal-apply over the per-write log

**Source**: https://github.com/tonydzi/agent-leash (README "fleet layer": Replay; docs/plan-vs-authorize.md reversibility tiers)
**Repo**: tonydzi/agent-leash (2★, MIT, prose-only: 721 lines of Markdown, no code)
**Released**: v0.1.2 (2026-09-05)

## What
"Who wrote what, and how to take it back": revert the writes of one agent (or one session, or one device) without restoring the whole vault. agent-leash frames rollback as the operator-side half of an attributable causal log; it publishes no mechanism.

For Open Second Brain: an apply path over the per-write log from the parent task. `o2b brain agent-revert <agent|session|device> [--since]` and the matching MCP verb produce a plan (dry-run default) listing each write, its target, the hash the file has now versus the `hash_after` recorded for that write, and the action: restore `hash_before` content from the nearest snapshot or from an inline before-image, delete a file the agent created, or refuse when a later write by someone else sits on top (drift). Apply runs only the reviewed plan, sealed by digest, under `withDestructiveSnapshot()` so the revert itself is revertible.

## Why useful for Open Second Brain
Rollback granularity today is the whole `Brain/` tree at a snapshot instant (`src/core/brain/snapshot.ts`, `src/cli/brain/verbs/rollback.ts`). Targeted removal keys on a source file (`src/core/brain/source-cleanup.ts`: `deleteBySource`) or a note's derivations, never on writer identity. `brain_agent_diff` can show an agent's contributions but there is no apply path anywhere in `src/core/brain/agent-source/`. A misbehaving sub-agent that touched forty notes over two days forces a choice between losing two days of everyone else's work and hand-editing forty files.

## Status in Open Second Brain
- **Verdict**: not_in_osb_useful
- **Codegraph hints**: snapshot gate `src/core/brain/snapshot-gate.ts:1-40` (`withDestructiveSnapshot`, `RecoverabilityVerdict`); manifest diff `src/core/brain/manifest.ts` (`diffManifests`, SHA-256 inventory); plan-seal-apply-exact discipline already implemented for state relocation in `src/core/state/migrate.ts` (`planStateMigration` :250, `sealManifest` :186, digest verify :740-746, `destination_occupied` drift refusal :724-730); dry-run-only `ForgetPlan` `src/core/brain/governance/forget-plan.ts`.

## Notes
Depends on the per-write log task t_662f4e82 (linked parent). Priority 3, not 4, by the triage rubric: two design decisions are open before this is actionable. (1) Where the before-image comes from: inline in the log event (vault grows with every edit) or resolved from the nearest snapshot (snapshots are opt-in and pruned). (2) Semantics when a later write by another agent overlaps the same file: refuse, three-way merge, or revert-to-before-both. The plan/approve-by-digest/apply-exact shape from `state/migrate.ts` and t_18fda844 is the recommended container for the answer.

## Task E (t_8a7bf39a, priority 3): Per-shard hash chain on the Brain log with report-only doctor verification

**Source**: https://github.com/tonydzi/agent-leash (docs/leash-8.md Domain 7 Observability: "append-only action log outside the agent's write scope")
**Repo**: tonydzi/agent-leash (2★, MIT, prose-only: 721 lines of Markdown, no code)
**Released**: v0.1.2 (2026-09-05)

## What
The action log must be tamper-evident with respect to the agents that write to it: an agent that can delete or edit a line of its own history defeats attribution. agent-leash states the requirement; it publishes no format.

For Open Second Brain: a per-shard hash chain on `Brain/log/<date>.<deviceId>.jsonl`, each line carrying `prev` (hash of the previous line in the same shard) so a removed or edited line breaks the chain from that point; `brain_doctor` verifies every shard and reports the first broken link as a named finding; verification is report-only, never a read gate. Per-shard chains, not a global one, because devices append concurrently and a global ordinal would need the merge story the project deliberately does not have.

## Why useful for Open Second Brain
The Brain log JSONL is unchained: a deleted or edited line is undetectable. The one hash chain in the codebase, `src/core/brain/lineage/ledger.ts` with `lineage/verify.ts`, covers session lineage only, and its docblock (:26-35) sets the policy this task should keep: "integrity here is an audit property, not a gate". `o2b brain protect` denies runtime writes to `Brain/log` but only for two runtimes and not for MCP tools. With the per-write note events landing in the same log (t_662f4e82), the log becomes the attribution record for every write; it should carry evidence that it was not edited after the fact.

## Status in Open Second Brain
- **Verdict**: present_weaker
- **Codegraph hints**: chain + verifier to reuse `src/core/brain/lineage/ledger.ts`, `src/core/brain/lineage/verify.ts` (`verifyLineageLedger`, sequence + hash chain, report-only); appender `src/core/brain/log.ts` (lock + atomic write); reader `src/core/brain/log-jsonl.ts` (per-shard iteration is already the unit); doctor finding shape `src/core/brain/diagnostics.ts:239` (`sync-conflict-log`).

## Notes
Priority 3 by the triage rubric: internal and the pieces exist, but one design decision is open - whether the `.md` human-readable twin of each shard is chained too or declared a derived rendering of the JSONL (recommended: derived, one source of truth). Depends on the per-device ledger sharding task t_1814b9bf only in the sense that chaining a file two devices append to is meaningless; the log is already sharded, so this can start independently.

# Project context

Open Second Brain (TypeScript, Bun runtime, CLI `o2b` + MCP server, an agent-owned `Brain/` directory inside an Obsidian-compatible Markdown vault replicated between devices by Syncthing). Version on main: 1.54.0; this wave ships 1.55.0.

Recent commits:
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
3ee1963a feat: what the index already knew (v1.44.0) (#157)

Related files (verified to exist):
- Brain log appender + parser: src/core/brain/log.ts (appendLogEvent(vault, BrainLogEntry, {deviceId}); every event carries `agent` (caller-asserted) and `origin_channel` (server-derived, src/core/origin-channel.ts); event kinds in src/core/brain/types.ts BRAIN_LOG_EVENT_KIND)
- Per-device log shards + deterministic merge + sync-conflict exclusion: src/core/brain/log-jsonl.ts (LOG_FILE_RE, SYNC_CONFLICT_SHARD_PREFIX, readLogDay, listLogShardFiles)
- Device id: src/core/config.ts resolveDeviceId (device-local, never synced)
- Unsharded ledgers: src/core/brain/continuity/store.ts (Brain/log/continuity/<YYYY-MM>.jsonl, appendContinuityRecord, listContinuityRecords), src/core/brain/idempotency-ledger.ts (Brain/logs/idempotency/<YYYY-MM>.jsonl, rememberKey/lookupKey), src/core/brain/pref-audit.ts (Brain/log/pref-audit/<pref-id>.jsonl), src/core/brain/metrics.ts (Brain/metrics/<surface>.jsonl), src/core/brain/lineage/ledger.ts + lineage/verify.ts (Brain/.state/session-lineage.jsonl, sequence numbers + hash chain, report-only verifier)
- Note write paths that emit no log event today: src/core/brain/notes/create-note.ts createNote (origin_channel stamped in frontmatter on create only, :495-505), src/mcp/brain/notes-tools.ts (brain_create_note / brain_update_note / brain_append_note handlers at :232/:317/:348), src/core/brain/write-batch.ts applyWriteBatch (:236; docblock :20-26 says mid-commit rollback is not attempted)
- Write-session engine emits one log event per terminal transition with target: src/core/brain/write-session/engine.ts auditTerminal (:414-428)
- Preference audit shape to generalise: src/core/brain/pref-audit.ts (agent, reason, revision_before/after, hash_before/after)
- Agent attribution readers: src/core/brain/agent-source/{types,registry,vault-provider,query,diff,summary}.ts (AgentSourceContributionKind = signal | preference | log), CLI src/cli/brain/verbs/agent-query.ts, agent-diff.ts, MCP src/mcp/brain/query-tools.ts
- Snapshot + rollback: src/core/brain/snapshot.ts, snapshot-gate.ts (withDestructiveSnapshot, RecoverabilityVerdict), manifest.ts (SHA-256 inventory, diffManifests), src/cli/brain/verbs/rollback.ts
- Plan/seal/apply-exact discipline already implemented for state relocation: src/core/state/migrate.ts (planStateMigration, sealManifest, digest verify, destination_occupied drift refusal, unwind)
- Source-keyed targeted removal: src/core/brain/source-cleanup.ts (deleteBySource, dry-run default, confirm + expect count guard)
- Write policy surfaces: src/core/write-binding/index.ts (+ docblock :11-25 stating identity is a caller claim), src/core/brain/policy/blocks/write-binding.ts, src/core/brain/pending.ts (write_approval), src/core/brain/protect.ts, src/core/brain/vault-identity.ts (assertVaultIdentityForWrite), src/mcp/reach-refusal.ts (named-reason refusals)
- Censuses that pin architecture: tests/core/architecture/write-site-census.test.ts, destructive-site-census.test.ts (+ src/core/brain/destructive-sites.ts), origin-channel-census.test.ts; state surfaces catalogue src/core/state/surfaces.ts (42 durable locations, test-pinned)
- Doctor findings: src/core/brain/diagnostics.ts (sync-conflict-log at :239), src/core/brain/doctor/
- Docs: docs/observability.md (event kinds table, continuity record kinds), docs/architecture.md, docs/cli-reference.md, docs/mcp.md

Conventions:
- Append-only files + byte-identical idempotent writes; Syncthing peers converge by construction, conflict copies are excluded and reported, never merged.
- Integrity is an audit property, not a gate (lineage/ledger.ts docblock): verifiers report by name, never refuse reads.
- Nothing writes silently, nothing degrades silently (1.52.0): every refusal has a named reason; fail-soft paths report the reason.
- `agent` is a caller-asserted claim; `origin_channel` and transport reach are server-derived facts; no fence may key on the agent name alone.
- Every destructive mutation runs behind withDestructiveSnapshot or has a written recovery story in destructive-sites.ts.
- Test pins: MCP tool counts, write-site census rows, state-surface count, docs prose counts are all pinned and must be updated deliberately.
- Standing engineering brief: SOLID, KISS, DRY, repeated values hoisted into named constants; no silent fallbacks, no stubs; everything in English.

Constraints:
- No new external dependencies.
- No change to existing public CLI/MCP argument shapes; additive only.
- A vault that never enables any of the new behaviour must read and write bit-identically (except that note writes now emit log events, which is the point of Task A).
- Task D depends on Task A. Task E must not need a cross-device global ordinal.
- The whole suite must be implementable by a small team in one wave (roughly 50-70 changed files).

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
