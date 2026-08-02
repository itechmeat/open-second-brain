### Variant 1: Shared vocabulary, enforced by conformance tests

- **Approach**: Ship no new shared runtime module. Instead, freeze a written contract up front — envelope field names (origin, trust grade, anchor source, scope), a registered code namespace for every refusal and every "capability absent" answer, and a canonical sha256 digest helper — and let each of the ten units implement against it in its own files. The only shared artifact landed before the parallel work is a conformance test suite that every unit's write path must pass.
- **Trade-offs**:
  - Pro: near-zero merge contention; ten atomic commits touch ten disjoint file sets, which is exactly what parallel implementation by separate agents wants.
  - Pro: additive by construction — nothing central changes, so "byte-identical when the flag is absent" is trivially true for all ten units.
  - Pro: reuses the rails that already exist (the advisory diagnostic rail, `SearchError` codes, `UNTRUSTED_SOURCE_TAG`, the preference lifecycle statuses) rather than superseding them.
  - Con: a credential write fence enforced by convention is not a fence — nothing structurally prevents a write path (existing or future) from skipping the check, which defeats the point of t_a3c4b13b.
  - Con: provenance drifts. The quarantine lane, the content-date anchor, the pack installer and the skill sha256 collapse will each grow their own near-identical origin descriptor, and the wave ends up with four provenance shapes instead of one.
  - Con: conformance tests only catch drift where someone thought to write the test; absence-vs-inability distinctions are easy to collapse silently in a unit nobody tested for it.
- **Complexity**: small
- **Risk**: medium

### Variant 2: Single write-admission pipeline

- **Approach**: Factor by control flow. Introduce one ordered admission chain — authority check, shape/schema validation, provenance stamp and trust routing, capability resolution, then land — and funnel every write-capable surface through it: create/append/update note, write-batch, intake extraction, ingest, schema mutation, pack apply. Each of the ten units becomes a stage implementation or a stage consumer rather than an independent code path.
- **Trade-offs**:
  - Pro: the write-prefix fence becomes genuinely unskippable, and every future write surface inherits it for free — the strongest possible answer to "authority to write".
  - Pro: one place defines what a refusal looks like, so the refusal contract, its registered codes and its tests exist exactly once.
  - Pro: quarantine routing (t_444349f2), `--strict` validation and `if_exists: skip` (t_c0fce0b9), and pack preview-before-apply (t_50033859) become three configurations of the same chain rather than three hand-rolled gates.
  - Con: blast radius across roughly every write surface in a ~900-module, ~8100-test codebase, with high odds of incidental behaviour change where the "absent flag is a no-op" guarantee is hardest to prove.
  - Con: it inverts the parallelism constraint — ten agents all editing one chain is contention concentrated precisely where the wave cannot afford it.
  - Con: it does not actually unify the wave. Embedding batch packing, capability tiers with deferred backfill, the content-date anchor, the verification ledger and skill receipts are not writes through this chain, so half the units sit outside the substrate and the "one coherent substrate" claim is only half true.
- **Complexity**: large
- **Risk**: high

### Variant 3: Two substrates plus a capability rail

- **Approach**: Accept that the six cross-cutting concerns cluster into two, not one, and factor accordingly. Substrate A, the intake boundary: a single provenance descriptor (origin, trust grade, digest) plus an admission decision that composes authority, validation and routing-to-quarantine, serving the quarantine lane, the write-prefix fence, template/strict/skip creation and HTTP pack install, and supplying the anchor-provenance field the content-date unit needs and the positive scope value the shared-observation unit needs. Substrate B, the attestation ledger: one witnessed-record shape (witness identity, witness kind, evidence digest, pass/fail) keyed by the existing sample id, serving the split verification ledger and the skill efficacy receipt chain. Alongside them, extend the existing registered-code rail with an explicit capability state — configured, absent, deferred — so embedding batch budgeting, tiered degradation with NULL-vector backfill, and the pack fetcher's network capability all answer "not configured" the same way, distinct from "nothing found".
- **Trade-offs**:
  - Pro: each shared piece is small enough for one agent to land as a seed commit before the eight dependent units fan out, satisfying the "decided up front, not discovered at merge" constraint without a central chokepoint.
  - Pro: the clustering is real — provenance, authority and validation genuinely meet at intake; claim-versus-proof genuinely meets at the ledger; capability-absence is a rail concern in both and in neither substrate. Nothing is forced together that does not share semantics.
  - Pro: gives enforcement teeth where it matters (one admission decision at intake, one witness-record identity) while leaving mechanically unrelated units — embedding token budgeting, the content-date column — as local additive changes that merely consume the vocabulary.
  - Pro: the capability rail is where the absence-versus-inability convention is naturally honoured once, instead of three times.
  - Con: three shared pieces must land before most of the wave, serialising the first stretch of an otherwise parallel effort.
  - Con: both substrates want a content digest and an origin notion; without deliberately sharing one digest primitive between them, the wave grows exactly the duplication it was meant to avoid.
  - Con: the boundary between the new capability state and the existing `SearchError` / advisory codes needs an explicit ruling, or two vocabularies will describe the same unconfigured provider.
- **Complexity**: medium
- **Risk**: medium

### Recommended: Variant 3

**Rationale**: The six concerns do not collapse into one substrate — intake admission and outcome attestation share almost no semantics, and Variant 2 pays a large-blast-radius, high-contention price to pretend otherwise while still leaving half the units outside the chain. Variant 1 is cheap and parallel-friendly but enforces the one concern that must be structural, authority to write, by convention alone, and will leave four divergent provenance shapes behind. Variant 3 buys real enforcement where it is load-bearing, keeps the seed commits small enough to land ahead of the fan-out as the parallel-agent constraint requires, and respects the per-task carve-outs by leaving the purely mechanical units local rather than dragging them into a substrate they do not need.
