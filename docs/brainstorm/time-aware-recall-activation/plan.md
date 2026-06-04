# Time-Aware Recall & Activation Suite - implementation plan

## Tasks

### Task 1: Activation kernel (pure math)
- **Files**: `src/core/search/activation/types.ts`, `src/core/search/activation/decay.ts`, `tests/core/search/activation-decay.test.ts`
- **Acceptance**: pure tests for the half-life table (infinite for preference/decision/antipattern, 120d project, 30d handoff/session, 60d default), strength bump (+0.1 capped at 1.0), effective activation `strength * 2^(-days/halfLife)`, type resolution from `kind:` frontmatter with path-prefix fallback, and injected-clock determinism.
- **Depends on**: none

### Task 2: Activation store (events + fold + sweep)
- **Files**: `src/core/search/activation/store.ts`, `src/core/search/activation/index.ts`, `tests/core/search/activation-store.test.ts`
- **Acceptance**: recording one access event writes one `<ts>-<hash>.json` under `Brain/search/activation/` (query hash + capped doc paths, idempotent re-record); the fold derives per-path `{strength, lastAccessAt, accessCount}` and bounded co-access pair counts deterministically (order-insensitive); the derived `activation-state.json` is replayable (delete + refold = identical); sweep drops events beyond 90d/5000 and malformed files never break the fold.
- **Depends on**: Task 1

### Task 3: Activation ranking layer
- **Files**: `src/core/search/ranker.ts`, `src/core/search/search.ts`, `src/core/search/types.ts`, `src/core/search/index.ts` (resolveSearchConfig), `tests/core/search/activation-ranking.test.ts`
- **Acceptance**: candidates with activation state gain a capped (0.04) `activation: 0.0xx` reason; a vault without events ranks bit-identically to before; `recordAccess: true` records the top surfaced paths after ranking (never affecting the current query, never on cache hits); query-cache key gains an activation-state fingerprint; `recall.activationEnabled` kill switch works.
- **Depends on**: Task 2

### Task 4: Co-access companion boost
- **Files**: `src/core/search/ranker.ts`, `src/core/search/search.ts`, `tests/core/search/co-access.test.ts`
- **Acceptance**: when a candidate is a frequent co-access companion of a higher-ranked candidate in the same result set, it gains a capped (0.03) `co_access: 0.0xx` reason; pairs below a minimum count threshold contribute nothing; no events = bit-identical ranking.
- **Depends on**: Task 3

### Task 5: Freshness-trend classifier + surfaces
- **Files**: `src/core/brain/temporal/freshness-trend.ts`, `src/core/brain/temporal/belief-evolution.ts`, `src/core/brain/dream.ts`, `tests/core/brain/freshness-trend.test.ts`
- **Acceptance**: pure classifier maps evidence-event time distributions to `new|strengthening|stable|weakening|stale` per the documented windows; belief-evolution envelope carries `freshnessTrend`; dream refresh stamps `freshness_trend` into preference frontmatter additively (dry-run untouched, absent field elsewhere = neutral).
- **Depends on**: none

### Task 6: Trend ranking multiplier
- **Files**: `src/core/search/ranker.ts`, `src/core/search/search.ts`, `tests/core/search/trend-ranking.test.ts`
- **Acceptance**: preference pages stamped `weakening`/`stale` are demoted (0.93/0.85 on the relevance portion), `strengthening` boosted (1.05), with a `freshness_trend` reason; unstamped pages and non-preference paths are untouched (bit-identical).
- **Depends on**: Task 5

### Task 7: Event-time validity filter
- **Files**: `src/core/search/validity.ts`, `src/core/search/search.ts`, `tests/core/search/validity.test.ts`
- **Acceptance**: documents declaring `valid_from`/`valid_until` pass a `since`/`until` filter by interval overlap (open sides honoured, UTC, bad values fall back to mtime with a warning); documents without validity fields keep mtime semantics byte-identically; storage time never consulted when event time exists.
- **Depends on**: none

### Task 8: Temporal-bridge traversal
- **Files**: `src/core/search/temporal-bridge.ts`, `src/core/search/search.ts`, `tests/core/search/temporal-bridge.test.ts`
- **Acceptance**: with an active time range, traversal expansion docs outside the padded event-time neighbourhood are dropped; in-pad docs score `parentScore * hopDecay^hop * proximityDecay(deltaDays)` with a `temporal_bridge` reason; no time range = existing traversal behaviour bit-identical.
- **Depends on**: Task 7

### Task 9: Two-pass recall controller
- **Files**: `src/core/search/search.ts`, `src/core/search/types.ts`, `src/core/search/evidence-pack.ts` (envelope field), `tests/core/search/two-pass.test.ts`
- **Acceptance**: in evidence-pack mode an abstention or `idfWeightedCoverage < 0.5` triggers exactly one broader pass (uncovered rare terms OR'd, doubled overfetch), merged deterministically (first-pass score wins on dupes, stable tie-breaks, limit respected), reported as `secondPass: {triggered, reason, added}`; high-coverage queries never trigger; `recall.twoPassEnabled: false` disables.
- **Depends on**: none

### Task 10: CLI + MCP surfaces
- **Files**: `src/cli/brain/verbs/activation.ts`, `src/cli/brain/verbs/index.ts`, `src/cli/brain/brain.ts`, `src/cli/brain/help-text.ts`, `src/cli/command-manifest.ts`, CLI search flag site, `src/mcp/brain-tools.ts`, `tests/cli/brain-activation.test.ts`, `tests/mcp/mcp.test.ts`
- **Acceptance**: `o2b brain activation status|sweep` round-trips with `--json` envelopes and exit codes (0 ok / 2 usage); search surfaces accept `--no-record-access`; `brain_search` accepts optional `record_access`; MCP tool count stays 66 and registry-guard passes.
- **Depends on**: Tasks 3, 4

### Task 11: End-to-end integration test
- **Files**: `tests/e2e/time-aware-recall.integration.test.ts`
- **Acceptance**: one vault exercises the whole suite: repeated recalls raise activation and co-access of a working set; a preference stamped `weakening` ranks below its prior position; a `valid_from` document is found by event-time window and excluded by storage-time expectations; a low-coverage query triggers the second pass and surfaces a previously-missed record.
- **Depends on**: Tasks 1-10

### Task 12: Docs
- **Files**: `README.md`, `CHANGELOG.md`, `docs/cli-reference.md`, `docs/how-it-works.md`
- **Acceptance**: CHANGELOG `[0.42.0]` entry (4 Added bullets + compare link); README capability paragraph; CLI reference for the activation verb and search flags; how-it-works section on activation/event-time/two-pass semantics.
- **Depends on**: Tasks 1-11
