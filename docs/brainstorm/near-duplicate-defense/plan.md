# Near-Duplicate Defense Across the Fact Lifecycle - implementation plan

This plan has four implementation lanes (A, B, C, D) and one integrator step:

- Feature branch: `feat/near-duplicate-defense`, one worktree.
- Every lane commits to this branch in place. The integrator ships one PR,
  which releases v1.74.0.
- Every task is TDD:
  1. Write the failing test first.
  2. Make it pass.
  3. Make one conventional commit.
- Design and rationale: `design.md`.

## 0. Pinned cross-lane contract

Everything two lanes share is decided here. Lanes implement against this
section as written. A lane that needs to change it stops and asks the
integrator. It does not edit another lane's file.

### 0.1 `src/core/brain/near-duplicate.ts` (owner: lane A, task A1)

```ts
export type NearDuplicateMethod = "lexical" | "embedding";
export type ReadableRef = (ref: string) => boolean;
/** Explicit operator-reach predicate; every unfiltered call site names it. */
export const READ_ALL_REFS: ReadableRef;

export const NEAR_DUPLICATE_THRESHOLDS: Readonly<{
  writeHint: 0.8;               // == page-lint NEAR_DUPLICATE_JACCARD
  retireSiblingLexical: 0.7;
  retireSiblingEmbedding: 0.92;
}>;
export const NEAR_DUPLICATE_MIN_TOKENS = 4;
export const NEAR_DUPLICATE_CANDIDATE_CAP = 200;
export const NEAR_DUPLICATE_WIDENING_TOP_K = 20;

export interface NearDuplicateProbe {
  readonly ref: string;                    // vault-relative path or pref id
  readonly tokens: ReadonlySet<string>;    // from similarity.ts tokenise
}
export interface NearDuplicatePoolEntry {
  readonly ref: string;
  readonly tokens: ReadonlySet<string>;
  /** Optional bucket; when the options carry `bucket`, entries must match it. */
  readonly bucket?: string;
}
export interface NearDuplicateOptions {
  readonly threshold: number;
  readonly readable: ReadableRef;          // required, applied before scoring and counting
  readonly minTokens?: number;             // default NEAR_DUPLICATE_MIN_TOKENS
  readonly cap?: number;                   // default NEAR_DUPLICATE_CANDIDATE_CAP
  readonly bucket?: string;
}
export interface NearDuplicateMatch {
  readonly ref: string;
  readonly score: number;                  // rounded to 3 decimals
  readonly method: NearDuplicateMethod;
}
export interface NearDuplicateScan {
  readonly compared: number;               // readable entries actually scored
  readonly capped: number;                 // readable entries left out by the cap
  readonly below_min_tokens: number;       // readable entries skipped as too short
}
export interface NearDuplicateResult {
  readonly matches: ReadonlyArray<NearDuplicateMatch>; // sorted by -score, then ref
  readonly scan: NearDuplicateScan;
}
export function findNearDuplicates(
  probe: NearDuplicateProbe,
  pool: ReadonlyArray<NearDuplicatePoolEntry>,
  opts: NearDuplicateOptions,
): NearDuplicateResult;
```

`findNearDuplicates` follows these rules:

1. It is pure: no I/O, no clock, no model.
2. It excludes the probe's own `ref`.
3. It never throws on well-formed input.
4. Unreadable entries never appear in `matches` or in any `scan` counter.

### 0.2 `src/core/config.ts` additions (owner: lane A, task A1)

```ts
export function resolveNearDuplicateRetireSiblingsEnabled(configPath?: string): boolean;
//   key  near_duplicate_retire_siblings_enabled
//   env  OPEN_SECOND_BRAIN_NEAR_DUPLICATE_RETIRE_SIBLINGS_ENABLED
export function resolveNearDuplicateWriteWideningEnabled(configPath?: string): boolean;
//   key  near_duplicate_write_widening_enabled
//   env  OPEN_SECOND_BRAIN_NEAR_DUPLICATE_WRITE_WIDENING_ENABLED
```

Both go through `resolveConfigFlag` and default to off. No other config key
is added in this wave. Stage timings reuse `mcp_route_metrics_enabled`.

### 0.3 Retire-sibling shapes (owner: lane A)

