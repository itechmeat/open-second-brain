# Brain Integrity & Safety Hardening — implementation plan

Implemented **one-by-one** via TDD on branch `feat/brain-integrity-safety-hardening`. Each task is one atomic conventional commit. Cards are driven **one at a time** on the shared branch — each worker MUST build on the commits previously-driven in-scope cards already landed, and must not duplicate or conflict with sibling tasks.

**Sequence (risk-ordered, lowest blast radius first; the concurrency-invariant change lands last):**

```
G → H → I → E → B → F → C → D → A
```

The combined design is at `docs/brainstorm/brain-integrity-safety-hardening/design.md` (same branch).

## Tasks

### Task G — Hardcoded absolute-path hygiene check (`t_44f91e9b`, p3)
- **Files**: new check in `src/core/brain/doctor.ts` (registered after the existing config-schema check) and/or a new CI lint script under `scripts/`; allowlist fixture support; tests `tests/doctor-absolute-path.test.ts` (and/or lint test).
- **Acceptance**: a vault/docs scan flags hardcoded home/absolute paths (`/root/...`, `/Users/...`, `/home/...`, `C:\\...`) in OSB source, docs, generated examples, and plugin config templates; annotated fixtures (documented allowlist or marker comment) suppress intentional-example false positives; the finding is a report-only `DoctorIssue` (severity `warning`, stable `code`) and never auto-edits files; absent flagged paths ⇒ doctor exit clean / lint passes.
- **Depends on**: none.

### Task H — Safe fallback names for punctuation-only generated notes (`t_5c364387`, p3)
- **Files**: `src/core/vault.ts` (`slugify`); tests `tests/vault-slugify.test.ts`. Verify `deriveSlug` (`src/mcp/brain/feedback-tools.ts:48-55`) and `src/mcp/resources.ts` slug/id validators still pass.
- **Acceptance**: `slugify` of `@`, `!!!`, whitespace, emoji-only, and combining-marks inputs falls back to a stable safe name (`unnamed` + short hash of the original); every currently-valid (non-punctuation-only) input is **byte-identical** to today (regression snapshot test against the current output); `ensureInsideVault` traversal protection is untouched and still rejects `..`/symlink escapes.
- **Depends on**: none.

