# Brainstorm: Open Second Brain — "Brain Integrity & Safety Hardening" suite

You are a senior backend architect. The project owner needs exactly **3 distinct architectural variants** for how to structure a 9-task release, then a single recommendation. Be concrete and grounded in the real codebase facts below. **No code.** Only the sections listed at the bottom.

## Project facts (grounding — do not contradict)

**Open Second Brain (o2b)** is an Obsidian-native memory layer for AI agents. Plain Markdown the user owns, in a vault synced across VPS/Mac/Android via Syncthing. No daemon, no vector black box, no hidden state outside the vault. The plugin NEVER calls an LLM itself — the agent owns generation, the vault owns the durable record. Every behaviour is opt-in and byte-identical-when-off.

- **Runtime/language**: TypeScript + Bun (`"type": "module"`). Node `node:fs` / `node:path` only. No new runtime dependency is ever added casually.
- **Testing**: `bash scripts/test`. Tooling: `tsc --noEmit`, `oxlint`, `oxfmt`. `bun run validate` = typecheck + lint + test.
- **Only runtime dependency**: `proper-lockfile` (already used by the search store writer lock and maintenance lease).
- **MCP-first**: the writer/reader tools are exposed as MCP tools (`src/mcp/tools.ts`, `src/mcp/brain/`). The CLI (`src/cli/`) is a thin layer over the same core. OpenClaw reads/writes the vault directly with `node:fs`.
- **Current version**: 1.20.0. Each release bumps README + CHANGELOG + package.json (`scripts/sync-version.ts`).
- **Architecture layers**: Agent runtime → runtime adapter/plugin → skills and commands → CLI/core library → vault files and local config. Core (`src/core/`) is runtime-agnostic and deterministic.

## Standing project conventions (every variant MUST honor these)

1. **No hidden daemon.** OSB is filesystem-first and can be called by many runtimes concurrently. No mandatory long-running process. Any coordination must use an explicit write session, file lock, or cooperative queue compatible with Syncthing and process exit.
2. **Deterministic, no LLM inside the kernel.** Counters, atomic file moves, regex. The plugin never runs a model. Memory "learns" via a nightly `dream` pass.
3. **Byte-identical-when-off.** Every new capability is opt-in behind a flag/verb. The default path changes nothing.
4. **No misleading fallbacks.** A verb that silently no-ops when its backend is absent is forbidden. Fail loudly or report honestly.
5. **Read-time-derive precedent.** The repo prefers computing derived views at read time over persisting them (`recall-hint.ts`, `enrich.ts`). The single principled exception in the codebase is in-memory side-indexes memoized + invalidated on store version (never SQLite-persisted for derived data).
6. **Path-safety chokepoint.** Every write funnels through `ensureInsideVault(target, vault)` (`src/core/path-safety.ts`), which resolves `..`, follows symlinks for the deepest existing ancestor, and re-runs a lexical prefix check. The write-session commit chokepoint re-resolves every target through it.
7. **Atomic writes.** `atomicWriteFileSync` / `atomicCreateFileSyncExclusive` for all vault mutations; verified snapshots before mutations.
8. **English-only strings, abstract multi-language.** No natural-language word lists in any algorithm; tokenizers emit CJK bigrams structurally.
9. **SOLID / KISS / DRY.** No hardcoding. Each suite unit ships one-by-one via TDD on a single feature branch, one atomic conventional commit per task.

## Recent git log (for style/conventions; current branch is `feat/brain-integrity-safety-hardening`)