```ts
// src/core/brain/retire-siblings.ts
export const RETIRE_SIBLING_TRIGGER_REASONS: ReadonlySet<BrainRetiredReason>;
//   superseded-by-context, rebutted, quarantine-violated, user-rejected
export interface RetireSibling {
  readonly retiring_id: string;            // pref-* id being retired
  readonly sibling_id: string;             // active pref-* id that resembles it
  readonly score: number;
  readonly method: NearDuplicateMethod;
}
export function planRetireSiblings(
  active: ReadonlyArray<{ id: string; principle: string }>,
  retiring: ReadonlyArray<{ id: string; principle: string; reason: BrainRetiredReason }>,
  opts: { readonly readable: ReadableRef; readonly gated: ReadonlySet<string> },
): ReadonlyArray<RetireSibling>;

// src/core/brain/dream-types.ts, DreamRunSummary
readonly retire_siblings?: ReadonlyArray<RetireSibling>; // absent when the key is off or the list is empty

// src/core/brain/near-duplicate-vectors.ts
export type StoredVectorStatus = "used" | "index_missing" | "vec_unavailable" | "model_mismatch";
export interface StoredVectorSimilarity {
  readonly status: StoredVectorStatus;
  readonly scores: ReadonlyMap<string, number>; // vault-relative candidate path -> max chunk-pair cosine
}
export function storedVectorSimilarity(
  config: ResolvedSearchConfig,
  probePath: string,
  candidatePaths: ReadonlyArray<string>,
): Promise<StoredVectorSimilarity>;

// review projection: ReviewCandidatesReport gains
readonly retire_siblings?: ReadonlyArray<RetireSibling>;
readonly retire_siblings_semantic?: StoredVectorStatus; // present only when retire_siblings is computed with a search config
```

### 0.4 Write-side shapes (owner: lane B)

```ts
// src/core/brain/page-lint.ts
export interface LintWrittenPagesOptions {
  readonly readable: ReadableRef;                                   // required
  readonly extraCandidates?: ReadonlyArray<NearDuplicateCandidate>; // from widening
  readonly widening?: NearDuplicateWideningStatus;                  // absent when the key is off
}
export function lintWrittenPages(
  vault: string,
  pages: ReadonlyArray<string>,
  opts: LintWrittenPagesOptions,
): PageLintReport;
export type NearDuplicateWideningStatus = "used" | "index_unavailable";
// NearDuplicateCensus gains: readonly widening?: NearDuplicateWideningStatus

// src/core/brain/page-lint-widening.ts
export interface WideningResult {
  readonly status: NearDuplicateWideningStatus;
  readonly candidates: ReadonlyArray<NearDuplicateCandidate>;
}
export function collectWideningCandidates(
  config: ResolvedSearchConfig,
  vault: string,
  pages: ReadonlyArray<string>,
  readable: ReadableRef,
): Promise<WideningResult>;
```

The finding code stays `near-duplicate`. A widened finding carries the same
code, and its message names the method: `method=lexical`.

### 0.5 Extract shapes (owner: lane C)

```ts
// src/core/brain/extract-signals.ts
export interface MinedTurn {
  readonly turnId: string;
  readonly text: string;
  readonly timestamp: string; // verbatim stored string; "" when the source has none
}
// transcript line: `[${turnId} @ ${timestamp}] ${text}`, or `[${turnId}] ${text}` when the timestamp is ""
// crossItem refusal message names both indices: `items[i] and items[j] share topic "<topic>"`
// turns_mined entries (MCP + CLI) gain: timestamp: string
```

### 0.6 `src/core/route-scope.ts` (owner: lane D, task D1)

```ts
export const ROUTE_STAGE: Readonly<{
  validate: "validate";
  idempotencyLookup: "idempotency_lookup";
  nearDuplicateLookup: "near_duplicate_lookup";
  documentWrite: "document_write";
  idempotencyRemember: "idempotency_remember";
  logAppend: "log_append";
  preferenceWrite: "preference_write";
  writeReceipt: "write_receipt";
  lint: "lint";
}>;
export type RouteStageName = (typeof ROUTE_STAGE)[keyof typeof ROUTE_STAGE];
export const ROUTE_STAGE_NAMES: ReadonlySet<RouteStageName>;
export function isRouteStageName(value: unknown): value is RouteStageName;
export interface RouteStageTiming { readonly name: RouteStageName; readonly ms: number }
export function timeStageSync<T>(name: RouteStageName, fn: () => T): T;               // try/finally, rethrows
export function timeStage<T>(name: RouteStageName, fn: () => Promise<T>): Promise<T>; // try/finally, rethrows
export function noteDecisionLatency(ms: number): void;                                 // moved from latency.ts
export interface RouteScope {
  run<T>(fn: () => Promise<T>): Promise<T>;
  decisionMs(): number | undefined;
  stages(): ReadonlyArray<RouteStageTiming> | undefined; // summed per name, first-seen order, 0.1 ms; undefined when none
}
export function createRouteScope(): RouteScope;
```

