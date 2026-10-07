# Near-Duplicate Defense Across the Fact Lifecycle - one reach-aware near-duplicate lookup at every point a fact enters or leaves the vault, with the added cost measured per stage

**Status:** draft
**Author:** claude-devbox-agent (via feature-release-playbook)
**Audience:** implementation
**Release:** v1.74.0, one PR on `feat/near-duplicate-defense`
**Cards:** t_acab97de (forget side), t_fda66477 (write side), t_b915b9cc (extract rules), t_72e93e18 (stage timings)

## Problem statement

A paraphrased duplicate of a fact can enter the vault and outlive the
original. Three gaps cause this:

1. Nothing looks for paraphrased siblings when a preference is retired.
2. The write-receipt near-duplicate hint only compares pages in the same
   directory. It also leaks: it names sibling pages the caller cannot read.
3. The extract lane hands the agent turns without their timestamps and with
   no hygiene rules.

Separately, the write path reports one total duration per call. So the cost
this wave adds, and every cost before it, cannot be attributed to a stage.

## Verified premise corrections

The four premise reports were verified against live source at `3d49820c`.
Where they disagree with the kanban cards, they win. This design is built on
the following corrections.

1. **The forget hook goes where retirement actually happens (t_acab97de).**
   - **The hygiene path the card names never runs.** Hygiene apply `forget`
     (`src/core/brain/hygiene/apply.ts:123`) exists, but no detector ever
     proposes it. The detectors only produce `review`, `merge` and
     `recompile` actions, and usefulness findings are kept out of apply
     plans (`hygiene/plan.ts:49`). A sibling scan hooked there would never
     fire, and reviewers must reject that placement.
   - **Where retirement really happens:**
     - Dream-pass retires, planned in `dream-refresh.ts:226`, `:265`,
       `dream-plan-topics.ts:532` and `dream-plan-retires.ts:55`, `:95`, and
       executed by `moveToRetired` (`dream-apply.ts:318`).
     - Operator `reject` (`src/cli/brain/verbs/reject.ts:55`).
     - Merge (`merge.ts:243`). Its sibling is the page that is kept, so merge
       is out of scope.
   - **Where the scan hooks:** it runs on the dream retire set after
     `planAutoRetires` (`dream.ts:297`), is checked against the gated
     retires, and also runs on `reject`.
   - **Which retires trigger it:** only those caused by context, namely
     `superseded-by-context`, `rebutted`, `quarantine-violated` and
     `user-rejected`. Decay retires (`stale-no-evidence`,
     `expired-unconfirmed`) mean nobody used the rule, not that the rule is
     wrong, so they do not trigger it.
2. **The write hint already exists (t_fda66477).** A Jaccard-0.8,
   same-directory, same-scope-bucket `near-duplicate` lint has shipped in
   every note-write receipt since v1.64.0 (commit `4499698c`,
   `src/core/brain/page-lint.ts:389-414`, `src/mcp/brain/notes-tools.ts:481-488`).
   - **What the card still adds:** the extension beyond that hint (reaching
     other directories, scoring by embedding, comparing facts and not just
     pages) and safer surfacing.
   - **The shipped hint has a reach leak:**
     - `lintWrittenPages` takes no reach predicate (`page-lint.ts:583`), and
       `noteWriteResult` calls it without the caller's reach
       (`notes-tools.ts:487`).
     - A receipt can therefore name a withheld sibling and its score, and
       the `candidates_skipped` and `candidates_unreadable` counts can
       disclose one.
     - Fixing this is unconditional and lands first.
   - **The card's anchors do not hold:**
     - `page-dedup.ts` is the merge tool for preferences.
     - `create-note.ts:121` is the policy for an occupied path.
     - `rerank-eval-gate.ts` measures recall hit@k and MRR, not
       duplicate-catch or wrong-hint rates, so it cannot gate any default.
