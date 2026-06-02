# Token diet - variants audit trail

Consultant: Claude Code (`claude -p`), primary, single pass. Raw output preserved verbatim in `cli-output/claude.md`; prompt in `cli-output/prompt.md`. Fallback consultant not invoked (primary returned 3 parseable variants).

## Variant 1: Shared budget kernel + registry guard seam (extract-and-reuse)

- **Approach**: Extract two reusable deterministic primitives early, then plug all six children into them. (a) A `text-budget` core lifted from `pre-compress-pack.ts` head-budget logic, used by both active.md slimming (child 2) and the hook reminder compaction (child 3); (b) a `registry-guard` seam over `buildToolTable` that enforces the description cap (child 5) and the preview-budget allowlist (child 6) from the same enumeration the contract test already pins. Tool consolidation (child 4) and the PostCompact bugfix (child 1) stay as standalone slices that consume these primitives but carry their own logic.
- **Trade-offs**:
  - Pro: One truncation implementation - determinism/idempotency property is proven once and inherited everywhere.
  - Pro: Description cap and preview allowlist share one registry walk; both guard tests key off the existing sorted-name+count contract.
  - Pro: Children stay independently shippable; P4 bugfix and P2 guards do not block each other.
  - Con: Two distinct seams (text vs registry) - shared infrastructure is split, not unified.
  - Con: Consolidation (child 4) and hooks (1-3) do not benefit from the registry seam; coordination across the MCP/hook boundary stays manual.
- **Complexity**: medium
- **Risk**: low

## Variant 2: Independent priority-ordered vertical slices

- **Approach**: Each of the six children is a self-contained slice with no new shared abstractions, sequenced strictly by priority. Each slice inlines whatever budgeting/guard logic it needs; the only shared touch-point is the existing registry contract test.
- **Trade-offs**:
  - Pro: Fastest path to landing the P4 PostCompact bugfix; minimal blast radius per slice; trivial rollback.
  - Pro: No upfront design cost; no over-built abstraction risk.
  - Con: Truncation/head-budget logic duplicated between active.md and the reminder - two places to keep deterministic.
  - Con: Description cap and preview allowlist each grow their own registry walk and guard test - drift risk.
  - Con: Highest long-term maintenance; duplicated determinism logic is exactly what the audit tries to reduce.
- **Complexity**: small
- **Risk**: medium

## Variant 3: Declarative tool-registry manifest + mirrored injection-budget module

- **Approach**: A single declarative manifest describes every MCP tool (capped description, preview-budget allowlist entry + reason, deprecation-alias mapping, consolidation group/param); the serialized registry, both guard tests, alias delegation, and the consolidated dispatch all derive from that one data model. A parallel `injection-budget` module owns all hook rendering with deterministic truncation.
- **Trade-offs**:
  - Pro: One source of truth; adding a tool forces an explicit manifest entry - the "explicit allowlist with reason" requirement becomes structural.
  - Pro: Strongest guarantee against future regression.
  - Con: Large upfront refactor of `tools.ts` plus the 3,592-line `brain-tools.ts`; high churn, harder review, risk to the pinned registry contract.
  - Con: Couples the MCP-surface children into one big structural change; works against landing the P4 bugfix quickly.
  - Con: Over-engineering risk for a static surface reduction; could be mistaken for the adaptive-selection work deferred to t_20dcb192.
- **Complexity**: large
- **Risk**: high

## Consultant recommendation

Variant 1. "It captures the one genuinely shared concern the audit exposes - deterministic, idempotent truncation reused by both active.md and the post-write reminder - without forcing the four MCP-surface children into a single high-churn manifest refactor that endangers the pinned registry contract and the one-PR-per-version rule."

## Orchestrator decision

**Variant 1 accepted.** Project context confirms the consultant's reasoning rather than overriding it: the repo already follows the "pure deterministic core + thin IO shell" pattern (preview-budget.ts, coverage.ts from the Recall Trust Suite), so two small seams fit the codebase idiom, while a manifest rewrite of brain-tools.ts would dwarf the six children combined and put the registry contract test in motion exactly when two new guard tests need it stable. Variant 2's duplicated truncation logic was rejected because the active.md idempotent-write property and the hook fail-soft contract both depend on truncation determinism - proving it once is the cheaper and safer route.
