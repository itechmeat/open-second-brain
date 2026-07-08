# Consultant prompt — memory-signal provenance and lifecycle integrity

You are a senior backend architect. Produce architectural variants for a single
shippable release of **Open Second Brain (o2b)**. Read the context below
carefully; every design MUST respect o2b's hard invariants.

## Output contract (MANDATORY)

Output EXACTLY three variant sections then ONE recommendation. No code. Nothing
outside these sections. Each variant:

```
### Variant N — <short name>
Approach: <2-3 sentences>
Trade-offs:
- <bullet>
- <bullet>
Complexity: small | medium | large
Risk: low | medium | high
```

Then exactly:

```
### Recommended: Variant N
<rationale, 3-5 sentences>
```

Do not add an introduction, summary, or closing.

## Project

- Name: `open-second-brain` (o2b), v1.25.0.
- Language/runtime: TypeScript, ESM, runs on Bun + Node. `type: module`.
- What it is: an Obsidian-native memory layer for AI agents. Plain Markdown in a
  vault (`Brain/` directory). Deterministic CLI + MCP tools. **The kernel calls
  no LLM** — this is a core, load-bearing invariant. All scoring, detection, and
  lifecycle logic is deterministic (counting, hashing, token overlap, date math).
- Conventions (hard): deterministic, byte-identical-when-off for any new field
  or switch; pure functions do the work, IO shells stay thin; everything is
  language-agnostic (no English wordlists; negation/similarity are structural
  token-overlap); additive optional fields absent by default; append-only claim
  ledger is never mutated — derived projections fold over it; privacy-preserving
  (no raw prompts, recalled text, or secrets); persistence via the continuity
  store (append-only, month-sharded JSONL under `<vault>/Brain/logs/continuity/`,
  reloaded on startup) or as Markdown frontmatter; config flags are explicit
  opt-in. Atomic writes via `writeFrontmatterAtomic` / `atomicWriteFileSync`.
  A no-op rerun must not rewrite files (keeps Syncthing peers quiet).
- SHA-256 is the hashing primitive (`createHash("sha256")`); the provenance
  module already owns `sourceIdentityHash(parts)` (one source path → one digest).
- Multi-runtime: Hermes, Claude Code, Codex, opencode, Aider, etc. all read/write
  the same Brain. Writes can be concurrent or retried across runtimes.

## The release problem

This release hardens **provenance and lifecycle integrity** across four
orthogonal axes the codebase is currently weak on, cohered by a shared theme:
provenance (where a signal came from and when), lifecycle (how it expires and is
reconciled), and integrity (deterministic dedup, safe preview, and surgical
cleanup). The 13 cards below are dependency-closed leaves that ship together on
one branch, driven one at a time. Several share files and several compose (the
content-hash manifest feeds the batch-plan planner; the idempotency key feeds the
batch checkpoint). The binding architectural question is: **how much shared
infrastructure to introduce up front (a manifest module, an idempotency-key
ledger, a dry-run wrapper) vs. how much to keep each card a self-contained
vertical** — and in what order to drive the cards so the shared-file collisions
and the hard composition edges serialize cleanly without coupling the p4 anchors
to the p2 capstones.

### Axis A — provenance: source identity & event-time (4 cards)

#### Card A1 — `t_c5184fd8` (p4): content-hash skip-unchanged manifest
OSB already computes SHA-256 for source *identity* (`sourceIdentityHash` in
`src/core/brain/provenance/provenance.ts:91`) but has no content-hash skip-
unchanged manifest, so re-ingest is driven by mtimes/index revision, not byte
content — a `git checkout`/NFS touch forces re-ingest. Requirement: a content-
hash cache so re-ingest is driven by content changes: `cache-check` classifies
paths new/modified/unchanged/missing vs a `.manifest.json`; `cache-update`
records post-ingest hashes; `cache-hash` SHA-256s a file or dir tree. Reuse the
existing sha256 primitive; the new artifact is the per-source content-hash
manifest + classify step, distinct from identity dedup. Sequence A1 BEFORE the
batch-plan task (A3) so parallel ingest can skip unchanged sources. Consumer:
`src/core/brain/ingest/ingest.ts`. Change-watching is keyed on index revision
today (`src/core/brain/ingest/`).