3. **Date grounding needs data, not only a prompt (t_b915b9cc).**
   - The extract lane mines taste rules, not facts
     (`extract-signals.ts:422-423`).
   - `MinedTurn` keeps only `turnId` and `text` (`:186-189`), although
     `ExpandedRawTurn.timestamp` is available (`session-recall.ts:176`).
     `MinedTurn` must carry the turn timestamp, and the transcript line must
     show it.
   - The extract instruction must require that any time bound is written as
     an ISO date or interval.
   - The dream pass already turns ISO tokens in a principle into
     `valid_from` / `valid_until` (`dream-plan-topics.ts:604-615` through
     `extractTemporalConstraints`, `temporal-extract.ts:45`), and that
     temporal extraction is reused unchanged.
   - No natural-language date parser and no phrase lists are added, because
     language independence is a kernel rule (`temporal-extract.ts:5-8`,
     `fact-extract.ts:9-13`).
   - Acceptance inside a question or proposal cannot be supported. Only user
     turns reach the prompt (`MINED_TURN_ROLE = "user"`, `:96`), so it is
     deferred.
4. **Stage timings have a narrower reach than the card says (t_72e93e18).**
   - **Where they attach:** `mcp_route_latency` is emitted from one seam,
     `MCPServer.invokeToolHandler` (`src/mcp/server.ts:280-322`). That seam
     serves the JSON-RPC `tools/call` path and the CLI `callTool` bridge
     (`server.ts:255`, `src/cli/main.ts:1113`), so stage timings attach
     there and only there.
   - **Hooks are out of scope.** Lifecycle hooks call
     `captureSessionLifecycleEvent` directly (`hooks/session-capture.ts:144`)
     and hand the dedup walk to a detached worker (`:82-95`).
   - **Stage names follow what the write tools actually do:**
     - signal validation;
     - the idempotency-key lookup (`signal.ts:357`);
     - the atomic document write (`:382-399`, `create-note.ts:570`);
     - remembering the key (`signal.ts:412`);
     - the log append (`feedback-tools.ts:224`);
     - the forced preference write (`:270`);
     - the write receipt (`create-note.ts:594`, `write-batch.ts:901`);
     - the receipt lint;
     - the near-duplicate lookup.
   - **The card names stages that do not exist on these routes:**
     "snapshot" means the write receipt, and "index or ledger writes" are
     not on these routes at all.
   - **One premise claim was wrong.** The timing premise said `brain_feedback`
     has no similarity stage. `adviseIncomingFeedback`
     (`write-advisory.ts:163`) already runs a Jaccard pass on that route, so
     `near_duplicate_lookup` is a real stage there today.
5. **Preferences carry no sign.** `BrainPreference` (`src/core/brain/types.ts:875`)
   has no `signal` field, so a "same sign only" guard on retire siblings
   cannot be built. The precision guards are a minimum token count, the
   accept gate, and an off-by-default key.

## Scope

- **Shared kernel.** One pure near-duplicate lookup,
  `src/core/brain/near-duplicate.ts`, built on `tokenise` / `jaccard`. It
  applies a reach predicate before any scoring or counting, holds one named
  threshold table, requires a minimum token count, caps its work, and labels
  every match with a `method`.
- **Forget side (t_acab97de).** A read-only retire-sibling projection on the
  dream retire set and on `reject`.
  - It surfaces in `DreamRunSummary.retire_siblings` and in
    `brain_review_candidates.retire_siblings`, and `o2b brain reject` prints
    it.
  - It runs a lexical tier always. It also runs a stored-vector tier, which
    reuses embeddings already paid for in the search index and makes zero
    provider calls.
  - Acceptance goes only through existing verbs: `brain_apply_evidence
    result: outdated` or `o2b brain reject`.
  - It is off by default.
- **Write side (t_fda66477).**
  - The reach fix for the shipped `near-duplicate` lint, on unconditionally.
  - A widening beyond the directory, off by default. It pulls BM25
    candidates from the existing keyword index, rescores them through the
    kernel, and has zero embedding spend.
  - `adviseOnIncoming` scoring moves onto the kernel, with its threshold
    source unchanged, so the write side has one scorer.
