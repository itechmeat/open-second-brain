# Near-Duplicate Defense Across the Fact Lifecycle - brainstorm audit trail

## Consultants

The prompt is `cli-output/prompt.md`. Raw outputs are in `cli-output/`.

1. **Primary: Claude Code** (`claude -p`). It exited 0 and returned four
   variants (A-D) and a recommendation. Raw output: `cli-output/claude.md`.
2. **Codex: not available.** The run stopped with
   "You've hit your usage limit ... try again at Oct 11th, 2026 3:03 AM".
   `cli-output/codex.md` is empty.
3. **opencode: not available.** It rejected its command-line arguments and
   printed its usage text instead of running. `cli-output/opencode.md` is
   empty.
4. **Second consultant: a second Claude Code instance**, briefed with an
   adversarial lens. Its job was to attack the obvious shared design, find
   the most likely failure modes, and propose counter-variants and the
   minimal honest scope. It returned three counter-variants (C1-C3), a
   recommendation (C1) and a gate list. Raw output:
   `cli-output/second-claude.md`.

Both transcripts are reproduced below verbatim.

## Primary consultant (Claude Code) - verbatim

# Near-duplicate defense: architectural variants

I read all four premise reports. Every variant below is built on their corrections:

- The forget-side scan hooks the dream retire plan (`dream.ts:297`) and the `reject` verb. It does not hook hygiene `forget`.
- The v1.64.0 receipt hint is extended. It is not rebuilt.
- Date grounding means a timestamp on `MinedTurn` plus a prompt instruction to write ISO dates.
- Stage timings ride on `mcp_route_latency` and use stage names the write tools actually have.

Two facts hold for every variant:

- **The shipped write hint leaks.** `lintWrittenPages` has no reach predicate (`page-lint.ts:583`, `notes-tools.ts:487`), so a receipt can name a page the caller can't read. Every variant fixes this first, unconditionally.
- **The timing premise is slightly off.** It says `brain_feedback` has no similarity stage. But `adviseIncomingFeedback` (`write-advisory.ts:163`) already runs a Jaccard pass on that route. This wave adds more lookups, so a `near_duplicate_lookup` stage becomes real on several routes. That is exactly the cost the timing card should measure.

---

## Variant A: "One lexical kernel, zero new spend"

**Approach.** One new pure module, `src/core/brain/near-duplicate.ts`, built on `tokenise`/`jaccard`. It takes:
- a probe;
- a candidate source, injected as a small interface: directory siblings, a cross-directory search-index pull, active preferences, or the other items in the same payload;
- a reach predicate, applied before scoring and before counting;
- a cap.

It returns `{ candidates: [{ ref, score, method: "lexical" }], census: { compared, capped } }`. All the thresholds sit in one named table: write hint 0.8, retire sibling 0.7, in-payload 0.8 for items with the same signal.

Four callers use it:
- **The retire-sibling projection.** It is computed after `planAutoRetires`, checked against the retires that are gated at apply time (`gatedRetireSlugs`), and shown as `retire_siblings` in `brain_review_candidates`. Retiring a sibling is accepted through the existing `apply_evidence outdated` or `reject`.
- **The receipt lint.** It gets the reach fix, plus an optional cross-directory pull from the existing keyword (BM25) search index. That pull sits behind a config key that is off by default.
- **The extract-signals check.** One `crossItem` check is added to the existing registration.
- **`adviseIncomingFeedback`.** It is refactored onto the same core.

Stage timings come from extending the decision-latency storage scope (an AsyncLocalStorage) into one shared route scope. Stage names are a closed allowlist that `emitMcpRouteLatency` enforces. They are written only to the continuity record, never to the tool response.

**Pros**
- No embedding spend and no egress.
- Fully deterministic, and the dream dry run stays write-free.
- One threshold table replaces three copies that are drifting apart (0.6, 0.7, 0.8).
- It fits the budget, at roughly 40–45 files.
- Low risk on Windows.