With no scope open, `timeStageSync` and `timeStage` reduce to `fn()`.
`src/core/decision-model/latency.ts` re-exports `noteDecisionLatency` and
keeps `createDecisionLatencyScope` as a thin wrapper over
`createRouteScope`, so `run.ts` and its tests stay untouched.

### 0.7 Record and log kinds

1. **No new continuity kind.** `mcp_route_latency` gains the optional
   `stages: Array<{ name: RouteStageName; ms: number }>`, and
   `McpRouteLatencyInput` gains `stages?: ReadonlyArray<RouteStageTiming>`.
2. **No new Brain log event kind.** The `write-conflict-advisory` kind keeps
   its existing payload.
3. **No new MCP tool.** No new `PAGE_LINT_SKIP_REASON`.
4. **New closed string sets:** `StoredVectorStatus`,
   `NearDuplicateWideningStatus` and `ROUTE_STAGE`.

### 0.8 Who imports whom

| Consumer | Imports | From (lane, task) |
|---|---|---|
| B3, B4 | `findNearDuplicates`, `NEAR_DUPLICATE_*`, `ReadableRef`, `READ_ALL_REFS` | A1 |
| B3 | `resolveNearDuplicateWriteWideningEnabled` | A1 |
| B5 | `timeStageSync`, `timeStage`, `ROUTE_STAGE` | D1 |
| A2-A6 | own modules only | - |
| C1-C5 | nothing from another lane | - |
| D2-D6 | own modules only | - |

The two substrate tasks, A1 and D1, are each lane's first task. They are
small: one module, one test file and the contract signatures above. The
tasks that consume them (B3, B4 and B5) sit after lane B's tasks that do not
depend on them.

## 1. Lanes, owned files and start conditions

Each lane edits only the files listed for it. The integrator owns
`CHANGELOG.md`, `docs/mcp.md` and the version files.

### Lane A: kernel and forget side (t_acab97de). Safe to start immediately.

Owned files (16):

| Source | Tests |
|---|---|
| `src/core/brain/near-duplicate.ts` (new) | `tests/core/brain/near-duplicate.test.ts` (new) |
| `src/core/config.ts` | `tests/core/config-near-duplicate.test.ts` (new) |
| `src/core/brain/retire-siblings.ts` (new) | `tests/core/brain/retire-siblings.test.ts` (new) |
| `src/core/brain/dream.ts` | |
| `src/core/brain/dream-types.ts` | |
| `src/core/brain/near-duplicate-vectors.ts` (new) | `tests/core/brain/near-duplicate-vectors.test.ts` (new) |
| `src/core/brain/review-candidates.ts` | `tests/core/brain/review-candidates.test.ts` |
| `src/mcp/brain/review-tools.ts` | `tests/mcp/review-tools-reach.test.ts` |
| `src/cli/brain/verbs/reject.ts` | `tests/cli/brain-reject-siblings.test.ts` (new) |

### Lane B: write side (t_fda66477). Safe to start immediately.

B1 and B2 have no cross-lane import. B3 and B4 start once A1 is committed;
the contract in 0.1 and 0.2 is fixed, so their tests can be written before
that. B5 starts once D1 is committed.

Owned files (12):

| Source | Tests |
|---|---|
| `src/core/brain/page-lint.ts` | `tests/core/brain/page-lint.test.ts` |
| `src/mcp/brain/notes-tools.ts` | `tests/mcp/note-write-reach.test.ts`, `tests/mcp/brain-create-note.test.ts` |
| `src/core/brain/page-lint-widening.ts` (new) | `tests/core/brain/page-lint-widening.test.ts` (new) |
| `src/core/search/visibility-surface-registry.ts` | `tests/core/architecture/visibility-surface-census.test.ts` |
| `src/core/brain/health/contradiction.ts` | `tests/core/brain/write-advisory.test.ts` |
| `src/core/brain/write-advisory.ts` | |

### Lane C: extract rules (t_b915b9cc). Safe to start immediately.

Lane C has no cross-lane import.

Owned files (8):