- **Extract rules (t_b915b9cc).**
  - `MinedTurn.timestamp`, and a transcript line `[turnId @ <timestamp>]`.
  - Language-neutral hygiene rules in the prompt.
  - A refusal of duplicate `topic` values in one payload, under
    `crossItem`.
  - An additive `timestamp` on the `turns_mined` projections.
- **Stage timings (t_72e93e18).**
  - One route scope that carries decision time and stages. It replaces the
    decision-only AsyncLocalStorage store.
  - A closed allowlist of stage names, enforced where the record is
    emitted.
  - An optional `stages` array on `mcp_route_latency`, 0.1 ms precision.
  - A per-stage roll-up in the `brain_route_metrics` summary.
  - Instrumentation on `brain_feedback` and on the four note-write tools.
- **Release.** CHANGELOG `[1.74.0]`, `docs/mcp.md`, `docs/observability.md`,
  `docs/cli-reference.md`, and the version bump inside this PR.

## Out of scope

- **Model-generated rewordings.** A reworded fact is new content written by
  a model, which is not accept-gated surfacing. Under this design,
  "rewording" means the operator rewrites the fact using the existing
  verbs, after seeing the surfaced pair.
- **Write-time embedding.** The new body is not indexed at write time, so a
  semantic write hint means one paid embed per write, more for batches. It
  also needs a labelled pair evaluation (duplicates caught against wrong
  hints) before any default could change. Both are deferred to their own
  wave.
- **Decision-model pair verdicts on retire siblings.** `runPairVerdicts` /
  `advisoryUseActive` could add them later, behind the advisory egress path.
