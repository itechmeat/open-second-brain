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