| Source | Tests and docs |
|---|---|
| `src/core/brain/extract-signals.ts` | `tests/core/brain/extract-signals.test.ts`, `tests/core/brain/extract-signals-prefilter.test.ts` (edited only if it pins the old line format) |
| `src/mcp/brain/extract-tools.ts` | `tests/mcp/extract-signals-tool.test.ts` |
| `src/cli/brain/verbs/extract-signals.ts` | `tests/core/brain/extract-signals-temporal.test.ts` (new) |
| | `docs/cli-reference.md` |

### Lane D: stage timings (t_72e93e18). Safe to start immediately.

Owned files (13):

| Source | Tests and docs |
|---|---|
| `src/core/route-scope.ts` (new) | `tests/core/route-scope.test.ts` (new) |
| `src/core/decision-model/latency.ts` | |
| `src/core/brain/mcp-route-metrics.ts` | `tests/core/brain/mcp-route-metrics.test.ts` |
| `src/mcp/server.ts` | `tests/mcp/route-metrics-tool.test.ts` |
| `src/core/brain/signal.ts` | |
| `src/mcp/brain/feedback-tools.ts` | |
| `src/core/brain/notes/create-note.ts` | |
| `src/core/brain/write-batch.ts` | |
| `src/mcp/brain/recall-tools.ts` | `docs/observability.md` |

### Integrator (after all lanes): 2 files, plus 9 generated

- `CHANGELOG.md` and `docs/mcp.md`.
- `package.json`. Then run `bun run scripts/sync-version.ts`, which rewrites
  `plugin.yaml`, `plugins/hermes/plugin.yaml`, `.claude-plugin/plugin.json`,
  `.codex-plugin/plugin.json`, `plugins/codex/.codex-plugin/plugin.json`,
  `openclaw.plugin.json`, `pyproject.toml` and `uv.lock`.

### Touched-file estimate

| Lane | Files |
|---|---|
| A | 16 |
| B | 12 |
| C | 8 |
| D | 13 |
| Integrator | 2 |
| **Total written by hand** | **51** |
| Generated by `sync-version.ts` | 9 (`package.json` plus 8 mirrors) |

The 51 files written by hand fall within the 40-55 budget.

## 2. Tasks

The test command for every task, from the worktree root:

```
env HOME=$(mktemp -d) bun test <paths>
```

### Lane A

**A1. Near-duplicate kernel and config keys (substrate)**
- Test first:
  - `tests/core/brain/near-duplicate.test.ts`:
    - an unreadable entry never appears in `matches` or in any `scan` counter;
    - an entry under `minTokens` counts in `below_min_tokens` and is not scored;
    - the cap counts as `capped`;
    - the probe's own `ref` is excluded;
    - sorting is deterministic;
    - multilingual tokens (Cyrillic, CJK) score through the shared
      `tokenise`;
    - `NEAR_DUPLICATE_THRESHOLDS.writeHint === NEAR_DUPLICATE_JACCARD`.
  - `tests/core/config-near-duplicate.test.ts`: both keys default to off, and
    the config key and the env var each turn them on.
- Implement: `src/core/brain/near-duplicate.ts` exactly as in contract 0.1;
  the two resolvers in `src/core/config.ts` (0.2).
- Commit: `feat(brain): add a reach-aware near-duplicate kernel and its config keys`

**A2. Retire-sibling planner**
- Test first: `tests/core/brain/retire-siblings.test.ts`:
  - only the four trigger reasons nominate;
  - decay reasons (`stale-no-evidence`, `expired-unconfirmed`) and
    `merged-into` never nominate;
  - siblings of a gated id are dropped;
  - merge-resolved pages are excluded;
  - preferences from other topics and scopes are compared;
  - a sibling of a sibling is never computed;
  - the output is stable across runs.
- Implement: `src/core/brain/retire-siblings.ts`, a pure planner over
  `findNearDuplicates`, using the threshold `retireSiblingLexical`.
- Commit: `feat(brain): plan retire siblings for context-driven retires`

**A3. Dream summary wiring**
- Test first: `tests/core/brain/retire-siblings.test.ts` (dream section):
  - with the key on, `dream({ dryRun: true })` and a real run report the
    same `retire_siblings`;
  - the dry run writes nothing (the vault tree is compared before and
    after);
  - with the key off, the field is absent and the summary is byte-identical
    to the baseline;
  - a sibling of a gated retire does not appear.
- Implement:
  - `src/core/brain/dream-types.ts`: add the optional field.
  - `src/core/brain/dream.ts`: compute the siblings once the retire plan is
    complete, and reconcile them against `gated_retires` in the summary
    builder.
