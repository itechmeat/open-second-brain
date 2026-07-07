# Implementation plan — Context-pack memory-economics & observability

Branch: `feat/context-pack-economics-observability`. Cards are driven ONE AT A
TIME on this shared branch. Each worker MUST `git pull` / build on the commits
previously-driven in-scope cards already landed, and must not duplicate or
conflict with sibling tasks. Follow TDD: write the failing test first.

Combined design: `docs/brainstorm/context-pack-economics-observability/design.md`.
Drive order: **C2 → C1 → C3 → C4 → C5**.

In-scope cards (ship together in this one release):
- `t_6c9a3e5c` (C2, p4) — route-level latency metrics for MCP tools
- `t_affa3bd9` (C1, p4) — value-per-token density ranking in context-pack
- `t_a8926bd0` (C3, p3) — durable token-impact + context-pack-quality ledger
- `t_dfda8adb` (C4, p3) — proactive active-memory budget-pressure watermark
- `t_f2140bae` (C5, p2) — agent-operable context-pack outcome loop

---

## C2 — `t_6c9a3e5c` — Route-level latency metrics for MCP tools (driven first)

### Files
- `src/core/brain/continuity/types.ts` — add `mcp_route_latency` to
  `ContinuityRecordKind`. (Shared-kernel commit; also lands the
  `token_impact` + `context_pack_outcome` kinds so C3/C5 don't re-touch this
  file.)
- `src/core/brain/continuity/readers.ts` — NEW shared
  `listRecordsByKind(vault, kind, filter)` + `summarizeCounters(records, keys)`
  helpers (pure, deterministic; composes the continuity store's existing
  month-shard list + reverse/limit/filter).
- `src/core/brain/mcp-route-latency.ts` — NEW.
  `emitRouteLatency(vault, {tool, durationMs, status, argShapeHash?})` →
  `ContinuityRecord` (kind `mcp_route_latency`); `listRouteLatency(vault,
  filter)`; `summarizeRouteLatency(vault, filter)` (top slow tools, p95-ish
  counters, by status). Payload: tool name, duration_ms, status, optional
  arg-shape hash over KEYS only (structural), never raw prompt/note content.
  Redaction through `safeContinuityPayload`.
- `src/mcp/tools.ts` — in `buildToolTable`, wrap each `ToolDefinition.handler`
  with a timing+status collector emitting one `mcp_route_latency` record per
  call. Gated by config flag `mcp_route_latency_enabled` (default false). On
  emission failure the tool result is unchanged (fail-open).
- `src/mcp/...` (or CLI `o2b`) — add a reader verb exposing the summary.
- `tests/core/brain/mcp-route-latency.test.ts` + `tests/mcp/tools-latency.test.ts`.

### Acceptance (passing test)
A test in `tests/mcp/tools-latency.test.ts` that:
1. With `mcp_route_latency_enabled=false`, calling a tool produces byte-identical
   output and writes NO `mcp_route_latency` record (bit-identity + zero-write
   guard).
2. With the flag true, calling a slow tool emits one record with the correct
   tool name, a positive duration, and status; the summary reader returns it;
3. Asserts the payload contains NO argument VALUES (only a key-shape hash at
   most) — a redaction/privacy assertion.

### Depends on
None. Isolated in `tools.ts`. Driven first (opens the shared-kernel commit).

---

## C1 — `t_affa3bd9` — Value-per-token density ranking in context-pack

### Files
- `src/core/brain/context-density.ts` — NEW. `densityScore({body, evidenceRefs,
  topic, principle}, tokens)` → number; computed from structural signals
  (evidence-ref/wikilink density, signal markers) per estimated token.
  Language-agnostic (no wordlists; same construction as
  `deriveEpistemicStatus`). Pure, deterministic.
- `src/core/brain/context-pack.ts` — add `densityRanking?: boolean` to
  `ContextPackOptions`. When true, compute a `densityScore` per candidate into a
  `densityScore` map and insert a density comparator INTO the existing
  `candidates.sort(...)`, AFTER `sessionFocus` (full chain: tier → sessionFocus
  → density → recency → id; map empty → default sort byte-identical). Tier stays
  the coarse gate; tie-break recency → id. Optionally add `density?` to `ContextPackItem`
  (absent when off → byte-identical).
- `tests/core/brain/context-density.test.ts` + extend `context-pack` ordering
  tests.

### Acceptance (passing test)
A test in `tests/core/brain/context-pack.test.ts` (or density test) that:
1. Asserts the pack with `densityRanking` OFF is byte-identical to a pack with
   the option absent entirely (the bit-identity guard);
2. With `densityRanking` ON, a denser lower-recency entry ranks above a sparser
   recent one WITHIN the same tier;
3. Asserts a peripheral page NEVER outranks a core page regardless of density
   (tier remains the coarse gate).

### Depends on
None (orthogonal). Driven second. NOTE: this card touches the
`candidates.sort(...)` region of `context-pack.ts`; C3 (later) touches the
`finalizeContextPackReport` region — disjoint, but pull before starting.

---

## C3 — `t_a8926bd0` — Durable token-impact + context-pack-quality ledger

