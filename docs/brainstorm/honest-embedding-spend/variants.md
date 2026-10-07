# Variants considered - honest embedding spend

The primary consultant CLI ran once against `cli-output/prompt.md` (output in `cli-output/claude.md`). It returned three parseable variants, so the fallback consultant was not invoked.

The consultant's output is reproduced verbatim below. The decision follows it, including the three places where it departs from the recommendation.

---

### Variant 1: Nullable price quote threaded through the existing sites
- **Approach**: Replace the bare number returned by `pricePerMillionTokens` with a `PriceQuote {usdPerMtok: number | null, source}` where `source` is a registered closed vocabulary (`builtin | operator | unknown`), resolved from the frozen table and then an operator pair in flat config (`embedding_price_model` + `embedding_price_usd_per_mtok`, both-or-neither like the sunset pair). The four pricing sites keep their shape but carry `estimatedUsd: number | null`; `evaluateCostGate` refuses on `null` under a positive cap with a new `SearchError` code that names the config pair and `--force-cost`, the banner prints "price unknown", and the receipt and journal gain an optional `price_source`. Card B ships the credential-source naming in `search check` and content-hash vector reuse inside `replaceChunks`; Card C ships only a `--path` scope on `findChunksWithoutEmbeddings` that flows into estimate, gate and receipt, plus an additive `vector_coverage` field on the context pack response so a caller can see whether belief vectors exist at all.
- **Trade-offs**:
  - Pro: smallest diff, every change is local to a site that already exists, byte-identical for tabled models and gate-off.
  - Pro: no new MCP enum values, no registry schema change, low census-test churn.
  - Con: one config pair prices one model; a second registry profile stays unknown, so operators with failover profiles hit the refusal often.
  - Con: four sites must each be audited for `null` handling by hand; nothing structural stops a fifth site from reintroducing `0`.
  - Con: Card C's retrieval ask is not met; beliefs can be paid for in isolation but not ranked semantically.
- **Complexity**: medium
- **Risk**: low

### Variant 2: One spend plan feeds estimate, gate, receipt and a belief-scoped semantic mode
- **Approach**: Introduce a single `planEmbeddingSpend({scope})` that owns the census, token count, `PriceQuote`, estimate and gate verdict; `runEmbeddingPhase`, the maintenance preview, `planVectorBackfill` and the `search status` estimate all consume the plan, and the receipt is the plan plus actual tokens, so the announced and spent figures cannot diverge. Prices resolve from the builtin table, then an optional `price_usd_per_mtok` field declared on registry profiles through `o2b search provider add`, then the flat-config pair as override; scope is a path prefix that `vector-backfill --path` and the plan carry end to end. Context pack gains `query_mode: semantic`: the async MCP and CLI boundary embeds the query once through the same resolver and reports that spend in the response, runs a KNN pre-filtered to belief chunk rowids via the existing `chunk_vec_map`, and hands a `relevanceByPath` map into the still-synchronous `packContext` through an optional injected scorer; when the embedder is unavailable or belief coverage is incomplete the tool refuses and names `vector-backfill --path Brain/preferences`. `replaceChunks` reuses vector rows whose content hash, model and dimension match, and `search check` names the credential sources consulted and which other profiles have a key present.
- **Trade-offs**:
  - Pro: the plan object is the structural guarantee behind "same census feeds estimate, gate and receipt"; new spend sites must go through it.
  - Pro: prices live where the operator declares models (profiles), so failover profiles are priced too; the config pair remains for the built-in `zeroentropy` case.
  - Pro: all three cards are met; `packContext` stays synchronous for the planner and anticipatory cache.
  - Con: largest planner refactor across four call sites and three CLI verbs; CLI help parity and MCP parity tests all move.
  - Con: a new paid path (query embedding) must be declared on the wire, which adds an additive response field and one more enum member.
  - Con: pre-filtered KNN over a rowid list is a new query shape in the vector store and needs a size guard.
- **Complexity**: large
- **Risk**: medium

### Variant 3: Price provenance persisted beside the vectors, with a guarded migration verb
- **Approach**: Make the price a stored fact of the index: `index_state` gains optional `price_usd_per_mtok`, `price_source` and `price_declared_at` for the active signature, every receipt row and the `maintenance_spend` metric copy them, and the operator declares the price through a `price_model` + `price_usd_per_mtok` pair in the `_brain.yaml` embeddings block with `o2b search price show | set` verbs. On top of that plan, build the deferred `o2b search migrate-embeddings --to <model>` verb (dry run, `--apply`, `--force-cost`) that prices a full re-embed at the target model's declared price and refuses when unknown. Card C is served by fixing `search(pathPrefix)` itself: the prefix becomes a KNN pre-filter instead of a post-filter, and the context pack's semantic mode routes through ordinary `search`; scoped backfill reuses the same plan.
- **Trade-offs**:
  - Pro: the receipt reads the price that was actually assumed at spend time, not a later reconstruction; old rows read as unrecorded.
  - Pro: fixes the prefix under-return defect for every `search` caller, not only beliefs; closes Card B(e).
  - Con: price is per account, but `_brain.yaml` is per vault; two vaults on one key must declare it twice and can drift.
  - Con: a migration verb is explicitly deferred by `restamp.ts`; adding it widens the release past the three cards and adds the most new surface.
  - Con: changing the KNN filter order touches the hot search path and its ranking tests; schema additions to `index_state` need a migration and census registration.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 2
**Rationale**: The release's argument is that one census produces one number everywhere, and only Variant 2 makes that a structural property rather than a four-site audit; Variant 1 leaves Card C's retrieval ask unmet and prices only one model, while Variant 3 pulls in a deferred migration verb and a hot-path KNN change that the cards do not require. Declaring prices on registry profiles follows the existing rule that only operator-declared names count, the plan object keeps spend behind the dry-run and apply idiom, and the injected scorer lets `packContext` stay synchronous for every caller it has today.

---

## Decision

Variant 2 is accepted. The release argues that one census produces one number everywhere: what a run announces, refuses, spends and receipts. Only a shared spend plan makes that structural. Variant 1 leaves four pricing sites to be audited by hand and does not serve the belief retrieval ask. Variant 3 pulls in the migration verb the cards do not require and a hot-path KNN change, and it stores price as per-vault policy although price is a fact about the account.

Three overrides, each recorded in `design.md` under "Chosen approach":

1. **Exact cosine instead of a pre-filtered KNN.** The belief set is bounded by the vault's preference notes, and `surprisal.ts` already reads stored vectors per note. Exact scoring adds no new `vec0` query shape and cannot under-return.
2. **No price field on registry profiles.** One model is active at a time, and the model-bound pair already prices it. A second price source would need a precedence rule and a consistency check for a case the pair covers. An unpriced switch is answered by the named refusal.
3. **Partial belief coverage is reported, not refused.** Refusing on any vectorless preference would disable the mode after every new preference until the next embedding pass. The mode refuses only when no kept candidate has a usable vector, and names every unembedded candidate otherwise.

## Premise outcomes that bound the variants

- t_0bed79f3: confirmed, with three corrections. There is no implicit default cap, visibility is partial already, and the scope is embeddings only.
- t_82c3b275: account-side model discovery and automatic model switching are refuted against the documented no-unrequested-network stance and the vector invalidation they would trigger. Env-key presence stays out of the capability tier. Keyless tiering and recall tooling already ship. What is built is the offline credential report and the provenance-gated vector carry-over.
- t_0431f64d: "beliefs have no embeddings" is refuted, because belief notes are indexed and vectorised like any document. What is built is a belief-scoped reader and a path-scoped backfill.
