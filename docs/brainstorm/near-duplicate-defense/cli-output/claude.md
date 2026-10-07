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
