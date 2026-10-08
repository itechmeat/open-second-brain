# Truth-correctable, time-aware claims - implementation plan

Four parallel implementation lanes plus one integrator, structured over Variant 3's two sub-suites. Sub-suite A (tasks 1-10, lanes 1 and 2) delivers temporal truth: ledger validity fields with the succession channel, the windowed events operation, and grounded agent-stated ledger claims. Sub-suite B (tasks 11-19, lanes 3 and 4) delivers correction and recall: the correct verb with per-target end-state policy and fail-recorded sweep receipts, deepened traversal with width caps and direct-hit precedence, and the shared serve-with-correction coupling predicate across surfaces. Sub-suite B tasks start only after the contract modules they consume have landed (see Cross-lane contract and the dependency rule).

Lane ownership is disjoint: no two lanes edit the same file. Shared new modules exist only as contract items and are named in the Cross-lane contract. Every task is test-first: the named test files are written first, run, and must fail with the expected error before implementation.

| Lane | Name | Owns |
|------|------|------|
| 1 | ledger-core | `src/core/brain/truth/**` (except `events-window.ts`), `src/core/brain/atomic-facts.ts`, truth and census tests |
| 2 | recall-surfaces | `src/mcp/brain/knowledge-tools.ts`, `src/mcp/brain/recall-tools.ts`, `src/mcp/brain/time-bounds.ts`, `src/core/brain/truth/events-window.ts`, `src/cli/brain/verbs/truth.ts`, truth MCP/CLI tests |
| 3 | correction-coupling | `src/core/brain/lifecycle/correction.ts`, `src/core/search/correction-coupling.ts`, `src/mcp/brain/lifecycle-tools.ts`, `src/cli/brain/verbs/lifecycle.ts`, `src/core/search/pipeline/post-rank.ts`, `src/core/brain/{query,context-pack,active,dream-scan}.ts`, lifecycle/coupling/matrix tests |
| 4 | deep-traversal | `src/core/search/{relational-fanout,fusion,ranker,retrieval-trail,index}.ts`, `src/core/search/pipeline/{relational-arm,attribution}.ts`, `src/core/search/store/entity-bridges.ts`, relational search tests |
| D | docs | `README.md`, `docs/architecture.md`, regenerated `plugins/codex/` mirrors |
| I | integrator | `tests/contract/serve-with-correction.test.ts`, full gates |

## Cross-lane contract

The contract pins exactly the three genuinely cross-card decisions. Each item names its owning lane, its module, and the exact signatures every consumer implements against. A consumer lane codes against these signatures before the owning lane's commit lands; the poll rule in the dependency section covers the wait.

### Contract item 1: the assertion-versus-validity axis rule (owner: lane 1, module `src/core/brain/truth/validity.ts` + `src/core/brain/truth/succession.ts`)

- `ClaimEvent`, `AppendClaimInput` and `ClaimVersion` gain optional presence-gated `validFrom?: string` and `validUntil?: string` (canonical ISO-8601 UTC, half-open `[validFrom, validUntil)`), serialized by conditional spread under `TRUTH_SCHEMA_VERSION = 1`.
- `export interface ClaimWindow { readonly fromMs: number | null; readonly untilMs: number | null }` and `export function claimWindow(event: ClaimEvent): ClaimWindow | null` - null when the event carries no window; a missing bound is unbounded on that side.
- `export function windowsIntersect(a: ClaimWindow, b: ClaimWindow): boolean` - half-open intersection, `a.fromMs < b.untilMs && b.fromMs < a.untilMs` with null as plus/minus infinity.
- Classification rule: a same-slot pair is succession if and only if both claims carry present windows and `windowsIntersect` is false; every other pair keeps today's assertion-time contest behavior verbatim; an expired window never suppresses contestation on its own.
- Windowed event shape: `ClaimEventRow` is the stored `ClaimEvent` with validity fields verbatim; the events operation's `since`/`until` filter assertion `ts` only and are stated as such in the schema description.
- Sibling consumers stay assertion-keyed: `collision.ts` and `grounding.ts` constants gain a comment stating the axis choice; their code does not change.