**Cons**
- Real paraphrases often score below a 0.8 Jaccard. Cross-topic comparison of short principles is noisy, which needs a minimum token count.
- The "embeddings" half of the write-hint card stays unbuilt.

**Cuts or defers**
- The semantic tier.
- Model-generated rewordings. "Reword" becomes "show the pair, and the operator rewrites it with the existing verbs."
- Hook capture timing.
- Acceptance-inside-a-proposal in extract-signals.

---

## Variant B: "Lexical kernel plus a vector tier that reuses paid embeddings" (two tiers)

**Approach.** Same module, contract and callers as A. The difference is a second tier, `method: "embedding"`. It only does vector-to-vector cosine over vectors already stored in the search index, so it never calls `provider.embed`.

- **Forget side.** The retiring preference and its siblings are both already indexed, so the tier costs nothing at the margin and runs whenever vectors exist.
- **Write side.** The new body is not indexed yet. The tier is either skipped and disclosed as `semantic: not_indexed`, or, behind a key that is off by default, it embeds the body through `prepareQueryEmbed` with full spend reporting.

The orphan `detectSemanticDedup` is reworked onto the stored-vector reader, so it no longer calls embed directly without a spend gate.

**Pros**
- Delivers the residual value the write-hint card actually has: catching paraphrases across directories and topics.
- On the forget side it does so with no new spend.
- Respects the v1.72.0/v1.73.0 spend gates by construction.
- The `method` label in the receipt and in review candidates tells the operator which tier fired.

**Cons**
- It needs a reader that fetches stored vectors by page, which may not exist yet. The reader also has to match the index's chunking (page vector vs. chunk max).
- Stored vectors go stale between reindexes.
- About 50–55 files, at the top of the budget.
- Promoting the write-side embed to on-by-default needs a labelled pair evaluation that this wave doesn't build.

**Cuts or defers**
- Write-time embedding stays opt-in and unevaluated.
- Model rewordings.
- Hook timing.

---

## Variant C: "Out-of-band candidate ledger"

**Approach.** The write path keeps only the reach-fixed lexical lint for directory siblings. Every wider lookup moves off the hot path: cross-directory, cross-type, embedding-based and retire-sibling scans all run in the dream or hygiene pass after reindex. Results go to a persisted `near_duplicate` candidate ledger. `brain_review_candidates` and the next receipt that touches the page show the pending pairs.

**Pros**
- No latency added to the synchronous write tools.
- The embedding tier always uses paid vectors.
- One review queue covers the write side and the forget side.

**Cons**
- The hint arrives late. The writer who created the duplicate never hears about it in the same turn, which is what the write-hint card was for.
- It adds a persisted store with its own reach filtering, expiry and staleness rules, which is new kernel state.
- Extract-signals still needs a separate in-payload check.
- The stage-timing card measures much less, because the expensive stage leaves the routes being timed.

**Cuts or defers**
- Same-turn cross-directory hints.
- Rewordings.

---

## Variant D: "Model-assisted rewording proposals"

**Approach.** Variant A's kernel finds the candidates. Then a new `needs_llm` step, registered in the existing step registry with response-shape and semantic checks, asks the agent for a verdict on each retire/sibling pair (same / related / different) and, for `related`, a proposed rewording. Proposals are written as pending review items. They are applied only when the operator accepts them through a new accept verb. The pair-verdict machinery (`runPairVerdicts`, `advisoryUseActive`) is reused when a decision model is configured.

**Pros**
- Matches the card's literal "accept-gated rewording proposals".
- The kernel stays model-free; the model runs only behind the step registry and the egress registry.

**Cons**
- It adds a new executor that writes, an accept verb, a pending-proposal store and a new response surface, all on top of the kernel. That is about 55–65 files, which breaks the budget.
- More egress of preference principles.
- The weakest correctness story of the four. The upstream project measured a rise in wrong merges even from a plain hint.