#### Card A2 — `t_7526e8d3` (p4): per-row event-time on the batch remember/import API
OSB has the bi-temporal *concept* on the read-side/types
(`src/core/brain/signal.ts` `readBiTemporalSlots()` reads optional
`valid_from`/`valid_until`/`recorded_at`; `src/core/brain/reconcile-domains.ts`
uses `recorded_at if present else created_at`). But the WRITE side is weaker:
`WriteSignalInput` (`src/core/brain/signal.ts`) exposes only `created_at`/`date`
— no `valid_from`/`valid_until`/`recorded_at`, so no caller can set the original
event-time. Session-import discards the source turn time:
`src/core/brain/sessions/import.ts` stamps `const now = opts.now ?? new Date()`
and `created_at: isoSecond(now)` even though `SessionTurn.timestamp` already
carries the original turn's ISO-8601. Requirement: (1) add optional
`valid_from`/`recorded_at` (and/or `event_time`) fields to `WriteSignalInput`
that flow into frontmatter the read-side already parses; (2) have `import.ts`'s
`emit` prefer the turn's `SessionTurn.timestamp` for `created_at`/event-time,
falling back to `now` only when absent. Keep fields additive/optional so existing
signals stay byte-identical. Guard against future-dated or unparseable turn
timestamps during backfill.

### Axis B — ingest parallelism (2 cards, parent→child)

#### Card A3 — `t_9eeb8ca2` (p2): batch-plan step to split large-folder ingest
A `batch-plan <vault> <source-dir>` step that discovers ingestible files, skips
unchanged via the content-hash cache (A1), and splits the remainder into
size+count-bounded batches that ingest dispatches as parallel subagents for large
directories. Today ingest handles sources one at a time (`src/core/brain/ingest/
ingest.ts`, per-source, agent-driven); the only bounded-batch primitive is for
context, not ingest (`runPinnedContextBatch` in `src/mcp/brain/context-
tools.ts`). **Depends on A1** (the content-hash manifest). Sequence A1 before A3.

### Axis C — write idempotency & lifecycle (6 cards)

#### Card C1 — `t_213f356b` (p3): idempotent feedback/signal writes via client idempotency keys
OSB is multi-runtime and feedback writes are file-appending Markdown; a retried
or double-delivered tool call can append a duplicate signal, and slug collisions
from genuinely different content are silently merged. Today dedupe is implicit
via `deriveSlug` (`src/mcp/brain/feedback-tools.ts`), not an explicit client key.
Requirement: an optional idempotency-key parameter on the write tools
(`brain_feedback`, `writeSignal`/`writePreference`/`appendApplyEvidence`) plus a
lightweight seen-key ledger (keyed by key → content hash) under `Brain/`; reject
reuse of the same key with a different payload (explicit error, not silent
overwrite). Keep the kernel deterministic (no LLM). This C1 ledger is the natural
dedup substrate for the batch checkpoint (C4) and the event-time backfill (A2).

#### Card C2 — `t_2c6cf3e2` (p3): dry-run extraction preview
OSB's extraction surfaces (`pre_compact_extract`, `derive_fact`, ingest) are
write-committing and fail-fast by design — there is no safe way to preview what
extraction will capture before it mutates `Brain/`. Requirement: a dry-run/preview
path that short-circuits ALL continuity-append writes (vault mutation, log events,
dream/retire triggers) while reusing the EXACT extraction logic, so preview output
faithfully predicts real extraction. Enables prompt/threshold tuning, eval
harnesses, operator review of low-confidence captures without polluting the vault,
and gives smoke-tests a non-destructive assertion target. Key files:
`src/core/brain/pre-compact-extract.ts` (calls `appendContinuityRecord`),
`src/core/brain/sessions/import.ts` (already has an `opts.dryRun` pattern to
mirror).

#### Card C3 — `t_92317f91` (p3): bounded verbatim last-N-turns buffer surviving compaction
After a compaction OSB only retains summarized/extracted forms (active.md,
pre-compact extract, session summary); the exact recent wording is lost.
Requirement: a small, bounded verbatim buffer of the last N conversation turns,
auto-captured each turn and preserved across host compaction, readable on demand
(and optionally re-surfaced right after a compaction). Must stay strictly bounded
and clearly separated from curated memory so it does not become verbatim hoarding
— ephemeral short-term scaffolding with a hard cap on N; surfacing post-compaction
is optional/opt-in. Searches for turn-history / conversation-history / last-n-turns
in `src/` returned ZERO matches today.