### Contract item 2: the correction end-state policy (owner: lane 1, module `src/core/brain/truth/correction-policy.ts`)

```ts
export type CorrectionEndState = "validity_close" | "tombstone";

export interface CorrectionEndStateInput {
  /** The caller declares the prior claim was never true, not merely superseded. */
  readonly flatlyWrong: boolean;
  /** Explicit window end for a time-scoped correction (canonical ISO-8601 UTC). */
  readonly windowEnd?: string;
}

export function correctionEndState(
  input: CorrectionEndStateInput,
  correctionTs: string,
): { endState: CorrectionEndState; validUntil: string | null };
// flatlyWrong -> { endState: "tombstone", validUntil: null }
// otherwise   -> { endState: "validity_close", validUntil: windowEnd ?? correctionTs }
```

Consumers: lane 3's correct verb chooses per target through this function and records the choice in the bundle receipt with the existing reason codes (`supersede` for validity_close, `tombstone` for tombstone); lane 1's succession logic and lane 4's path-provenance annotation read the outcome through the ledger/frontmatter data (a validity-closed predecessor against its successor has non-overlapping present windows and classifies as succession under item 1).

### Contract item 3: the serve-with-correction coupling predicate (owner: lane 3, module `src/core/search/correction-coupling.ts`)

```ts
export type CouplingVerdict =
  | { readonly action: "serve_coupled"; readonly correctionPath: string }
  | { readonly action: "drop" };

export interface CouplingInput {
  /** Path of the retired-but-serveable row's page. */
  readonly predecessorPath: string;
  /** Chain-tip successor path from resolveChainTip/buildChainLookup, null when unresolved. */
  readonly successorPath: string | null;
  /** True when the successor page is readable at the caller's reach. */
  readonly successorReadable: boolean;
}

export function couplingVerdict(input: CouplingInput): CouplingVerdict;
// resolved AND readable -> { action: "serve_coupled", correctionPath: successorPath }
// otherwise             -> { action: "drop" }
```

Rule: a retired-but-serveable row is served only beside its chain-tip correction; otherwise it is dropped fail-closed (a withheld page stays indistinguishable from an absent one). Any correction content pulled in re-runs the full filter set: status, visibility scope, agent scope, reach. Every serving surface consumes this predicate: search post-rank, recall by topic, context-pack, active.md, dream scan. Tombstoned rows stay dropped by the status filter everywhere; the predicate governs the serveable-retired regime only. The guarantee is pinned by the integrator's cross-suite test `tests/contract/serve-with-correction.test.ts`, named here as part of the contract.

### Dependency rule