**Cuts or defers**
- It has to drop either the stage-timing card or the vector tier to fit.

---

## Cross-cutting choices (the same in A, B and C)

- **Write receipt.** Extend the hint; don't replace it. Keep the code `near-duplicate`, add `method`, and keep the receipt byte-identical when there is no finding. Withheld siblings are dropped before they are counted.
- **Defaults.** Cross-directory widening and retire-sibling surfacing are behind config keys that are off by default. Only the reach fix is on unconditionally.
- **Stage names.** A closed set:
  - `validate`
  - `idempotency_lookup`
  - `near_duplicate_lookup`
  - `document_write`
  - `idempotency_remember`
  - `log_append`
  - `preference_write`
  - `write_receipt`
  - `lint`

  Timing uses separate sync and async helpers with `try/finally`. Stages are rounded to 0.1 ms. The docs list which routes emit stages, so a missing array reads as "not instrumented" rather than "zero cost". Stages are never written to the tool response.
- **Extract-signals.** Turn timestamps are rendered verbatim, and the line drops the `@` marker when the timestamp is empty. Hygiene rules go in as language-neutral prompt text. Two `crossItem` refusals are added: duplicate `topic` in one payload, and principles that are too similar within the same `signal`, using the shared kernel's threshold.

---

## Recommendation: Variant B, built in stages

Build A's kernel and callers first; they carry the whole wave. Then add only the stored-vector tier, active on the forget side and used opt-in on the write side.

B is the only variant that delivers the write-hint card's real remaining value (catching paraphrases across directories and across facts) without breaking the spend gates. It reuses vectors that are already paid for and keeps the write-time embed off by default. It also keeps the hint in the same turn, unlike C, and avoids a new executor that writes, unlike D. The rewording half becomes an operator action on a surfaced pair, which meets "accept-gated" without a model.

If the stored-vector reader turns out not to exist, or not to line up with the index's chunking, B drops back cleanly to A by turning off one tier. Nothing about the contract or the callers changes.

## Second consultant (second Claude Code instance, adversarial lens) - verbatim

# Adversarial review: Near-Duplicate Defense wave

## 1. Most likely failure modes

**F1. Wrong-merge or wrong-retire churn from cross-bucket lexical matching.** This is the most likely way the wave goes wrong. The obvious shared design is one candidate lookup, cross-directory and cross-topic, maybe with embeddings, wired into retire, write and extract. Cross-bucket Jaccard on short principles is noisy. "use tabs" and "never use tabs" score high, and the premise reports already warn about stop-token overlap. Two parts make it worse:
- On the retire side, one `outdated` event (`dream-refresh.ts:215-231`, which already ignores pin) produces a sibling list. Operators or agents who mechanically apply `outdated` to every listed sibling cause a cascade.
- On the extract side, an in-payload Jaccard refusal rejects the whole payload (refusal, not filtering). One false positive therefore drops every valid signal in that run, silently from the operator's point of view.

Upstream measured wrong merges rising from 2.50% to 3.75% with a default-on hint. This vault has more short, polarity-sensitive rules than upstream's pages.

**F2. Visibility leak that grows with the reach of the lookup.** The shipped `near-duplicate` lint already leaks: `lintWrittenPages` has no `readable` predicate (`page-lint.ts:583`, called at `notes-tools.ts:487`). It discloses withheld sibling paths and scores, and leaks through the `candidates_skipped` and `candidates_unreadable` counts. A shared lookup that goes vault-wide (FTS widening, embeddings, cross-topic retire siblings) turns a same-directory leak into a vault-wide one. The leak then appears on four surfaces at once: write receipts, `brain_review_candidates`, the extract envelope and the dream summary. Calling this "recall-quality regression" understates it. It is a reach-invariant break, and it is the most damaging outcome if it ships.

