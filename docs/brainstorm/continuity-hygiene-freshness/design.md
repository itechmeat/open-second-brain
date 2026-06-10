# Continuity, Hygiene & Freshness Suite - design

**Status:** approved
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation
**Kanban:** t_d08ccc5a, t_a94623ad, t_05f5dc12, t_4cee9df5, t_698db8f7, t_da3f138f, t_db375a60, t_d9624ef6, t_fe490119

## Problem statement

Two structural gaps. First, Hermes rotates `session_id` on context compression while Open Second Brain keys the whole session subsystem on the flat id, so one logical conversation fragments into disconnected Brain sessions that `brain_session_expand` / `grep` / `describe` cannot stitch. Second, the Brain accumulates entropy with no remediation surface: near-duplicate memories, contradictory episodic facts, and pages derived from sources that changed or disappeared all persist silently, and over-budget recall items are truncated mid-sentence instead of degrading gracefully.

## Scope

Nine features in two clusters, structured around two new kernels (consultant Variant 2):

**Kernel 1 - session lineage (`src/core/brain/lineage/`)**
- A1 `t_d08ccc5a`: `HookPayloadBase` gains optional `parent_session_id` / `root_session_id` / `compression_depth` (the native path, ready for upstream Hermes PR #42940). `resolveSessionLineage()` is the single resolution point; the interim resolution for today's Hermes lives in one crutch file marked `CRUTCH(t_1459706f)`.
- A2 `t_a94623ad`: capture stamps lineage onto `session_turn` / `session_summary_node` continuity records (additive payload fields, no schema bump); session recall and the session-read tools key on the lineage root so any segment id returns the stitched conversation.
- A3 `t_05f5dc12`: `recall-budget.ts` grows a staged degradation ladder (sentence-boundary trim -> line extract -> hard cut), opt-in, default behavior byte-identical.
- A4 `t_4cee9df5`: an anticipatory context cache refreshed from existing hook events (no daemon, no watcher), written atomically, consumed cache-or-live by a new MCP tool / CLI verb.

**Kernel 2 - hygiene findings pipeline (`src/core/brain/hygiene/`)**
- B1 `t_698db8f7`: `scan` fans out over pure detectors and composes a digest; `apply` executes a typed remediation plan with an audit trail and a dry-run mode.
- B2 `t_da3f138f`: dedup detector - embedding cosine similarity (provider registry) with deterministic lexical fallback when embeddings are unavailable.
- B3 `t_db375a60`: conflict detector is deterministic; resolution consults an optional external resolver command via a shared command bridge extracted from `bench/judge.ts`; unresolved or unconfigured conflicts are flagged for review.
- B4 `t_d9624ef6`: freshness detector - pages declaring a `sources:` frontmatter contract (path + sha256 recorded at derivation) are reported `stale` when a source's current hash differs and `orphaned` when every source is gone. Computed on demand, no background jobs.
- B5 `t_fe490119`: targeted recompile - `o2b brain refresh --stale [--dry-run]` re-derives only pages whose owning sources changed and stages cleanup for orphans, skipping unrelated content.

**Shared**
- `src/core/reliability/command-bridge.ts`: the external-command JSON bridge (spawn, timeout, JSON stdin/stdout, fail-open) extracted from `bench/judge.ts`; `judge.ts` becomes a thin caller with unchanged behavior.
- New MCP tools (deliberate parity-list update): `brain_hygiene`, `brain_anticipatory_context`. Session tools gain additive optional lineage parameters only.
- New CLI verbs: `brain hygiene`, `brain refresh`, `brain anticipate`; additive `--lineage` flags on session verbs.
- New brain-config keys (one-level YAML blocks): `hygiene` (resolver_cmd, dedup_threshold), `anticipatory` (ttl_seconds, max_tokens), `recall` (degradation).

## Out of scope

- Hermes-side changes; removing the crutch (tracked separately in t_1459706f, gated on upstream PR #42940).
- File-watcher index sync (explicitly rejected by the brain-search design: no daemon, no watcher).
- Learning-to-rank / reinforce recall (separate kanban task, different release).
- Retrofitting every existing page writer with the `sources:` contract - only writers that already derive from on-disk artifacts (session import, handoff notes) stamp it in this release.
- Cross-vault hygiene; everything operates on the active vault.

## Chosen approach

Consultant Variant 2 ("two shared kernels"), accepted without override.

The lineage kernel exposes `resolveSessionLineage(hints, deps) -> { rootId, parentId, depth, source }` where `source` is `"payload" | "crutch" | "flat"`. The native path reads the three new optional payload fields. When they are absent, the crutch path consults a local lineage ledger (`Brain/state/session-lineage.jsonl`, append-only, fail-soft): capture records each session's first/last activity and compression-indicating events (PreCompact / pre-compact-extract activity, or a structured `end_reason`-style field when the payload carries one); a new session id links to a predecessor only when the predecessor (a) shares the same `cwd`, (b) ended with a compression indicator, and (c) its last activity falls within a bounded window. No indicator means no link - a conversation is never stitched on time proximity alone. Every crutch call site carries the `CRUTCH(t_1459706f)` marker. Missing lineage always degrades to flat-id behavior.

Recall stitching builds a root index from record payloads (plus the ledger) and filters session records by resolved root, falling back to exact-id filtering for flat sessions, so never-compacted sessions are byte-identical to today.

The hygiene kernel defines one detector contract: `(vault, deps) -> HygieneFinding[]` where a finding carries `detector`, `severity`, `targets`, `evidence`, and a `proposedAction` from a closed set (`merge` / `supersede` / `archive` / `recompile` / `review` / `forget`). `scan` is read-only composition; `apply` consumes an explicit plan (finding ids selected from a scan), executes via existing primitives (merge, archive, recompile entry points), appends audit records, and supports `--dry-run`. The conflict resolver and any future LLM-adjacent step go through the shared command bridge: deterministic detection in core, advisory external resolution, flag-for-review default.

## Design decisions

- **Lineage as additive payload fields, not a new record kind**: `session_turn` / `session_summary_node` records gain optional `parent_session_id` / `root_session_id` / `compression_depth` payload fields. Additive optional fields do not bump `o2b.continuity.v1`, and legacy records read as flat sessions.
- **Crutch never guesses on time alone**: a false stitch (two unrelated sessions merged) is worse than a missed stitch (status quo). The ledger links only on compression evidence + same cwd + bounded window.
- **Ladder defaults off**: `applyCharBudget` keeps its hard-cut default so every existing caller stays byte-identical; staged degradation is an explicit option wired through context-pack / pre-compress config. Stage boundaries are structural (sentence-terminator punctuation across scripts, line boundaries), never language-specific wordlists.
- **Anticipatory cache is hook-driven, TTL-guarded**: refresh runs inside existing hook handlers (prompt-submit / post-tool-use paths), skips when the cache is younger than the configured TTL (debounce without timers), writes via the atomic temp-file + rename pipeline, and the read path falls back to a live pack on miss or staleness. A broken cache never blocks the hook (fail-soft).
- **One MCP tool per kernel surface, not per feature**: `brain_hygiene` exposes scan/apply via a `mode` parameter; freshness, dedup, conflicts, and usefulness are detector selectors inside it. `brain_anticipatory_context` exposes the cache-or-live read. This keeps the parity-list delta at two and matches the mcp-context-economy direction.
- **`sources:` frontmatter is the freshness truth**: recorded at derivation time on the derived page itself (path + sha256), so freshness survives index rebuilds and is inspectable in the vault. The search index only caches freshness status for result metadata; the index stays rebuildable.
- **Recompile reuses derivation pipelines**: session-derived pages re-import from their recorded transcript source; index entries refresh via the existing incremental indexer. No new compilation engine; B5 is a planner + executor over existing entry points.
- **Command bridge is reliability infrastructure**: extraction from `bench/judge.ts` is a pure refactor (same spawn semantics, timeout, fail-open contract) proven by the existing judge tests before B3 builds on it.

## File changes

New modules:
- `src/core/brain/lineage/{types,resolve,ledger,crutch}.ts` (+ tests)
- `src/core/brain/hygiene/{types,scan,apply,plan}.ts`, `src/core/brain/hygiene/detectors/{conflicts,dedup,freshness,usefulness}.ts`, `src/core/brain/hygiene/resolve-conflicts.ts` (+ tests)
- `src/core/brain/anticipatory-cache.ts`, `src/core/brain/freshness.ts`, `src/core/brain/recompile.ts` (+ tests)
- `src/core/reliability/command-bridge.ts` (+ tests)
- `src/mcp/brain/hygiene-tools.ts`
- `src/cli/brain/verbs/{hygiene,refresh,anticipate}.ts` (paths per existing verb layout)

Modified:
- `hooks/lib/stdin.ts` (HookPayloadBase lineage fields), hook entry points that forward lifecycle events
- `src/core/brain/session-lifecycle.ts`, `src/core/brain/sessions/import.ts`, `src/core/brain/session-recall.ts`, `src/core/brain/handoff.ts` (sources stamp)
- `src/core/brain/recall-budget.ts`, `src/core/brain/context-pack.ts`, `src/core/brain/pre-compress-pack.ts`, `src/core/brain/context-presets.ts` (degradation option plumb)
- `src/core/brain/policy.ts` (config keys), `src/core/bench/judge.ts` (bridge extraction)
- `src/mcp/brain/recall-tools.ts`, `src/mcp/brain/pack-tools.ts`, `src/mcp/brain-tools.ts` (aggregation), MCP parity test (deliberate +2)
- CLI command manifest / completions / help-text, session verbs (lineage flags)
- `README.md`, `CHANGELOG.md`, `docs/mcp.md`, `docs/cli-reference.md`, `docs/architecture.md`

## Risks and open questions

- **Crutch precision**: compression indicators visible to our hooks differ between hosts (Claude Code fires PreCompact; Hermes may only show a rotated id). The conservative rule means Hermes sessions without a visible indicator stay flat - acceptable, documented, and exactly what t_1459706f later fixes natively.
- **Dedup cost**: embedding similarity over all memory pages is O(n^2) at the margin; bound the candidate set (same-topic / same-entity buckets via existing index) before pairwise comparison.
- **Hygiene apply safety**: every destructive action goes through the plan + audit + dry-run path; `forget` archives rather than deletes (vault pages are never unlinked from git history anyway).
- **Parity test churn**: +2 tools is a deliberate, reviewed surface change; the parity list update is its own commit trailer line in the implementation commit that adds the tools.
- **Sentence-boundary detection across scripts**: terminator set must cover Latin/CJK/Arabic punctuation structurally; covered by dedicated multi-script tests.
