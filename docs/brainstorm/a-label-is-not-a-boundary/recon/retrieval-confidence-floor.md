# Recon: the recall-inject confidence floor (t_eb94ac35)

Read-only reconnaissance against `feat/a-label-is-not-a-boundary` @ `280469d2`
(v1.48.0). Every anchor below was read; paths are repo-relative. Every number
below was produced by running the shipped `indexVault` + `search` +
`decideRecallInject` over disposable vaults, or by calling `rankResults`
directly — the probe scripts are throwaway and live outside the repo.

Headline, in one line: **the premise is right about the outcome and wrong
about three of its four mechanisms, and the floor is not the only knob the
pinned top score neutralises — it is the least consequential of four.**

---

## What exists

### 1. The scoring path, exactly

`rankResults` (`src/core/search/ranker.ts:392`) computes one composite per
candidate at `:623-633`:

```
score = clamp01(
    weighted * tierMul * trendMul
  + linkBoost + recency + entityBoost + activationBoost
  + coAccessBoost + reuseBoost + (temporalBoost ?? 0) + sessionFocus
)
```

**The relevance term (`weighted`, `:564-568`).** Two mutually exclusive modes:

- `linear` (the default, `src/core/search/index.ts:171`):
  `keywordWeight * kwMul * kwNorm + semanticWeight * semMul * cos`.
- `rrf`: `weighted = rrf` — the fused value **replaces** the term, and the
  configured lane weights are deliberately not applied (`:558-563`,
  `src/core/search/fusion.ts:10-27`).

**The keyword lane is min-max normalised within the candidate set**
(`normalizeBm25`, `:203-219`). The best BM25 hit gets exactly `1`, the worst
exactly `0`. When every hit ties — **including the single-hit case** — every
hit gets `1` (`:211-213`). The raw `bm25` value never leaves this function.

**The semantic lane is NOT normalised.** `semanticFromDistance`
(`:222-225`) maps L2-on-unit-vectors to `1 - d²/2`, clamped — an **absolute**
cosine similarity, pool-independent. This asymmetry is the whole story of
this task (see §5, §6).

**The RRF lane is also min-max normalised** to `[0,1]`
(`src/core/search/fusion.ts:125-138`), so `rrf` mode pins the top at `1.0`,
not at a weight.

**Constants and where they live:**

| Layer | Cap / value | Anchor |
| --- | --- | --- |
| `keywordWeight` | **0.6** (default) | `src/core/search/index.ts:154` |
| `semanticWeight` | 0.4 (default) | `src/core/search/index.ts:155` |
| `kw + sem <= 1` invariant | validated | `src/core/search/index.ts:324-328` |
| link + tag boost | 0.05 (0.03 + 0.02) | `ranker.ts:118-122` |
| entity boost | 0.04 | `ranker.ts:124` |
| activation boost | 0.04 | `ranker.ts:126` |
| co-access boost | 0.03 | `ranker.ts:128` |
| observed-reuse boost | 0.06 | `ranker.ts:130` |
| temporal-intent boost | 0.06 | `ranker.ts:138` |
| recency amplitude | 0.05 | `src/core/search/recency.ts:39-43` |
| tier multiplier | core 1.4 / supporting 1.0 / peripheral 0.6 | `src/core/brain/page-meta/tier.ts:45-49` |
| trend multiplier | strengthening 1.05 / weakening 0.93 / stale 0.85 | `ranker.ts:141-145` |
| supersede fade | 0.5 | `ranker.ts:156` |
| intent `keywordMul` | 0.9 … 1.3 | `src/core/search/query-plan.ts:52-67` |
| learned weight bounds | 0.8 … 1.2 | `src/core/search/feedback.ts:29-31` |

Post-ranker stages that still move a score: `applyRankAdjusters`
(`src/core/search/rank-adjust.ts:90`) multiplies and re-clamps (`:135`),
driven by `supersedeFadeAdjuster` (`src/core/search/result-filters.ts:219`)
and `trustGateAdjuster` — both off by default
(`src/core/search/index.ts:755-769`). Traversal, temporal bridge, MMR,
relevance rerank and the cross-encoder re-order or add rows
(`src/core/search/pipeline/assemble.ts:274-310`,
`pipeline/post-rank.ts:58-113`).