#### Card C4 — `t_1a3a9eba` (p3): batch checkpoint save for whole sessions
OSB captures session summaries and individual signals, but session-close ingestion
can involve several writes with partial-write states. Requirement: a batch
checkpoint tool that saves a whole session's extracted memories, decisions,
learnings, and optional diary/summary in ONE idempotent MCP round-trip. Define
idempotency around session id + content hash. If some writes need review, the
checkpoint reports a mixed result rather than silently dropping items. Session
summary write/get/list exists at `src/mcp/brain/synthesis-tools.ts`; learning
staging at `src/mcp/brain/feedback-tools.ts`. **Composes C1's idempotency-key
ledger** as the dedup substrate.

#### Card C5 — `t_a82b674e` (p3): caller-settable per-memory expiration date
OSB callers cannot time-box a memory: an agent that learns a deadline-bound rule
("use the staging endpoint until 2026-07-15") has no way to say when it should
stop applying — only dream's stale/rebutted heuristics can eventually retire it.
Requirement: an optional ISO `expiration_date` on
`WritePreferenceInput`/signal writes, honored by the read path and by dream;
default search/list silently drop anything past its date unless an opt-in
`showExpired` flag is set. Orthogonal to dream's heuristic retirement (an
expired-by-date memory need not move to `Brain/retired/` — it can simply be
filtered, preserving audit trail). `writePreference` is in
`src/core/brain/preference.ts`; retirement is dream-driven (`planAutoRetires` in
`src/core/brain/dream.ts`, reasons in `BRAIN_RETIRED_REASON`).

#### Card C6 — `t_edde2198` (p3): delete and search by exact source file
When benchmark files, logs, or accidental imports pollute a Brain, operators need
to find and surgically remove everything derived from a source without re-mining
the whole vault or manually chasing index artifacts. Requirement: exact
`source_file` filtering on search + a dry-run-by-default deletion/cleanup command
that removes all derived entries for a contaminated source file, including index
entries. Dry run MUST report blast radius first. Writes auditable; must NOT delete
original user notes unless explicitly requested.

### Axis D — intellectual-honesty detection (3 cards, parent→child)

#### Card D1 — `t_4678a91a` (p4): signed source-diversity grounding score
The entity-truth ledger marks a slot CONTESTED (binary,
`resolution: ask_user`, never auto-resolved) when independent sources disagree
within a window (`src/core/brain/truth/conflicts.ts` `withinWindow`/
`CONFLICT_WINDOW_DAYS`). But CONTESTED is binary and confidence is unsigned bands
(high/medium/low, `src/core/brain/page-meta/confidence.ts`). It cannot say WHICH
side of a contest carries more independent support, nor distinguish "agreed by 1
source" from "agreed by 10". Requirement: a signed grounding score on a
−1.0..+1.0 scale, computed from the balance of confirming vs contradicting
evidence across INDEPENDENT sources (not raw mention count), weighted by
relationship strength, plus a separate confidence/sufficiency dimension. Labels
the band (Strongly supported → Mixed → Contested → Contradicted) and weights N
mentions in one document far below N mentions across N independent sources.
Deterministic (counting + weighting, no LLM). Derives from the append-only claim
ledger (`ClaimEvent` carries independent `source` + `agent` provenance); do NOT
mutate history — compute as a projection alongside the existing fold
(`src/core/brain/truth/fold.ts` `computeTruthState`). Source-diversity weighting
(independent sources > repeated mentions) is the part o2b lacks entirely.

#### Card D2 — `t_11e3db8b` (p3): note-position contradiction detection over prose
o2b detects contradictions only across confirmed preferences
(`src/core/brain/health/contradiction.ts` `detectContradictions`) and across fact
claim-slots (`computeTruthStateWithConflicts`). Neither surfaces the operator's
own contradictory *positions* held across note prose. Requirement: extend
contradiction detection to pair same-subject permanent notes that assert opposite
stances, quote the relevant span from each, and surface them as a reviewable
clarification prompt (ask_user), never auto-resolving. Reuse the language-agnostic
token-overlap + sign machinery (`similarity.ts`) but derive position-sign from
note prose rather than evidence signals; touch `src/core/brain/health/
contradiction.ts`. **Parent of D3.**