- **A Jaccard refusal across items in extract-signals.** Refusal rejects the
  whole payload, and two short principles with opposite meanings ("use
  tabs", "never use tabs") score high, so one false positive would drop
  every valid signal in the run. Only the exact duplicate-topic rule ships.
- **Hook capture timing** and **acceptance inside an assistant turn.**
- **Changes elsewhere.** No change to `computeDedupHash`, to hygiene
  `forget`, to `moveToRetired` or to `detectSemanticDedup`, which stays
  without a production caller.

## Chosen approach

This is the first consultant's Variant B ("lexical kernel plus a vector
tier that reuses paid embeddings"), built in the staged form it
recommended. Three guards from the adversarial consultant's C1 are folded
in:

1. The reach fix is unconditional and lands first.
2. Every new surface is advisory, read-only and off by default.
3. Nothing in this wave calls an embedding provider.

**The kernel.** `findNearDuplicates(probe, pool, opts)` is pure. It
receives:
- a probe;
- a candidate pool, which the caller has already projected into tokens;
- a required `readable` predicate;
- a threshold from `NEAR_DUPLICATE_THRESHOLDS`;
- `minTokens` and `cap`.

Withheld candidates are dropped before they are scored and before they are
counted, so neither a match nor a census number can disclose them. The
kernel returns matches labelled `method: "lexical"` and a census that
counts only readable entries.

**The vector tier.** It lives in a separate module that reads the index,
`src/core/brain/near-duplicate-vectors.ts`. It follows the precedent of
`src/core/brain/surprisal.ts`:
- It opens the store read-only.
- It reads vectors that are already stored, through
  `storedEmbeddingsForDocument` (`src/core/search/store/vectors.ts:262`).
- It compares only vectors whose `model` and `dimension` match.
- It never imports a provider.
- It reports its outcome as a named status (`used`, `index_missing`,
  `vec_unavailable`, `model_mismatch`). It never degrades silently.

The kernel never sees vectors. The projection merges the vector scores
into matches labelled `method: "embedding"`.

**The forget side.** `planRetireSiblings` is pure, like `planAutoRetires`,
so the dream dry run stays write-free and the dry and real runs agree.

1. It runs inside `dream()` once the retire plan is complete.
2. The summary builder drops siblings of the retires that were gated at
   apply time (`gated_retires`).
3. `buildReviewCandidates` projects the result and, when a search config is
   present, adds the vector tier (the same `opts.searchConfig` path that
   `scoreSignalNovelty` already uses).
4. `review-tools.ts` filters both ids of every pair through the caller's
   reach view before counting.
5. `reject` prints the siblings of the preference it just retired, at the
   CLI's operator reach.

**The write side.**
- **Reach.** `lintWrittenPages` gains a required options object with
  `readable`, and `noteWriteResult` threads `readableAtContextReach(ctx)`
  through, which covers all four note-write tools at once.
- **Widening.** When the widening key is on, an async pre-step in
  `notes-tools.ts` (`collectWideningCandidates` in the new
  `src/core/brain/page-lint-widening.ts`) builds an FTS5 query with
  `buildFtsMatch` from the written body. It pulls the BM25 top-k chunks
  through `keywordTopK`, maps them to documents, re-reads each candidate
  from disk, and hands it to the lint as an extra candidate. The scope-bucket
  rule and the reach rule are unchanged. The census reports the widening
  status, and that field is absent when the key is off, so a clean receipt
  stays byte-identical.

**Extract.** The extract lane reaches no Jaccard code:
- it adds the timestamp field and its rendering;
- it adds the prompt rules;
- it extends the existing `registerResponseCheck` closure with an exact
  duplicate-topic rule.

**Stage timings.** A new `src/core/route-scope.ts` takes over the
AsyncLocalStorage store from `src/core/decision-model/latency.ts`. That
file shrinks to a re-export of `noteDecisionLatency`, so `run.ts` is
untouched. `invokeToolHandler` opens one `createRouteScope()` instead of
`createDecisionLatencyScope()`. The write tools wrap their stages in
`timeStageSync` or `timeStage`, which use `try/finally` and never swallow
an error. `emitMcpRouteLatency` then:
- drops any name outside `ROUTE_STAGE_NAMES`;
- sums repeated names, keeping the order each name was first seen;
- rounds to 0.1 ms;
- omits `stages` when nothing was noted.

With the gate off, no scope is open, and every stage helper costs one
`getStore()` that returns `undefined`.

## Design decisions

- **One threshold table, values unchanged where a behaviour already
  ships.** The table is `NEAR_DUPLICATE_THRESHOLDS`:

  | Key | Value | Source |
  |---|---|---|
  | `writeHint` | 0.8 | `NEAR_DUPLICATE_JACCARD`, which becomes an alias |
  | `retireSiblingLexical` | 0.7 | the doctor lint bar |
  | `retireSiblingEmbedding` | 0.92 | the entity semantic-dedup bar, `entities/semantic-dedup.ts:39-41` |

  The feedback advisory keeps reading
  `BRAIN_HEALTH_DEFAULTS.contradiction_jaccard`, which operators can
  configure. Only its scoring loop moves onto the kernel.
- **`readable` is required, not optional.** If the predicate were
  optional, the leak this wave fixes could come back at a new call site. An
  operator-reach caller, such as the `reject` verb or a CLI dream, passes
  `READ_ALL_REFS` explicitly, so every unfiltered call is visible in the
  diff.
- **A minimum of 4 tokens for both the probe and the candidate
  (`NEAR_DUPLICATE_MIN_TOKENS`).** Short principles share most of their
  tokens by accident. Below that count the kernel does not score at all,
  and the census reports `below_min_tokens`.
- **Off-by-default keys, read through `resolveConfigFlag`:**
  - `near_duplicate_retire_siblings_enabled`, env
    `OPEN_SECOND_BRAIN_NEAR_DUPLICATE_RETIRE_SIBLINGS_ENABLED`;
  - `near_duplicate_write_widening_enabled`, env
    `OPEN_SECOND_BRAIN_NEAR_DUPLICATE_WRITE_WIDENING_ENABLED`.

  Stage timings reuse the existing `mcp_route_metrics_enabled` and add no
  key. The reach fix and the extract changes have no key: the first is a
  defect fix, the second a contract tightening.
- **The vector tier has no key of its own.** It runs only when
  retire-siblings is on and stored vectors exist. It costs zero provider
  calls and zero new egress, so a separate key would be configuration
  without a decision behind it. The status field makes it visible whether
  the tier ran.
- **Spend gates by construction.** Neither `near-duplicate-vectors.ts` nor
  `page-lint-widening.ts` imports from `src/core/search/embeddings/`. A
  test that scans the source of both modules pins this, and also pins that
  `detectSemanticDedup` still has no production caller. The egress census
  delta for this wave is zero.
- **Retire siblings live in the plan, not the apply step.**
  `moveToRetired` and the write-site and destructive-site censuses are
  unchanged. An accepted sibling retires on the next dream pass through
  the existing superseded-by-context path, or at once through `reject`.
  Siblings are never cascaded: a sibling of a sibling is not computed.
- **The pool for retire siblings** is every active preference (unconfirmed,
  confirmed or quarantine) except:
  - the retiring set itself;
  - pages that have already been merged, using `isMergeResolved`, as
    `hygiene/detectors/dedup.ts:96-97` does.

  The pool crosses topic and scope buckets, because a later paraphrase
  usually lands under another topic slug. The cost is O(retires x active)
  and is capped by `NEAR_DUPLICATE_CANDIDATE_CAP` (200, matching
  `NEAR_DUPLICATE_MAX_CANDIDATES`).
- **Widening is bounded.** `NEAR_DUPLICATE_WIDENING_TOP_K` is 20 chunks. A
  candidate already present from the same directory is not counted twice.
  An index that cannot be opened, or has no FTS table, reports
  `widening: "index_unavailable"` and never fails the write. The write path
  stays fail-open, as the existing lint does.
- **The extract timestamp is rendered verbatim.** It is the stored string,
  never a locale-formatted `Date`, so Windows and Linux output stay
  byte-identical. An empty timestamp drops the `@` part, and `now` is never
  substituted. The resolved date stays in the principle text, and the dream
  pass derives the window. The extract lane never writes `valid_from`,
  because `signal.ts:147-152` reserves it for event-time backfill.
- **One store for decision time and stages.** Two AsyncLocalStorage stores
  would double the wrapping in `server.ts`. Stage names are code constants,
  and the allowlist is enforced in `emitMcpRouteLatency`, not at the call
  sites, so a hostile name cannot reach disk. That property gets its own
  test against a persisted record.
- **No timing in tool responses.** Stages live only in the continuity
  record. `docs/observability.md` lists the routes that emit stages, so an
  absent array reads as "not instrumented", not as "zero cost".

## Kernel invariants this design respects

1. **Language independence.** There are no word lists, phrase lists or
   relative-date parsers. Similarity is `tokenise` / `jaccard` over Unicode
   letter and number runs. The hygiene rules are prompt text that applies
   to any language.
2. **No model in the kernel.** The kernel, the planner, the widening step
   and the stage scope are all deterministic. The only model-facing change
   is envelope text that the calling agent executes, behind the existing
   `buildNeedsLlmStep` registry.
3. **Embedding spend gates (v1.72.0 / v1.73.0).** The wave makes zero
   `provider.embed` calls. The vector tier reads only stored vectors, and
   the widening step is BM25. Nothing bypasses `prepareQueryEmbed`, because
   nothing needs it.
4. **Accept-gated, off-by-default proposals.** Retire siblings are a
   projection. A sibling retires only when the operator calls an existing
   verb. Both new behaviour keys default to off, and with them off every
   receipt, summary and review projection is byte-identical to v1.73.0.
5. **Reach and visibility.** Matches are filtered before scoring and
   counting on every surface: receipts, review candidates, the dream
   summary and the reject output. The visibility-surface registry gains a
   row for the note-write lint and a note on the `brain_review_candidates`
   row.
6. **Determinism and dry-run purity.** `dream({ dryRun: true })` stays
   write-free. `planRetireSiblings` is pure and sorts its output by
   `(retiring_id, -score, sibling_id)`.
7. **Fail-closed registry.** The extract check extends the single existing
   registration (`extract-signals.ts:302-329`) and uses the closed
   `SEMANTIC_VIOLATION_CODES.crossItem` code.

## File changes

New:
- `src/core/brain/near-duplicate.ts`
- `src/core/brain/near-duplicate-vectors.ts`
- `src/core/brain/retire-siblings.ts`
- `src/core/brain/page-lint-widening.ts`
- `src/core/route-scope.ts`
- the tests named in `plan.md`

Modified:
- **Forget side:** `src/core/config.ts`, `src/core/brain/dream.ts`,
  `src/core/brain/dream-types.ts`, `src/core/brain/review-candidates.ts`,
  `src/mcp/brain/review-tools.ts`, `src/cli/brain/verbs/reject.ts`.
- **Write side:** `src/core/brain/page-lint.ts`,
  `src/mcp/brain/notes-tools.ts`, `src/core/brain/write-advisory.ts`,
  `src/core/brain/health/contradiction.ts`,
  `src/core/search/visibility-surface-registry.ts`.
- **Extract:** `src/core/brain/extract-signals.ts`,
  `src/mcp/brain/extract-tools.ts`, `src/cli/brain/verbs/extract-signals.ts`.
- **Stage timings:** `src/core/decision-model/latency.ts`,
  `src/core/brain/mcp-route-metrics.ts`, `src/mcp/server.ts`,
  `src/core/brain/signal.ts`, `src/mcp/brain/feedback-tools.ts`,
  `src/core/brain/notes/create-note.ts`, `src/core/brain/write-batch.ts`,
  `src/mcp/brain/recall-tools.ts`.
- **Docs:** `CHANGELOG.md`, `docs/mcp.md`, `docs/observability.md`,
  `docs/cli-reference.md`.
- **Version:** `package.json` and the mirrors that
  `scripts/sync-version.ts` rewrites.

The count per lane is in `plan.md`: 51 files written by hand, plus 9
generated by `sync-version.ts`. No skill or `hooks/hooks.json` change is
planned, so `sync-plugin-mirrors` is not triggered. If a skill line is
edited after all, the integrator runs `bun run sync-plugin-mirrors`.

## Risks and open questions

- **Cross-topic false positives on retire siblings.** These are mitigated by
  the 0.7 / 0.92 bars, the 4-token minimum, the off-by-default key and the
  accept gate. There is no cascade, because siblings are never computed
  for siblings.
- **Stale vectors.** Stored vectors trail the last reindex. The tier
  compares only vectors from the same model and dimension. A page that
  changed since its last embedding is still scored on its old vector,
  which is acceptable for an advisory, and the docs say so.
- **Index staleness for widening.** A page that was just written, or a
  sibling written recently, may not be indexed yet. Widening is
  best-effort beyond the same-directory walk, which still reads the disk.
  Candidates are re-read from disk, so a deleted page in the index cannot
  produce a hint.
- **Latency on the write path.** Widening adds one read-only store open and
  one FTS query per note-write call. The `near_duplicate_lookup` stage
  measures it, which is the reason this wave ships timings with the lookup.
- **Windows CI.**
  - Tests assert only that stages are present, that their names are
    allowed, and that their values are finite and non-negative. They never
    assert a positive duration or an order.
  - Fixtures set mtimes explicitly.
  - Paths stay vault-relative POSIX through `canonicalPage`.
  - Timestamps are rendered verbatim.
- **Overlap with card t_cabe84aa (supersede sweep).** That card also extends
  `DreamRunSummary`. This wave adds only the optional `retire_siblings`
  field, so a later supersede field does not collide with it.
- **Decided by the design writer.** These were open in the premises:
  1. Vector tier on the forget side only. There is no write-time embed.
  2. The Jaccard refusal in extract-signals is deferred, and only
     duplicate-topic ships.
  3. Repeated stages are summed per name.
  4. Stage precision is 0.1 ms.
  5. `readable` is required in the kernel.
  6. Docs and the version bump belong to the integrator, not to a lane.
