# Recall Injection Lifecycle - implementation plan

Feature branch: `feat/recall-injection-lifecycle`. Design: `design.md` in this directory.

Every task follows TDD: write the listed tests first, watch them fail, implement until they pass. Each task ends in one atomic conventional commit, and `bun run fmt:check`, `bun run lint` and `bun run typecheck` must be green before the commit. Commit with `git commit --only <owned files>` and never use `git add .`, because lanes run in parallel in one working tree.

## Lanes and file ownership

There are four lanes, and no file belongs to more than one of them. A lane never edits another lane's files. When it needs something from another lane, it imports only the exports pinned in the contract below.

| Lane | Tasks | Owns (exclusive) |
|---|---|---|
| S - substrate | S1, S2, S3 | `hooks/lib/session-state.ts`, `hooks/lib/injection-ledger.ts` (new), `src/core/config.ts`, `tests/hooks/session-state.test.ts`, `tests/hooks/injection-ledger.test.ts` (new), `tests/core/config-recall-inject.test.ts` (new) |
| A - recall | A1, A2, A3, A4 | `src/core/brain/recall-inject.ts`, `hooks/recall-inject.ts`, `tests/core/brain/recall-inject.test.ts`, `tests/core/brain/recall-inject-slices.test.ts` (new), `tests/hooks/recall-inject.test.ts`, `tests/hooks/recall-inject-dedupe.test.ts` (new) |
| B - slice declaration | B1 | `src/core/brain/policy/blocks/recall-inject.ts` (new), `src/core/brain/policy/validate.ts`, `src/core/brain/types.ts`, `tests/core/brain/policy/recall-inject-block.test.ts` (new) |
| C - active digest and re-delivery | C1, C2, C3, C4 | `src/core/brain/reground-parts.ts` (new), `hooks/active-inject.ts`, `hooks/reground-deliver.ts` (new), `hooks/hooks.json`, `plugins/codex/hooks/hooks.json` (generated), `tests/core/brain/reground-parts.test.ts` (new), `tests/hooks/active-inject-ledger.test.ts` (new), `tests/hooks/active-inject-reground.test.ts` (new), `tests/hooks/reground-deliver.test.ts` (new), `tests/hooks/hooks-json-shape.test.ts`, `tests/core/install/adapters/grok-hook-parity.test.ts` |
| D - docs (after all lanes) | D1 | `docs/decision-models/recall-inject.md`, `docs/cli-reference.md`, `docs/observability.md`, `hooks/README.md` |

Order: S1 -> S2 -> S3 are committed first. B1 and C1 have no dependency and may start at once. A1 needs nothing from S, but A2 needs S. A3 needs B1. C2 needs S. D1 runs last.

## Cross-lane contract (pinned)

### `hooks/lib/session-state.ts` (S1)

```ts
export const HOOK_STATE_STALE_LOCK_MS = 30_000;
export type HookStateMutator<T> = (
  state: Record<string, unknown>,
  nowMs: number,
) => { readonly state: Record<string, unknown>; readonly result: T };
export type HookStateUpdateOutcome<T> =
  | { readonly status: "ok"; readonly result: T }
  | { readonly status: "busy" }
  | { readonly status: "failed" };
export function updateHookState<T>(
  vault: string,
  sessionId: string | null | undefined,
  mutate: HookStateMutator<T>,
  opts?: { readonly tryOnce?: boolean; readonly nowMs?: number },
): HookStateUpdateOutcome<T>;
export function pruneHookStateFiles(
  vault: string,
  opts?: { readonly maxAgeMs?: number; readonly maxFiles?: number; readonly nowMs?: number },
): number; // defaults: 7 days, 200 files; returns files removed; never throws
```

### `hooks/lib/injection-ledger.ts` (S2)

