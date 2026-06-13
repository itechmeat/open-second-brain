# Knowledge Provenance Suite - variant audit trail

Primary consultant: Claude Code (`claude -p`), exit 0, three parseable variants.
Fallback (Codex) not invoked - primary returned a clean, complete set.

The full consultant output is preserved verbatim in `cli-output/claude.md`. The
three variants and the consultant's recommendation are reproduced below, followed
by the orchestrator decision.

## Variant 1: Unified staged-intake kernel

- **Approach**: Generalize the existing `write-session` kernel into ONE
  provider-agnostic "intake transaction" that every generation-bearing feature
  (ingest, research-report, derived-facts, on-write NER) funnels through: the
  agent proposes a typed payload across an MCP/CLI boundary, OSB validates ->
  provenance-stamps -> cross-links -> atomically commits. Primitive (a) is the
  discriminated `ExtractionIntake` payload shared by ingest and NER, (b) is a
  `Provenance` value object stamped at commit, (c) reuses `agent-scope.ts` for
  owner fields. Features 2/3/6 become payload variants or phases of the same
  commit path.
- **Trade-offs**: Maximum DRY and one tested seam for provenance/atomicity, but
  a large upfront abstraction conflicts with one-feature-at-a-time TDD (first
  commits carry the most risk), over-generalization invites leaky union types or
  `as` crutches, and per-feature atomic revertability is hardest.
- **Complexity**: large
- **Risk**: high

## Variant 2: Per-feature pipelines over three shared libraries

- **Approach**: Each feature is its own module/pipeline with its own MCP tool or
  CLI command and its own TDD unit (`ingest.ts`, `research.ts`, a `derive` phase
  in `dream.ts`, `ner.ts`, owner-scoped facts on `preference-txn.ts`, an
  extension to `attention-flows.ts`), but all import three shared library
  functions rather than duplicating logic: `extractIntake()` (primitive a,
  shared by ingest + NER), `stampProvenance()`/citation builder (primitive b,
  shared by ingest + research + derive), and the existing owner-visibility
  helpers (primitive c). The generation boundary sits at each feature's own tool;
  each pipeline sequences-validates-commits using the shared libs (mirroring
  `importSession`'s dedup-hash blueprint).
- **Trade-offs**: Matches the repo's domain-module decomposition and the
  one-atomic-commit-per-feature TDD constraint exactly; risk is isolated per
  feature; DRY is enforced via three named exports without a monolith; flags stay
  independently opt-in. Cons: larger MCP/CLI surface, repeated sequencing
  boilerplate, and shared-lib usage is discipline-dependent (drift possible
  without review vigilance).
- **Complexity**: medium
- **Risk**: low

## Variant 3: Read-time provenance/visibility resolver with thin write adapters

- **Approach**: Push provenance, trust-ordering, and owner-scoping entirely into
  a read-time derivation at `packContext`/recall time, governed by frontmatter
  tokens and wikilinks; writes stay "dumb". Generation features become thin
  agent-side adapters that emit notes with the right frontmatter, while one
  `resolveProvenance()`/`resolveVisibility()` layer at the read chokepoint does
  all ordering and filtering.
- **Trade-offs**: Strongest byte-identical-when-off guarantee (storage
  unchanged); trust ordering and owner filtering in one read seam. Cons: ingest
  and research are inherently write-heavy multi-page operations that do not fit a
  pure read-time model, so the resolver only covers 3/6 features and a hybrid is
  unavoidable; recomputing on every assembly adds read-path cost and complicates
  caching against the O(1) graph side-index; frontmatter-only provenance is
  brittle under hand edits with no commit-time validation.
- **Complexity**: medium
- **Risk**: medium

## Consultant recommendation: Variant 2

The consultant recommended Variant 2 as the only variant that fits the hard
process constraints (one feature at a time via TDD, one atomic revertable commit
per unit, single 50-70 file PR), because each pipeline lands independently while
three named shared exports satisfy the DRY mandate without a monolithic kernel.
It mirrors the repo's own precedents (`importSession`, `write-session`, the v1.2
domain decomposition) and keeps each opt-in flag and its byte-identical-off
guarantee isolated. Variant 1 front-loads risk against the TDD cadence; Variant 3
cleanly covers only the read-side half of the suite.

## Orchestrator decision: accept Variant 2, with one hardening

Accepted. Variant 2 is the correct fit for this repo's TDD/atomic-commit cadence
and the single-PR constraint, and it is the only variant under which a flawed
ingest pipeline cannot regress derived-facts.

One hardening is added to close Variant 2's single weakness (shared-lib usage is
discipline-dependent): the three shared primitives are made the ONLY exported way
to perform their operation. There is no public alternative write path for
extraction-intake or provenance-stamping - features import the shared export or
they do not compile. This converts "drift is possible without review vigilance"
into a type-and-module-boundary guarantee, recovering Variant 1's single-seam
benefit without its monolith or its front-loaded risk.

A second clarification follows directly from the project's provider-agnostic
kernel (OSB never calls an LLM): for the four generation-bearing features
(ingest, research, derived-facts, NER), all model generation lives on the agent
side of an MCP/CLI boundary. OSB owns only the deterministic half - sequencing,
validation, provenance-stamping, idempotent dedup, and the atomic vault write -
which is exactly the half that is testable and the half the operator agreed to
cover with tests. No ML dependency is bundled anywhere in the suite.