**F3. Spend and latency leaks hidden by the instrumentation meant to measure them.** Two risks:
- **Spend.** A semantic layer on the write path costs one embed per note write, multiplied by `brain_write_batch`. The tempting reuse, `detectSemanticDedup`, calls `provider.embed` directly with no gate (`dedup.ts:154`).
- **Timing.** The stage card measures only MCP `tools/call`. Its natural stage set has no `similarity_lookup` stage, because none exists today. If the lookup lands without a stage name in the closed allowlist, the added cost is invisible, which defeats the wave's own spine claim. If stage names are built from input, or the `stages` array is emitted on every record including the gate-off path, records bloat and the content-free claim breaks.

Secondary hazards:
- **Windows CI.** Asserting positive or ordered sub-millisecond durations, or mtime-ordered candidate fixtures, will flake on Windows timer and filesystem resolution. Locale-formatted timestamps in the transcript line will differ by OS.
- **Dry-run versus real-run drift.** Siblings of retires that are gated at apply time (`dream-apply.ts:298-311`) get reported as if they were retiring.

## 2. Counter-variants

### C1 "Fix the leak, measure, then defend" (minimal honest scope)
Ship the reach fix for the existing lint, stage timings and the language-neutral extract rules. Ship the retire-sibling scan as a read-only, lexical, same-signal projection in `brain_review_candidates`. There is no shared vault-wide lookup, no embeddings and no write-side widening. The shared primitive is a small pure helper over `tokenise`/`jaccard`: `nearDuplicateCandidates(subject, pool, {threshold, minTokens, readable})`. It returns `{id, score, method: "lexical"}[]`, filters by the reach predicate before scoring and counting, and is called by the retire projection, the extract cross-item check and the lint.

- **Pros**
  - Zero new spend or egress.
  - Closes a real shipped defect.
  - Every new output is advisory or read-only.
  - Each new behaviour can be traced through the timings.
  - Roughly 30-38 files.
- **Cons**
  - The cross-directory and paraphrase cases from t_fda66477 stay unsolved.
  - The card's headline ("hint an existing similar page") ships as "the hint is now safe", not "the hint is smarter".
- **Cuts and defers**
  - FTS-backed widening.
  - The semantic layer and its labelled-pair evaluation.
  - Decision-model pair verdicts on retire siblings.
  - Rewording proposals, which are cut outright and not just deferred.
  - Hook-capture timing.
  - Assistant-turn acceptance.

### C2 "Shared lookup, lexical lanes only, widening behind a flag"
Same as C1, plus an index-backed lexical candidate pull (FTS/BM25 top-k, rescored with Jaccard) for the write lint. It is behind a config key that defaults to off, with a time and size bound and a disclosed skip when a bound trips.

- **Pros**
  - Catches cross-folder duplicates at zero embedding spend.
  - Proves the shared lookup on a second candidate source.
- **Cons**
  - Adds a search dependency on the hot write path.
  - Index staleness: the newly written page is not indexed yet, and recently written siblings may not be either.
  - Needs its own cost test.
  - Ships a default-off feature with no evaluation to justify ever turning it on.
- **Cuts and defers**
  - Embeddings.
  - Pair verdicts.
  - Rewording.
  - The promotion evaluation.

### C3 "Retire side only, write side is a bug fix" (narrowest)
Ship only the retire-sibling projection and the reach fix. Defer t_b915b9cc and t_72e93e18 to the next wave.

- **Pros**
  - Smallest diff, about 20 files.
  - A single new behaviour to review.
- **Cons**
  - Drops the spine's "measured cost" leg.
  - The timing card is the cheapest and safest of the four, so cutting it removes risk nobody was carrying.
  - The date-grounding part of t_b915b9cc is a free win: the downstream ISO extraction already exists.
- **Cuts and defers**
  - Two whole cards.