```ts
export const LEDGER_KEY_RECALL = "osb.recall_inject.injected";
export const LEDGER_KEY_ACTIVE = "osb.active_inject.emitted";
export const LEDGER_KEY_REGROUND = "osb.reground.queue";
export const LEDGER_TTL_MS = 86_400_000; // 24 h, refreshed on every write
export function isRealSessionId(sessionId: unknown): sessionId is string;
export function recallNoteKey(note: {
  readonly path: string;
  readonly origin?: string;
  readonly startLine: number;
  readonly endLine: number;
}): string; // `${origin ?? ""}:${path}#L${startLine}-L${endLine}`
export function readRecallInjected(vault: string, sessionId: string, nowMs?: number): ReadonlySet<string>;
export function recordRecallInjected(
  vault: string,
  sessionId: string,
  keys: ReadonlyArray<string>,
  nowMs?: number,
): boolean; // merges into the existing set
export function readActiveEmittedPaths(vault: string, sessionId: string, nowMs?: number): ReadonlySet<string>;
export function digestNotePaths(input: {
  readonly emittedText: string;
  readonly activeBodyEmitted: boolean;
  readonly lessonsBodyEmitted: boolean;
}): ReadonlyArray<string>; // `pref-<slug>` tokens -> Brain/preferences/pref-<slug>.md, plus Brain/active.md / Brain/lessons.md
export function beginInjectionEpoch(
  vault: string,
  sessionId: string,
  input: {
    readonly epoch: string;
    readonly emittedPaths: ReadonlyArray<string>;
    readonly regroundParts: ReadonlyArray<string>; // parts 2..n; empty deletes the queue
    readonly partCeilingChars: number;
  },
  nowMs?: number,
): boolean; // one locked write: set ACTIVE, delete RECALL, set or delete REGROUND
export type RegroundTake =
  | {
      readonly status: "part";
      readonly part: string;
      readonly index: number; // 1-based position in the full split (first queued part is 2)
      readonly total: number;
      readonly epoch: string;
      readonly partCeilingChars: number;
    }
  | { readonly status: "empty" }
  | { readonly status: "busy" }
  | { readonly status: "failed" };
export function takeRegroundPart(vault: string, sessionId: string, nowMs?: number): RegroundTake; // tryOnce
```

### `src/core/config.ts` (S3)

```ts
export interface RecallInjectCapsResolution {
  readonly caps: {
    readonly maxNotes?: number;
    readonly maxChars?: number;
    readonly timeBudgetMs?: number;
    readonly confidenceFloor?: number;
  };
  readonly invalid: ReadonlyArray<string>; // config key names whose value was rejected
}
export function resolveRecallInjectCaps(configPath?: string): RecallInjectCapsResolution;
export function resolveRecallInjectDedupe(configPath?: string): boolean; // default true
export function resolveRegroundPartsEnabled(configPath?: string): boolean; // default false
export const REGROUND_PART_CHARS_DEFAULT = 9000;
export function resolveRegroundPartChars(
  runtime: "claudecode" | "codex",
  configPath?: string,
): number;
```

The config keys and env overrides follow. Env always wins over the config value.

| Config key | Env override | Range / default |
|---|---|---|
| `recall_inject_max_notes` | `OPEN_SECOND_BRAIN_RECALL_INJECT_MAX_NOTES` | integer 1..10 |
| `recall_inject_max_chars` | `OPEN_SECOND_BRAIN_RECALL_INJECT_MAX_CHARS` | integer 200..8000 |
| `recall_inject_time_budget_ms` | `OPEN_SECOND_BRAIN_RECALL_INJECT_TIME_BUDGET_MS` | integer 250..6000 |
| `recall_inject_confidence_floor` | `OPEN_SECOND_BRAIN_RECALL_INJECT_CONFIDENCE_FLOOR` | number 0..1 |
| `recall_inject_dedupe` | `OPEN_SECOND_BRAIN_RECALL_INJECT_DEDUPE` | boolean, default `true` |
| `reground_parts_enabled` | `OPEN_SECOND_BRAIN_REGROUND_PARTS_ENABLED` | boolean, default `false` |
| `reground_part_chars` | `OPEN_SECOND_BRAIN_REGROUND_PART_CHARS` | integer 2000..100000, default 9000 |
| `reground_part_chars_claudecode` | `OPEN_SECOND_BRAIN_REGROUND_PART_CHARS_CLAUDECODE` | as above, wins over `reground_part_chars` |
| `reground_part_chars_codex` | `OPEN_SECOND_BRAIN_REGROUND_PART_CHARS_CODEX` | as above, wins over `reground_part_chars` |

### `src/core/brain/types.ts` (B1)

```ts
export interface RecallSliceSpec {
  readonly name: string; // ^[a-z][a-z0-9]{0,23}$
  readonly heading: string; // defaults to name
  readonly pathPrefix: string | null;
  readonly types: ReadonlyArray<string>; // frontmatter `type` values; empty = no class filter
  readonly limit: number | null; // 1..10
  readonly maxChars: number | null; // 100..8000
}
export interface BrainRecallInjectConfig {
  readonly slices: ReadonlyArray<RecallSliceSpec>; // declared order, at most 6
}
// BrainConfig gains: readonly recall_inject?: BrainRecallInjectConfig;
```

`_brain.yaml` shape (B1):

```yaml
recall_inject:
  slices: [decisions, lessons]
  slice_decisions_heading: Recent decisions
  slice_decisions_path_prefix: Brain/decisions/
  slice_decisions_types: [decision]
  slice_decisions_limit: 2
  slice_decisions_max_chars: 400
  slice_lessons_path_prefix: Brain/lessons