```
313d061 feat: configurable skills_dir + trigger-keyword auto-attach scoring (#114)
a3ea315 fix: v1.19.1 - cross-vault cards, event-trace exit codes, registry-guard hygiene (#113)
bb5f320 feat(brain): session-boundary capture durability and post-compaction pinned-anchor survival audit (v1.19.0) (#112)
c5e30b8 fix: cross-vault chain-stop reads the max normalized score (v1.18.1) (#111)
33b4fba feat: recall precision, coverage, and provenance hardening (v1.18.0) (#110)
254b580 feat: codegraph link-graph depth and MCP exposure (v1.17.0) (#108)
da2e3cc feat: memory subsystem alignment - honest pinned budgets, atomic batch writes, on_memory_write host bridge (v1.16.0) (#107)
9295e28 feat: Brain Portability & Interop Suite - bank export/import, page contract, brain_create_note, in-process SDK (v1.9.0) (#98)
6e59a42 feat: Vault Integrity & Trust Suite - untrusted-source containment, NFC identity, watch-sync, O(1) graph, agent-scope (v1.6.0) (#95)
```

## The 9 in-scope tasks (verbatim bodies + verified code anchors)

This release's theme: **write-time integrity discipline, cross-machine portability, and corpus-level safety** — the architectural strip that the project's own triage ranks as priority-4 (core) plus three thematically aligned p3 tasks.

### Task A — `t_559fbe1f` (p4): Single-writer queue for concurrent Brain writes
Introduce a single-writer queue or lease-backed write lane for concurrent OSB writes from MCP tools, hooks, imports, and scheduled jobs, WITHOUT violating the no-hidden-daemon invariant. Concurrent writes to the same Brain artifacts risk races, lost updates, or noisy Syncthing conflict files; serializing write operations gives deterministic ordering and clearer failure/retry.
- **Anchors**: search store already has `acquireWriterLockSync` (`proper-lockfile.lockSync`, `realpath:false`, stale-ms guard) at `src/core/search/store.ts:228`. Maintenance lane has an expiring SQLite lease (`src/core/brain/maintenance/lease.ts` `acquireLease/releaseLease`, `MAINTENANCE_LEASE_TTL_MS`, never bypassable) and `runMaintenance` is sequential-by-design. Write-session commit chokepoint at `src/core/brain/write-session/engine.ts:347`. No general single-writer queue across ALL Brain writes exists yet.
- **Constraint**: prefer an explicit write session / file lock / cooperative queue. Never a mandatory daemon.

### Task B — `t_e032ff18` (p4): Portable graph/index artifact keys (scan-root-relative, not absolute)
Store OSB-generated graph/index artifacts (codegraph manifest, node/edge/hyperedge source references, search/embedding index keys, generation reports) using keys relative to the vault scan root instead of absolute machine-local paths. Syncthing syncs the vault across 3 devices, so any `/root/vault/...` key is stale/unmatched on every other device, forcing full re-extraction/re-index instead of incremental reuse.
- **Anchors**: search store already stores document paths as **vault-relative POSIX** (`readonly path: string; // vault-relative POSIX`, `store.ts:46,537,553,566,579`); content_hash + mtime drive the unchanged-file fastpath. The open question is whether the CODEGRAPH artifacts (manifest.json keys, graph.json `source_file`, generation reports) and any embedding-index keys carry absolute paths — `src/core/partner/codegraph-report.ts` resolves `manifestPath`/project dir but the emitted on-disk graph artifact key format is NOT yet verified from hints. `path-safety.ts` `vaultRelative` is about sandboxing writes (different concern from manifest-key portability).
- **Note**: must confirm the actual on-disk key format first; if some readers already store relative paths, scope down to only the absolute-leaking readers.

### Task C — `t_aec23bd0` (p4): Scheduled corpus-wide prompt-injection sweep
A scheduled, corpus-wide prompt-injection sweep as a phase of the memory health check (fsck): regex-scan EVERY stored memory for injection payloads (instruction-override, role impersonation, delimiter/boundary spoofing), NO LLM, with findings surfaced for auto-fix or quarantine. Closes the gap where a poisoned memory that got persisted (via an untrusted ingested source / hostile pasted log) sits in the vault and is only caught at read time.
- **Anchors**: the injection-pattern detector ALREADY EXISTS — `src/core/brain/safety/context-guard.ts` exports `TEXT_PATTERNS` (frozen ReadonlyArray of `DetectionPattern`) covering `prompt_injection.instruction_override` / `delimiter_spoof` / `secret_exfiltration`, plus `contextSafetyReport`, `guardBrainContextSnippet`, `detectText`. Today it fires only at read-time context assembly. Grep confirms context-guard is NOT wired into hygiene/doctor/maintenance as a corpus scan. Host: the maintenance lane (`runMaintenance`, leased, quiet-window, sequential) and the hygiene scan registry (`src/core/brain/hygiene/scan.ts` + detectors dir: conflicts/dedup/freshness/id/usefulness).
- **Constraint**: deterministic regex, no LLM. Land in the existing lane so it runs in the quiet window with the lease. Findings flow to the operator (quarantine/auto-fix), NEVER silent deletion.