### Task I — Memory cost meter: write-volume accounting (`t_0c7bed77`, p3)
- **Files**: new `src/core/brain/write-telemetry.ts` (sibling to `recall-telemetry.ts`: `emitWriteTelemetry`, `summarizeWriteTelemetry`, write-vs-read ratio); wire `brain_feedback` / `apply_evidence` / `create_note` (and note-create paths) to emit; tests `tests/write-telemetry.test.ts`. Anticipate — but do NOT yet wire — the write-lane seam (Task A provides it).
- **Acceptance**: write events (preference/note/fact saves) are counted per period and folded against `summarizeRecallTelemetry` reads into a write-vs-read ratio; reads-only behaviour is **byte-identical** to today when no write events occur; deterministic counting; summary shape documented and frozen.
- **Depends on**: none (anticipates Task A's chokepoint; final wiring to the lane lands with Task A).

### Task E — Read-only graph health gate before labeling/import (`t_301db77e`, p4)
- **Files**: new `src/core/partner/graph-health.ts` (read-only post-construction pass: dangling refs, self-loops, collapsed-edge warnings, cache-root mismatches); surface findings as `DoctorIssue`-shaped warnings in the existing `vault_health` / `doctor` surfaces (`src/mcp/tools.ts:381`, `src/mcp/brain/health-tools.ts`); tests `tests/graph-health.test.ts`.
- **Acceptance**: after graph/index construction, the gate surfaces the four warning classes as non-aborting warnings (never aborts the run, never mutates state); a clean graph ⇒ no warnings; findings carry a stable `code` and severity `warning`; the gate runs read-only (no writes).
- **Depends on**: none.

### Task B — Portable graph/index artifact keys (`t_e032ff18`, p4)
- **Files**: **first** a read-only confirmation of the on-disk key format of codegraph artifacts (`manifest.json` keys, `graph.json` `source_file`, generation reports) and any embedding-index keys; then relativize any absolute-leaking readers in `src/core/partner/codegraph-report.ts` (+ sibling codegraph artifact readers). The search index already stores vault-relative POSIX (`store.ts:46,537,553`) — do **not** touch it. Tests `tests/codegraph-portable-keys.test.ts`.
- **Acceptance**: codegraph manifest keys + graph `source_file` + report references are stored relative to the vault scan root; an incremental update after a simulated clone/move (different absolute vault root) matches cached files instead of forcing full re-extraction; if a reader already stores relative paths, the task shrinks to a pin-the-invariant test (no invented work); no absolute host path leaks into a synced/committed graph artifact.
- **Depends on**: none.

### Task F — Signed source-diversity grounding score (`t_4678a91a`, p4)
- **Files**: new `groundingScore(slot)` projection in `src/core/brain/truth/` (e.g. `grounding.ts`), computed alongside `computeTruthState`/`computeTruthStateWithConflicts` in `truth/fold.ts`; surface the signed score + sufficiency as an additional dimension next to CONTESTED in `truth/conflicts.ts`; tests `tests/truth-grounding.test.ts`. Do **not** mutate the append-only ledger; do **not** change `page-meta/confidence.ts` unsigned bands.
- **Acceptance**: a contested slot with N mentions across N independent `source`s scores higher support than N mentions in one source (pinned weighting test); the signed score ∈ [−1.0, +1.0] with a labelled band (Strongly supported → Mixed → Contested → Contradicted); the existing binary CONTESTED flag is unchanged (backward-compat test); no recall ranking changes unless a caller opts into the new dimension; deterministic, no LLM; history (claim ledger) is byte-identical before/after.
- **Depends on**: none.

### Task C — Scheduled corpus-wide prompt-injection sweep (`t_aec23bd0`, p4)
- **Files**: new corpus scan reusing `src/core/brain/safety/context-guard.ts` `TEXT_PATTERNS`/`contextSafetyReport` verbatim (no new pattern list); register as a maintenance task in `src/core/brain/maintenance/` (leased, quiet-window, sequential via `runMaintenance`) and/or a hygiene detector in `src/core/brain/hygiene/scan.ts` registry; findings flow to operator via the existing hygiene `apply` plan (quarantine/auto-fix); tests `tests/corpus-injection-sweep.test.ts`.
- **Acceptance**: scanning every stored memory surfaces injection payloads (instruction_override / delimiter_spoof / secret_exfiltration) with zero LLM; a poisoned memory persisted via an untrusted source is flagged on the next scheduled sweep, not only at read time; findings are surfaced for operator decision (quarantine/auto-fix) and **never silently deleted**; sweep runs inside the maintenance lease and is bounded on a large-vault fixture; default-off until the operator schedules/enables the lane task.
- **Depends on**: none. (If D lands first and defines a shared linear-detector contract, C may reuse it; otherwise C defines the contract D later shares.)

### Task D — Redactor fail-closed past ceiling + infra-topology detectors (`t_de2ccadd`, p4)
- **Files**: `src/core/redactor.ts` — (1) replace the silent truncate-and-drop (`out.slice(0, maxInput) + TRUNCATION_MARKER`, line 171) with a fail-closed `scan_truncated` marker that demotes/excludes the artifact; (2) add infra-topology detector family (`public_ipv4`, `public_ipv6`, `basic_auth_url`, `fqdn_port`, `ipv4_port`, `internal_host`). All detector regexes (existing SECRET_KEYS family + new topology family) must stay **linear** (bounded, no catastrophic backtracking). Tests `tests/redactor-failclosed.test.ts`, `tests/redactor-topology.test.ts`.
- **Acceptance**: input > `MAX_REDACTOR_INPUT` (256 KB) on the receipts path produces a `scan_truncated` marker that demotes/excludes (no unscanned tail treated as clean); a secret placed after byte 256 KB is flagged, not passed through; bare public IPv4/IPv6, `basic_auth_url`, `fqdn:port`, `ipv4:port`, and internal hostnames are redacted (artifact-store path benefits most); a pathological-large-input test asserts bounded (linear) time — no ReDoS; existing key=value/Bearer redaction is **byte-identical** for inputs under the ceiling (regression snapshot test).
- **Depends on**: none (shares C's linear-detector contract on second use, if C landed first).

### Task A — Single-writer queue / lease-backed write lane for concurrent Brain writes (`t_559fbe1f`, p4)
- **Files**: new `src/core/brain/write-lane.ts` (or `write-session/lane.ts`) reusing the `proper-lockfile` writer-lock pattern (`src/core/search/store.ts:228`, `lockfile.lockSync`, `realpath:false`, stale-ms guard) and the maintenance-lease shape (`src/core/brain/maintenance/lease.ts`); attach at the write-session commit chokepoint `src/core/brain/write-session/engine.ts:347` (verify every write path funnels through it via grep before locking); **complete I's write-telemetry wiring at the same seam** (I anticipated this chokepoint). Tests `tests/write-lane.test.ts`.
- **Acceptance**: concurrent writes to the same Brain artifact from two callers serialize with deterministic ordering (no lost update, no Syncthing conflict file); a held lane makes the second writer wait-or-fail-clearly (no silent corruption); the lane is process-exit-safe (stale-guarded, releases on completion, no daemon, no mandatory long-running process); read paths are unaffected (byte-identical); the lane never bypasses `ensureInsideVault` or the atomic-write discipline. Design note (resolve in TDD): prefer enforcing at the chokepoint if grep confirms all write paths pass through it; otherwise ship an opt-in `acquireWriteLane()` and document the expansion path.
- **Depends on**: Tasks G–F landed (the safety net — E health gate, I meter, C/D scanners — precedes the concurrency-invariant change). I's chokepoint seam is finalized here.

### Task (final) — Docs + version bump (same release)
- **Files**: `README.md`, `CHANGELOG.md` (new `## [1.21.0]` heading + link-ref, grouped by the three sub-themes: write-time integrity / cross-machine portability / corpus-level safety), `package.json` (1.20.0 → 1.21.0), then `bun run scripts/sync-version.ts`.
- **Acceptance**: `bun run sync-version:check` passes; CHANGELOG version matches package.json; README documents the nine opt-in/projection capabilities; `bun run validate` (typecheck + lint + test) is green.
- **Depends on**: Tasks G, H, I, E, B, F, C, D, A.