```

### `src/core/brain/recall-inject.ts` additions (A1, A3)

```ts
// RecallAbstainReason gains: | "all_already_injected" | "all_slices_abstained"
// RecallInjectOptions gains:
//   readonly alreadyInjected?: ReadonlySet<string>;    // recallNoteKey values
//   readonly activeDigestPaths?: ReadonlySet<string>;  // vault-relative paths, path-only match
//   readonly slices?: ReadonlyArray<RecallSliceSpec>;
//   readonly sliceRetriever?: (slice: RecallSliceSpec, limit: number) => RecallRetriever;
// The inject decision variant gains:
//   readonly injectedNotes: ReadonlyArray<{ path: string; origin?: string; startLine: number; endLine: number }>;
//   readonly slices?: ReadonlyArray<{ name: string; outcome: "inject" | RecallAbstainReason; notes: number }>;
export interface RecallRetrieverFilter {
  readonly limit?: number;
  readonly pathPrefix?: string;
  readonly types?: ReadonlyArray<string>;
}
// defaultRecallRetriever(configPath, vault, limitOrFilter: number | RecallRetrieverFilter = RECALL_INJECT_MAX_NOTES)
```

### `src/core/brain/reground-parts.ts` (C1)

```ts
export const REGROUND_MAX_PARTS = 8;
export interface RegroundSplit {
  readonly parts: ReadonlyArray<string>; // parts[0] is emitted now; a lone part equals the joined input byte for byte
  readonly utf16Chars: number; // length of the unsplit joined context
  readonly partsDropped: number;
  readonly overBudget: boolean; // any part > ceiling, or partsDropped > 0
}
export function splitRegroundParts(
  blocks: ReadonlyArray<string>, // standing, scoped, memory, in priority order
  ceilingChars: number,
  join: (blocks: ReadonlyArray<string>) => string, // active-inject's joinBlocks, so the fit case is identical
): RegroundSplit;
```

## Tasks

### Task S1: Locked multi-key hook-state update, stale-lock takeover, prune
- **Lane**: S
- **Files**: `hooks/lib/session-state.ts`, `tests/hooks/session-state.test.ts`
- **Tests first** (in `tests/hooks/session-state.test.ts`):
  - `updateHookState` applies a mutator under the scope lock and preserves other keys.
  - With `tryOnce: true` and a held lock it returns `busy` within 20 ms, with no retry loop.
  - Without `tryOnce` it keeps today's 20 x 5 ms retry.
  - A lockfile with mtime older than `HOOK_STATE_STALE_LOCK_MS` is taken over.
  - Writes leave no partial file: the state file is replaced by rename, and no `*.tmp` is left behind.
  - `writeHookStamp` still round-trips with `readHookStamp` (existing cases unchanged).
  - `pruneHookStateFiles` removes only files older than `maxAgeMs`, stops at `maxFiles`, ignores lockfiles and non-JSON files, and returns 0 on a missing directory.
- **What**: implement the S1 contract. Writes go through `atomicWriteFileSync` (`src/core/fs-atomic.ts`), including `writeHookStamp`. Stale takeover unlinks the lockfile only when its mtime is older than the threshold, then makes one fresh `acquireLockSync` attempt.
- **Acceptance**: `bun test tests/hooks/session-state.test.ts tests/hooks/nav-inject.test.ts tests/hooks/pretool-orient.test.ts`
- **Depends on**: none

### Task S2: Injection ledger module
- **Lane**: S
- **Files**: `hooks/lib/injection-ledger.ts` (new), `tests/hooks/injection-ledger.test.ts` (new)
- **Tests first**:
  - `isRealSessionId` rejects `undefined`, `null`, `""` and non-strings.
  - `recallNoteKey` is stable and includes the origin and the line span.
  - `recordRecallInjected` merges sets and `readRecallInjected` returns them until `LEDGER_TTL_MS` passes.
  - `digestNotePaths` maps every `` `pref-<slug>` `` token and adds `Brain/active.md` and `Brain/lessons.md` only when flagged. Repeated tokens are deduped.
  - `beginInjectionEpoch` sets the active set, clears the recall set, and replaces or deletes the queue in one write.
  - `takeRegroundPart` returns parts 2..n in order, then `empty`. It returns `busy` while the lock is held, and a subsequent take still returns the undelivered part, so nothing is lost or duplicated.
  - Two interleaved takers in one process never receive the same index.
  - Each key is isolated per session id.
- **What**: implement the S2 contract on top of `updateHookState` and `readHookStamp`. `takeRegroundPart` passes `tryOnce: true`. The ledger is the only module that spells the three key strings.
- **Acceptance**: `bun test tests/hooks/injection-ledger.test.ts`
- **Depends on**: S1

### Task S3: Config resolvers for recall caps, dedupe and re-delivery
- **Lane**: S
- **Files**: `src/core/config.ts`, `tests/core/config-recall-inject.test.ts` (new)
- **Tests first**:
  - Each key resolves from config and from env, and env wins.
  - Out-of-range, non-numeric and non-integer values land in `invalid` and are omitted from `caps`.
  - Unset keys produce empty `caps` and empty `invalid`.
  - `resolveRecallInjectDedupe` defaults to true and treats `"false"` as false.
  - `resolveRegroundPartsEnabled` defaults to false.
  - `resolveRegroundPartChars` precedence is runtime key, then `reground_part_chars`, then 9000, and an invalid value falls through to the next level.
  - No resolver throws on a malformed config file.
- **What**: implement the S3 contract, using `resolveNavTierCadenceMinutes` as the lenient pattern and `resolveConfigFlag` for the booleans. `resolveRecallInjectDedupe` needs a default-true variant: a missing value is true, and only an explicit falsy literal is false.
- **Acceptance**: `bun test tests/core/config-recall-inject.test.ts tests/core/config-read-failure.test.ts`
- **Depends on**: none (it is ordered after S2 only to keep the substrate commits contiguous)

### Task B1: `recall_inject:` policy block and slice types
- **Lane**: B
- **Files**: `src/core/brain/types.ts`, `src/core/brain/policy/blocks/recall-inject.ts` (new), `src/core/brain/policy/validate.ts`, `tests/core/brain/policy/recall-inject-block.test.ts` (new)
- **Tests first**:
  - The YAML from the contract parses to two `RecallSliceSpec`s in declared order, with the heading defaulting to the name.
  - A vault without the block yields no `recall_inject` key on `BrainConfig`.
  - Each of these is a named hard error:
    - an unknown slice field
    - a `slice_*` key for an undeclared name
    - a duplicate name
    - a bad name pattern
    - more than 6 slices
    - `limit` outside 1..10
    - `max_chars` outside 100..8000
    - `types` that is not an array
  - An unknown non-slice key warns through `warnUnknownKeys` and does not error.
  - `path_prefix` is normalised to forward slashes, and a value containing `..` is rejected.
- **What**: add the types and `parseRecallInjectBlock(ctx)` modelled on `policy/blocks/active.ts` (`openBlock`, `requireIntegerInRange`, `warnUnknownKeys` for non-`slice_` keys), and register it in `policy/validate.ts` next to `parseActiveBlock`.
- **Acceptance**: `bun test tests/core/brain/policy/recall-inject-block.test.ts tests/core/brain/policy-active.test.ts tests/core/brain/policy-safe-loaders.test.ts`
- **Depends on**: none

### Task A1: Pure-core dedupe and cross-lane filter
- **Lane**: A
- **Files**: `src/core/brain/recall-inject.ts`, `tests/core/brain/recall-inject.test.ts`
- **Tests first**, using the existing fake retriever:
  - With `alreadyInjected` holding a candidate's key, that candidate is dropped after the floor check and the next one is kept.
  - `matchQuality` and the floor verdict are identical with and without the set, which pins the coupling.
  - When every surviving candidate is filtered, the result is `abstain` with `all_already_injected` and the same `matchQuality`.
  - A different line span of an injected path is not filtered.
  - `activeDigestPaths` filters by path on any span.
  - `injectedNotes` lists exactly the notes rendered: a note cut by the `maxChars` fit and a note removed by the decision filter are both absent.
  - With neither option set, the brief is byte-identical to a fixture captured before the change.
- **What**: add the options, the filter between the floor check and `ranked.slice(0, maxNotes)`, the new abstain reason, and `injectedNotes` on the inject variant, computed from the notes `renderRecallBrief` actually emitted and after `applyDecisionFilter`. The key function is a local mirror of `recallNoteKey` with the same format string. The contract test in A2 pins that both produce equal keys.
- **Acceptance**: `bun test tests/core/brain/recall-inject.test.ts tests/core/brain/recall-inject-decision.test.ts tests/core/bench/failure-modes.test.ts`
- **Depends on**: none

### Task A2: Hook wiring for caps, dedupe and cross-lane read
- **Lane**: A
- **Files**: `hooks/recall-inject.ts`, `tests/hooks/recall-inject.test.ts`, `tests/hooks/recall-inject-dedupe.test.ts` (new)
- **Tests first**:
  - Flag off: still no stdout, and no `hook-state/` directory is created (extends the existing no-op test).
  - An invalid `recall_inject_max_notes` lands in the audit line's `config_invalid`, and the decision still runs on the constant.
  - `recall-inject-dedupe.test.ts` builds an indexed temp vault (`tests/helpers/search-fixtures.ts`) and spawns the hook twice with one `session_id` and one prompt. The first run injects. The second run abstains with `all_already_injected` and records `deduped` in its audit line.
  - The same pair with no `session_id` injects both times.
  - With `recall_inject_dedupe: false`, both runs inject.
  - A ledger seeded through `beginInjectionEpoch` with a preference path suppresses that note.
  - `recallNoteKey` from the ledger equals the core's key for the same note.
- **What**: read `payload.session_id`. Pass `resolveRecallInjectCaps().caps` into `decideRecallInject`, and pass the caps' `maxNotes` as the retriever limit. When `isRealSessionId` and dedupe are both on, read `readRecallInjected` and `readActiveEmittedPaths` and pass them. After the stdout write, call `recordRecallInjected` with the keys of `decision.injectedNotes`. Every ledger touch sits after the `:209` opt-out.
- **Acceptance**: `bun test tests/hooks/recall-inject.test.ts tests/hooks/recall-inject-dedupe.test.ts tests/hooks/recall-inject-decision-model.test.ts`
- **Depends on**: A1, S2, S3

### Task A3: Pure-core slice execution and sectioned rendering
- **Lane**: A
- **Files**: `src/core/brain/recall-inject.ts`, `tests/core/brain/recall-inject-slices.test.ts` (new)
- **Tests first**, with fake per-slice retrievers:
  - Two slices render inside one fence under their headings, in declared order.
  - A slice below its own floor is omitted and recorded with outcome `below_floor`.
  - The global `maxNotes` and `maxChars` (fence included) bound the sum, and the slice declared later is the one clamped.
  - A note found by both slices appears once, in the first.
  - Dedupe options apply across slices.
  - All slices abstaining gives `all_slices_abstained` with per-slice outcomes.
  - The slices share one time budget: a slow slice past the budget makes the decision `error` with the timeout fault, not a partial inject.
  - A hostile heading is neutralised like a title.
  - `slices` undefined or empty takes exactly today's path, byte for byte.
- **What**: implement the slice path in `decideRecallInject`, the `RecallRetrieverFilter` form of `defaultRecallRetriever` (mapping `pathPrefix` and `types` onto `SearchOptions.pathPrefix` and `properties: Map([["type", types]])`), and a sectioned variant of `renderRecallBrief` that shares the fence and the neutralisers.
- **Acceptance**: `bun test tests/core/brain/recall-inject-slices.test.ts tests/core/brain/recall-inject.test.ts`
- **Depends on**: A1, B1

### Task A4: Hook wiring for slices
- **Lane**: A
- **Files**: `hooks/recall-inject.ts`, `tests/hooks/recall-inject-dedupe.test.ts`
- **Tests first** (in the indexed-fixture suite):
  - A vault with a `recall_inject:` block holding one `path_prefix` slice injects only notes under that prefix, under the slice heading, and the audit line carries `slices` with per-slice counts.
  - A vault whose `_brain.yaml` fails to load falls back to the unsliced path, and the audit line records `slices_config: "invalid"`.
- **What**: load `loadBrainConfig(vault).recall_inject?.slices` inside the existing try boundary, and pass `slices` plus a `sliceRetriever` built from `defaultRecallRetriever(configPath, vault, {limit, pathPrefix, types})`.
- **Acceptance**: `bun test tests/hooks/recall-inject-dedupe.test.ts tests/hooks/recall-inject.test.ts`
- **Depends on**: A2, A3

### Task C1: Pure re-delivery splitter
- **Lane**: C
- **Files**: `src/core/brain/reground-parts.ts` (new), `tests/core/brain/reground-parts.test.ts` (new)
- **Tests first**:
  - If the joined input fits the ceiling, the result is one part that equals `join(blocks)` byte for byte.
  - Over the ceiling, every part is at most the ceiling in `.length` with the header and trailer included.
  - Block order is preserved and the standing block starts part 1.
  - Splitting prefers block, then paragraph, then line boundaries.
  - A single 30,000-char line is hard-cut.
  - More than `REGROUND_MAX_PARTS` parts gives `partsDropped > 0` and `overBudget`.
  - Astral characters (surrogate pairs) are never cut in half.
  - `utf16Chars` equals `join(blocks).length`.
- **What**: implement the C1 contract with the header and trailer texts from `design.md`.
- **Acceptance**: `bun test tests/core/brain/reground-parts.test.ts`
- **Depends on**: none

### Task C2: active-inject records the injection epoch and the emitted set
- **Lane**: C
- **Files**: `hooks/active-inject.ts`, `tests/hooks/active-inject-ledger.test.ts` (new)
- **Tests first**:
  - With `recall_inject_enabled` on and a `session_id`, a SessionStart writes `osb.active_inject.emitted` holding the pref paths present in the emitted body and clears a pre-seeded `osb.recall_inject.injected`.
  - A preference cut by the budget is absent from the set.
  - With both recall and reground flags off, no `hook-state/` file is written and stdout is byte-identical to the existing `active-inject.test.ts` expectations.
  - Without a `session_id`, nothing is written.
  - On `startup`, a 10-day-old scope file is pruned.
  - A ledger write failure (read-only state directory) leaves stdout unchanged and the exit code 0.
- **What**: after the stdout write and beside `recordInjectionSize`, call `beginInjectionEpoch` (epoch is `${source}:${Date.now()}`) with `digestNotePaths` over the emitted text, gated as described in `design.md`. Call `pruneHookStateFiles` on `source === "startup"` after a successful ledger write. In this task `regroundParts` is always empty.
- **Acceptance**: `bun test tests/hooks/active-inject-ledger.test.ts tests/hooks/active-inject.test.ts tests/hooks/active-inject-meter.test.ts tests/hooks/active-inject-scoped-rules.test.ts`
- **Depends on**: S1, S2, S3

### Task C3: active-inject splits an oversized payload and meters it
- **Lane**: C
- **Files**: `hooks/active-inject.ts`, `tests/hooks/active-inject-reground.test.ts` (new)
- **Tests first**:
  - With `reground_parts_enabled` on, a Claude Code-shaped payload (a `transcript_path` under `/.claude/projects/`) and standing rules plus a body totalling 20,000 chars, stdout carries only part 1, and the ledger holds parts 2..n under the new epoch.
  - The same with `reground_part_chars_claudecode: 5000` produces more parts.
  - A grok-shaped or unknown payload emits the single full payload and queues nothing.
  - Under the ceiling, the output is byte-identical with the flag on.
  - The receipt carries `utf16_chars`, `part_ceiling_chars`, `parts_total`, `parts_dropped` and `over_budget` only when the flag is on.
  - The receipt with the flag off deep-equals the existing meter expectation.
  - The emitted set from C2 includes pref paths from the queued parts.
- **What**: resolve the runtime with `detectHookRuntime`. When the flag is on and the runtime is `claudecode` or `codex`, call `splitRegroundParts([standingBlock, scopedBlock, memoryContext], resolveRegroundPartChars(runtime), joinBlocks)`, write `parts[0]`, and pass `parts.slice(1)` to `beginInjectionEpoch`. Then extend `recordInjectionSize` with the meter fields.
- **Acceptance**: `bun test tests/hooks/active-inject-reground.test.ts tests/hooks/active-inject-ledger.test.ts tests/hooks/active-inject.test.ts tests/hooks/active-inject-meter.test.ts`
- **Depends on**: C1, C2

### Task C4: `reground-deliver` carrier hook and registration
- **Lane**: C
- **Files**: `hooks/reground-deliver.ts` (new), `hooks/hooks.json`, `plugins/codex/hooks/hooks.json` (generated), `tests/hooks/reground-deliver.test.ts` (new), `tests/hooks/hooks-json-shape.test.ts`, `tests/core/install/adapters/grok-hook-parity.test.ts`
- **Tests first** (spawned hook):
  - Flag off: no stdout, no vault resolution and no `hook-state/` directory.
  - Flag on with a queue seeded through `beginInjectionEpoch`:
    - each PostToolUse spawn emits the next part as `hookSpecificOutput.additionalContext` with `hookEventName: "PostToolUse"`, then nothing once the queue is empty
    - a UserPromptSubmit spawn emits the next part with `hookEventName: "UserPromptSubmit"`
    - a held scope lock makes the spawn emit nothing and exit 0 within its budget, and the part is delivered by the next spawn
    - every delivery appends one audit line with `part`, `total`, `epoch`, `bytes`, `utf16_chars`, `part_ceiling_chars` and `over_budget`
  - Any other `hook_event_name` emits nothing.
  - `hooks-json-shape` asserts the PostToolUse `*` and UserPromptSubmit `*` entries end in the `o2b-hook reground-deliver` fallback.
  - The grok parity test declares `PostToolUse:reground-deliver` and `UserPromptSubmit:reground-deliver` as divergences with the reason "chunked re-delivery splits only for Claude Code and Codex; grok keeps the single SessionStart payload".
- **What**: write the hook. It reads stdin, checks the flag with `resolveRegroundPartsEnabled` before anything else, then checks `isRealSessionId`, resolves the vault, calls `takeRegroundPart`, writes stdout on `part`, and appends the audit line through the hook-audit root builder (`tests/hooks/audit-root.test.ts` enforces this). It arms the process ceiling like its siblings. Register it in `hooks/hooks.json`: a new PostToolUse group with matcher `*`, and a fourth command appended to the UserPromptSubmit `*` group. Then run `bun run sync-plugin-mirrors`.
- **Acceptance**: `bun test tests/hooks/reground-deliver.test.ts tests/hooks/hooks-json-shape.test.ts tests/hooks/audit-root.test.ts tests/core/install/adapters/grok-hook-parity.test.ts tests/scripts/sync-plugin-mirrors.test.ts && bun run sync-plugin-mirrors:check`
- **Depends on**: S2, S3, C3

### Task D1: Documentation
- **Lane**: D
- **Files**: `docs/decision-models/recall-inject.md`, `docs/cli-reference.md`, `docs/observability.md`, `hooks/README.md`
- **What**:
  - `docs/cli-reference.md` gets every config key from the S3 table, with env names, ranges and defaults (beside `recall_inject_enabled` at :739 and the context-delivery keys at :816), plus the `recall_inject:` `_brain.yaml` block with the contract example.
  - `docs/decision-models/recall-inject.md` covers dedupe semantics, the cross-lane digest filter, the two new abstain reasons and slice clamping.
  - `docs/observability.md` covers the new receipt and audit fields.
  - `hooks/README.md` gets rows for the two `reground-deliver` registrations.
  - The root `README.md` lists no hook config keys and stays unchanged.
- **Acceptance**: `bun test tests/docs` and `bun run link-ratchet:check`
- **Depends on**: A4, B1, C4

## Version bump and CHANGELOG

None of these tasks bumps the version or edits `CHANGELOG.md`. The bump to the next minor version, the `CHANGELOG.md` entry with its compare link (including the disclosure that `recall_inject_dedupe` defaults to true for existing opt-in users) and `bun run scripts/sync-version.ts` all happen later in the `osb-pr-prepare` phase, inside the same pull request.