#### Card D3 — `t_74d29363` (p2): declared-thesis register with new-note monitor
o2b tracks preference contradictions and fact conflicts but has NO register of
operator-declared theses, and nothing evaluates each new note against standing
positions. Requirement: a declared-thesis register (statement, supporting
evidence, counter-evidence, last-updated) plus a monitor that flags newly-
ingested notes that support or contradict an active thesis — distinct from
D2 (this is incoming-note-vs-declared-position monitoring). Includes a staleness
check (reuse the cadence/obligation machinery `obligations.ts` for "not updated
in N days"), thesis-graveyard pass (flag theses with no supporting evidence in N
days for formal closing), and a per-thesis falsification field ("what would make
me wrong") monitored so the register alerts when incoming evidence matches the
documented failure scenario. Suppress mere added-complexity per the article.
**Child of D2** (both touch `src/core/brain/health/contradiction.ts`; D3 is the
specific incoming-note monitor on top of D2's note-position base).

### Axis E — runtime lifecycle (1 card)

#### Card E1 — `t_1c894c19` (p4): session-bracketing memory wrapper for Aider
OSB's Aider adapter (`src/core/install/adapters/aider.ts`) is a deliberate static
sidecar because "Aider has no native MCP client" — it covers the load half via a
regenerated one-time snapshot (`o2b install --target aider --apply`) but has NO
per-session capture/write-back loop for Aider. Requirement: scope a wrapper-based
bracketing mode that reuses the Hermes `prefetch`/`sync_turn` lifecycle shape
(load relevant memory at session start, persist the session back at session end),
implemented as a CLI wrapper process around Aider (since MCP/hooks aren't
available — the mechanically hard part Hindsight solved). Keep the static sidecar
as the fallback for users who don't run through the wrapper. The Hermes provider
shape to mirror is `plugins/hermes/provider.py` `prefetch()`/`sync_turn()`/
`on_session_end()`.

## Cross-cutting constraints (apply to every variant)

- **No LLM in any kernel logic.** Every score, detector, planner, and lifecycle
  rule is deterministic (hashing, token overlap, date math, counting).
- **Byte-identical-when-off / absent.** Any new optional field or switch must be
  absent by default so existing files and outputs stay byte-identical.
  Additive-only on `WriteSignalInput`/`WritePreferenceInput`.
- **Append-only ledger is never mutated.** D1's grounding score is a derived
  projection; truth history is never rewritten.
- **Shared-file collisions must be serialized by drive order.** Known collisions:
  - `src/core/brain/health/contradiction.ts` — D2 (note-position base) + D3
    (thesis monitor).
  - `src/core/brain/signal.ts` `WriteSignalInput` — A2 (event-time fields).
  - `src/core/brain/sessions/import.ts` — A2 (emit turn time) + C2 (dry-run).
  - `src/core/brain/truth/{fold,conflicts}.ts` — D1 (grounding projection).
  - `src/core/brain/ingest/ingest.ts` — A1 (manifest) + A3 (batch-plan).
- **Hard composition edges:**
  - A1 → A3 (batch-plan consumes the content-hash manifest).
  - C1 → C4 (checkpoint reuses the idempotency-key ledger).
  - D2 → D3 (thesis monitor builds on the note-position detector).
- **No silent overwrite or silent drop.** Idempotency-key mismatch is an explicit
  error; checkpoint mixed-result is reported; C6 dry-run reports blast radius.
- **Cards are driven ONE AT A TIME on the shared branch `feat/memory-signal-
  provenance-lifecycle`**; each worker builds on prior commits and must not
  duplicate sibling work. The variant's drive order must resolve every shared-file
  collision and honor every hard dependency.

## Recent git history (context for conventions)

```
fe2c0be2 feat(brain): context-pack economics and observability (1.25.0) (#126)
1cde572f fix(brain): harden reindex swap, self-heal, hot paths, and continuity contracts (1.24.0) (#125)
998e437f fix(windows): resolve 3 compatibility issues on Windows (#123)
ce5d5655 fix(windows): normalize vault path and resolve o2b command (#122)
67bcb71c refactor: DRY and decomposition (Phases 0-2) (#121)
b9bbcb16 feat(brain): semantic entity dedup and cross-encoder rerank (1.23.0) (#120)
b8d709ee fix: keep full MCP status output and normalize codegraph paths (#116)
a98bed1d feat(brain): retrieval precision and quality loop (v1.22.0) (#118)
42816058 feat(brain): integrity & safety hardening suite (1.21.0) (#115)
313d061e feat: configurable skills_dir + trigger-keyword auto-attach scoring (#114)
a3ea3151 fix: v1.19.1 - cross-vault cards, event-trace exit codes, registry-guard hygiene (#113)
bb5f3201 feat(brain): session-boundary capture durability and post-compaction pinned-anchor survival audit (v1.19.0) (#112)
33b4fba5 feat(brain): recall precision, coverage, and provenance hardening (v1.18.0) (#110)
da2e3ccd feat(brain): memory subsystem alignment - honest pinned budgets, atomic batch writes, on_memory_write host bridge (v1.16.0) (#107)
```

Now produce the three variants and the recommendation.