### Files
- `src/core/brain/token-impact-ledger.ts` — NEW.
  `emitTokenImpact(vault, {packReceiptId, exactTokens, modeledAvoidance?,
  counterfactual?, basis})` where `basis: "tokenizer_exact" | "fallback_est"`.
  Strict schema separation: `exact.prompt_token_delta` vs
  `modeled.inference_avoidance` (confidence-banded) never merged. Persisted via
  continuity store (kind `token_impact`, added in the C2 shared-kernel commit),
  reloaded on startup through the shared reader.
- `src/core/brain/context-pack.ts` — in `finalizeContextPackReport`, when a new
  opt-in flag is set (`token_impact_ledger_enabled` / option), emit one
  `token_impact` record: tokenizer-exact delta of the packed body vs an
  un-packed baseline, with `basis` set honestly. Default-off → no record,
  byte-identical.
- CLI/MCP `brain_token_impact_outcome` — outcome-calibration endpoint: posts
  first-pass/repair/retry outcomes to recalibrate the modeled band (the passive
  endpoint C5 writes into). Reader `summarizeTokenImpact(vault, filter)`.
- `tests/core/brain/token-impact-ledger.test.ts`.

### Acceptance (passing test)
A test in `tests/core/brain/token-impact-ledger.test.ts` that:
1. Emits a token_impact record with `basis: "tokenizer_exact"` and asserts exact
   and modeled fields are stored SEPARATELY (no merged field);
2. Emits with `basis: "fallback_est"` and asserts the fallback label is present;
3. Asserts the record survives a reload (persisted, listable) and contains NO
   raw prompt/recalled text (privacy assertion);
4. With the flag off, `finalizeContextPackReport` writes no record (bit-identity).

### Depends on
C2's shared-kernel commit (the `token_impact` kind + shared reader). Driven
third.

---

## C4 — `t_dfda8adb` — Proactive active-memory budget-pressure watermark

### Files
- `src/core/brain/active-budget-pressure.ts` — NEW.
  `computeActiveBudgetPressure(body, budgetChars)` → `{fillRate, status:
  "healthy"|"elevated"|"critical", candidates: Array<{sectionKey, bytes,
  priority}>}`. Reuses `SECTION_PRIORITIES` from `active-budget.ts` (extract to a
  shared constant in `text-budget.ts` or `active-budget.ts` if not already
  exported) and the same section-split logic.
- `src/core/brain/active-budget.ts` — export `SECTION_PRIORITIES` (and the
  split helper if shared) for reuse; no behavior change.
- `src/core/brain/doctor.ts` — add a proactive pressure check: when `fillRate`
  exceeds the warn threshold, list ranked eviction CANDIDATES (highest-priority-
  to-drop first) as suggestions; "empty output = healthy" (quiet on healthy
  vaults). Never auto-deletes.
- `tests/core/brain/active-budget-pressure.test.ts`.

### Acceptance (passing test)
A test in `tests/core/brain/active-budget-pressure.test.ts` that:
1. With `fillRate <= threshold`, `status` is `healthy` and the doctor check emits
   NOTHING (quiet-on-healthy contract);
2. With a body over budget, `status` is elevated/critical and candidates are
   returned ranked by drop-priority (retired before confirmed);
3. Asserts the term "active budget pressure" / does NOT collide with
   `WatermarkState` in `skill-proposals.ts` (grep guard);
4. Asserts no vault content is mutated (suggestions only).

### Depends on
None. Driven fourth. (If `SECTION_PRIORITIES` extraction touches
`active-budget.ts`, that is the only shared-file seam; pull before starting.)

---

## C5 — `t_f2140bae` — Agent-operable context-pack outcome loop (capstone)

### Files
- `src/core/brain/context-pack-outcome.ts` — NEW.
  `emitContextPackOutcome(vault, {sampleId, firstPassSuccess, repairRequired?,
  retryCount?, followUpTokens?, providerTokens?, tokenSignal})` where
  `tokenSignal: "exact" | "modeled" | "observed"` keeps the three token signals
  strictly separate (never merged into one field). Writes a
  `context_pack_outcome` continuity record AND posts to C3's calibration
  endpoint. Compact counters only; agent omits a field rather than inventing it.
- `src/core/brain/context-pack.ts` (or the receipt/report path) — carry the
  latest sample id as bounded local state in the pack report/receipt (not a
  daemon). On completion the agent posts the outcome row.
- MCP/CLI surface to post the outcome row.
- `tests/core/brain/context-pack-outcome.test.ts`.

### Acceptance (passing test)
A test in `tests/core/brain/context-pack-outcome.test.ts` that:
1. Posts an outcome row and asserts the three token signals (exact/modeled/
   observed) are stored as SEPARATE fields, never merged;
2. Asserts the record contains only compact counters — NO raw prompts,
   completions, source text, or secrets (privacy assertion);
3. Asserts a missing field is OMITTED, not invented (omit-don't-invent guard);
4. Asserts the outcome also appears in C3's ledger calibration (composes C3).

### Depends on
C3 (hard dependency — the outcome loop writes into C3's ledger). Driven last.
