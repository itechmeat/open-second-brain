# Design — Context-pack memory-economics & observability

Branch: `feat/context-pack-economics-observability`
Slug: `context-pack-economics-observability`
Cards: C1 `t_affa3bd9`, C2 `t_6c9a3e5c`, C3 `t_a8926bd0`, C4 `t_dfda8adb`, C5 `t_f2140bae`

## Problem

Releases v1.18–v1.23 repeatedly improved recall *precision* (coverage, rerank,
entity dedup, epistemic provenance, cross-encoder rerank) with **zero gain in
measuring the value that precision delivers**. o2b can enforce token/char budgets
and record recall/gate telemetry, but it cannot answer five distinct operational
questions that are now the binding constraint on further precision work:

1. **Is the context pack shipping the densest signal per token?**
   `context-pack.ts` orders candidates by tier → recency → id and fills the token
   budget greedily. As the vault grows this fills the budget with recent-but-
   low-value entries and skips denser high-signal ones (`pagesSkipped` overflow of
   important content). There is no per-item density/impact score.
2. **Which MCP route is slow?** o2b records latency for generation reports and
   memory benchmarks, but not per-MCP-route. When a specific tool blocks a turn,
   the operator has only aggregate numbers, not an endpoint breakdown.
3. **How many prompt tokens did the memory layer actually keep out of (or add to)
   the agent call?** Budget code enforces limits; nothing measures the realized
   prompt-token delta per context pack. The core value-of-memory metric is absent.
4. **Is the active-memory body near its budget before it silently truncates?**
   `active-budget.ts` truncates the `active.md` injection REACTIVELY at render
   time. Content disappears with a notice; there is no proactive fill-rate signal
   and no named eviction candidates.
5. **Did this recall sample lead to a first-pass success or force repair/retries?**
   Brain records per-preference `outcome` via `brain_apply_evidence`, but nothing
   closes the loop on *recall quality*. Recall precision stays a guessed metric.

This release closes the gap with five deterministic, independently-shippable
signals that REUSE existing budget/telemetry machinery.

## Scope

All five cards ship in this release, driven one at a time on the shared branch:

- **C2** `t_6c9a3e5c` (p4) — route-level latency metrics for MCP tools.
- **C1** `t_affa3bd9` (p4) — value-per-token density ranking in context-pack.
- **C3** `t_a8926bd0` (p3) — durable token-impact + context-pack-quality ledger
  (tokenizer-exact, exact-vs-modeled separation, persisted, reload-on-startup).
- **C4** `t_dfda8adb` (p3) — proactive active-memory budget-pressure watermark +
  ranked eviction candidates.
- **C5** `t_f2140bae` (p2) — agent-operable context-pack outcome loop (carries
  sample id; posts measured/modeled/observed outcome rows on completion).

## Out of scope

- A web dashboard (o2b has none; every new signal ships as CLI/MCP readers).
- Any LLM inside kernel logic. Every new score, metric, and threshold is
  deterministic (byte/section/token counting, structural heuristics).
- A server-managed shared control plane, hosted "Spaces", per-agent billing
  tokens, or anything that sends vault content off-host.
- The capture-once projection unification refactor (`t_b4297898`, p2) — left in
  triage as a future generalization path; this release composes existing surfaces
  rather than refactoring them.
- Migrating existing JSONL or stored Markdown. New ledger kinds are additive; old
  continuity records are read as-is (v1 schema contract).
- Auto-deletion of any vault content. C4 eviction entries are suggestions only.

## Chosen approach

**Variant 3 — thin shared kernel, parallel modules, priority-ordered drive.**

Extend `ContinuityRecordKind` with the new kinds in one small commit and
introduce one tiny shared list/summarize helper that each card's reader composes,
while keeping every card's pure logic in its own module behind its own gate.
This captures exactly the reuse the codebase already rewards —
`emitGatedTelemetry`'s fail-open no-work-when-off contract, the continuity
store's append/list model, and the `sessionFocus` within-tier-boost precedent
that makes C1's density score byte-identical when disabled — without either
fragmenting the reader surface into five near-duplicate triplets (Variant 1) or
front-loading the largest, highest-schema-risk card behind a premature shared
spine that couples the quick p4 wins to it (Variant 2).

