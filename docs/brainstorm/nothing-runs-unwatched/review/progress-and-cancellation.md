# Independent review — the progress spine and the cancellation wiring

Branch `feat/nothing-runs-unwatched` against `main`. Scope as assigned:
`src/core/brain/progress.ts`, `safeguard.ts`, `src/cli/progress-rail.ts`,
`src/cli/interrupt.ts`, every emitter, the CLI verbs that attach them, and
the progress tests including `tests/core/architecture/progress-census.test.ts`.

Everything under CONFIRMED was reproduced by running code — either the
repository's own modules in a throwaway `git worktree`, or the shipped test
suite against a deliberately broken copy of production. The worktree was
removed and `git status` is clean; nothing in the tree was modified.

The release's thesis is that a mechanism which must be called by hand will
be missed, and that the answer is declaration plus a census. The findings
below are, almost without exception, instances of that same thesis applied
to this branch: the census is syntactic and does not reach the properties
the release cares about, and the two headline mechanisms — the terminator
and the interrupt — are each provably removable without turning a single
test red.

---

## CONFIRMED

### 1. Ctrl-C cannot stop four of the six operations, because they are fully synchronous

`src/cli/interrupt.ts:80` (`onInterrupt`), `src/core/brain/safeguard.ts:155`
(`checkpoint`), `src/core/brain/dream.ts:174` (`dreamRun`),
`src/core/brain/link-graph/communities.ts:98`,
`src/core/brain/link-graph/bridge-discovery.ts:107`,
`src/core/brain/architect/generate.ts:301`.

`onInterrupt` aborts an `AbortController` from a `process.once("SIGINT")`
handler. A Node/Bun signal handler is a JavaScript callback dispatched from
the event loop. `dreamRun`, `detectCommunitiesRun`, `discoverBridgesRun` and
`generateRun` are all declared `function`, not `async`, and contain no
`await` — so from the moment the pass starts until the moment it returns,
the process never re-enters the event loop and the handler cannot run. The
signal is pending, `signal.aborted` stays `false`, and every
`safeguard.checkpoint()` inside the pass passes.

Reproduced twice. First, the platform fact in isolation: a SIGINT delivered
0.3 s into a 2 s synchronous loop left `controller.signal.aborted === false`
for all 15.8 million iterations, and became `true` only on the next event-loop
turn. Second, end to end against this repository's own modules — `onInterrupt()`
plus `createSafeguard({operation:"dream", signal})`, calling `checkpoint()` in
a synchronous loop exactly as `dream` does:

```
{"checkpoints":26780673,"stoppedByCtrlC":false,"receivedDuringRun":null}
```

26.7 million checkpoints ran with the interrupt pending; `SafeguardAbortError`
was never thrown; `interrupt.received()` was still `null` when the pass ended.

**Failure scenario.** Operator runs `o2b brain dream` on a large vault, presses
Ctrl-C. Nothing happens. The pass runs to completion and writes every artifact
it was going to write. Only the *second* Ctrl-C stops it — by killing the
process outright, which is the SIGKILL-equivalent outcome this unit was
written to replace.

