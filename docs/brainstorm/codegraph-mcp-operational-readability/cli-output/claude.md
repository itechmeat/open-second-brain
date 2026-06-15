## Variant 1: In-place surface augmentation
Approach: Extend the two existing modules directly without adding new surfaces. `codegraph.ts` gains Cargo-workspace detection that enriches the existing `code_graph` `CheckResult` with crate count and workspace-membership readability (reading `Cargo.toml` `[workspace]` members and, when the partner CLI is present, passing through its status), while `communities.ts` gains an opt-in `batchSize` option that chunks label propagation and cluster-note materialization with per-batch failure isolation. Defaults stay unset, so doctor output and community detection remain byte-identical until a flag is used.
Trade-offs:
- Smallest footprint and fastest to ship; no new CLI verbs, MCP tools, or schema tokens to document and version.
- Couples two unrelated concerns (partner readability, graph robustness) onto pre-existing functions, and Rust readability stays buried inside `o2b doctor` output rather than being independently queryable.
- Partial-failure resilience added inside `detectCommunities` risks diluting its current deterministic, fully-in-memory contract that downstream tests rely on.
Complexity: small
Risk: low

## Variant 2: Dedicated operational-readability reporting layer
Approach: Add a new read-only surface (`o2b partner codegraph report` plus a `brain_codegraph_report` MCP tool) that aggregates partner code-graph status, detected Cargo-workspace crate membership, and any partner-reported crate dependency counts into one structured, schema-versioned report with honest absent-data fields and typed errors. Community labeling robustness is delivered as a separate, option-gated batched pass over the existing detection, leaving the default path untouched. Each concern lives in its own discoverable surface.
Trade-offs:
- Operational readability becomes a first-class, queryable artifact for agents and operators rather than a doctor side effect, matching the cards' stated intent.
- Honest-absent-data and typed-error reporting fit the project's existing conventions and stay additive, so existing reads are byte-identical.
- More new surface area to register, document, changelog, and version-sync than Variant 1; two cards land as two distinct surfaces rather than one cohesive change.
Complexity: medium
Risk: low

## Variant 3: Unified batched-graph-pass abstraction with crate edges
Approach: Introduce a shared "batched graph pass with partial-failure accumulation" primitive consumed by both subsystems: community detection runs chunked, fault-isolated batches, and a new crate-graph projection extracts Graphify-style `crate_depends_on` edges from detected Cargo workspaces into Open Second Brain's graph schema as a new typed edge. This generalizes batching as a cross-cutting concern and brings Rust workspace dependencies in as first-class graph structure.
Trade-offs:
- Maximizes reuse and treats batching/partial-failure as one well-tested primitive across the graph layer.
- Adds a new `crate_depends_on` edge type to the graph schema, a non-additive change that touches indexing, recall, and schema-pack surfaces, raising migration and regression surface.
- Presupposes deeper Graphify-style edge mapping the constraints caution against, and risks recasting Open Second Brain's optional partner as an owned ingestion dependency.
Complexity: large
Risk: high

## Recommended: Variant 2
Rationale: The cards are explicitly framed as operational readability rather than new graph machinery, so a dedicated read-only report surface delivers their value where operators and agents can find it, without burying it in doctor output as Variant 1 does. It stays additive and option-gated with typed errors and honest absent-data, preserving byte-identical default behavior per the constraints. It deliberately avoids Variant 3's new `crate_depends_on` schema edge and Graphify-as-dependency overreach, keeping the partner integration detection-only. The modest extra surface area is the right cost for a discoverable, versioned artifact that fits existing conventions.