- Commit: `feat(dream): report retire siblings in the run summary`

**A4. Stored-vector tier**
- Test first: `tests/core/brain/near-duplicate-vectors.test.ts`. Each status
  is driven by a fixture index or a missing index:
  - `index_missing`;
  - `vec_unavailable`, when `vecLoaded()` is false;
  - `model_mismatch`, when the stored model or dimension differs;
  - `used`, with the max chunk-pair cosine as the score.

  A source-scan test asserts that neither this module nor
  `src/core/brain/page-lint-widening.ts` (once it exists) imports from
  `src/core/search/embeddings/`. It also asserts that `detectSemanticDedup`
  has no caller outside `tests/`.
- Implement: `src/core/brain/near-duplicate-vectors.ts` (contract 0.3). It
  opens the store read-only, uses `storedEmbeddingsForDocument`, and makes
  zero provider calls.
- Commit: `feat(brain): score retire siblings on stored vectors at zero embedding spend`

**A5. Review projection and MCP reach**
- Test first:
  - `tests/core/brain/review-candidates.test.ts`: `retire_siblings` and
    `retire_siblings_semantic` are projected. Embedding matches merge in
    with `method: "embedding"` at or above `retireSiblingEmbedding`. With
    the key off, both fields are absent.
  - `tests/mcp/review-tools-reach.test.ts`: a pair whose retiring id or
    sibling id is outside the caller's reach is neither listed nor counted.
    Both the `pref-` and `ret-` spellings are checked.
- Implement:
  - `src/core/brain/review-candidates.ts`: project the field and run the
    vector tier on the existing `opts.searchConfig` path.
  - `src/mcp/brain/review-tools.ts`: filter through `reviewView` before any
    counting, and update the output schema and description.
- Commit: `feat(mcp): surface reach-filtered retire siblings in brain_review_candidates`

**A6. Siblings on `reject`**
- Test first: `tests/cli/brain-reject-siblings.test.ts`:
  - with the key on, `o2b brain reject <id>` prints each sibling with its
    score and the accept command;
  - with the key off, the output is byte-identical to before;
  - nothing besides the rejected preference is retired.
- Implement: `src/cli/brain/verbs/reject.ts`. Call `planRetireSiblings` with
  `READ_ALL_REFS` (operator reach) and the reason `user-rejected`, then
  print the result and update the help text.
- Commit: `feat(cli): list retire siblings after brain reject`

### Lane B

**B1. Reach fix for the shipped hint**
- Test first:
  - `tests/core/brain/page-lint.test.ts`: a withheld sibling is neither
    scored, named, nor counted in `candidates_skipped` or
    `candidates_unreadable`. A clean write still produces no `lint` key.
  - `tests/mcp/note-write-reach.test.ts`: `brain_create_note`,
    `brain_update_note`, `brain_append_note` and `brain_write_batch` never
    name a withheld sibling.
  - `tests/core/architecture/visibility-surface-census.test.ts`: the new
    registry row is pinned.
- Implement:
  - `src/core/brain/page-lint.ts`: `LintWrittenPagesOptions` with
    `readable` (contract 0.4), applied in `collectNearDuplicateCandidates`
    before the census.
  - `src/mcp/brain/notes-tools.ts`: `noteWriteResult` passes
    `readableAtContextReach(ctx)`.
  - `src/core/search/visibility-surface-registry.ts`: add a row for the
    note-write lint, and a note on the `brain_review_candidates` row for
    `retire_siblings`.

  Until A1 lands, page-lint declares its own local predicate type with the
  same shape as `ReadableRef`. B3 switches it to the kernel import.
- Commit: `fix(brain): filter near-duplicate receipt candidates by caller reach`

**B2. Keyword-index widening collector**
- Test first: `tests/core/brain/page-lint-widening.test.ts`, using a fixture
  index built by the indexer. Cases:
  - a near-identical page in another directory is returned;
  - a withheld page is dropped before it is returned;
  - a page deleted from disk but still in the index is dropped;
  - a missing index returns `status: "index_unavailable"` and empty
    candidates;
  - the top-k bound holds.
- Implement: `src/core/brain/page-lint-widening.ts`:
  1. build the query with `buildFtsMatch` over the written body;
  2. pull hits with `keywordTopK` (limit `NEAR_DUPLICATE_WIDENING_TOP_K`,
     declared locally until A1 lands);
  3. map them to document paths, apply `readable`, and re-read each page
     from disk;
  4. project each page into a `NearDuplicateCandidate`.

  It must not import from `src/core/search/embeddings/`.