### Task D — `t_de2ccadd` (p4): Redactor fail-closed past scan ceiling + infra-topology detectors
OSB's `redactRawOutput` (`src/core/redactor.ts`) truncates input to `MAX_REDACTOR_INPUT = 256 * 1024` and SILENTLY drops the tail past the cut (`out.slice(0, maxInput) + TRUNCATION_MARKER`), so secrets/infra beyond 256KB are neither scanned nor flagged. Two independent fixes: (1) make oversized input FAIL-CLOSED — a `scan_truncated` marker that demotes/excludes rather than treating the unscanned tail as clean; (2) add an infra-topology detector family (bare `public_ipv4`/`public_ipv6`, `basic_auth_url`, `fqdn_port`, `ipv4_port`, `internal_host`) — today only `key=value`/Bearer-shaped secrets are caught, so a bare public IP or internal hostname is never redacted. MCP artifact-store already scans the full payload (`maxInput: Number.POSITIVE_INFINITY`), so window size is moot there but the topology detectors still apply.
- **Anchors**: `SECRET_KEYS` list (key=value/Bearer family only) lines 53–69; known-literal pre-scrub lines 161–168; silent truncate at 171; MCP caller at 141–145.
- **Constraint**: upstream bounds the detector regexes to stay LINEAR — port that property to avoid ReDoS on large inputs. Fail-closed marker on the 256KB receipts path; infra-topology detectors benefit the artifact-store path most.

### Task E — `t_301db77e` (p4): Read-only graph health gate before labeling/import
Run a read-only graph-health gate after graph/index construction and before labels, imports, or downstream recall surfaces trust the graph. Surface dangling references, self-loops, collapsed-edge warnings, and cache-root mismatches WITHOUT aborting the run. Prevents subtly-wrong-but-syntactically-present graph structure from being promoted into agent context or vault artifacts.
- **Anchors**: `vault_health` MCP tool at `src/mcp/tools.ts:381`; brain diagnostics at `src/mcp/brain/health-tools.ts`. No `diagnose_extraction` equivalent, no graph-health gate tied to codegraph labeling/import found.
- **Constraint**: report warnings in existing health/doctor surfaces; stay non-destructive.

### Task F — `t_4678a91a` (p4): Signed source-diversity grounding score for contested truth-ledger slots
Replace the binary CONTESTED flag with a signed grounding score on a −1.0..+1.0 scale, computed from the balance of confirming vs contradicting evidence across INDEPENDENT sources (not raw mention count), weighted by relationship strength, plus a separate confidence/sufficiency dimension. Kappa weights N mentions in one document far below N mentions across N independent sources.
- **Anchors**: contested-slot detection (binary, to extend) — `src/core/brain/truth/conflicts.ts` `withinWindow`/CONTESTED, `CONFLICT_WINDOW_DAYS=30`, `computeTruthStateWithConflicts`. Claim ledger w/ independent source+agent provenance (the INPUT signal) — `src/core/brain/truth/types.ts` `ClaimEvent` (entity/aspect/value/source/agent/valueKind), `ClaimVersion` (carries `count` = how many events asserted this value). Derived truth projection (where a score would compute) — `src/core/brain/truth/fold.ts` `computeTruthState`, `slotKey`, `normalizeClaimValue`. Unsigned confidence bands (to generalize) — `src/core/brain/page-meta/confidence.ts` `PageConfidence`/`BRAIN_CONFIDENCE` (high/medium/low).
- **Constraint**: deterministic (counting + weighting, no LLM). Score is a PROJECTION over the append-only claim ledger — do NOT mutate history; compute alongside the existing fold. Source-diversity weighting (independent sources > repeated mentions) is the part o2b lacks entirely.