Each card lands as a self-contained module behind its own explicit switch whose
off-branch is provably byte-identical to today. The only hard dependency is
C3 → C5 (the outcome loop writes into C3's ledger).

### Drive order: C2 → C1 → C3 → C4 → C5

Resolves both real shared-file collisions:
- **C1 → C3** (both touch `context-pack.ts`): C1 adds the density comparator to
  the within-tier sort (the `candidates.sort(...)` region); C3 adds the
  token-impact emit to `finalizeContextPackReport`. Disjoint regions, sequenced.
- **C2 → C3 → C5** (all touch `continuity/types.ts`): the new `ContinuityRecordKind`
  additions serialize cleanly in drive order.
- **C3 → C5** (hard dependency): C5 composes C3's ledger emit API.

## Design decisions

### Shared kernel (lands in the C2 commit, reused by C3/C5)
- `src/core/brain/continuity/types.ts` — add new kinds: `mcp_route_latency`
  (C2), `token_impact` (C3), `context_pack_outcome` (C5). Additive; legacy records
  read as v1 (schema-stamp contract). C1 and C4 add NO new continuity kind — they
  are pure ordering/health modules.
- `src/core/brain/continuity/readers.ts` (new, tiny) — one shared
  `listRecordsByKind(vault, kind, filter)` + `summarizeCounters(records, keys)`
  helper each card's reader composes, eliminating 5× list/filter/reverse/limit
  boilerplate. Pure, deterministic. No schema coupling — each card owns its own
  payload shape.
- Every emitter routes through `emitGatedTelemetry` so a broken/absent option is
  a no-op (fail-open), identical to `recall-telemetry`/`generation-reports`.

### C1 — value-per-token density (t_affa3bd9)
- New pure module `src/core/brain/context-density.ts` exporting
  `densityScore(item, tokens)` → number, computed from structural signals already
  on the candidate (signal markers, `evidenceRefs` count/wikilink density,
  evidence weight) divided by `estimateTokens(body)`. Language-agnostic by
  construction (no wordlists — same approach as `deriveEpistemicStatus`).
- `context-pack.ts`: add `densityRanking?: boolean` to `ContextPackOptions`. When
  true, insert a density comparator INTO the existing within-tier sort, AFTER
  `sessionFocus` (which already occupies the between-tier-and-recency slot): the
  full chain becomes tier → sessionFocus → density → recency → id. Compute a
  `densityScore` per candidate into a map (0 for every candidate when disabled →
  the map is empty and the sort is byte-identical to today). Focus dominates
  density so a static content-quality heuristic can never override the user's
  active session target; density only breaks focus ties, then recency → id. Tier
  remains the coarse gate; a peripheral page can never outrank a core one.
- No new continuity kind; the score is computed, not persisted. Density MAY be
  surfaced as an optional field on `ContextPackItem` (absent when off →
  byte-identical).

### C2 — MCP route-level latency (t_6c9a3e5c)
- New module `src/core/brain/mcp-route-latency.ts`: `emitRouteLatency(vault,
  {tool, durationMs, status, argShapeHash?})` → `ContinuityRecord` of kind
  `mcp_route_latency`. Payload records tool name, duration, status, and an
  OPTIONAL argument-shape hash (structural — `createHash` over the arg keys/types,
  never values) — never raw prompt or note content. `listRouteLatency` /
  `summarizeRouteLatency` compose the shared reader.
- `src/mcp/tools.ts`: wrap `ToolDefinition.handler` in `buildToolTable` with a
  timing+status collector that emits one `mcp_route_latency` record per call.
  Gated by a config flag (`mcp_route_latency_enabled`, default false) so
  unconfigured deployments are byte-identical and write nothing. On emission
  failure the tool result is unchanged (fail-open).

### C3 — durable token-impact + quality ledger (t_a8926bd0)
- New module `src/core/brain/token-impact-ledger.ts`:
  - `emitTokenImpact(vault, {packReceiptId, exactTokens, modeledAvoidance?,
    counterfactual?, basis})` where `basis: "tokenizer_exact" | "fallback_est"`
    labels honesty (when a real tokenizer is unavailable, basis is
    `fallback_est` and the value comes from `estimateTokens`).
  - Strict separation enforced in the payload schema: `exact.prompt_token_delta`
    vs `modeled.inference_avoidance` (confidence-banded counterfactual, e.g.
    retries/repairs avoided) are never merged.
  - Persisted via continuity store → reloaded on startup (existing
    list-by-kind reader), bounded by the store's month-shard + redaction.
- An outcome-calibration endpoint (CLI/MCP `brain_token_impact_outcome`) lets the
  agent post first-pass/repair/retry outcomes to recalibrate the modeled band —
  this is the passive endpoint C5's loop writes into.
- `context-pack.ts` `finalizeContextPackReport`: when a new opt-in flag is set,
  emit one `token_impact` record with the tokenizer-exact delta of the packed
  body vs an un-packed baseline. Default-off → no record, byte-identical.

### C4 — active-memory budget-pressure watermark (t_dfda8adb)
- New pure module `src/core/brain/active-budget-pressure.ts`:
  `computeActiveBudgetPressure(body, budgetChars)` → `{fillRate, status:
  "healthy"|"elevated"|"critical", candidates: Array<{sectionKey, bytes,
  priority}>}`. Reuses `SECTION_PRIORITIES` from `active-budget.ts` (extracted to
  a shared constant if not already) and the same section-split logic.
- "Empty output = healthy": when `fillRate` is at or below the warn threshold
  (a constant owned by the new `active-budget-pressure.ts` module, not a
  pre-existing symbol), the probe emits nothing on the `doctor` surface (quiet on
  healthy vaults). Above threshold it
  lists ranked eviction CANDIDATES (highest-priority-to-drop first) as
  suggestions — never auto-deleted.
- Distinct term "active budget pressure" — NOT the `WatermarkState` cursor in
  `skill-proposals.ts`. Surfaced through `doctor.ts` (new check) and the hygiene
  surface.

### C5 — agent-operable context-pack outcome loop (t_f2140bae)
- New module `src/core/brain/context-pack-outcome.ts`:
  `emitContextPackOutcome(vault, {sampleId, firstPassSuccess, repairRequired?,
  retryCount?, followUpTokens?, providerTokens?, tokenSignal})` where
  `tokenSignal` is one of `exact` | `modeled` | `observed`, keeping the three
  token signals strictly separate (never merged into one field).
- Composes C3's ledger: writes a `context_pack_outcome` continuity record AND
  posts to C3's calibration endpoint so the modeled band tightens. Compact
  counters only; agent omits a field rather than inventing it.
- The agent carries the latest sample id as bounded local state (carried in the
  context-pack report/receipt, not a new daemon). On completion it posts the
  outcome row. Sequenced AFTER C3 (hard dependency).

## File changes (summary; per-card detail in plan.md)

- `src/core/brain/continuity/types.ts` — 3 new `ContinuityRecordKind` entries.
- `src/core/brain/continuity/readers.ts` — NEW shared list/summarize helper.
- `src/core/brain/context-density.ts` — NEW (C1).
- `src/core/brain/mcp-route-latency.ts` — NEW (C2).
- `src/core/brain/token-impact-ledger.ts` — NEW (C3).
- `src/core/brain/active-budget-pressure.ts` — NEW (C4).
- `src/core/brain/context-pack-outcome.ts` — NEW (C5).
- `src/core/brain/context-pack.ts` — density comparator (C1) + token-impact emit
  in finalize (C3).
- `src/core/brain/active-budget.ts` / `doctor.ts` — C4 pressure check + candidate
  listing.
- `src/mcp/tools.ts` — latency wrapper in `buildToolTable` (C2); new MCP/CLI
  readers for C2/C3/C5 summaries.
- Tests under `tests/core/brain/` and `tests/mcp/` per card (TDD).
- `CHANGELOG.md`, `docs/observability.md` — document the new signals.

## Risks

- **Byte-identity regression (C1).** A density comparator that fires by default
  reorders every pack and breaks the determinism contract. Mitigation:
  default-off flag; when off the score map is empty and the sort is identical to
  today; a dedicated bit-identity test (pack with flag off == pack without the
  flag at all).
- **Shared-file conflict (C1+C3 in `context-pack.ts`).** Mitigation: drive order
  C1 → C3 touches disjoint regions (sort vs finalize); each card pulls before
  starting.
- **Privacy leak via latency/argument logging (C2).** Mitigation: record tool
  name/duration/status + arg-shape hash over KEYS only, never values; redaction
  through the continuity store's `safeContinuityPayload`; default-off flag.
- **Overclaiming token savings (C3/C5).** Mitigation: strict exact-vs-modeled
  separation in the payload schema; honest `basis` label; modeled values are
  confidence-banded; the three token signals in C5 never merge.
- **Name clash with `WatermarkState` (C4).** Mitigation: distinct term "active
  budget pressure"; grep guard in tests.
- **Schema churn coupling.** Variant 2's risk, avoided here: each card owns its
  payload shape; the shared kernel is only list/summarize plumbing.