- Commit: `feat(brain): collect cross-directory near-duplicate candidates from the keyword index`

**B3. Kernel scoring and opt-in widening on the receipt** (after A1)
- Test first:
  - `tests/core/brain/page-lint.test.ts`: findings and messages from the
    same directory are byte-identical to v1.73.0. With
    `extraCandidates`, a cross-directory finding has the same code, and its
    message carries `method=lexical`. The census `widening` field is
    present only when it is passed.
  - `tests/mcp/brain-create-note.test.ts`: with
    `near_duplicate_write_widening_enabled` on, a create in another folder
    reports the earlier page. With the key off, the receipt is unchanged.
- Implement:
  - `nearDuplicateFindings` scores through `findNearDuplicates`, using the
    threshold `writeHint` and the scope key as `bucket`.
  - `NEAR_DUPLICATE_JACCARD` becomes an alias of the table value.
  - `notes-tools.ts` runs `collectWideningCandidates` only when
    `resolveNearDuplicateWriteWideningEnabled()` is on.
- Commit: `feat(mcp): widen the near-duplicate receipt hint beyond the directory behind a flag`

**B4. Feedback advisory on the kernel** (after A1)
- Test first: `tests/core/brain/write-advisory.test.ts`. The advisory output
  and the `write-conflict-advisory` log line are byte-identical for the
  existing fixtures, and the threshold still comes from
  `BRAIN_HEALTH_DEFAULTS.contradiction_jaccard`. The only allowed behaviour
  change is that a principle under `NEAR_DUPLICATE_MIN_TOKENS` no longer
  advises; the test pins that case.
- Implement: `src/core/brain/health/contradiction.ts`, where the
  `adviseOnIncoming` scoring loop calls `findNearDuplicates`. Reach stays
  where `write-advisory.ts` applies it today, through the `readable`
  argument.
- Commit: `refactor(brain): score the feedback write advisory through the shared kernel`

**B5. Stage instrumentation on write-side lookups** (after D1)
- Test first:
  - `tests/mcp/brain-create-note.test.ts`: with route metrics on, a create
    record carries `lint` and `near_duplicate_lookup` stages with finite,
    non-negative values. Only presence is asserted, never order.
  - `tests/core/brain/write-advisory.test.ts`: a feedback write records
    `near_duplicate_lookup`.
- Implement:
  - `notes-tools.ts`: wrap the lint in `timeStageSync(ROUTE_STAGE.lint, ...)`,
    and widening plus scoring in `ROUTE_STAGE.nearDuplicateLookup`.
  - `write-advisory.ts`: wrap the advisory computation in
    `ROUTE_STAGE.nearDuplicateLookup`.
- Commit: `feat(mcp): time the near-duplicate lookup and receipt lint stages`

### Lane C

**C1. Turn timestamp in the envelope**
- Test first: `tests/core/brain/extract-signals.test.ts`:
  - `MinedTurn.timestamp` equals the stored string verbatim;
  - the transcript line is `[turnId @ <ts>] text`;
  - an empty timestamp renders `[turnId] text`, and `now` is never
    substituted;
  - assistant turns stay excluded.

  If `tests/core/brain/extract-signals-prefilter.test.ts` pins the old line
  format, update it in this commit.
- Implement: `src/core/brain/extract-signals.ts`, at `MinedTurn` (`:186-189`),
  its construction (`:385`) and `buildMiningStep` (`:415-417`).
- Commit: `feat(brain): carry the turn timestamp into mined extract turns`

**C2. Language-neutral hygiene rules in the prompt**
- Test first: `tests/core/brain/extract-signals.test.ts`. The envelope
  instruction contains the five rule clauses:
  1. ISO bounds;
  2. skipping conversational mechanics;
  3. one rule per item;
  4. conditions kept;
  5. no restatements.

  The test also asserts that the envelope carries no per-language example
  words beyond what is there today.
- Implement: the `buildMiningStep` prompt and `schema_hints`.
- Commit: `feat(brain): add date-grounding and hygiene rules to the extract envelope`

**C3. Duplicate-topic refusal**
- Test first: `tests/core/brain/extract-signals.test.ts`:
  - two items with the same `topic` are refused whole under `crossItem`,
    and the message names both indices;
  - distinct topics pass;
  - the refusal happens before any write and before `computeDedupHash`.