### Task G — `t_44f91e9b` (p3): Hardcoded absolute path hygiene check
Add a deterministic hygiene check that flags hardcoded home/absolute paths in OSB source, docs, generated examples, and plugin config templates. OSB installs across different machines and vault roots; hardcoded paths leak private host assumptions and cause broken installs or unsafe copy-paste.
- **Anchors**: `docs/brainstorm/hermes-memory-provider/design.md:40` distinguishes vault path from `hermes_home`; text search finds hardcoded-path concerns in brainstorm docs but no shipped lint/hygiene command scanning source+docs. Host: the doctor surface (`src/core/brain/doctor.ts` `runDoctor` → `DoctorIssue` w/ `code`/severity; config schema check is check #1).
- **Constraint**: start report-only in `o2b brain doctor` or CI; allow annotated fixtures to avoid false positives for intentional examples.

### Task H — `t_5c364387` (p3): Safe fallback names for punctuation-only generated notes
Ensure any OSB-generated note/canvas/artifact filename that slugifies to punctuation-only or empty falls back to a stable safe name like `unnamed` plus a short hash. Punctuation-only filenames break downstream re-sluggers, collide across devices, or become hard to address from agents and shell.
- **Anchors**: `src/mcp/brain/feedback-tools.ts:48-55` `deriveSlug` → `slugify(topic)` (from `src/core/vault.ts`); `src/mcp/resources.ts:24-25` validates slug/id args. No explicit punctuation-only generated filename fallback found.
- **Constraint**: acceptance must cover `@`, `!!!`, whitespace, emoji-only, combining marks; do NOT weaken traversal protection (`ensureInsideVault`).

### Task I — `t_0c7bed77` (p3): Memory cost meter — write-volume accounting alongside read telemetry
A memory-operation cost meter that accounts for WRITE volume (preference/note/fact saves) alongside the existing read/recall telemetry, surfacing a write-vs-read ratio and a rough cost signal per period. Today recall-telemetry tracks only reads (`RecallTelemetryMode = search|context_pack|pre_compress|query`); there is no write-side accounting, so "is my agent write-heavy?" is unanswerable.
- **Anchors**: `src/core/brain/recall-telemetry.ts` — `emitRecallTelemetry` (records reads only), `summarizeRecallTelemetry` (no write dimension), `listRecallTelemetry`. Write events already pass through the log (brain_feedback / apply_evidence / note / create_note). Relates to active-memory budget-pressure watermark (informs eviction).
- **Constraint**: write events already flow through known boundaries; a meter can fold those counts against recall-telemetry reads. Keep deterministic.

## What I need from you

Produce exactly these sections and nothing else:

1. **3 distinct architectural variants** for how to structure this 9-task release (how tasks group, what shared primitives to extract, ordering/dependencies, where the derive-vs-persist and opt-in lines fall). Each variant:
   - **Approach** (2–3 sentences)
   - **Trade-offs** (bullets: pro / con)
   - **Complexity** (small | medium | large)
   - **Risk** (low | medium | high)
   - The three variants must be genuinely different strategies, not the same plan reworded.

2. Then exactly one line: **Recommended: Variant N** followed by a 3–5 sentence rationale grounded in the project facts/conventions above (byte-identical-when-off, no-daemon, read-time-derive, path-safety chokepoint, proper-lockfile reuse, etc.).

Do NOT write code. Do NOT add sections beyond those two. Do NOT propose anything that violates the standing conventions (no daemon, no LLM-in-kernel, no misleading fallbacks, no new runtime dependency unless justified).