### 2. The hand-off: the number thresholded IS the number the ranker produced

`decideRecallInject` (`src/core/brain/recall-inject.ts:155`) sorts the
retriever's candidates and compares `ranked[0].score` to
`RECALL_INJECT_CONFIDENCE_FLOOR = 0.35` (`:43`, `:189-192`).

The chain, unmodified end to end:

- `defaultRecallRetriever` (`:361-381`) maps `result.score` straight onto
  `RecallCandidate.score` — no rescaling.
- `searchAcrossVaults` (`src/core/search/cross-vault.ts:170`) only appends an
  `origin:` reason; the score is copied (`:46-52`). The module states the
  merge is score-as-is at `:20-22`.
- `search` (`src/core/search/search.ts:285-295`) slices and decorates.

So the floor is applied to the ranker's `clamp01` output. Confirmed by
measurement: every `topScore` reported by the decision equals the `score` on
`outcome.results[0]` to the digit.

---

## Measurements

Method: `indexVault` + `search` over disposable vaults with the shipped
defaults (`tests/helpers/search-fixtures.ts:129-184` reproduces
`resolveSearchConfig`'s defaults exactly, including `keywordWeight: 0.6`),
`limit: 4`, then `decideRecallInject` with a retriever wrapping the same
`search`. File mtimes were pushed 400 days back to zero the recency layer
unless stated.

### The default path: the top score is a constant

| Case | Top score | Decision |
| --- | --- | --- |
| Single weak keyword hit ("kubernetes" mentioned once in a gardening note) | **0.6000** | `inject` |
| 12 notes, wide BM25 spread, worst match still top of pool | **0.6000** | `inject` |
| Every note tagged `tier: peripheral` | **0.6000** | `inject` |
| `tier: peripheral` + `freshness_trend: stale` | **0.6000** | `inject` |
| `freshness_trend: stale` (note not under `Brain/preferences/`) | **0.6000** | `inject` |
| `fusionMode: rrf` | **1.0000** | `inject` |
| Fresh (today) file, keyword hit | **0.6500** | `inject` |
| No lexical match at all | — | `abstain / no_matches` |

The observable band of the *top* score in a default, keyword-only vault is
**[0.60, 0.65]** — `keywordWeight` plus the recency amplitude. The floor at
0.35 sits entirely below it. Every additive boost only pushes it further up.

### The floor CAN fire. Four exact configurations

| # | Configuration | Top score | Decision |
| --- | --- | --- | --- |
| H | `search_supersede_fade_enabled: true`, every matching candidate carries `superseded_by` | **0.3000** | `abstain / below_floor` |
| K | Strongest match carries `visibility: private`, dropped by the default visibility scope; the surviving candidate is the pool's BM25 minimum | **0.0000** | `abstain / below_floor` |
| J | `search_keyword_weight` set to **0.34** or below (0.35 is exactly at the boundary and still injects) | 0.3400 | `abstain / below_floor` |
| M/N | Semantic-only candidate (no keyword hit): distance 1.414 → **0.0000**; distance 0.8 → **0.2720** | 0.0000 / 0.2720 | below floor |

Case **K needs no non-default flag**. It is the general mechanism, and it is
worse than the premise's framing: because `normalizeBm25` pins the pool
*minimum* at 0, any downstream stage that removes the pool maximum
(visibility scope, owner scope, status filter, exact-state barrier,
structured exclusion, duplicate merge) leaves a survivor whose score is a
statement about *which rows were filtered*, not about how well anything
matched. Verified directly on the pure ranker: a two-hit pool scores
`0.6000 / 0.0000` regardless of how good the loser's BM25 actually was
(`bm25 = -0.0001` vs `-10` produced the same `0.0000`).

### Absolute ceilings, for calibration

- Keyword-only vault (embeddings off — the common default): relevance term
  maxes at `0.6`. The 0.4 `semanticWeight` is simply unspent.
- Embeddings on: a hybrid hit can reach `0.6 + 0.4 = 1.0` before boosts.
- `rrf` mode: relevance term is `1.0` at the top by construction.

The same `0.35` therefore means three different things depending on
configuration, and in none of them does it mean "the match was weak".

---

## Corrections to the premise

1. **The keyword weight is 0.6, not 0.65.** `src/core/search/index.ts:154`.
   The 0.65 figure appears in the task body *and in shipped source* —
   `src/core/bench/failure-modes.ts:38-44` states "0.65 by default" in a
   doc comment that the conformance suite's caveat rests on. That comment is
   wrong on the number and should be corrected whatever else is decided.

2. **`below_floor` is NOT unreachable.** It fires today, under default
   config, whenever a scope/visibility filter removes the pool maximum
   (case K, measured at `0.0000`), and under two documented opt-in knobs
   (supersede fade, keyword weight ≤ 0.34). "Unreachable" is the wrong
   diagnosis; **"fires for reasons unrelated to match quality"** is the
   right one. The `false_fire` term in the conformance suite is therefore
   not merely inert — when it does bite, it is measuring the filter stack.

3. **The tier multiplier claim is right, but for a different reason than
   stated.** `tierMul` *does* reach the score arithmetically
   (`ranker.ts:572-573`, `:624`). It never fires because
   **`tierByDoc` has no producer anywhere in `src/`** — `rankCandidates`
   (`src/core/search/pipeline/assemble.ts:390-441`) does not pass it, and
   grep finds the field only in `ranker.ts:50`, `ranker.ts:572` and
   `tests/core/search/ranker-tier.test.ts`. Every shipped search reports
   `breakdown.tier === 1`; my probe confirmed `tier=1` on notes explicitly
   stamped `tier: peripheral`. This is a separate defect (see §Defects).

4. **The supersede claim is wrong.** "Only affects rank 2+" — no. The fade
   is a multiply in kernel 1 applied per candidate
   (`result-filters.ts:219-229`), and when the *only* matching candidates
   are superseded, the top score is `0.6 * 0.5 = 0.3000` and `below_floor`
   fires. Measured.

5. **`freshness_trend` is narrower than it looks.** The multiplier only
   applies to paths under `Brain/preferences/`
   (`src/core/search/pipeline/candidate-signals.ts:25`, `:223`). A
   `stale`-stamped preference page tops out at `0.6 * 0.85 = 0.5100`,
   measured — still above the floor.

6. **`rrf` mode makes the top score *higher*, not lower** (1.0), because RRF
   is min-max normalised too and bypasses the lane weights entirely. Any
   design that reasons about "the top score" must account for two different
   ceilings.

---

## The floor is the smallest of four knobs the pinned score neutralises

This is the part the task body does not cover, and it is what makes the
decision release-wide rather than local. Complete list of everything that
compares a normalised result score to a constant:

| Consumer | Constant | Anchor | Effect of the pinned 0.60 |
| --- | --- | --- | --- |
| `decideRecallInject` confidence floor | 0.35 | `src/core/brain/recall-inject.ts:43,190` | Never fires on a clean pool; fires only when a filter removed the pool max |
| **`assessRecallAdequacy`** `sufficient` | **0.6** | `src/core/brain/recall-adequacy.ts:45-49,124` | `0.6 >= 0.6` is **exactly true**: every keyword hit is graded `sufficient / proceed`. `weak` (0.3) and `insufficient` are unreachable on the default path. Knife-edge: lowering `search_keyword_weight` to 0.59 flips *every* recall to `re_recall` |
| — its callers | | `src/mcp/search-tools.ts:1156` (`brain_recall_gate`), `src/mcp/brain/pack-tools.ts:102` (`brain_context_pack`) | Both surfaces inherit the collapse |
| — its config keys | | `src/core/config.ts:850-868` | `recall_adequacy_sufficient` / `_weak` / `_min_results` are operator-facing and equally affected |
| **Gap-loop auto-close floor** | **0.5** | `src/core/brain/gaps/gap-loop.ts:47,402,415` | Always cleared by any keyword match — a gap task auto-closes on a hit of arbitrary quality |
| Cross-vault chain stop | 0.8 | `src/core/search/cross-vault.ts:200`; default `index.ts:175`, off by default `index.ts:801-805` | Unreachable in `linear` mode (band is [0.60,0.65]); **always** triggers in `rrf` mode (1.0). The knob means opposite things per fusion mode |
| Caller relevance floor (`opts.threshold`) | caller-supplied | `src/core/search/pipeline/assemble.ts:216,296-300` | Any value in (0, 0.6] is a no-op on the top row; a value above 0.65 empties the window |
| Cross-encoder `minScore` | 0 default | `src/core/search/rerank/index.ts:83-84`; `index.ts:180` | Compares *cross-encoder* scores, not fused ones — unaffected |
| Supersede fade multiplier | 0.5 | `ranker.ts:156`, `result-filters.ts:226` | The one knob that moves the top score in a measurable way today |
| Relative-only readers (no constant) | — | `mmr.ts:90`, `traversal.ts:127`, `temporal-bridge.ts:99`, `enrich.ts:159-161`, `deep-synthesis.ts:377-380`, `recall-hint.ts:60`, `rerank-fit-check.ts:178`, `mcp/search-tools.ts:998,1030,1574` | Unaffected — they only order or display |

Blast-radius reading of that table: **changing the normalisation changes four
absolute thresholds at once**, two of which (`recall_adequacy_*`, the gap-loop
floor) currently sit on the *wrong side* of the pinned value and would flip
behaviour, not merely become live. A scoring change is release-wide.

---

## What a score would have to be, and what already exists

For an absolute floor to be meaningful the number must vary with *match
quality* and not with *pool composition*. Two such signals are computed in
this tree today.

1. **`idfWeightedCoverage`** — `src/core/search/coverage.ts:162-187`. Share
   of the query's significant terms, IDF-weighted, that the retrieved
   material actually covers; `[0,1]`, pool-independent, language-agnostic by
   construction (`:24-32`), with a rare-term classification alongside
   (`:71-76`). **It is computed only in evidence-pack mode**
   (`src/core/search/evidence-verification.ts:59,83`,
   `src/core/search/evidence-pack.ts:159`) and is discarded on every ordinary
   search. This is the strongest candidate for an honest floor.

2. **The raw `bm25` value** — `src/core/search/store/keyword.ts:12-24`,
   `bm25(chunk_fts, 1.0, 0.3)`. Carried on `KeywordHit` into `rankResults`,
   consumed by `normalizeBm25` (`ranker.ts:208`) and by the RRF sort
   (`ranker.ts:423`), then **discarded** — it reaches no
   `BrainSearchResult` field, no `ScoreBreakdown`, no reason string. It is a
   corpus-relative magnitude, so it is not directly a `[0,1]` quality, but it
   is the only raw lexical-fit number the pipeline has and it is currently
   thrown away.

3. **Cosine similarity** — already absolute (`ranker.ts:222-225`), already on
   `BrainSearchResult.semanticScore`. Nothing to recover.

---

## The vector lane behaves differently, and the default has no vector lane

- **Keyword lane:** min-max normalised → top pinned at `1`, bottom pinned at
  `0`, both independent of match quality (`ranker.ts:203-219`).
- **Vector lane:** absolute cosine, no normalisation (`ranker.ts:409-414`).
  A genuinely poor semantic neighbour scores near zero — measured `0.0000`
  at distance √2 and `0.2720` at distance 0.8. **The floor already works
  correctly against this lane.**
- **Embeddings absent (the shipped default,
  `tests/helpers/search-fixtures.ts:104-116` mirrors
  `resolveSearchConfig`):** `semanticEnabled` is false
  (`search.ts:258`, `ranker.ts:394`), `semanticScore` is forced to 0
  (`ranker.ts:659`), the semantic lane never runs
  (`pipeline/semantic-lane.ts:47`), and the relevance term reduces to the
  keyword weight alone. So the floor's only *working* input is the one the
  default install does not have.

That is the cleanest statement of the defect: **the confidence floor is
correct for the lane that is usually absent and meaningless for the lane that
is always present.**

---

## Candidate fixes, with measured blast radius

### A. Express the floor against IDF-weighted coverage

Compute `buildCoverageReport` on the ordinary search path (it already runs in
evidence-pack mode) and expose `idfWeightedCoverage` on the outcome; have
`decideRecallInject` gate on it instead of on `score`.

- Blast radius: **local to the floor**, plus one new field on `SearchOutcome`.
  No score moves, so none of the four thresholds in the table above changes,
  and no ranking changes anywhere.
- Cost: one extra document-frequency read per query on a path that does not
  do one today (`evidence-verification.ts:59` shows the inputs required).
- Answers the "member describes a state the system SHOULD reach" constraint
  without touching ranking.

### B. Stop min-max-normalising the keyword lane

Replace `normalizeBm25` with a monotone absolute squash of raw BM25.

- Blast radius: **release-wide and measured**. Every result score in the
  product moves. Four absolute thresholds change meaning simultaneously
  (recall-inject 0.35, adequacy 0.6/0.3, gap-loop 0.5, chain-stop 0.8), and
  two of them currently sit exactly on the value the change would move
  (`assessRecallAdequacy.sufficient === 0.6 === keywordWeight`). Every
  ranking snapshot test over a fixture vault would need re-baselining.
- Not defensible inside this task alone.

### C. Fix the four thresholds instead of the score

Leave normalisation alone; make each consumer state that it reads a *ranking*
position, and delete the ones that cannot be honest — the adequacy
`sufficient` threshold and the gap-loop auto-close floor in particular.

- Blast radius: touches `recall-adequacy.ts`, its two MCP callers, three
  config keys (`src/core/config.ts:850-868`) and `gap-loop.ts`. No score
  moves. But it removes capability rather than adding it, and it does not
  give `below_floor` an honest firing condition.

### D. "Keep and document" — only in one form

The repo forbids settings that cannot change an outcome, and `below_floor`
*can* change one — just for the wrong reason. If nothing else is done, the
documentation must state the actual condition: *"the floor fires when a
downstream filter removes the pool's best row, or when supersede fade
applies, or when `search_keyword_weight` is below the floor — never because a
match was weak."* The comment at
`src/core/bench/failure-modes.ts:38-44` must be corrected regardless: it is
both numerically wrong (0.65) and behaviourally wrong ("unreachable").

Recommendation: **A**, plus the `failure-modes.ts` comment correction, plus
raising the tier-plumbing defect below as its own task.

---

## Defects noticed

1. **`tierByDoc` has no producer.** `ranker.ts:50,572-573` implement a
   documented, user-editable frontmatter knob (`tier:`,
   `src/core/brain/page-meta/tier.ts:1-10,28-37`) that the search pipeline
   never populates: `rankCandidates`
   (`src/core/search/pipeline/assemble.ts:390-441`) passes eleven signal maps
   and not this one. `collectCandidateSignals` has no tier collector
   (`src/core/search/pipeline/candidate-signals.ts`). Measured: notes stamped
   `tier: peripheral` report `breakdown.tier === 1` and score identically to
   untagged notes. `readTier` *is* consumed elsewhere
   (`src/core/brain/context-pack.ts:336`), so the frontmatter key is not
   dead — only its ranking half is. Note that
   `candidate-signals.ts:208` explicitly says "like the tier signal, the
   stamp is read from frontmatter at query time", describing a collector that
   does not exist.

2. **`src/core/bench/failure-modes.ts:38-44` states the wrong default
   (0.65 vs the actual 0.6) and the wrong conclusion ("unreachable").** The
   v1.48.0 conformance suite's caveat is anchored on both.

3. **`assessRecallAdequacy`'s `sufficient` threshold is exactly equal to the
   shipped `keywordWeight`** (`recall-adequacy.ts:46` vs
   `src/core/search/index.ts:154`). `>=` makes every keyword hit
   `sufficient`; a one-hundredth change to either constant inverts the
   verdict for every query in the product. Whatever is decided about the
   recall-inject floor, this coincidence should not survive as a coincidence.

4. **`search_chain_stop_score` means opposite things in the two fusion
   modes** — unreachable at 0.8 in `linear` (band [0.60, 0.65]), always met
   in `rrf` (top pinned at 1.0 by `fusion.ts:125-138`). The knob is
   documented as a normalised-confidence threshold
   (`cross-vault.ts:136-143`), which it is not across modes.

5. **`normalizeBm25` returns `1` for every hit when the pool ties**
   (`ranker.ts:211-213`), including the single-hit case. Defensible as
   ranking, indefensible as an input to an absolute threshold — a sole hit of
   any quality is scored identically to a perfect one.
