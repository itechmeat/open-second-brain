# Recall Lane Latency and Caller Control - implementation plan

Feature branch: `feat/recall-lane-latency`. TDD per task: write the failing test first, run it, watch it fail with the expected error, then implement. One atomic conventional commit per task, formatter + linter green before every commit.

Landing order: lane D first (pure test substrate), then lane A, then lane B, then lane C. Lanes B and C tasks C1-C2 are file-disjoint from A and may proceed in parallel on separate worktrees; the bench hunks are sequenced by the dependency edges below.

## Cross-lane contract (pinned)

Shared file seams. Parallel lanes never edit the same file; where two lanes must touch one file, the hunk boundaries and the owning lane are pinned here and the dependency edge sequences them.

| Shared file | Owner | Hunk |
|---|---|---|
| `tests/helpers/fake-http.ts`, `tests/helpers/fake-http.test.ts` | Lane D exclusively | `/rerank` default-handler branch and its self-test. No other lane touches the helper. |
| `src/core/search/**`, `src/cli/search/**`, search explain surfaces | Lane A exclusively | Start-early/join, supplier, timing sink, explain envelope and transcript. Lanes B and C never edit search files. |
| `src/core/brain/context-pack.ts`, `src/core/brain/recall-budget.ts`, `src/mcp/brain/pack-tools.ts`, `docs/mcp.md` | Lane B exclusively | Packing vocabulary, allocation, partition, accounting, MCP argument/schema/response, mcp.md section. Lanes A and C never edit these. |
| `src/core/brain/attention-flows.ts`, `src/core/brain/preference-provenance.ts` (new) | Lane C exclusively | Facet option on the standing_query evaluation, provenance join. |
| `src/core/bench/types.ts` | Lane A then Lane C (sequenced, disjoint regions) | A owns the aggregate latency-family field addition (report family near types.ts:378 region). C owns the `BENCH_CATEGORIES` member (types.ts:36-48) and the `BenchPinnedKnobs` field (types.ts:247-262). C3 depends on A6. |
| `src/core/bench/phases.ts` | Lane A then Lane C (sequenced) | A owns the per-question timing-sink pass-through in the retrieve loop (405-414 region) and the `overlapped_ms` aggregation in the report family (775-805 region). C owns the `standing_instruction` retrieve branch (alongside the session_handoff/proactive_recall branches, 399-501 region) and the `evaluateQuestion` branch (573-652 region). C3 depends on A6. |
| `src/cli/brain/verbs/bench.ts` | Lane A then Lane C (sequenced) | A owns the conditional `overlapped_ms` human line adjacent to line 431. C owns the conditional `standing_instruction` report block (mirroring the conditional longmemeval block). C4 depends on A6. |
| `CHANGELOG.md` | Lane A creates the version section; B and C append bullets | D adds none (test-only change, no entry per playbook). A lands first with the concurrency bullets; B appends the packing bullets; C appends the facet bullets. Sequential landing makes the hunks conflict-free. |
| `docs/updating.md` | A, B, C each add their own additive-options note | Distinct lines; landing order D, A, B, C keeps it conflict-free. |

Rule inherited by every lane: an omitted new option must be byte-identical on every surface it touches, and any new English user-facing string lives in a named constant.

## Lane D - fixture substrate (lands first, test-only)

### Task D1: `/rerank` default route in the fake-http fixture
- **Lane**: D
- **Files**: `tests/helpers/fake-http.test.ts` (failing tests first), `tests/helpers/fake-http.ts` (default handler body only; no exported API change)
- **Test first**: in the self-test, assert POST `{url}/rerank` with `{ model, query, documents }` returns 200 `{ results: [{ index, relevance_score }...], model }` with one item per document in input order; two identical requests produce byte-identical responses; a document containing a query token outscores one that does not (monotone in overlap); GET `/rerank` does not 200; a body without an array `documents` answers 400; the `/embeddings` branch behavior is unchanged (vector derivation, model echo, 404 elsewhere).
- **Then implement**: the branch inside `defaultHandler` per the design (whitespace-token overlap scoring `matches / (matches + 1)`, lowercase and punctuation-stripped, no clock or randomness; model echo `body.model ?? "fake-model"`; empty `documents` yields `{ results: [], model }`).
- **Done when**: the self-test is green and a sample of existing embedding-consumer suites (at minimum `tests/core/search/embeddings.test.ts` and `tests/core/search/rerank-failure.test.ts`) still pass, proving the additive route regressed nothing.
- **Depends on**: none