- Implement: extend the single `registerResponseCheck` closure
  (`:302-329`).
- Commit: `feat(brain): refuse extract payloads that repeat a topic`

**C4. `turns_mined` timestamp projection**
- Test first: `tests/mcp/extract-signals-tool.test.ts`. The `turns_mined`
  entries carry `timestamp`, and the CLI JSON output carries the same field,
  asserted through the MCP bridge fixture.
- Implement: `src/mcp/brain/extract-tools.ts:61` and
  `src/cli/brain/verbs/extract-signals.ts:86`.
- Commit: `feat(mcp): expose the turn timestamp in turns_mined`

**C5. Downstream temporal proof and docs**
- Test first: `tests/core/brain/extract-signals-temporal.test.ts`. An
  extract payload whose principle carries an ISO bound produces a signal.
  A dream pass over that signal yields `valid_until` through the existing
  `extractTemporalConstraints`, with no new parser.
- Implement: `docs/cli-reference.md`, covering the envelope rules, the line
  format and the new refusal. No source change is expected. If the test
  exposes a gap, fix it in `extract-signals.ts` only.
- Commit: `test(brain): prove extract date grounding reaches the dream temporal window`

### Lane D

**D1. Route scope (substrate)**
- Test first: `tests/core/route-scope.test.ts`:
  - with no scope open, both helpers are a no-op and return the value of
    `fn`;
  - inside `run`, a sync stage is recorded;
  - repeated names are summed in first-seen order;
  - values are rounded to 0.1 ms;
  - an error inside a stage still records and rethrows;
  - `decisionMs()` matches the old behaviour;
  - `isRouteStageName` rejects names outside the set.
- Implement:
  - `src/core/route-scope.ts` (contract 0.6).
  - `src/core/decision-model/latency.ts` becomes a re-export plus a thin
    wrapper. Run `tests/core/decision-model/run.test.ts` unchanged to prove
    that nothing regressed.
- Commit: `feat(core): add a shared route scope for decision time and write stages`

**D2. Stages on the route-latency payload**
- Test first: `tests/core/brain/mcp-route-metrics.test.ts`:
  - `stages` is written only when it is non-empty;
  - an unknown name, a negative value and a non-finite value are dropped;
  - a hostile stage name, such as a path or a topic, never reaches the
    persisted continuity file;
  - records without stages are byte-identical.
- Implement: `src/core/brain/mcp-route-metrics.ts`, in
  `McpRouteLatencyInput` and in the payload build next to the `decision_ms`
  guard.
- Commit: `feat(brain): carry allowlisted write stages on mcp_route_latency`

**D3. Server wiring**
- Test first: `tests/mcp/route-metrics-tool.test.ts`:
  - with the gate on, a `brain_feedback` call through `callTool` yields a
    record with `stages`;
  - with the gate off, no record is written and no scope is opened;
  - `decision_ms` behaviour is unchanged.
- Implement: `src/mcp/server.ts`. `invokeToolHandler` uses
  `createRouteScope()` and spreads `stages` next to `decisionMs`. The reach
  gates stay before the timer.
- Commit: `feat(mcp): open one route scope per tool call and emit its stages`

**D4. Feedback-path stages**
- Test first: `tests/mcp/route-metrics-tool.test.ts`. A `brain_feedback`
  record carries `validate`, `idempotency_lookup`, `document_write`,
  `idempotency_remember` and `log_append`, and with `force_confirmed` it
  also carries `preference_write`. The idempotency mismatch error still
  propagates.
- Implement:
  - `src/core/brain/signal.ts`, at `:357`, `:382-399` and `:412`, without
    reordering the hash computation;
  - `src/mcp/brain/feedback-tools.ts`, at `:224` and `:270`.
- Commit: `feat(brain): time the signal write stages`

**D5. Note-write stages**
- Test first: `tests/mcp/route-metrics-tool.test.ts`. A `brain_create_note`
  record carries `document_write` and `write_receipt`, and a
  `brain_write_batch` record carries `write_receipt`.
- Implement:
  - `src/core/brain/notes/create-note.ts`, at `:570` and `:594`;
  - `src/core/brain/write-batch.ts`, at `:901`.
- Commit: `feat(brain): time the note write and receipt stages`

**D6. Per-stage roll-up and docs**
- Test first: `tests/core/brain/mcp-route-metrics.test.ts`. The summary
  gives each route a per-stage count, average and p95. A route without
  stages has no `stages` key in its summary.
