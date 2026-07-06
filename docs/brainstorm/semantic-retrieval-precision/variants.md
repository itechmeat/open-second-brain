# Architecture variants - semantic-retrieval-precision

Branch: `feat/semantic-retrieval-precision`. Consultant output is preserved verbatim in
`cli-output/claude.md`; this file restates the three variants verbatim and records the final
decision and rationale.

## Variant 1
Approach: The parent lands a single generic `learned/` precision layer under `src/core/search` —
one module exposing a provider-resolution + graceful-no-op guard and one abstract "learned stage"
contract that both features implement. Entity semantic dedup becomes the first consumer (emitting
alias-merge candidates) and the cross-encoder becomes the second (emitting a rescored top-K
order), so both cards route through one shared abstraction and one guarded call-site convention.
Trade-offs:
- Maximal DRY on the opt-in/no-op guard and provider validation; one place to audit invariant
  #2/#3 compliance.
- Couples two stages that live in different subtrees (`brain/entities`/`hygiene` vs `search`) and
  have genuinely different contracts (proposal-only candidate pairs vs reader-tail rescoring),
  forcing a lowest-common-denominator interface that fits neither cleanly.
- The child cannot land until the abstract contract is finalized, so the shared module itself
  becomes the collision seam rather than eliminating it; a mid-stream contract change ripples into
  both cards.
Complexity: large
Risk: medium

## Variant 2
Approach: Each card independently mirrors an already-proven pattern and touches a different
subtree, sharing only one small new seam. The parent adds an entity semantic-dedup detector
modeled directly on `hygiene/detectors/dedup.ts` (embedding-cosine over registry entities,
`method`-labeled lexical fallback, nominates alias-merge candidates into doctor lints /
`registry.ts` alias resolution — never rewrites the deterministic key), and while doing so
extracts a thin provider-resolution/no-op helper. The child adds an isolated cross-encoder stage
in the `search.ts` reader tail after `rerankByRelevance`, mirroring `openai-compat.ts`
fail-closed config validation and importing that same helper.
Trade-offs:
- Lowest collision surface: parent edits live in `brain/entities` + `brain/hygiene`, child edits
  in `search`; the only shared new artifact is the small provider helper the parent lands and the
  child extends — a clean already-merged seam.
- Each stage keeps a contract shaped to its own job (candidate pairs vs rescored order), honoring
  KISS and avoiding a premature super-abstraction.
- Two guarded call sites instead of one, so invariant #2 byte-identical verification must be
  checked in two places rather than centrally.
Complexity: medium
Risk: low

## Variant 3
Approach: Extend the existing named-provider registry (`embeddings/registry.ts`,
`Brain/search/embedding-providers.json`) with a `role` field so one enriched registry resolves
both the embedding used by the dedup pass and the cross-encoder rerank endpoint. The parent adds
role-aware resolution plus the entity semantic pass; the child registers the cross-encoder as
another role and consumes it in the reader tail.
Trade-offs:
- Single unified config surface for every learned-model endpoint; operators manage one registry
  file.
- Mutates a shared file-first schema that is already persisted and sorted-on-write, risking
  backward-compat and Syncthing-peer determinism (invariants #5/#7) for records that currently
  assume embedding-only semantics.
- The registry becomes a hot collision point both cards must edit, inverting the "child extends an
  already-merged seam" goal; schema migration and fail-soft load paths must be re-validated for
  existing vaults.
Complexity: large
Risk: high

## Recommended: Variant 2
Variant 2 best fits OSB's stated conventions. The two cards naturally live in different subtrees,
so mirroring the two proven patterns already in the repo — the `hygiene/detectors/dedup.ts`
cosine-with-labeled-lexical-fallback for the parent and the `openai-compat.ts` fail-closed
validation for the child — reuses established discipline without inventing a new abstraction,
satisfying "reuse, do not duplicate" while respecting KISS. It directly realizes the intended
collision structure from the scope: the parent establishes a small provider-resolution/no-op
helper as its seam, the child extends that already-merged helper, and their substantive edits
never overlap, so the one-PR-many-cards-one-at-a-time cadence (invariant #6) holds without
ordering gymnastics. It also keeps each stage's contract honest — the parent stays proposal-only
feeding candidates into doctor/registry alias resolution (invariant #8) while the deterministic
`entityIdentityKey` is untouched, and the child stays a graceful no-op / fail-open final reader
stage (invariants #2/#3) — whereas Variant 1's shared contract would blur those two very
different shapes and Variant 3 would put both cards in conflict over a persisted,
determinism-sensitive registry schema. The only cost, two guarded call sites instead of one, is
the cheapest of the three risks to verify and is exactly the "single guarded call site whose
off-branch is unchanged" property invariant #2 calls easiest to check — applied twice.

## Final decision: Variant 2 (accepted)

Agreed with the consultant's recommendation. Variant 2 is the only variant whose collision
structure is resolved by the cheapest sufficient mechanism — the parent lands a small
provider-resolution/no-op helper as its seam and the child extends the already-merged helper,
while their substantive edits live in different subtrees (`brain/entities` + `brain/hygiene` vs
`search`) and never overlap — so the one-PR-many-cards-one-at-a-time cadence (invariant #6)
holds without a premature super-abstraction. It preserves every load-bearing convention: an
LLM-free kernel (both the cosine and the cross-encoder reuse the existing embedding-provider
abstraction / an external endpoint and are graceful no-ops when unconfigured), default-off
byte-identical off-branches (invariant #2, two guarded call sites — the easiest property to
verify, applied twice), fail-open telemetry (invariant #3), language-agnostic logic (invariant
#4, the cosine uses the embedder not an NL word list), Syncthing-peer determinism (invariant #5),
and proposal-only identity writes (invariant #8, the parent surfaces alias-merge candidates and
never rewrites the deterministic `entityIdentityKey`).

Variant 1's shared abstract `learned/` contract couples two stages with genuinely different
contracts (proposal-only candidate pairs vs reader-tail rescoring) behind a
lowest-common-denominator interface and makes the shared module itself the collision seam.
Variant 3 mutates a persisted, determinism-sensitive registry schema that both cards must edit,
inverting the "child extends an already-merged seam" goal and risking backward-compat for
existing vaults. Neither is warranted for this two-card scope.

Drive order: **parent → child** (`t_47fd9523` → `t_110867f5`).