- Lanes commit their pure modules first: lane 1 commits `validity.ts`, `succession.ts`, `correction-policy.ts` (and their tests) before its store/surface wiring tasks; lane 3 commits `correction-coupling.ts` before its wiring tasks; lane 4 commits the `relational-fanout.ts` budget changes before arm wiring.
- A lane that consumes an upstream lane's module may poll `git log -- <file>` for the upstream lane's commit at a 30 s interval, with a 12-minute cap; when the cap expires the consumer proceeds against the contract signatures above (they are exact and test-pinned, so drift surfaces as the consumer's failing test, which the integrator then reconciles).
- Sub-suite B tasks (11-19) must not land before the contract item they consume has landed: lane 3's task 16 needs item 2, lane 4's tasks need no lane-1 module (they depend on item 1's annotation rule only through frontmatter data, so lane 4 may run fully in parallel), lane 3's tasks 18-19 need item 3 (their own module).
- Format and lint before every commit; each task is its own conventional commit on the feature branch.

## Tasks

### Task 1: Ledger validity fields and window parsing
- **Lane**: 1 (ledger-core)
- **Files**: `src/core/brain/truth/validity.ts` (new), `src/core/brain/truth/types.ts`, `src/core/brain/truth/store.ts`, `tests/core/brain/truth/validity.test.ts` (new, written first), `tests/core/brain/truth/store.test.ts`, `tests/core/architecture/visibility-surface-census.test.ts`
- **Acceptance**: `validity.test.ts` passes: window parsing reuses the `search/validity.ts` discipline (bare dates day-snapped, datetimes, relative phrases rejected), `claimWindow` returns null for windowless events, `windowsIntersect` implements the half-open rule with infinity for missing bounds; `store.test.ts` passes: presence-gated serialization leaves windowless lines byte-identical, `coerceClaim` tolerates and validates the new optional fields under schema v1, the read/write matrix (old binary reads new lines, new binary reads old lines) is pinned; census rows exist for the new exported surfaces.
- **Depends on**: none.

### Task 2: Succession channel in the conflict policy layer
- **Lane**: 1 (ledger-core)
- **Files**: `src/core/brain/truth/succession.ts` (new), `src/core/brain/truth/conflicts.ts`, `src/core/brain/truth/types.ts`, `tests/core/brain/truth/succession.test.ts` (new, written first), `tests/core/brain/truth/conflicts.test.ts`
- **Acceptance**: `succession.test.ts` passes: two same-slot claims with present non-overlapping windows classify as `ClaimSuccession` entries and never as conflicts; intersecting windows or any windowless claim falls through to the assertion-time contest rule verbatim; an expired window never suppresses contestation. `conflicts.test.ts` passes unchanged on its existing pins (base fold equality, bit-identical neutral default) and `TruthState.successions` is absent (undefined, not `[]`) whenever empty; `TruthConflictKind` is unchanged; state file serialization spreads `successions` only when present.
- **Depends on**: Task 1.

### Task 3: Ingest window defaults, frozen at ingest
- **Lane**: 1 (ledger-core)
- **Files**: `src/core/brain/truth/store.ts`, `src/core/brain/truth/validity.ts`, `tests/core/brain/truth/validity.test.ts`
- **Acceptance**: `validity.test.ts` window-default cases pass: explicit `validFrom`/`validUntil` input wins outright; absent input, the resolver reads the source record's frontmatter `valid_from`/`valid_until` when the source is readable at ingest and stores the frozen resolved value; an unreadable or windowless source stores a windowless event that is byte-identical to today's output; mtime is never used as a window source.
- **Depends on**: Task 1.

### Task 4: Grounded agent-stated claim core
- **Lane**: 1 (ledger-core)
- **Files**: `src/core/brain/truth/stated-claims.ts` (new), `src/core/brain/truth/ingest.ts`, `src/core/brain/truth/types.ts` (optional `extractor?: "agent_stated"`), `src/core/brain/truth/store.ts`, `src/core/brain/atomic-facts.ts` (export the occurrence-anchoring kernel as a pure `anchorEntityForms`), `tests/core/brain/truth/stated-claims.test.ts` (new, written first)
- **Acceptance**: `stated-claims.test.ts` passes: a stated claim `{ subject, relation, object }` with `text` maps to a ledger event (entity = normalized subject, aspect = relation token, value = object) with `extractor: "agent_stated"`; an unknown relation, missing text or missing source refuses the whole payload with nothing written (refuse-before-write at the boundary); anchoring verdicts are per claim - subject and object anchored via the quality-gated match forms commit, ungrounded claims are reported back with reasons; conflict detection is untouched (`contestingValues` unchanged, conflict rows may annotate the tag but never re-rank or resolve).
- **Depends on**: Task 1.

### Task 5: Correction end-state policy (contract item 2)
- **Lane**: 1 (ledger-core)
- **Files**: `src/core/brain/truth/correction-policy.ts` (new), `tests/core/brain/truth/correction-policy.test.ts` (new, written first)
- **Acceptance**: `correction-policy.test.ts` passes the exact signature and rule table: `flatlyWrong` yields tombstone with null `validUntil`; any other input yields validity_close with `windowEnd` when time-scoped, else the correction instant; results are pure and deterministic.
- **Depends on**: none. Must land before lane 3's Task 16 (sub-suite A before B).

### Task 6: Events-window selection (pure)
- **Lane**: 2 (recall-surfaces)
- **Files**: `src/core/brain/truth/events-window.ts` (new), `tests/core/brain/truth/events-window.test.ts` (new, written first)
- **Acceptance**: `events-window.test.ts` passes: `selectClaimEvents(events, { entity, sinceMs, untilMs, limit })` slices the already-`ts`-sorted event array with second-precision string compare (since floored, until ceiled to the second, matching the grammar's inclusive day-edge semantics), composes with the normalized-entity filter, applies `DEFAULT_EVENT_LIST_LIMIT = 200` with hard cap `CLAIM_EVENT_MAX_LIST_LIMIT = 1000`, and returns stable ascending rows with `total` and `truncated`.
- **Depends on**: none (codes against the `ClaimEvent` shape of contract item 1).

### Task 7: Shared time-bounds wrapper
- **Lane**: 2 (recall-surfaces)
- **Files**: `src/mcp/brain/time-bounds.ts` (new), `src/mcp/brain/recall-tools.ts`, `tests/mcp/time-bounds.test.ts` (new, written first)
- **Acceptance**: `time-bounds.test.ts` passes: the lifted `resolveTimeBounds(since, before)` resolves through `resolveTimeRange` and maps `SearchError` to `MCPError(INVALID_PARAMS)`; `recall-tools.ts` consumes the shared wrapper for session-grep bounds with behavior unchanged (its existing tests stay green).
- **Depends on**: none.

### Task 8: brain_truth events operation and agent-stated claims operation
- **Lane**: 2 (recall-surfaces)
- **Files**: `src/mcp/brain/knowledge-tools.ts`, `tests/mcp/brain-truth.test.ts`
- **Acceptance**: `brain-truth.test.ts` additions pass: `operation: "events"` accepts `entity`/`since`/`until`/`limit` (declared in the closed schema, `additionalProperties: false`), returns `{ ok, operation, entity, events: ClaimEventRow[], total, withheld, truncated }` with rows in stable ascending assertion-`ts` order and validity fields verbatim; every row passes the same per-row visibility/reach gate as `brain_claims`, dropped rows counted in `withheld`; the slots and conflicts responses are byte-identical to before (the `events` count pin stays); `operation: "state"` accepts `{ claims, text, source, agent? }`, refuses unknown relations before any write, commits grounded claims with `extractor: "agent_stated"`, and reports ungrounded claims back per claim with reasons. Schema descriptions state the ts-only filter and the half-open validity convention.
- **Depends on**: Tasks 1, 2, 4, 6, 7 (polls lane 1 commits per the dependency rule).

### Task 9: CLI truth surface
- **Lane**: 2 (recall-surfaces)
- **Files**: `src/cli/brain/verbs/truth.ts`, `tests/cli/brain-truth.test.ts`
- **Acceptance**: `brain-truth.test.ts` CLI additions pass: `o2b brain truth events [--entity E] [--since X] [--until Y] [--limit N]` prints the same shape as the MCP events op; `o2b brain truth ingest` accepts `--valid-from`/`--valid-until`; `o2b brain truth state --subject S --relation R --object O --text T --source S [--agent N]` prints the anchoring verdict (committed event or reported-back reasons); unparseable bounds fail with the INVALID_PARAMS-equivalent CLI error through the shared wrapper; the CLI/MCP op asymmetry is preserved (all ops present on both, `sweep` CLI-only).
- **Depends on**: Tasks 3, 4, 6, 8.

### Task 10: Sub-suite A integration checkpoint
- **Lane**: 2 (recall-surfaces)
- **Files**: none new (verification only)
- **Acceptance**: full truth-suite test files green together (`tests/core/brain/truth/`, `tests/mcp/brain-truth.test.ts`, `tests/cli/brain-truth.test.ts`, census test); a windowed events call over events ingested with resolved windows returns rows carrying the frozen windows; the succession channel and the events surface agree on the axis rule from contract item 1.
- **Depends on**: Tasks 1-9.

### Task 11: Traversal budgets, hub skipping, deadline
- **Lane**: 4 (deep-traversal)
- **Files**: `src/core/search/relational-fanout.ts`, `src/core/search/index.ts`, `tests/core/search/relational-fanout.test.ts`
- **Acceptance**: `relational-fanout.test.ts` additions pass: seed cap `TRAVERSAL_MAX_SEEDS = 8`, per-node cap `TRAVERSAL_MAX_EXPANSION_PER_NODE = 4`, total-node cap `TRAVERSAL_MAX_TOTAL_NODES = 16`, all overridable via `OPEN_SECOND_BRAIN_SEARCH_TRAVERSAL_*` with the `parseBool(envOrConfig(...))` pattern; a node whose walked-edge degree exceeds `TRAVERSAL_HUB_DEGREE_THRESHOLD = 12` is reached but not expanded; a fired deadline abandons the frontier deterministically keeping already-reached nodes; the existing hop-dominance and determinism pins stay green; off state unchanged.
- **Depends on**: none.

### Task 12: Entity bridges from chunk_entities
- **Lane**: 4 (deep-traversal)
- **Files**: `src/core/search/store/entity-bridges.ts` (new), `src/core/search/relational-fanout.ts`, `tests/core/search/relational-fanout.test.ts`
- **Acceptance**: `relational-fanout.test.ts` bridge cases pass: `entityBridgesForDocuments` joins `chunk_entities` into deduplicated bridge edges labeled `entity`; bridges are walked only when `OPEN_SECOND_BRAIN_SEARCH_ENTITY_BRIDGES` is true and the arm is enabled; with bridges off, fanout output equals the Task 11 output exactly; bridge edges count toward hub degree and node caps.
- **Depends on**: Task 11.

### Task 13: Ordered path provenance with per-node reach gating
- **Lane**: 4 (deep-traversal)
- **Files**: `src/core/search/pipeline/relational-arm.ts`, `src/core/search/pipeline/attribution.ts`, `src/core/search/retrieval-trail.ts`, `tests/core/search/relational-path.test.ts` (new, written first), `tests/core/search/relational-arm.test.ts`
- **Acceptance**: `relational-path.test.ts` passes: `RelationalReach` carries the ordered path of `{ documentId, relation }` steps; path nodes unreadable at the caller's reach are omitted and counted, and the attribution reason renders `relational: via <types> (<n> hops, <k> nodes withheld)`; a readable path node that is a non-tip superseded predecessor with a closed validity window is annotated `superseded_by: <tip>` from frontmatter only; the ordered path lands in the retrieval trail as a new stable typed code carrying readable document ids plus the withheld count; existing attribution tests stay green.
- **Depends on**: Task 12.

### Task 14: Structural direct-hit precedence
- **Lane**: 4 (deep-traversal)
- **Files**: `src/core/search/fusion.ts`, `src/core/search/ranker.ts`, `src/core/search/pipeline/relational-arm.ts`, `tests/core/search/fusion.test.ts`
- **Acceptance**: `fusion.test.ts` precedence pins pass: relational-only rows are admitted after the last organic row in the pre-rerank fused order; a relational-only row at relational-rank 1 never outranks a keyword direct hit; the tightened rerank pin holds (a relational-origin row may move within the relational block, never sinks below its pre-rerank position relative to other relational rows, and never crosses above an organic direct hit); with the arm disabled, fusion output is byte-identical.
- **Depends on**: Task 11.

### Task 15: Coupling predicate module (contract item 3)
- **Lane**: 3 (correction-coupling)
- **Files**: `src/core/search/correction-coupling.ts` (new), `tests/core/search/correction-coupling.test.ts` (new, written first)
- **Acceptance**: `correction-coupling.test.ts` passes the exact signature and rule table: resolved and readable successor yields `serve_coupled` with the correction path; unresolved, unreadable, or absent successor yields `drop`; pure, deterministic, no I/O.
- **Depends on**: none.

### Task 16: Correct-verb sweep core
- **Lane**: 3 (correction-coupling)
- **Files**: `src/core/brain/lifecycle/correction.ts` (new), `tests/core/brain/lifecycle/correction.test.ts` (new, written first)
- **Acceptance**: `correction.test.ts` passes: discovery gathers the affected set within the caller's reach (claim-graph closure via `whatReplaced`/`whatContests`, match-only wikilink mention scan via `retargetWikilinks` with `apply: false`, same-entity/aspect ledger claims); dry-run writes nothing and returns the blast-radius report; the applied run retires each target through `correctionEndState` (contract item 2), retargets mentions with per-write failure carry, appends ledger correction events from the successor's source (self-correction semantics, never a conflict), and emits per-record receipts with `correction_bundle:<bundleId>` in `evidence_triggers`; replay converges (no double tombstone, receipts report `appended: false`, closed windows stay closed); Brain/log and receipt lines are never rewritten; every write passes the vault-identity guard.
- **Depends on**: Task 5 (contract item 2; sub-suite A before B).

### Task 17: brain_lifecycle correct action, CLI verb, matrix equality
- **Lane**: 3 (correction-coupling)
- **Files**: `src/mcp/brain/lifecycle-tools.ts`, `src/cli/brain/verbs/lifecycle.ts`, `tests/mcp/brain-lifecycle-correct.test.ts` (new, written first), `tests/mcp/agent-scope-matrix.test.ts`
- **Acceptance**: `brain-lifecycle-correct.test.ts` passes: `brain_lifecycle` action `correct` and CLI `o2b brain lifecycle correct` expose the sweep with `dry_run` default true, a `flatly_wrong` flag, an optional `window_end`, and reach-gated targets (a target the caller may not read is refused as missing before anything is written); the agent-scope-matrix equality is updated for the new action's recipes and stays an equality (tool count unchanged); receipt reason codes stay `supersede`/`tombstone`, name-aligned with the verb and action.
- **Depends on**: Task 16.

### Task 18: Search-pipeline coupling wiring
- **Lane**: 3 (correction-coupling)
- **Files**: `src/core/search/pipeline/post-rank.ts`, `tests/core/search/post-rank-coupling.test.ts` (new, written first)
- **Acceptance**: `post-rank-coupling.test.ts` passes: the retired-row branch consumes `couplingVerdict` - a retired-but-serveable row is served only beside its resolved, readable chain-tip correction and is dropped otherwise; correction content pulled in re-runs the full filter set (status, visibility scope, agent scope, reach), closing the recorded gap where pulled successors bypassed visibility and agent scope; with no retired rows the pool is unchanged (byte-identical neutral path pinned); tombstoned rows remain dropped by the status filter before the predicate runs.
- **Depends on**: Task 15.

### Task 19: Cross-surface coupling
- **Lane**: 3 (correction-coupling)
- **Files**: `src/core/brain/query.ts`, `src/core/brain/context-pack.ts`, `src/core/brain/active.ts`, `src/core/brain/dream-scan.ts`, `tests/core/brain/coupling-surfaces.test.ts` (new, written first)
- **Acceptance**: `coupling-surfaces.test.ts` passes: recall by topic, context-pack injection, the active.md digest and the dream scan all decide through `couplingVerdict` - a serveable retired row appears only with its correction, is dropped otherwise, and today's exclusion wiring keeps tombstoned rows hidden; each surface's non-retired output is unchanged.
- **Depends on**: Task 15.

### Task 20: Docs, matrix documentation, and plugin mirrors
- **Lane**: D (docs)
- **Files**: `README.md`, `docs/architecture.md`, regenerated mirrors under `plugins/codex/`
- **Acceptance**: docs/architecture.md agent-scope-matrix section matches the implementation lane's test equality (same recipe rows for the `correct` action); README documents the `events` and `state` truth operations, the `correct` verb, the traversal budget flags and their defaults; `bun run sync-plugin-mirrors` has been run and the generated mirror is committed in this lane's FIRST commit; `bun run sync-plugin-mirrors:check` is clean afterwards.
- **Depends on**: Tasks 10 and 17 (final shapes and matrix numbers; may be written against the contract in parallel and committed after they land).

### Task 21: Integrator - contract pin and full gates
- **Lane**: I (integrator)
- **Files**: `tests/contract/serve-with-correction.test.ts` (new, written first)
- **Acceptance**: the cross-suite contract test passes: with sub-suite A's windows and sub-suite B's coupling wired together, a retired-but-serveable row served by any surface is always accompanied by its chain-tip correction, and is dropped when the successor is unresolved or out of reach - the guarantee named in contract item 3. Then the full gates in CI order: formatter, linter, full test suite, `bun run sync-plugin-mirrors:check`, the architecture census and agent-scope-matrix equalities; any cross-lane drift against the contract is reconciled here.
- **Depends on**: Tasks 10, 14, 19, 20.
