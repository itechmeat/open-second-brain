# Consultant output - delivery-trust

The consultant role was performed in-session against the prompt at `cli-output/prompt.md`; the output below is preserved verbatim.

### Variant 1: Central egress gate at the server boundary

- **Approach**: Grow the one place response bytes are already reach-shaped - the MCP server's result builder and its error redaction, both of which already branch on transport reach - into a full delivery gate: every structured tool result and resource payload passes a shaper that probes each row's provenance and fences below-operator-authorship text before the response leaves, the receipt-verify verb and the attestation verification are exposed as read-side services beside it, and the opencode plugin consumes the same gate by spawning the shared hook shims.
- **Trade-offs**:
  - Pros: one rule in one place, so no surface can forget shaping; new read surfaces inherit the fence automatically; the gate already exists as the redaction precedent, so the branch point is proven; the wave gets one obvious story - everything a remote reader receives passes one door.
  - Cons: the boundary sees opaque JSON - per-row provenance is not in the payload, so the gate must re-read vault files by reconstructing paths from result shapes, fighting the per-tool output contracts and the two existing view families; structured rows and text/markdown resources need different mechanics through one function; results parked in the artifact store before the caller fetches them would bypass the gate on replay unless the gate re-shapes there too, which it cannot without per-request reach; the per-surface census rows lose their written reasons because the decision no longer lives at the surfaces.
- **Complexity**: large
- **Risk**: high

### Variant 2: Family-seam shaping over shared pure kernels

- **Approach**: Build two pure leaf modules - a closed treatment vocabulary with the fail-closed derivation from the existing stamps (origin_channel, content_class, untrusted_source) and a cached frontmatter provenance probe - then wire them per surface family at the seams those families already own: search rows at the snippet-windowing site, report-shaped reads through one binding beside the existing reach-events reference view, whole-document resources at their readers. The verify verb is a pure kernel over the receipts family with two thin faces (an operation on the existing MCP receipts tool, a CLI subcommand); the opencode lane registers an execute.before gate and a prompt-observe hook that spawn the existing shims and drain a per-turn queue through the existing context hook; the attestation kernel binds per-shard heads and state-surface stamps under an operator Ed25519 key, sharing only the digest and seal primitives.
- **Trade-offs**:
  - Pros: no second architecture - every wire point is a seam that already decides what a reader may see, so the frozen conventions (fail closed, identical to absent) and the local-reach byte-identity pins hold untouched; the fence lives in the delivered bytes so output schemas stay unchanged; the four lanes own disjoint families and share only pure modules and append-only registries; census registries keep their per-surface meaning.
  - Cons: shaping lives at several call sites, so a future read surface can forget it - mitigated by teaching the visibility-surface census the shaper's name and pinning each family with a remote-quoted/local-identical test; more total wiring code than one central gate; the treatment vocabulary must be registered in the verdict-vocabulary census like any other closed set.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Delivery pipeline framework

- **Approach**: Introduce a typed delivery-pipeline object - stages for reach gating, provenance fencing, preview-budget parking and receipt emission - that every read handler constructs its response through; policy changes become stage registrations, the opencode lane implements the same pipeline interface over its hook events, and attestation attaches as a pipeline observer signing the state the pipeline read from.
- **Trade-offs**:
  - Pros: future delivery policy becomes configuration rather than surface edits; one type documents the whole delivery contract; receipts and fencing cannot disagree because one object produces both; the pipeline is the natural home for the queue-then-context drain on the opencode lane.
  - Cons: migrating roughly forty read surfaces onto a new abstraction is a wave of its own riding a wave that is supposed to ship four cards; the pipeline type duplicates rules the two existing view families and the search result filters already encode and pin by test, so every existing reach test rewrites or fights it; the artifact-store parking order and the preview budget are load-bearing today and re-deriving them inside pipeline stages risks subtle regressions in the oversized-result path.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 2

**Rationale**: The repo already encodes delivery rules as per-family views with frozen conventions and per-tool output contracts, both pinned by tests; Variant 1's central gate cannot see per-row provenance in opaque results and would have to re-read files at the boundary, while Variant 3 rebuilds machinery that exists and would rewrite the reach test corpus for no new capability. Variant 2 adds exactly what is missing - one pure treatment kernel, one cached provenance probe - and wires it where each family already decides what a remote reader may see, which keeps the four lanes disjoint, the local-reach contracts byte-identical, and the census registries meaningful.