**Attack on the ambitious first-consultant shape** (one embedding-backed lookup across all four paths): it fails all three tests in section 1 at once. It adds new egress and spend on the write path, a vault-wide reach surface and a whole-payload refusal triggered by semantic similarity. It also has no evaluation that can measure any of this, because `rerank-eval-gate.ts` measures recall hit@k and MRR, not duplicate-catch or wrong-hint rates. Reject any variant that turns on embeddings without a labelled-pair evaluation landing in the same PR.

## 3. Minimal honest scope (my recommendation: C1)

**Ship in one PR:**
1. **t_fda66477, reach fix only.** Add a `readable` predicate to `lintWrittenPages` and `collectNearDuplicateCandidates`, threaded from `noteWriteResult` so it covers all four note-write tools. Withheld siblings are neither scored nor counted. Add a visibility-surface registry row for the note-write lint and a byte-identical clean-receipt test.
2. **t_acab97de, a read-only `retire_siblings` field.** Compute it after `planAutoRetires` (`dream.ts:297`), and add it to `DreamRunSummary` and `buildReviewCandidates`.
   - **Triggers:** superseded-by-context, rebutted, quarantine-violated, and user-rejected. Decay retires and merges are excluded.
   - **Matching:** lexical, threshold ≥0.7, a minimum token count, same `signal` sign only, capped like `DEDUP_CANDIDATE_CAP`.
   - **Reconciliation:** check against gated retires.
   - **Acceptance:** only through existing verbs (`outdated` evidence, `reject`). No new executor. Nothing retires automatically.
3. **t_b915b9cc.** Carry the turn timestamp into `MinedTurn`. Render it verbatim, and leave it out when empty, never substituting `now`. Add the ISO-bound instruction and the prompt-only hygiene text. The cross-item check refuses duplicate `topic` values only. Ship the Jaccard cross-item refusal only if fixtures prove zero false refusals on short same-signal principles; otherwise defer it.
4. **t_72e93e18.** Use one shared ALS scope that carries both `decision_ms` and `stages`, so there is no second store. Stage names form a closed allowlist enforced in `emitMcpRouteLatency`, and it includes `near_duplicate_lookup` for the lint. The `stages` key appears only when at least one stage was noted, and only when the existing default-off gate is on. Durations use 0.1 ms rounding. Docs list which routes emit stages and state that hooks are out of scope.

**Explicitly left undone, and stated in CHANGELOG and docs:**
- Rewording proposals. A model-generated reword is a write of new content, so it is not "accept-gated surfacing".
- Any embedding or semantic layer, and the labelled-pair evaluation it needs.
- FTS cross-directory widening.
- Decision-model verdicts on siblings.
- Hook-capture stage timing.
- Assistant-turn acceptance.
- Any change to `computeDedupHash`.
- The hygiene `forget` anchor, which stays untouched.

## 4. Gates that must hard-fail the build

| Gate | Must fail when |
|---|---|
| **Visibility-surface census** (`tests/core/architecture/visibility-surface-census.test.ts`) plus a reach test | Any surface returns a sibling id, path, score or count without a reach predicate. This is the gate that matters most for this wave. |
| **Egress census** (`egress-census.test.ts`) | Any new network path appears. Under C1 the expected delta is zero, so any delta means the scope slipped. |
| **Embedding spend counters / `planEmbeddingSpend` path** | Any `provider.embed` call is reachable from a dream, write or extract path without going through `prepareQueryEmbed`. Under C1 that call count must also be zero. Add an assertion that `detectSemanticDedup` still has no production caller. |
| **Architecture census, specifically write-site and destructive-site** (`write-site-census`, `destructive-site-census`) | A new write or a new caller of `moveToRetired` appears. The retire projection must add neither, since it is accept-gated by construction. |
| **Route-metrics payload safety** | A stage name outside the allowlist reaches disk. Test with a hostile name on a persisted record. |
| **Response-check registry** | A second `registerResponseCheck` on the extract surface is registered (it already throws), or a violation code appears outside the closed set. |
| **`sync-version --check`, `sync-plugin-mirrors:check`, Windows job** | These standing gates are already blocking. |

