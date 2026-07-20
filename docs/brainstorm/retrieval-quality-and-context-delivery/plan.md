# Retrieval quality and context delivery - implementation plan

Sequence follows consultant Variant 2. Each task is one atomic TDD commit on feat/retrieval-quality-and-context-delivery. Seams ride inside their anchor feature commits. Hard edges: N1 before N2 (admission predicate), N2 before N3 (composite-key module). All other units are independent.

Hook-state convention (binding for D1 and D2): stamps live in the existing hooks/lib session state under namespaced keys `osb.nav_tier.*` (D1) and `osb.oriented.*` (D2); each stamp carries an explicit epoch-ms expiry written by its producer; readers treat a missing, malformed, or expired stamp identically (absent) and never throw. No new store.

## Tasks

### Task N1 (t_b0c9d0a3): exact-state lane plus retrieval-time staleness barrier (carries seam 2)
- **Files**: new exact-state lane module under src/core/brain (overwrite-only, keyed by aspect), new index-admission predicate consulted by src/core/search/walker.ts, retrieval-time barrier in the recall path, src/core/vault-scope/defaults.ts, src/core/brain/pinned.ts integration, CLI/MCP surface per convention, tests
- **Acceptance**: writing an aspect replaces its canonical value (no history accumulation); lane artifacts never enter FTS/vector/graph/rollups (admission predicate test); the retrieval barrier drops superseded exact-state rows from every retrieval source including pre-existing indexed copies; a regression test proves no existing non-lane content leaves the index; with the lane unused, search results are byte-identical.
- **Depends on**: none

### Task N2 (t_37c05a34): composite scope keys, per-scope dedup, search scoping (carries seam 1)
- **Files**: new composite-key module under src/core (source-identity key for RRF/dedup plus owner/session/project scope vocabulary), dedup call sites keyed per scope, optional scope filters on search surfaces, agent-scope integration, tests
- **Acceptance**: identical text written under two different scopes is not collapsed by dedup; dedup within one scope still collapses; search accepts optional scope filters and returns byte-identical results when filters are omitted; existing global dedup state is untouched (additive keying, no destructive migration; rerun over old rows does not re-collapse); the key module is the only implementation of scope and source-identity keys.
- **Depends on**: N1 (admission predicate consulted for scope-aware indexing)

### Task N3 (t_09b7ccea): typed-edge relational retrieval arm with federation hardening
- **Files**: new relational-query parser (edge-type vocabulary from schema packs, subset validation) and relationalFanout module under src/core/search, fourth RRF arm behind a mode flag, shared rrfKey carrying source identity via the N2 key module, query-cache scoping by canonical source-set key, tests
- **Acceptance**: relationship-shaped queries (structurally detected) produce ranked nodes via bounded depth-2 typed-edge fan-out from a seed array with hop count and via-link-types; the arm joins RRF only when the mode flag enables it and default-off output is byte-identical (regression test); RRF/dedup keys carry source identity from the shared module; cache entries scope by source-set key; no natural-language word lists anywhere (parser is vocabulary-driven).
- **Depends on**: N2

### Task R1 (t_7b96f242): deterministic summary-search router plus retrieval skill hardening
- **Files**: router step in src/core/search/query-plan.ts path, retrieval skill instruction hardening where the repo documents search surfaces, tests
- **Acceptance**: TDD starts by recording what buildQueryPlan already routes for summary-shaped questions (dedupe with existing intent handling; harden rather than duplicate); after the change, structurally summary-shaped queries (source-targeted, artifact-kind, summary-typed pages) deterministically select the summary surface; non-summary queries route byte-identically to today; skill/docs text names the intended surface explicitly.
- **Depends on**: none

### Task R2 (t_267f3b4c): per-store reranker fit check diagnostic
- **Files**: new fit-check module hosted in the doctor/diagnostics surface, tests
- **Acceptance**: on a vault with sampled real queries, the check computes correlation between reranker scores and base retrieval signal and reports out-of-domain (low fit) and inverted (negative correlation) verdicts with a concrete recommendation (disable or swap); stays quiet when the reranker helps; keyless/rerankerless vaults report the diagnostic as inapplicable explicitly; strictly read-only (test asserts no config or store writes).
- **Depends on**: none

### Task R3 (t_3ffb021c): shadow-only retrieval_plan advisor
- **Files**: new advisor module composing query-plan intent/weights, context-density allocation, token-impact ledger, and route latency; one MCP tool (registry baselines updated); tests
- **Acceptance**: per question the advisor emits a read-only plan bundling source/query strategy, token-budget allocation matching what the packer would spend, graph-expansion advice, observed reliability with p95 latency, and a marginal-value stop derived from the density curve plus p95 latency; the tool exposes no mutating parameters; tests assert no live ranking or weight policy changes through the advisor path.
- **Depends on**: none

### Task D1 (t_2d4f34d7): tiered context injection with cadence-controlled navmap
- **Files**: navmap tier logic in the hook injection path (hooks/active-inject.ts or a sibling per convention), cadence state under `osb.nav_tier.*` per the hook-state convention, observability of inclusion decisions, tests
- **Acceptance**: the every-turn kernel is byte-identical to today's injected context; the nav tier injects only on cadence or trigger and each inclusion records when, why, and added char count; disabling the tier (default off unless configured) reproduces today's bytes exactly; cadence state expiry follows the convention (missing = absent, never throw).
- **Depends on**: none

### Task D2 (t_36b0fd8d): opt-in strict PreToolUse read-block hook
- **Files**: new PreToolUse hook script, hooks/hooks.json entry, orientation stamp under `osb.oriented.*` per the hook-state convention (refreshed by brain query/search paths), tests
- **Acceptance**: with the env flag on and no orientation stamp, the first raw vault-file read of a session is denied once with a redirect naming the brain search surface, then downgrades to a nudge; any brain query/search refreshes the stamp and suppresses the block; flag off (default) is byte-identical to today; every failure path (missing state, malformed stamp, non-Claude-Code harness) fails open with a test each.
- **Depends on**: none

### Task W1 (t_0f3f2422): codegraph partnering across all workspace projects
- **Files**: openclaw/index.js (checkCodegraph, findCodeProjects consumers, health-check aggregation, per-query project_path threading), skills/codegraph-partner/SKILL.md, tests in the openclaw harness
- **Acceptance**: with multiple discovered projects, status and queries cover every project (aggregated health output names each project); project_path is threaded per query when the partnered codegraph supports it; when it does not (feature-detected), behavior degrades to today's single-project path with an explicit note in health output; single-project workspaces behave byte-identically.
- **Depends on**: none

### Task L: docs, changelog, version bump
- **Files**: README.md, CHANGELOG.md (1.37.0 entry plus link reference), docs/cli-reference.md, docs/mcp.md, package.json plus `bun run scripts/sync-version.ts`
- **Acceptance**: all nine features documented; version 1.37.0 propagated; `bun run scripts/sync-version.ts --check` passes.
- **Depends on**: all above

## Batching for delegated implementation

- Batch A (one agent, sequential): N1 then N2 then N3 (state and ranking track, seam-first)
- Batch B (one agent, sequential): R1 then R2 then R3 (routing and diagnostics track)
- Batch C (one agent, sequential): D1 then D2 then W1 (delivery hooks and workspace track)
- Batch D: L (docs and bump, orchestrator)

Batches run strictly one at a time (agents share one working tree). Every unit runs `bun run fmt`, `bun run lint` (baseline exactly 134 warnings, 0 errors), `bun run typecheck`, and full foreground `bun test` before its commit.