The module header already knows the shape of this ("a JavaScript timer cannot
interrupt a fully-synchronous CPU hang on a single thread, and neither can a
cooperative signal") but frames it as the pathological hang case. It is in
fact the *normal* case for `dream`, `bridges`, `clusters` and `architect`:
those four are synchronous end to end, so the cooperative signal is
unobservable for their entire duration, not merely during a hang. Only the
index run (which awaits real I/O — `provider.embed`) and the maintenance lane
(which awaits between tasks) can see it.

This makes `SafeguardAbortError` reachable in production only from the index
path, in a release whose stated purpose was to give that class a producer.
The core test that "proves the wiring" (`dream-progress.test.ts:158`) passes a
*pre-aborted* `AbortController` straight into `dream`, which exercises the
`createSafeguard` priority rule and nothing about signal delivery. Its own
comment concedes it declines to race a real interrupt.

Confidence: high. The synchronous-execution fact is checkable by inspection;
both reproductions used production code.

### 2. The first Ctrl-C is now swallowed, and the verb still exits 0

`src/cli/interrupt.ts:91` (`process.once(name, listener)`), and every verb
that calls `onInterrupt()` outside the region that checks the signal:
`src/cli/brain/verbs/bridges.ts:161`, `clusters.ts:139`, `dream.ts:409`,
`architect.ts:52`, `src/cli/search/verbs/indexing.ts` (both builders),
`src/cli/brain/verbs/maintenance.ts:157`.

Registering a SIGINT listener suppresses the default terminate behaviour for
as long as it is registered. The handle is open across work that never
consults the signal: `Store.open`, `writeBridgeProposals`, `appendMetric`,
`materializeClusterNotes`, `reportIndexRun`, `resolveSearchConfig`, the whole
reindex swap. A Ctrl-C landing in any of those windows is absorbed — the
controller aborts, nobody reads it, and the verb completes normally.

Reproduced with the repository's `onInterrupt`:

```
{"received":"SIGINT","aborted":true}
verb returned 0 after a Ctrl-C nobody acted on
exit=0
```

**Failure scenario.** `o2b brain bridges discover` has finished scanning and is
writing proposals. Operator presses Ctrl-C. The keystroke does nothing visible;
the command writes the file, prints its report, and exits 0. Before this branch
the same keystroke killed the process immediately. Only
`maintenance.ts:274` consults `interrupt.received()` after the fact; the other
five verbs check `instanceof SafeguardAbortError` only, so an absorbed signal
leaves no trace at all.

Combined with finding 1, the net effect on `dream`, `bridges`, `clusters` and
`architect` is that Ctrl-C responsiveness is strictly *worse* after this
branch than before it: the first press used to terminate, and now does nothing.

Confidence: high.

### 3. Removing the terminator from the entire index run breaks no test

`src/core/search/indexer.ts:320-330` (`indexInto` / `withProgressAsync`),
`tests/cli/search-index-progress.test.ts`.

The branch's final commit is titled "a stream that stops arriving has reported
nothing". I deleted the `withProgressAsync` wrapper from `indexInto` so that
`o2b search index --progress` and `o2b search reindex --progress` emit
`started` and `advanced` records and then simply stop — no `finished`, no
`stopped`, ever. Result:

```
tests/cli/search-index-progress.test.ts + tests/core/search  →  1319 pass, 0 fail
tests/core/architecture + progress rails                     →   159 pass, 0 fail
```

Neither CLI progress test for the index asserts a terminator; both stop at
`records.length > 0` and `operation === "reindex"`. Only
`tests/core/brain/dream-progress.test.ts` and
`tests/core/brain/architect-progress.test.ts` assert `finished`, and only for
their own operations. The bridges, clusters, maintenance and architect CLI
progress tests assert no terminator either (`grep` for `finished` in those five
files returns nothing).

**What this means.** The property the release is named for is untested for the
operation most likely to run for minutes.

Confidence: certain (reproduced).

### 4. `withProgress` emits no terminator on a crash — the documented contract is the opposite

`src/core/brain/progress.ts:282` (`withProgress`), `:295` (`withProgressAsync`).

The docblock opens: *"Run `body` and terminate `counter` exactly once,
whichever way it ends."* The code terminates on success and on a safeguard
stop only; `progressReasonForError` returns `null` for anything else and no
event is emitted. Reproduced:

```
events on a crash: ["started"]
```

The second paragraph of the same docblock argues the case for not calling a
crash a cancellation — which is right — but the conclusion drawn is silence,
and silence is the exact failure mode the module's own three-way argument
rejects ("a stream that simply STOPS arriving is the shape of a completed run,
a crashed run and a hung run all at once"). There is no `failed` arm in
`PROGRESS_KIND` to carry the third case.

**Reachable production scenario.** `generateArchDocs`: `scanProject` emits
`started:walk` and N `advanced:walk` records, then `mkdirSync` on the vault
arch directory fails with EACCES, or `acquireLockSyncWithRetry(dir)`
(`generate.ts:340`) exhausts its retries. Neither is a safeguard error, so the
render counter — which has no stage open — emits nothing, the walk counter is
never terminated, and the stream ends mid-walk. Same for `dream`: any plain
throw inside `dreamRun` (malformed `_brain.yaml` reaching `loadBrainConfig`, an
`atomicWriteFileSync` failure in the apply stage) leaves the stream on
`started:scan` forever. The CLI prints a prose error on stderr, but the
structured stream an adapter parses carries no terminator.

Confidence: certain for the counter behaviour (reproduced); high for the
production paths (read, not run).

### 5. The counter enforces neither monotonicity nor a terminal state

`src/core/brain/progress.ts:248` (`advance`), `:258` (`finish`), `:261` (`stop`).

`ProgressEvent.completed` is documented as *"Units finished in this stage so
far. Monotonic within a stage."* and the event shape as *"Integers and
identifiers only."* `assertTotal` guards the denominator; nothing guards the
numerator, and nothing marks the counter terminal. Reproduced in one run:

```
["started:scan:0/3","advanced:scan:-5/3","advanced:scan:94/3","advanced:scan:95.5/3",
 "finished:scan:95.5/3","advanced:scan:96.5/3","finished:scan:96.5/3","stopped:scan:96.5/3"]
```

`completed` went negative, exceeded `total` by 31×, became fractional, and the
stream carried an `advanced` **after** `finished` plus three terminators. The
asymmetry is the defect: a bad `total` is "a loud defect, not a wrong number",
a bad `by` is a wrong number reported confidently.

`finish()` and `stop()` before any `start()` emit nothing at all (also
reproduced: `no-stage terminators emitted: []`), which is why finding 4's
architect path is silent rather than merely mis-labelled.

Confidence: certain (reproduced).

### 6. The census passes four different ways of taking a safeguard and reporting nothing

`tests/core/architecture/progress-census.test.ts:116-135` (the rule),
`:92-110` (`interfaceBlocks`), `:204-218` (the sync check).

I added each of the following to `src/core/brain/`, one at a time, and ran the
census. All four passed (6 pass, 0 fail). A positive control —
`export interface EvadePlainOptions { readonly safeguard?: Safeguard; }` —
correctly failed, so the census works only for the exact shape it recognises.

| Evasion | Why it passes |
|---|---|
| `interface X { readonly safeguard: Safeguard }` (required, not optional) | The file filter is `source.includes("safeguard?:")` and the member regex is `/\breadonly safeguard\?:/`. A required safeguard is invisible. |
| `type X = { readonly safeguard?: Safeguard }` | `interfaceBlocks` matches `interface\s+(\w+)[^{]*\{` only. A type-alias options object is never enumerated. |
| `interface X<T extends { k: string }> { readonly safeguard?: Safeguard }` | The header regex's `[^{]*` cannot cross the `{` inside the generic constraint, so brace-matching starts inside the constraint and the block "body" is `k: string`. The real body is never scanned. |
| A `Promise`-returning sink split over three lines | The sync check is line-based (`if (!line.includes("onProgress?:")) continue`), so a declaration whose return type is on a later line never meets the `Promise<` test. |

The generics case is the one to fix first: it does not merely fail to flag a
violation, it silently mis-parses a block that *is* in the population.

Beyond the parser, the rule itself is declaration-only. Nothing checks that a
declared `onProgress` is ever read, that a counter is ever built, that a
terminator is ever emitted, or that any CLI verb attaches a sink. An interface
satisfies the census by declaring a field it ignores.

Confidence: certain (reproduced, with positive control).

### 7. The "no prose" rule does not cover the three emitters that use a bare stage constant

`tests/core/architecture/progress-census.test.ts:160-202`,
`src/core/brain/link-graph/bridge-discovery.ts:87`,
`src/core/brain/link-graph/communities.ts:78`,
`src/core/search/vector-backfill.ts:107`.

Test 4 matches `start(` followed by either `CONST.member` or a `"literal"`, and
`advance(` followed by a `"literal"`. Test 5 matches only
`const \w*STAGE = Object.freeze({...})`. Three emitters declare their stage as
a bare string constant — `const BRIDGE_STAGE = "candidates"`,
`const COMMUNITY_STAGE = "sweep"`, `const VECTOR_BACKFILL_STAGE = "plan"` —
which is neither a dotted member reference nor an inline literal nor a frozen
object, so **neither** test ever sees its value.

Reproduced. I rewrote both link-graph constants to prose:

```ts
const BRIDGE_STAGE = "Scanning candidate pairs, please wait...";
const COMMUNITY_STAGE = "Propagating labels ACROSS the graph";
```

Census: 6 pass, 0 fail. The CLI-level guards would catch it for `clusters`
(`brain-clusters-progress.test.ts` matches `STAGE_IDENTIFIER`) but not for
`bridges`, whose progress test never inspects `stage`, and not for the
standalone vector backfill, which has no CLI progress test at all.

Confidence: certain (reproduced).

### 8. The whole cancellation wiring can be deleted with no test failure

Every `signal: interrupt.signal` in `src/cli/brain/verbs/{dream,bridges,clusters,architect,maintenance}.ts`
and `src/cli/search/verbs/indexing.ts`.

I removed the signal from all six verbs — the complete U3 wiring, leaving
`onInterrupt()` registered but connected to nothing — and ran
`tests/cli` + `dream-progress` + `tests/core/architecture`:

```
1339 pass, 0 fail (181 files, 141.92 s)
```

The only assertions the branch offers for the interrupt are
`expect(EXIT_INTERRUPTED).toBe(130)` (a constant compared to a literal) and
`reportInterrupted` called with a hand-constructed `SafeguardAbortError`. No
test drives a signal through a verb into an operation.

Confidence: certain (reproduced).

### 9. `search reindex --progress` reports `finished` before the rebuild is swapped in

`src/core/search/indexer.ts:1028` (`indexVault` returns, terminating the
stream) vs `:1032-1044` (marker clear, `tryUnlink`, `tryRename`,
`renameSync`).

`reindexVault` forwards `onProgress` into `indexVault`, which owns the counter
and calls `finish()` when the staging build completes. The atomic swap that
actually makes the rebuild real happens *after* that, outside any counter.

**Failure scenario.** `renameSync(newPath, config.dbPath)` fails (ENOSPC, EPERM
on the target directory, a cross-device `dbPath`). A caller tailing the
progress stream has already received `{"kind":"finished"}`; the command then
exits non-zero having left the live index untouched. The terminator said the
run finished; the run did not.

The mirror-image gap: `acquireWriterLock(config.dbPath)` at `:996` can block
for the duration of a competing reindex, and no counter exists yet, so
`--progress` emits nothing at all during the wait — the state the release
describes as indistinguishable from a hang.

Confidence: high (read; not reproduced, since forcing a rename failure needs a
crafted filesystem).

### 10. Cancelling the maintenance lane deepens a failure streak that will eventually refuse the tasks

`src/core/brain/maintenance/lane.ts:272-298` (catch → journal `verdict: run,
ok: false`), `:255-258` + `:324-346` (`refuseOnStreak`),
`src/core/brain/maintenance/journal.ts:141-150` (`consecutiveTaskFailures`),
`src/core/brain/policy/blocks/maintenance.ts:64`
(`MAINTENANCE_FAILURE_STREAK_LIMIT_DEFAULT = 3`).

The lane runs its four tasks sequentially and catches each one's error into a
journal row with `verdict: "run", ok: false`. `SafeguardAbortError` is not
distinguished — `timed_out` is set for `SafeguardTimeoutError` only. So an
abort is journaled as a failed attempt. `consecutiveTaskFailures` counts
exactly those rows, and `refuseOnStreak` refuses a task at 3.

Worse, the abort signal stays set for the rest of the process, so after the
first task is stopped the remaining three trip on their *first* checkpoint and
are journaled as failures too. One Ctrl-C therefore writes four failure rows,
one per task.

**Failure scenario.** An operator cancels `o2b brain maintenance run` three
times over three nights. On the fourth run every task is refused by name with
`refused: 3 consecutive journaled failures reached the
maintenance.failure_streak_limit of 3; fix the cause, or re-run with --force`,
about passes that never failed. `refuseOnStreak`'s own comment is careful that
a refusal must not deepen the streak it reports — the same care was not taken
for a deliberate stop.

The verb's exit code is right (`maintenance.ts:274` returns 130), but its
`--json` payload reports `ok: false` per task with the abort message as
`error`, so the machine-readable surface still calls a stop a failure.

Confidence: high (read end to end; the streak default and the counting rule
were both verified in source).

### 11. The rail's refusal path has no producer in any shipped call site

`src/cli/progress-rail.ts:55-63` (`PROGRESS_OUTCOME.suppressedBufferedStream`),
`:110-125` (`ProgressAttachment.reason`), `:178-186`
(`reportProgressRefusal`), `src/core/brain/progress.ts:117`
(`PROGRESS_REASON.streamBuffered`), `src/cli/json-helpers.ts:68`
(`ownsInternalJson`).

`progressIsLegal` returns `true` unconditionally when `ownsInternalJson` is
true, and `ownsInternalJson` returns `true` for any argv under `brain` or
`search`. Every production `attachProgress` call site passes
`command: "brain"` or `command: "search"`. Therefore the refusal branch, the
`suppressed-buffered-stream` outcome, the `stream-buffered` reason, the
`ProgressAttachment.reason` field, and the `progress: not emitted (…)` wording
are unreachable from any shipped command.

`tests/cli/progress-report.test.ts:11-15` states this outright: *"Neither is
reachable through `o2b brain …` or `o2b search …`"*. That is an honest note,
but the honest conclusion is that this is a stub — a vocabulary member and an
operator-facing string with no producer, which is the defect class the release
names in its own title.

Related comment-versus-code gap: `ProgressAttachment.reason` is documented as
*"A caller rendering a `--json` payload carries it as a field, so the refusal
is visible on the surface the caller actually reads."* No verb reads
`observation.reason`. `grep` for it across `src/cli/` returns nothing.

Confidence: certain (both facts checked by grep against every call site).

### 12. `OPERATION.maintenance` can never appear on a progress stream, and its timeout key has no reader

`src/core/brain/safeguard.ts:39` and `:51`, `src/cli/brain/verbs/maintenance.ts:162`,
`tests/cli/brain-maintenance-progress.test.ts:78`.

`OPERATION` was promoted from a bare union specifically so "both the timeout
ladder and `ProgressEvent.operation` read from one place". Of the six members,
`maintenance`:

- is never passed to `progressCounter` (the only six call sites are dream,
  bridges, clusters, architect ×2, reindex ×2). The lane forwards the caller's
  sink to the four sub-operations instead — a defensible design, and the CLI
  test *asserts* `records.every(r => r.operation !== OPERATION.maintenance)`;
- is never passed to `resolveSafeguardTimeoutMs` either. `laneSafeguard` builds
  per-task safeguards from the four task operations. So
  `safeguard_timeout_maintenance_seconds`, documented in
  `docs/brainstorm/release-1-0-stability-trust/design.md:40`, is a config key
  nothing reads.

So one member of a vocabulary the census enforces has no producer on either of
the two surfaces the vocabulary exists to unify.

A second consequence of the lane forwarding: one `o2b brain maintenance run
--progress` emits **four** `finished` records (or four `stopped` records on a
cancel), and there is no lane-level terminator at all. A reader cannot tell
from the stream when the lane is done. The rest of the module argues at length
that one run has one terminator; this surface has four and none.

Confidence: certain (grep over every call site) for the no-producer claims;
high for the four-terminator consequence (read).

---

## PLAUSIBLE

### 13. Four of the six emitters let a throwing sink abort the operation

`src/core/brain/progress.ts:182-200` (`ProgressCounterOptions.onSinkError`),
`:234` (`if (opts.onSinkError === undefined) throw error`).

Only `dream.ts:162` and `architect/generate.ts:287` (via `guardedSink`) supply
a fault reporter. `bridge-discovery.ts:102`, `communities.ts:88`,
`indexer.ts:325` and `vector-backfill.ts:102` all call
`progressCounter(op, sink)` with no options, so per the module's own
documented rule the throw propagates out of the operation.

The docblock two paragraphs above says *"Progress is observation, and an
observation must not be able to destroy the thing observed: a broken edge
stream — a closed pipe, a renderer defect — must not abort a consolidation
pass that is otherwise succeeding."* For four of six emitters it can.

**Failure scenario.** A library or MCP caller supplies its own sink to
`discoverBridges` or `detectCommunities` and it throws (closed pipe, a
serialiser that chokes, a renderer defect). The scan aborts and the CLI
reports `bridges discover failed: …` — a scan that had already done its work.
The same sink handed to `dream` degrades gracefully and reports a
`progress-sink-failed` warning. Two behaviours for one condition.

I did not reproduce this against a live `Store`, and I am not confident that
the *CLI's* own sink can throw in practice (`process.stderr.write` on a closed
pipe usually surfaces asynchronously rather than throwing). The asymmetry
itself is certain from the source; the reachability from the CLI is what I am
marking plausible.

### 14. The dream `plan` stage declares a denominator and never counts toward it

`src/core/brain/dream.ts:211`.

`progress.start(DREAM_STAGE.plan, scan.preferences.length)` is the only
statement about that stage. No `advance(DREAM_STAGE.plan)` exists anywhere;
the next progress call is `start(DREAM_STAGE.apply)`. A caller watching a vault
with 4 000 preferences sees `{"stage":"plan","completed":0,"total":4000}` and
then nothing until planning is entirely over. The `total` is a promise of
granularity that is never delivered — arguably worse than the `walk` stage's
honest absence of a denominator.

The same shape, less severely, applies to `apply`, `log` and `finalize`, each
of which advances exactly once at the end of its span, and to
`vector-backfill.ts:107`'s `plan` stage, which starts and never advances.

Confirmed that no test notices: I replaced the denominator with a literal
`999` and deleted `progress.advance(DREAM_STAGE.scan)` outright — 159 tests
across 9 files still passed.

### 15. The embed phase counts work it has not done yet, against a total nothing verifies

`src/core/search/indexer.ts:936` and `:943`.

`progress?.advance(INDEX_STAGE.embed, batch.length)` runs *before*
`await provider.embed(texts)`. `completed` therefore counts units dispatched,
not units finished, contradicting `ProgressEvent.completed`'s
*"Units finished in this stage so far."* On the last super-batch the stream
reports `completed === total` while a network round-trip is still outstanding —
precisely the moment a watcher would conclude the run is wedged if it then
takes 30 s to return.

Nothing tests the denominator: I doubled it (`pending.length * 2`) and every
progress test still passed.

Related, and worth a second look: `search-index-progress.test.ts:81` asserts
`record["total"]` is `undefined` for *every* record on an
`o2b search index --progress` run. That holds only because the test never
passes `--embeddings`, so the `embed` stage never opens. The assertion reads
as a property of the operation and is in fact a property of the fixture.

### 16. `discoverBridges` emits two `started` events for one stage in one run

`src/core/brain/link-graph/bridge-discovery.ts:103` and `:156`.

The outer `start(BRIDGE_STAGE)` exists so an already-expired guard reports a
stop; the inner `start(BRIDGE_STAGE, candidates.length)` adds the denominator.
On the normal path both fire, so the stream carries
`started:candidates:0` (no total) followed by `started:candidates:0/N`. A
renderer that treats `started` as "a new stage began" shows a restart. `dream`
solved the same problem differently — it opens `scan` once, before the first
checkpoint — so the two emitters disagree about how to express one idea.

### 17. The interrupt handle can leak past its `finally`, and the docblock says that must not happen

`src/cli/brain/verbs/maintenance.ts:157` (`onInterrupt()`), `:167`
(`resolveSearchConfig`, outside the try), `:170` (try begins), `:259`
(`release`).

`InterruptHandle.release` is documented *"MUST be called in a `finally`: the
listeners are process-global, and a verb that returns without releasing leaves
a dead controller wired to the next signal."* In `cmdBrainMaintenance`,
`resolveSearchConfig` runs between the handle's creation and the `try`. If it
throws — an unreadable config, an unresolvable db path — control jumps to the
outer catch and `release()` is never reached. The listeners stay registered for
the remainder of the process, which by finding 2 means the operator's next
Ctrl-C is absorbed instead of terminating.

The exposure is bounded (the CLI process exits shortly after), but it is the
exact hazard the docblock names, in the one verb of the six that got the
ordering wrong.

### 18. `onInterrupt`'s docblock describes behaviour the code does not have and a mechanism that does not work that way

`src/cli/interrupt.ts:71-79`.

*"Deliberately not idempotent across concurrent calls: two overlapping handles
would each register a `once` listener and the first signal would abort only one
of them. … a second handle in the same process is a defect worth failing on
rather than a case to paper over."*

Two problems. First, nothing fails: a second `onInterrupt()` returns a normal
handle. Second, the stated failure mode is not what Node does —
`EventEmitter` dispatches a signal to *every* registered listener, so both
controllers would abort. The comment asserts a property, and both halves of the
assertion are wrong.

This matters concretely in `cmdBrainDream`, which creates `stagedInterrupt`
(`dream.ts:242`) for every action including `run`, releases it, and then creates
a second handle at `:409`. The two are sequential rather than overlapping so
nothing breaks today, but the comment is the only thing standing between that
and a future overlap.

### 19. `EXIT_TERMINATED` is exported and consumed by nobody

`src/cli/interrupt.ts:40`, and `EXIT_FOR_SIGNAL` at `:47`.

`EXIT_TERMINATED` has no importer in `src/` or `tests/` (grep). The SIGTERM
code reaches an exit only through `EXIT_FOR_SIGNAL.SIGTERM`, which is built
from `SIGTERM_EXIT` directly. So the module holds three names for two numbers
(`SIGINT_EXIT`/`EXIT_INTERRUPTED`, `SIGTERM_EXIT`/`EXIT_TERMINATED`, plus the
map). One of them is dead. Minor, but this branch's own standard is that a
declared surface with no consumer is a defect.

### 20. `DreamStageOptions.onProgress` is a declared surface with no producer

`src/core/brain/dream-stage.ts:107`, forwarded at `:252`, `:368`, `:407`.

The field is threaded through all three staged-lifecycle entry points and
documented at length (*"a caller who asked to watch a staged pass watches the
same five stages"*). No caller can ask. `src/cli/brain/verbs/dream.ts:249`,
`:276`, `:285` build `stageOpts` with `now`, `safeguard` and `agentName` only;
`src/mcp/brain/feedback-tools.ts:411` builds `{ now, agentName }` only — and
does not even pass a safeguard, so the MCP staged lifecycle has no deadline
either. `o2b brain dream stage --progress` parses the flag and silently
ignores it.

### 21. The documented CLI stream advertises a `kind` it can never carry

`docs/cli-reference.md:724`, `src/core/brain/progress.ts:66-72`.

The docs describe the `--progress` NDJSON stream as carrying `kind` from
`started | advanced | finished | stopped | refused`. `ProgressCounter` has no
method that emits `refused`; the only producer of that kind is
`src/mcp/progress.ts:161`, and it produces a `ProgressRefusal`, a different
shape on a different transport, never a `ProgressEvent`. A CLI caller writing a
handler for `refused` writes dead code. The same applies to
`PROGRESS_REASON.streamBuffered`, which per finding 11 never reaches a
`ProgressEvent` at all.

### 22. A directory the scan cannot read is silently omitted from the architecture facts

`src/core/brain/architect/scan.ts:190` (`catch { return; }`) and `:203`
(`catch { continue; }` around `lstatSync`).

`walk` swallows `readdirSync` and `lstatSync` failures with no notice, no
warning field, and no progress event. A permission-denied subtree lowers
`totalFiles`, changes `languages`, and can drop a whole module from
`modules[]` — and the generated overview note asserts those numbers as fact.
The early `return` also skips `safeguard?.checkpoint()` for that directory.

This predates the branch, but the branch rewrote `walk` and the surrounding
argument is explicitly about not degrading in silence, so it is worth listing
under the standard being applied.

---

## Checked and found sound

So the absence of a finding above is informative, here is what I examined and
did not fault.

- **Vocabulary hygiene.** `PROGRESS_KIND`, `PROGRESS_KINDS`, `PROGRESS_REASON`,
  `PROGRESS_REASONS`, `OPERATION`, `OPERATIONS` and `PROGRESS_OUTCOME` are all
  frozen, all have complete membership arrays, and all have `unknown`-taking
  guards. `tests/core/brain/progress.test.ts:17-42` asserts freeze,
  completeness and guard behaviour against plausible drift (`"Started"`,
  `"aborted "`), not only obvious garbage. This part is genuinely well built.
- **`total` omission.** `emit` spreads `total` conditionally, so a stage with no
  denominator omits the key rather than emitting `total: undefined`;
  `progress.test.ts:75` asserts `Object.hasOwn` is false, which is the right
  assertion. `assertTotal` correctly rejects negatives and fractions, and does
  so even with no sink attached (`progress.test.ts:116`), so a denominator bug
  is loud whether or not anyone is watching.
- **Sink-detach semantics in `dream`.** The `onSinkError` reporter,
  the one-shot `live = false` detach, and the `progress-sink-failed` warning
  carried out on the summary are correct and tested
  (`dream-progress.test.ts:185`, which asserts `calls === 1` — the detach, not
  just the survival). `architect/generate.ts:264` (`guardedSink`) makes the
  same guarantee across the run's two counters, and its reasoning for not
  using `onSinkError` per counter is right.
- **Byte-identity with no observer.** I could not find a path where attaching
  a sink changes what is written, returned or ordered. `dream`'s only
  behavioural difference is the extra warning on sink failure;
  `generateArchDocs` adds `progressFault` to its result but the CLI spreads
  `progress_fault` into the JSON only when non-null, so the envelope is
  unchanged; the indexer passes the counter into `runEmbeddingPhase` without
  altering the phase's logic. `dream-progress.test.ts:117` compares two copies
  of one seeded vault (rather than two bootstraps) and excludes only the tar
  snapshot and the forensically-stamped workrun journal — both exclusions are
  justified and both are argued in the test. `search-index-progress.test.ts:85`
  checks that `--verbose` output is byte-unchanged when `--progress` is added.
  These are good tests.
- **Rail placement.** Progress on stderr, payload on stdout, and the inversion
  against `advisoryIsLegal` under `--json` are correct and, unusually, the
  branch asserts the *fact the reasoning rests on* — that `withJsonFallback`
  patches stderr as well as stdout (`progress-rail.test.ts:93`). That is the
  right way to keep a docblock from quietly becoming false, and it is a pattern
  the rest of this branch would benefit from copying.
- **NDJSON as the wire shape** and `schema` on every record: the
  `progressRecords` helper selects by discriminator rather than by position, so
  a verb cannot pass by emitting something that merely looks like progress.
- **`progressReasonForError` centralisation** is right, and the argument for
  putting it in the spine rather than at five call sites holds.
- **`throwIfAborted` in the index walk** is the one cancellation seam that can
  actually fire, and `reindexSafeguard` deliberately omitting the signal (so
  the abort travels through `throwIfAborted` alone) is consistent.
- **Terminator coverage on every *return* path.** I traced every `return` in
  `dreamRun` (two, both preceded by `finish()`), `discoverBridgesRun` (the
  no-embeddings early return is inside `withProgress`), `detectCommunitiesRun`,
  `indexIntoRun`, `planVectorBackfillRun` and `generateRun`. Normal returns are
  all covered. It is the *throw* paths (finding 4) and the post-terminator work
  in `reindexVault` (finding 9) that are not.
- **`advance` with a mismatched or unopened stage** throws `RangeError` rather
  than mis-attributing the count — the right call, and it throws whether or not
  a sink is attached, so a stage-name typo is a defect in every run rather than
  only in observed ones.
- **The architect's plan-then-write restructure** (`generate.ts:227` `planNote`,
  `:307` the write loop under one lock) genuinely fixes the half-refreshed-prefix
  problem it claims to, and moving the safeguard checkpoints into the planning
  phase only means an aborted architect run has written nothing. The
  `compareStable` replacement for `localeCompare` is a real determinism fix.
- **The lane's decision not to own a counter** is correct on its merits; my
  objection (finding 12) is to the absence of any lane-level terminator, not to
  the forwarding.
- **Exit codes.** 130/143 are the shell's own `128 + signum` convention, do not
  collide with the codes this CLI already spends (0, 1, and `search check` /
  `doctor`'s 6 for an incomplete probe), and `o2b search watch` correctly keeps
  exiting 0 because stopping is how that command ends. The reasoning in
  `interrupt.ts:20-26` is sound. The problem is not the numbers; it is finding
  2 — that a run which was asked to stop, and did not, still returns 0.