- Implement:
  - `summarizeMcpRouteLatency` in `mcp-route-metrics.ts`;
  - the `brain_route_metrics` description in `src/mcp/brain/recall-tools.ts`;
  - `docs/observability.md`: the payload rows, the list of instrumented
    routes, the 0.1 ms precision, and a note that hook capture is not an MCP
    route.
- Commit: `feat(mcp): roll write stages up in brain_route_metrics summary`

### Integrator

**I1. Docs, changelog and version**
- Run the full targeted test set of all four lanes, then `bun run typecheck`
  (or the repo's equivalent script), then `oxlint` and `oxfmt --check` over
  the whole tree.
- `docs/mcp.md`:
  - the receipt hint: reach, widening and the `method` text;
  - `brain_review_candidates` `retire_siblings`;
  - the extract envelope;
  - the route-metrics row.
- `CHANGELOG.md`: a `## [1.74.0] - 2026-10-07` entry and its
  `[1.74.0]: https://github.com/itechmeat/open-second-brain/compare/v1.73.0...v1.74.0`
  link reference. The entry states the deferred items: rewordings,
  write-time embedding, the extract Jaccard refusal, hook timing and
  assistant-turn acceptance.
- Bump `package.json` to `1.74.0`, run `bun run scripts/sync-version.ts`,
  then `bun run scripts/sync-version.ts --check` and
  `bun run sync-plugin-mirrors:check`.
- Commit: `chore(release): v1.74.0 near-duplicate defense`

## 3. Integration rule

1. All lanes commit to `feat/near-duplicate-defense` in this worktree. A
   lane edits only its own files (section 1).
2. **Contract changes.**
   - A missing contract symbol is a blocker for the integrator. It is never
     a reason to edit another lane's file.
   - If a lane finds the contract wrong, it stops and reports. The
     integrator amends section 0, and the owning lane adapts.
3. **Commit order.** A1 and D1 should land first; both are small. A
   consuming task (B3, B4, B5) does not commit until the substrate it
   imports is committed and its tests pass on the branch.
4. **Integrator duties.**
   1. Run each lane's test files together, then the architecture censuses:
      `tests/core/architecture/visibility-surface-census.test.ts`,
      `egress-census.test.ts`, `write-site-census.test.ts` and
      `destructive-site-census.test.ts`. The expected delta is zero for
      egress, write sites and destructive sites.
   2. Finish I1.
   3. Run the full gates once.
5. **Hard-fail gates.** The PR is not opened while any of these fail:
   1. a surface lists or counts a near-duplicate candidate without a reach
      predicate;
   2. a provider embed call is reachable from a dream, write or extract
      path;
   3. a stage name outside `ROUTE_STAGE_NAMES` reaches disk;
   4. a new `moveToRetired` caller appears;
   5. `sync-version --check` or `sync-plugin-mirrors:check` fails.

## 4. Commit discipline (every lane, every commit)

1. **Stage by name only.**
   - For a new file, register it first with `git add -N <new-file>`.
   - Commit with `git commit --only <path> [<path> ...] -m "<subject>"`.
   - Never use `git add -A`, `git add .`, `git commit -a`, or a pathspec
     that covers another lane's files.
2. **Format and lint your own files before every commit.**

   ```
   ./node_modules/.bin/oxfmt <your files>
   ./node_modules/.bin/oxlint -c oxlint.json <your files>
   ```

   Both must be clean before you commit. The repo formats `.ts`, `.js`
   and `.json` (the `fmt` script in `package.json`). Markdown is not
   formatted, so don't pass `.md` files to oxfmt.
3. **Run your task's tests first.**

   ```
   env HOME=$(mktemp -d) bun test <paths>
   ```

   They must be green before you commit.
4. **If the pre-commit hook rejects the commit.** The hook checks the whole
   tree, so another lane's work in progress can fail it. Wait 30 seconds and
   retry, up to 5 times.

   Only after the fifth rejection may the lane commit with `--no-verify`.
   It must first prove its own files clean: rerun `oxfmt --check` and
   `oxlint` over exactly its committed paths, run its tests, and quote both
   outputs in the lane report. Never use `--no-verify` for a failure in the
   lane's own files.
5. **Write conventional subjects exactly as listed in section 2.** There is
   no AI attribution trailer or marker in any commit.
6. **The rest of the tree.**
   - Never commit `.reviews/`, scratch files or another lane's paths.
   - Never switch branches.
   - Never use bare `git stash`.