**The rerank evaluation gate should not be a gate for this wave.** It measures something else, and citing it as cover would be a false assurance. If a later wave adds a semantic hint, its own duplicate-catch/wrong-hint evaluation must hard-fail before the config default can change.

**Why C1:** the wave can close a real shipped reach leak, measure its own cost, and make retirements visible without adding any spend, egress or automatic action. Every ambitious variant depends on a precision claim (cross-bucket or semantic near-duplicate detection) that no gate in the repo can currently test. The near-duplicate helper stays small and reach-aware, so a later semantic lane plugs into it rather than forking a second threshold. Leaving rewording and embeddings undone is honest, since nothing here could catch it if they were wrong.

## Final rationale (design writer)

**Chosen: the primary consultant's Variant B, built in stages.** Three
guards from the adversarial consultant's C1 are added on top:

1. **The reach fix comes first and is unconditional.** The shipped
   `near-duplicate` receipt lint (`page-lint.ts:583`, `notes-tools.ts:487`)
   discloses withheld siblings today, and every wider lookup would make that
   leak larger.
2. **Every new behaviour is an advisory projection, off by default.** It
   reads only, and an operator accepts it through existing verbs
   (`brain_apply_evidence result: outdated`, `o2b brain reject`).
3. **No embedding provider call anywhere in the wave.** A source-scan test
   pins this.

**Why B rather than C1.** The write-hint card's residual value is the
extension beyond the hint that already ships: reach across directories,
scoring by embedding, and comparing facts. C1 ships none of it. B's forget
side delivers the semantic part at zero marginal spend, because both the
retiring preference and its siblings are already indexed. The pattern is
already proven in the review projection: `scoreSignalNovelty` in
`src/core/brain/surprisal.ts` reads stored vectors through the
`opts.searchConfig` path of `buildReviewCandidates`. The reader the first
consultant feared might be missing exists as `storedEmbeddingsForDocument`
(`src/core/search/store/vectors.ts:262`). On the write side, the extension
beyond the directory is C2's BM25 pull from the keyword index, behind an
off-by-default key. It adds no embeddings.

**What the adversarial review changed:**

- **Write-time embedding is cut**, not offered as an opt-in. The new body is
  not indexed, so a semantic write hint is real spend. No gate in the repo
  can measure how many duplicates it would catch against how many wrong
  hints it would give, and `rerank-eval-gate.ts` measures recall, not
  that.
- **The Jaccard refusal across extract items is deferred.** Refusal rejects
  the whole payload, so one false positive on two short, opposite rules
  would drop every valid signal. Only the exact duplicate-topic rule ships.
- **`readable` is a required argument of the shared kernel**, not an
  option, and it is applied before scoring and before counting.
- **One AsyncLocalStorage scope** carries both decision time and stages.
  The allowlist of stage names is enforced where the record is emitted, and
  `near_duplicate_lookup` is in the allowlist.
- **The hard-fail gate list** (visibility, egress, spend, write-site,
  destructive-site, route-metrics payload safety) became the integration
  rule in `plan.md`. The rerank evaluation gate is not cited as cover.

**One premise correction:** the adversarial consultant suggested comparing
"same signal sign only" for retire siblings. Preferences carry no sign
(`BrainPreference`, `src/core/brain/types.ts:875`), so that guard is
replaced by a minimum of 4 tokens, the accept gate and the off-by-default
key.

**Rejected variants:**

| Variant | Why rejected |
|---|---|
| C (out-of-band ledger) | The hint arrives late, and a new persisted store adds kernel state. |
| D (model-assisted rewordings) | Breaks the budget, adds egress, and has the weakest correctness story. |
| C3 (retire side only) | Drops two cards, including the cheapest and safest one. |
| A on its own | Leaves the semantic half unbuilt, although stored vectors make it free on the forget side. |
