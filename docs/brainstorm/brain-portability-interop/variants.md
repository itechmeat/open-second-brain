# Brain Portability & Interop - brainstorm audit trail

Primary consultant: Claude Code (`claude -p`), exit 0, 3 parseable variants.
Fallback (Codex) not invoked - the primary returned a complete, parseable set.

The full consultant output is preserved verbatim in
`cli-output/claude.md`; the variants are reproduced below.

---

### Variant 1: SDK-centric hub
- **Approach**: Build Unit C's `createBrain(vault)` façade first and make it the
  single composition point. Unit A's bank export/import, Unit B's per-page
  projection, and Unit D's `brain_create_note` all route their logic through the
  SDK, so the CLI verbs and MCP tool become thin shells over `createBrain(vault)`.
  One object owns the orchestration of `exportPreferencesJson` +
  `exportVaultGraph` + `aggregateSources`.
- **Trade-offs**:
  - Pro: a single chokepoint eliminates duplication across CLI, MCP, and SDK
    surfaces; the SDK is dogfooded by its own consumers.
  - Pro: write paths (`writeStatus`, note creation) share one provenance/guard
    implementation.
  - Con: tension with the "SDK must be a thin façade, not a reimplementation"
    constraint - if bundle orchestration lives in the SDK it stops being thin.
  - Con: forces C to land before A/B/D, serialising the four units and making the
    SDK the critical path.
  - Con: risk of SDK scope creep into a de-facto new subsystem, which the task
    explicitly discourages.
- **Complexity**: medium
- **Risk**: medium

### Variant 2: Layered core with thin peer adapters
- **Approach**: Add a small core bundle module beside the existing portability
  helpers (e.g. `portability/bundle.ts` composing the existing exporters into a
  schema-versioned bank envelope, plus `portability/page.ts` defining Unit B's
  decoupled per-page contract as a pure projection). Each surface is a thin,
  independent adapter over those core functions: Unit A is CLI verbs, Unit C
  re-exposes the same core functions (including source-backed writes) as a
  façade, and Unit D is an MCP tool calling vault/path helpers directly. No
  surface depends on another surface.
- **Trade-offs**:
  - Pro: matches the repo's established structure exactly (one file per
    portability concern, one CLI verb per file, tool-def array), so each unit
    lands as a near-independent PR over shared core.
  - Pro: keeps the SDK genuinely thin (re-export, not orchestrate) and keeps B's
    contract decoupled from OSB internals in its own projection module.
  - Pro: byte-identical-when-off and per-entry import validation fall out
    naturally from reusing the existing envelope conventions.
  - Con: four units touch the shared bundle module, needing light coordination on
    the envelope shape.
  - Con: slightly more files than folding into an existing module.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Bank-as-graph-extension
- **Approach**: Avoid a new bundle module by extending the existing
  `exportVaultGraph` / `importVaultGraph` envelope to optionally carry
  preferences, sources/provenance, and Unit B's per-page fields as extra sections
  and per-node attributes of the same graph bundle. Units C and D are added as
  small surfaces on top, reusing the extended exporter for any whole-vault read.
- **Trade-offs**:
  - Pro: smallest code footprint; literally one existing serialisation path
    reused, with its conflict modes and `ensureInsideVault` guards already in
    place.
  - Con: overloads a link-graph exporter with non-graph concerns (preferences,
    sources), conflating "page graph" with "whole bank."
  - Con: envelope versioning becomes muddy - `GRAPH_VERSION` now gates unrelated
    bank content, so the bank format cannot evolve independently.
  - Con: bolting B's contract onto graph nodes works against the "decoupled from
    OSB internals, stable interchange schema" requirement.
- **Complexity**: small
- **Risk**: medium

### Recommended (consultant): Variant 2

> It mirrors the repository's existing portability conventions (discrete core
> modules, thin CLI/MCP/SDK adapters as peers), which keeps the SDK a genuine
> façade and Unit B's interchange contract cleanly decoupled, satisfying the
> stated constraints directly. It composes the existing exporters into a new
> schema-versioned bank envelope rather than overloading the graph exporter
> (Variant 3) or centralising orchestration in the SDK (Variant 1), so the four
> units can land additively and independently in one release without forking a
> parallel serialisation path.

---

## Orchestrator decision: agree with Variant 2

No override. Variant 2 is the only option that satisfies all four hard
constraints at once:

- **"SDK is a thin façade, not a reimplementation"** - Variant 1 violates this by
  moving bundle orchestration into the SDK; Variant 2 keeps orchestration in
  core modules and the SDK delegates.
- **"Unit B decoupled, stable interchange schema"** - Variant 3 violates this by
  bolting the contract onto graph nodes under `GRAPH_VERSION`; Variant 2 gives
  it its own module and `PAGE_CONTRACT_VERSION`.
- **"Reuse existing exporters, no parallel serialisation path"** - Variant 2
  composes `collectExportRows` + `exportVaultGraph` + `aggregateSources` instead
  of re-serialising.
- **"Additive, byte-identical-when-off"** - Variant 2's peer adapters add new
  surfaces without touching existing ones; Variant 1's serialisation of the four
  units and Variant 3's envelope overloading both increase blast radius.

Implementation detail decided beyond the consultant's output: the page-contract
module is named `page-contract.ts` (not `page.ts`) to avoid colliding with the
generic "page" vocabulary already used across the vault layer, and the upstream
`writeStatus` source API maps to the existing `ingestSource` write rather than a
fabricated status field (OSB has no source status lifecycle).