### Task D2: migrate `rerank.cross-encoder.test.ts` onto the fixture
- **Lane**: D
- **Files**: `tests/core/search/rerank.cross-encoder.test.ts`
- **Test first**: re-point one test at a started `FakeHttp` while keeping its assertions, watch the migration surface any contract mismatch, then migrate the rest: the endpoint constant becomes `server.url`; the canonical request-shape test rides the default route plus a capturing `setHandler` that records `req`; the out-of-order, bare-array, wrong-length and 503 variants become `setHandler` overrides returning the exact bodies they return today; the empty-documents test asserts `server.callCount() === 0`.
- **Done when**: the file contains no `globalThis.fetch` assignment, `let server: FakeHttp` wiring matches the house consumer pattern, and the suite is green.
- **Depends on**: D1

### Task D3: migrate the three pipeline rerank files onto the fixture
- **Lane**: D
- **Files**: `tests/core/search/rerank.search.test.ts`, `tests/core/search/relational-rerank-pin.test.ts`, `tests/core/search/rerank-sunset.test.ts`
- **Test first**: per file, start a server, pass `baseUrl: server.url` in the rerank config handed to `makeConfig`, and replace the duplicated `stubRerankFetch(winner)` with one local `setHandler` scoring `doc.includes(winner) ? 0.99 : 0.01` (preserving today's winner selection exactly, reading `req.body` from the already-parsed `FakeRequest`); the cache test's call-counting wrapper becomes `server.callCount()` deltas; the disabled-means-zero-HTTP tripwire becomes the same assertion on `callCount()`. The raw-body 503 pins stay at the fetch seam so the pinned `rerank_degraded:` warning strings do not change.
- **Done when**: rerank-related `globalThis.fetch` mutations remain only in `tests/core/search/rerank-failure.test.ts` (stream-level cases) and the doctor tripwire; full `bun test` over the migrated files is green.
- **Depends on**: D1

## Lane A - semantic lane concurrency (recon tasks 1-6)

### Task A1: lazy `keywordHitCount` supplier
- **Lane**: A
- **Files**: `src/core/search/pipeline/semantic-lane.ts`; `tests/core/search/semantic-phase-spend-gate.test.ts`
- **Test first**: a failing assertion where the lane is given a supplier whose backing value changes while the embed is in flight and the emitted `hybrid_degraded` warning reflects the completion-time count (today the type has no supplier, so a start-early caller would capture the call-time value); a second assertion pins that a plain number is still accepted (union `number | (() => number)`), keeping the four existing numeric call sites (266-292 region) compiling untouched.
- **Then implement**: widen `SemanticLaneInput.keywordHitCount`, resolve the supplier where `detectHybridDegrade` runs (semantic-lane.ts:109-113 region).
- **Done when**: new tests green; the four existing call sites unmodified; the suite green.
- **Depends on**: D1 (fixture available), none otherwise

### Task A2: extract the join seam
- **Lane**: A
- **Files**: `src/core/search/search.ts` (new helper/overload); `tests/core/search/hybrid-overlap.test.ts` (new)
- **Test first**: unit tests over the extracted seam using fake promises: (a) the keyword step runs to completion while the lane promise is still pending; (b) a keyword-step throw while the lane is in flight routes the lane's rejection to `noteAbandonedFailure` when a deadline exists and produces no unhandled rejection when none does; (c) the never-start rule - an already-expired deadline starts nothing and serves the fallback.
- **Then implement**: an `awaitWithinDeadline` overload accepting an already-started `Promise<T>` (or a `joinSemanticLane` helper carrying the same catch-attachment semantics, search.ts:220-250 region).
- **Done when**: the new tests are green; the existing rerank race and deadline tests pass unchanged.
- **Depends on**: none

### Task A3: start-early join in `search()`
- **Lane**: A
- **Files**: `src/core/search/search.ts`; `tests/core/search/hybrid-overlap.test.ts`
- **Test first**: using the fake-http pattern from hybrid-deadline.test.ts with a delayed embed handler: results byte-identical to the serial baseline via the `resultShape` projection (hybrid-deadline.test.ts:110 pattern), and the embed request observed arriving at the fake server before `search()` resolves; warning order pinned (keyword sentences before semantic sentences).
- **Then implement**: start the semantic lane before `runKeywordLane`, join at today's await site (search.ts:454-461 region), both deadline arms, signal still riding the lane input; attach the rejection handler at start time per the design; lane start stays after the cache probe.
- **Done when**: hybrid-overlap tests green AND the full existing `tests/core/search/hybrid-deadline.test.ts`, `hybrid-degrade.test.ts`, `tuning-semantic-lane.test.ts`, `iterative-recall.test.ts`, `relational-arm.test.ts` suites pass unchanged (byte-identical contract).
- **Depends on**: A1, A2

### Task A4: deadline-authoritative overlap and the abandoned-lane sentence
- **Lane**: A
- **Files**: `src/core/search/search.ts` (start-site never-start rule if not already in A2's helper); `tests/core/search/hybrid-deadline.test.ts` (extensions)
- **Test first**: with the lane started early and the clock at 300ms over a stalled embed, the answer stays keyword-only with `hybridDeadlineExceeded` plus `hybridDegraded` (the existing assertions must keep passing under the overlapped join); NEW: an embed rejecting with a non-abort error after the fire lands the `hybrid deadline: an abandoned lane failed after the answer:` sentence (prefix constant, search.ts:108) in warnings.
- **Done when**: all deadline tests green with the overlapped join active, including the wall-clock assertions (answer under 3s on a 300ms budget) and the never-cached contract.
- **Depends on**: A3

### Task A5: `overlapped_ms` through the timing sink and `search --explain`
- **Lane**: A
- **Files**: `src/core/search/types.ts` (per-call sink option in the `freshenSpawn` mold, timing record type), `src/core/search/semantic-phase.ts` (embed start/end capture), `src/core/search/pipeline/semantic-lane.ts` (record plumbed out), `src/core/search/search.ts` (interval capture around the keyword lane, sink invoked once at the join), `src/core/search/explain-envelope.ts`, `src/cli/search/outcome-render.ts`, `src/cli/search/verbs/query.ts`, `CHANGELOG.md` (creates the wave version section with the concurrency bullets - the section lanes B and C append to), `docs/updating.md` (own additive-options line); `tests/cli/search-explain-overlap.test.ts` (new, sibling of search-explain-trace.test.ts)
- **Test first**: with `--explain` and a delayed fake embed, the JSON payload carries an integer `overlapped_ms >= 0` and the human transcript prints the overlapped line; without `--explain` the payload bytes are unchanged (key absent, off-means-absent rule); a keyword-only run (embed never attempted) reports `overlapped_ms` of 0 with `attempted` false.
- **Done when**: new tests green; no timing field exists anywhere on `SearchOutcome`; the existing explain-trace suite passes unchanged.
- **Depends on**: A3

### Task A6: bench `overlapped_ms` plumbing
- **Lane**: A
- **Files**: `src/core/bench/types.ts` (aggregate latency-family field only), `src/core/bench/phases.ts` (sink per question in the retrieve loop, aggregation into the report family), `src/cli/brain/verbs/bench.ts` (conditional human line), `CHANGELOG.md` (appends the bench-accounting bullet to the section A5 created); `tests/core/bench/phases.test.ts` (extension)
- **Test first**: a bench run whose fixture exercises the semantic lane reports `overlapped_ms` in the latency family (per-question and aggregate); a keyword-only fixture reports it absent or zero without adding keys elsewhere; the human line prints only when the aggregate carries it; the failure-modes baseline fixture stays byte-identical.
- **Done when**: bench tests green, `tests/core/bench/failure-modes-baseline.test.ts` green and unmoved.
- **Depends on**: A5. Sequencing note: lane C's bench tasks build on this task's hunks (cross-lane contract).

## Lane B - packing policy (recon tasks 1-3 and 5; task 4 deferred per the operator note)

### Task B1: packing-policy vocabulary and pure allocation
- **Lane**: B
- **Files**: `src/core/brain/recall-budget.ts`; `tests/core/brain/recall-budget.packing.test.ts` (new)
- **Test first**: membership and narrowing cases mirroring the `isContextPackQueryMode` guard; allocation cases: `query_first` reordering, `facts_first` identity, empty page pool hands the budget to facts (and vice versa), facts exceeding the remainder, total conservation (the sum of lane allocations equals the total, reserved charges included), and per-lane native caps staying lane-internal.
- **Then implement**: frozen `PACKING_POLICIES = ["facts_first", "query_first"]` tuple, type, `isPackingPolicy` guard, and the pure `allocateRecallBudget` helper. Nothing else changes; no wiring.
- **Done when**: the new suite is green; no other file modified.
- **Depends on**: D1 not required; none

### Task B2: pack partition and report accounting
- **Lane**: B
- **Files**: `src/core/brain/context-pack.ts` (option field, partition activating only when the option is present, `packing` report object wired through the one finalize funnel); `tests/core/brain/context-pack-packing.test.ts` (new)
- **Test first**: absent `packingPolicy` is byte-identical to today (pin copied from the absent-`queryMode` pattern in context-pack-ranked-query.test.ts:86); with a policy, the report carries both lane spends and the policy name; skipped reasons unchanged; a policy against an empty lane is refused by name; the zero-budget early return and the char-budget path agree with the funnel.
- **Done when**: new tests green and the existing `context-pack.test.ts`, `context-pack-ranked-query.test.ts`, `context-pack-semantic.test.ts`, `pre-compress-pack.test.ts` suites pass untouched.
- **Depends on**: B1

### Task B3: MCP `brain_context_pack` argument, schema, response
- **Lane**: B
- **Files**: `src/mcp/brain/pack-tools.ts`; `tests/mcp/context-pack-tool.test.ts` (extension) or a sibling file for the packing cases
- **Test first**: INVALID_PARAMS for a non-member with the message naming the frozen members; the inert single-lane refusal; omitted argument produces a byte-identical response; the `packing` accounting object appears only when the policy was named; the schema enum derives from the tuple and the pairing is declared declaratively (`dependentRequired` style); `tests/mcp/brain-tools-parity.test.ts` stays green and unchanged (new argument, not a new tool).
- **Done when**: MCP tests green including the parity pin.
- **Depends on**: B2

### Task B4: explain surfaces and docs
- **Lane**: B
- **Files**: `src/core/brain/context-pack.ts` (receipt/telemetry metadata via `contextPackBudgetMetadata`, prompt-prefix segment gaining the policy only when named, mirroring the `query_mode` conditional at context-pack.ts:998); `docs/mcp.md` (section modeled on the query_mode one at 2054-2068); `docs/updating.md` (own line); `CHANGELOG.md` (appends packing bullets to the section lane A created); test coverage folded into `tests/core/brain/context-pack-packing.test.ts`
- **Test first**: prompt-prefix stability for unnamed callers; metadata presence only when the policy was named; the synced telemetry carries the policy as a closed enum member.
- **Done when**: tests green; docs complete; no CLI flag shipped (out of scope per design).
- **Depends on**: B3

## Lane C - standing-instruction facets (recon tasks 1-5)

### Task C1: pure origin-join core
- **Lane**: C
- **Files**: `src/core/brain/preference-provenance.ts` (new, no I/O); `tests/core/brain/preference-provenance.test.ts` (new)
- **Test first**: each producer format exercised from its live writer - import-session `basename#turn` (import.ts:445 shape), capture lifecycle `session:<id>#<event>` (session-lifecycle.ts:858 shape, resolved as origin event, labeled as such), extract-signals bare `session:<id>` (extract-signals.ts:646 shape, no provenance); malformed and missing refs; duplicate turns; deterministic ordering; the never-guess rule (unknown shape yields no provenance). Purity pin: the module imports no fs/vault APIs.
- **Then implement**: parse `<key>#<fragment>` session refs, resolve `evidenced_by` wikilinks to signal `session_ref` values via an injected lookup, return ordered `(sessionKey, fragment, kind)` hints with the earliest as first mention.
- **Done when**: the new suite is green and the purity pin holds.
- **Depends on**: D1 not required; none

### Task C2: opt-in facet projection on the standing_query evaluation
- **Lane**: C
- **Files**: `src/core/brain/attention-flows.ts` (additive option; new `StandingInstructionFacet` type in the `ThreadFacet` style with the doc-comment cross-reference); `tests/core/brain/standing-instruction-facets.test.ts` (new)
- **Test first**: with the option unset, the emitted `pref-<slug> (scope)` strings are byte-identical to today; with it set, only preferences whose join resolves gain origin annotations; owner-scoped and retired/tombstoned exclusions apply before annotation (a facet never makes a withheld preference visible); no write syscalls occur against a vault holding standing rules, scoped rules and owner-scoped preferences (fs write-guard).
- **Done when**: new tests green; `tests/core/brain/attention-standing-query.test.ts` and `attention-flows.test.ts` pass untouched.
- **Depends on**: C1

### Task C3: bench `standing_instruction` category and knob pin
- **Lane**: C
- **Files**: `src/core/bench/types.ts` (category member and additive `BenchPinnedKnobs` field only - region ownership per cross-lane contract), `src/core/bench/phases.ts` (retrieve branch driving the surfacing call with the facet option on, `evaluateQuestion` branch); `src/core/bench/fixture.ts` needs no change (category validation rides the existing tuple check); `tests/core/bench/standing-instruction.test.ts` (new)
- **Test first**: reports without the new category serialize byte-identically; lane-on questions assert the preference id plus origin turn; `DEFAULT_BENCH_KNOB_PIN` serializes byte-for-byte unchanged; a resumed run whose pin changed fails the identity guard.
- **Done when**: new tests green; `tests/core/bench/failure-modes-baseline.test.ts` green and unmoved; existing bench suites untouched.
- **Depends on**: C2, and A6 (bench file sequencing per cross-lane contract)

### Task C4: bench verb surfacing
- **Lane**: C
- **Files**: `src/cli/brain/verbs/bench.ts` (conditional category block only); `tests/cli/brain-bench.test.ts` (extension) or a sibling file
- **Test first**: a run whose report carries no `standing_instruction` category keeps stdout byte-identical; a lane-on run prints the new category and its rates; the exit code stays all-pass-or-nonzero with the new category in play.
- **Done when**: CLI tests green.
- **Depends on**: C3

### Task C5: invariants coverage
- **Lane**: C
- **Files**: `tests/core/brain/standing-instruction-facets.test.ts` (extension; fold into C2 if it stays small)
- **Test first**: one test asserting the whole lane performs zero writes against a vault that has standing rules, scoped rules and owner-scoped preferences, and that facet output never includes a preference the caller could not already see; resolved-count honesty (a population where nothing resolves reports zero resolved, not an implied provenance).
- **Done when**: green; the lane's read-only and visibility invariants are pinned by test.
- **Depends on**: C2

## Wave integration

- **Final docs pass**: `docs/updating.md` lines from all three lanes, `CHANGELOG.md` section completed by lane C (last to land), README untouched (no new verb or tool; all changes are options and accounting on existing surfaces).
- **Deliberately not planned**: recall-inject hook packing, the CLI packing flag, MCP `overlapped_ms`, extract-signals turn stamping, fake-http `rawBody`/stall mode - each recorded with its reason under design.md Out of scope.
