You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Build an "Indexer Durability & Resilience" suite for Open Second Brain (OSB), a TypeScript/Bun knowledge-vault tool whose search index is a SQLite database (FTS5 + sqlite-vec) derived from a Markdown vault. The suite bundles three kanban tasks that the board's validator clustered as the "indexer-durability family":

1. t_ea80ddb5 - Graceful stop/restart with index flush and multi-instance support. Upstream (agentmemory) inverted stop order: worker first with a SIGTERM grace window for index flush, engine second; added a --instance N flag for multi-daemon support with --port. The OSB-side concern: an operator stopping OSB mid-index (crash, SIGTERM, timeout) can lose uncommitted changes; and running multiple instances on one host.

2. t_672c751e - Resumable durable append-only sync checkpoints with lock heartbeat. Upstream (gbrain) added an append-only checkpoint delta table, guaranteed final flush on every exit path including SIGTERM, lock heartbeat-aware takeover, and treated lock-busy as a skip rather than a phase failure. The OSB-side concern: if a large index run is interrupted it restarts from scratch.

3. t_79e773be - Cooperative abort-honoring with honest attempt accounting. Upstream (gbrain) threaded an AbortSignal through embed phases, checking on both the stale and full paths and between batches; added honest attempt accounting (no retry for non-idempotent work), per-handler wall-clock budgets, and a queue-scoped DB supervisor singleton. The OSB-side concern: long embed jobs can wedge a cycle with no way to abort cooperatively.

# Critical grounding facts about the ACTUAL OSB codebase (verified in code, must shape the design)

- The INCREMENTAL index path (`indexVault`) is ALREADY resumable. `indexInto` walks the vault and skips unchanged files via an mtime+size fastpath (re-running after an interruption skips everything already committed). `populateEmbeddings` only processes `findChunksWithoutEmbeddings()` and commits each batch before the next, so an interrupted embed phase resumes by computing only the still-missing embeddings. => A new resumable-checkpoint table for the INCREMENTAL path would be REDUNDANT and is forbidden by project rules (no misleading or duplicate mechanisms).
- The genuinely NON-resumable path is `reindexVault`: a full rebuild (force=true) that writes a fresh temp DB (`brain.sqlite.new`), then does an atomic same-file rename swap with `.bak` retention. An interruption discards the whole temp build; there is no intermediate resume. Crash-recovery for the rename window already exists (Store.open restores `.bak` if the main file is missing).
- There is already a cooperative deadline primitive: `Safeguard` (src/core/brain/safeguard.ts). An operation receives a `Safeguard` and calls `checkpoint()` at iteration boundaries (per file, per embed batch); past the deadline the next checkpoint throws `SafeguardTimeoutError`. Bun runs SQLite synchronously, so preemptive cancellation is impossible - the honest contract is cooperative. The gap: Safeguard is a TIME deadline only; there is no on-demand AbortSignal to cancel a run that is still within its time budget (e.g. from a SIGTERM in the watcher, or a parent cancellation).
- The only long-running process is `o2b search watch` (src/cli/search.ts): a debounced fs.watch loop that calls `indexVault`. Its SIGINT/SIGTERM handler currently resolves immediately WITHOUT awaiting an in-flight `indexVault` pass - so a signal during a flush kills the run mid-write. This is a real bug.
- The MCP server is stdio-only (no HTTP, no port). Multiple OSB instances against DIFFERENT vaults already work: the writer path in `Store.open` acquires a per-dbPath `proper-lockfile` lock (stale 60s) and a second writer on the same vault gets a typed `INDEX_LOCKED` error. => A `--port`/`--instance` daemon model from the upstream is NOT applicable to OSB's architecture and must NOT be fabricated.
- The SQLite store uses WAL; `Store.close()` consolidates the WAL (`PRAGMA wal_checkpoint(TRUNCATE)` then `journal_mode=DELETE`) and releases the lock, but only on an orderly close - a SIGTERM that bypasses close leaves an orphan `-wal` and a held lock.
- Schema migrations live in src/core/search/schema.ts: `LATEST_SCHEMA_VERSION` (currently 7) plus an ordered `MIGRATIONS` array of `{version, up}`. Bumping the version auto-migrates on the next write-mode open.
- Existing reusable primitives: `src/core/reliability/lock.ts` (async proper-lockfile wrapper), `src/core/brain/sync-lockfile.ts` (sync lock with a process-exit cleanup hook that unlinks held locks).

# Project context

- Open Second Brain - TypeScript, Bun runtime, SQLite (bun:sqlite), MCP server, `o2b` CLI, Obsidian/Markdown vault under `Brain/`.
- Recent suites shipped as cohesive versioned releases (v1.4 Grok, v1.5 Search & Recall Quality, v1.6 Vault Integrity & Trust, v1.7 Knowledge Provenance).
- Conventions: opt-in guardrail flags in config so behaviour is byte-identical when a feature is off; DRY shared primitives; strict TypeScript with NO `as` cast crutches (build values with the correct type via conditional spreads / narrowing guards); language-agnostic (no hardcoded natural-language word lists); provider-agnostic kernel (OSB never calls an LLM itself); no new heavy or ML dependencies; no misleading fallbacks (a feature that would silently no-op when its substrate is absent is forbidden - fail loud and typed instead).

# Constraints

- Do NOT add a redundant resumable-checkpoint mechanism for the already-resumable incremental path.
- Do NOT invent a --port/--instance daemon model; OSB is stdio and per-vault locking already isolates instances.
- No new external dependencies; reuse proper-lockfile and bun:sqlite.
- Cancellation must be cooperative (Bun SQLite is synchronous); never claim preemptive abort.
- The abort/deadline mechanism should compose with the existing `Safeguard`, not replace it (DRY).
- Resumable behaviour and graceful-shutdown grace windows should be controllable and default to current behaviour where they would otherwise change output shape.

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
