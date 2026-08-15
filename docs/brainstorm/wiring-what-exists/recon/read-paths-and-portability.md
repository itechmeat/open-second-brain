# Recon: four smaller units, and two task bodies that reconnaissance corrected

Covers `t_decf83b1` (D1), `t_dd59fc50` (D2), `t_e0ef6011` (E1), `t_984b8664` (E2).
Two of the four described a gap that is not the gap; both are recorded here rather
than quietly re-scoped.

## D1 - the ranker has the authoring instant and ranks on storage mtime

`ranker.ts:502`:

```
const recency = recencyBoost(c.mtime, nowMs, recencyOpts) * recMul * temporalDamping;
```

Nine lines further down, `ranker.ts:597` surfaces `hyd.authoredAt` off the same
hydrated record, and `ranker.ts:671-675` uses it as a tie-break rung. The column is
already projected: `store/chunks.ts:241` selects `d.authored_at` on the join that
fetches `d.mtime`, mapped at `:257`, typed at `:56`. Both values are unix seconds, so
`recencyBoost`'s internal `* 1000` stays correct with no conversion.

So the fix needs no schema change, no index change and no join. A batch of
conversations imported today with year-old turn instants currently receives the
maximum freshness boost, because `indexer.ts:324` stores `mtime` as the filesystem
mtime at index time.

Three things bound the honest claim:

- `representativeChunks` (`store/chunks.ts:271-317`) does not project `authored_at` -
  its SELECT stops at `d.mtime` (`:292-294`). `chunks.ts:61-63` documents the
  *absence* of unprojected fields as load-bearing for byte-identity on that read, so
  adding the column is a deliberate change to that contract, not an oversight fix.

  **Correction, made during implementation.** This recon first claimed that
  link-expansion candidates therefore "silently keep ranking on mtime". That claim is
  not established. The relational arm pushes only `rep.chunkId` into the ranked list
  (`pipeline/relational-arm.ts:58-67`) and the ranker's hydrated map is built by
  `hydrateChunks`, which does project the column; traversal expansions carry
  `recencyBoost: 0` (`traversal.ts:69`, `relation-polarity.ts:146`). Against that,
  `pipeline/assemble.ts:150-151` states that some candidates are "hydrated through the
  representative-chunk read", so the two readings are not reconciled here. The
  projection is added on a ground that does not depend on the answer: without it those
  rows cannot distinguish "declares no instant" from "this read did not ask". Whether
  any current consumer routes a representative chunk into the recency prior is an open
  question carried into review rather than answered by assertion.
- `authored_at` is stamped only by session import (`sessions/import.ts:284-293`, and
  only when the turn carried a usable timestamp) and by the inbox backfill. For any
  other ingestion path the column is NULL and the fallback changes nothing. That is a
  real limit on what this unit buys.
- `ranker.test.ts:330-393` asserts an *exact* score tie between two chunks with equal
  `mtime` and different `authored_at`, then checks the tie-break orders them. Feeding
  `authoredAt` into recency breaks that premise by construction. The tests get
  re-derived against the new premise; patching them to keep passing would be hiding
  the change.

The gate to re-measure afterwards is `tests/core/search/recall-benchmark.test.ts`,
whose header at `:27-32` instructs exactly that whenever the ranking pipeline changes.

## D2 - the task body describes sub-recalls that do not exist

`t_dd59fc50` asks for alias resolution "on the sub-recalls the dream pass issues".
The dream pass issues none. `dream()` is a **synchronous** function
(`src/core/brain/dream.ts:106`) and its import list at `:51-89` contains no search
module - no `core/search`, no recall module, no retrieval plan. Grepping the
`dream-*.ts` family for recall verbs returns only prose in comments. All matching
during a pass is exact-string over the vault snapshot the `close` phase read.

The asymmetry the task is pointing at is real, one layer over. The read path
canonicalises: `search/entity-alias.ts:32` folds the registry over extracted query
entities through `buildEntityIndex` plus `normalizeEntityName`, fail-soft to identity
when the registry is missing. The consolidation path does not:
`dream-plan-topics.ts:59-66` builds `byTopic` with `const topic = rec.signal.topic`
and `Map.get`/`set` on that exact string, and `:69-75` indexes existing preferences
with `prefByTopic.set(p.pref.topic, ...)`. Byte equality, no NFC, no case fold, no
quote fold, no alias hop.

`normalizeEntityName` (`entities/canonical.ts:67`) is NFC, trim, whitespace collapse,
lowercase, quote fold - structural in every step, no language-specific rule anywhere,
which is what makes it usable here. `canonical.ts` deliberately imports nothing
(`:83-84`) to stay outside the import-cycle ratchet, so consuming it adds no edge
risk.

## E1 - the probe already runs and its answer is thrown away

The task asks for a live pre-flight probe. It exists.
`indexer.ts:1371-1391`, inside `indexCheck`, gated on a resolved embedding key,
builds the provider and runs `await withTimeout(provider.ping(), 5_000)`.
`OpenCompatProvider.ping` (`openai-compat.ts:326-336`) is already the cheap form: a
single-item batch, `maxAttempts: 1`, no retry loop, returning
`{ok:true, dimension}` or `{ok:false, reason}` and never throwing.

`o2b search check` already prints `provider_reachable: OK|FAIL` and a
`provider_reason:` line. What it does with the answer is the defect: the finding is
pushed into `warnings`, never `fatal`, and the verb's exit code is `1` only when
`report.fatal.length > 0` (`check.ts:454-455`). So a provider that is configured and
proved unreachable exits 0, and a script gating on the exit code reads it as healthy.
That is the same class as the readiness exit fixed in 1.46.0.

A second finding, not in the task: the probe is **not** opt-in. Every
`o2b search check` with a resolved key makes a network call. The task asked for an
opt-in probe and got the opposite by accident.

`o2b doctor` cannot host this check as things stand: `DoctorCheck.run` is declared
synchronous (`doctor/check.ts:75`), and no doctor check anywhere touches the network.
Changing that contract for all eighteen checks to accommodate one is not in this
round.

## E2 - the bundle carries preferences and the import counts them

`portability/bundle.ts` composes four sections at `:53-62` and restores one. The
docblock at `:11-19` states the reason and it is a good one: "preferences have a
delicate confidence/audit lifecycle, the page contract is a read projection, and the
sources dashboard is derived", and the result "reports each carried section
explicitly so the bundle can never be read as a full round-trip of material it did
not reconstruct." That last clause is the reason this is a round-trip gap and not a
correctness bug.

What makes the gap closable is that the delicate lifecycle has an owner.
`preference-txn.ts:169-175` `writePreferenceTxn` is documented as the single
chokepoint for every preference write: acquire the lock, re-read the existing record
inside it, run the expectations chain, stamp `_content_hash` on promotion, bump
`_revision` only when bytes change, append edit history, append the audit line.
Nothing under `portability/` imports it. Restoring through it maintains the lifecycle
instead of overwriting it - which is exactly what the docblock says a naive restore
must not do.

Two constraints on the work:

- `BANK_BUNDLE_SCHEMA_VERSION` is `"1"` and a mismatch is a hard refusal at `:107-111`
  with no version-dispatch table and no upgrade function. Adding restore semantics
  means deciding what a version-1 bundle does on import, and a refusal would be a
  breaking change that has to be named as one.
- There is no reverse mapper from `ExportedPreferenceRow` (`export.ts:26`, a
  projection) into `WritePreferenceInput` (`preference.ts:125-260`, about twenty
  lifecycle fields). Writing it is where the per-field round-trip test earns its
  keep: a field that exports and has no home on the way back is exactly what the
  test should fail on.
