### Variant 1: Shared budget kernel + registry guard seam (extract-and-reuse)

- **Approach**: Extract two reusable deterministic primitives early, then plug all six children into them. (a) A `text-budget` core lifted from `pre-compress-pack.ts` head-budget logic, used by both active.md slimming (child 2) and the hook reminder compaction (child 3); (b) a `registry-guard` seam over `buildToolTable` that enforces the description cap (child 5) and the preview-budget allowlist (child 6) from the same enumeration the contract test already pins. Tool consolidation (child 4) and the PostCompact bugfix (child 1) stay as standalone slices that consume these primitives but carry their own logic.
- **Trade-offs**:
  - Pro: One truncation implementation → determinism/idempotency property is proven once and inherited everywhere (satisfies the idempotent-write and identical-input constraints).
  - Pro: Description cap and preview allowlist share one registry walk, so both guard tests key off the existing sorted-name+count contract — low test sprawl.
  - Pro: Children stay independently shippable (one PR = one CHANGELOG version); P4 bugfix and P2 guards don't block each other.
  - Con: Two distinct seams (text vs registry) means the "shared infrastructure" is split, not unified — some conceptual overhead deciding where a change lands.
  - Con: Consolidation (child 4) and hooks (1–3) don't benefit from the registry seam, so coordination across the MCP/hook boundary is still manual.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Independent priority-ordered vertical slices

- **Approach**: Treat each of the six children as a self-contained PR with no new shared abstractions, sequenced strictly by priority (P4 bugfix → P3 active.md/reminder/consolidation → P2 cap/preview). Each slice copies or inlines whatever budgeting/guard logic it needs locally; the only shared touch-point is the existing registry contract test, updated per slice.
- **Trade-offs**:
  - Pro: Fastest path to landing the P4 PostCompact bugfix and the silent-16KB-stdout leak with zero dependency on other work.
  - Pro: Minimal blast radius per PR; easiest review and rollback; CHANGELOG mapping is trivially one-per-child.
  - Pro: No upfront design cost; no risk of an over-built abstraction.
  - Con: Truncation/head-budget logic gets duplicated between active.md (child 2) and the reminder (child 3) — two places to keep deterministic, violating the single-source idempotency intent.
  - Con: Description cap (5) and preview allowlist (6) each grow their own registry walk and guard test → drift risk between two contract tests.
  - Con: Highest long-term maintenance; the duplicated determinism logic is exactly the kind of thing the audit is trying to reduce.
- **Complexity**: small
- **Risk**: medium

### Variant 3: Declarative tool-registry manifest + mirrored injection-budget module

- **Approach**: Introduce a single declarative manifest describing every MCP tool (capped description, preview-budget allowlist entry + reason, deprecation-alias mapping, consolidation group/param), and derive the serialized registry, both guard tests, the alias delegation, and the consolidated `brain_brief`/`brain_analytics`/`schema` dispatch from that one data model (children 4, 5, 6). A parallel `injection-budget` module owns all hook/SessionStart/PostCompact rendering with deterministic truncation (children 1, 2, 3), mirroring the manifest's budget philosophy on the hook side.
- **Trade-offs**:
  - Pro: Consolidation, description diet, and preview budget all fall out of one source of truth — adding a tool forces an explicit manifest entry (the "flip the default / explicit allowlist with reason" requirement becomes structural, not a test afterthought).
  - Pro: Strongest guarantee against future regression; the registry contract becomes a projection of the manifest.
  - Pro: Cleanly separates the two real domains (tool surface vs context injection) into two owned modules.
  - Con: Large upfront refactor of `tools.ts` + the 3,592-line `brain-tools.ts` to route definitions through a manifest — high churn, harder review, more chance of perturbing the sorted-name+count contract mid-flight.
  - Con: Couples the four MCP-surface children into one big structural change, working against one-PR-per-version and against landing the P4 bugfix quickly.
  - Con: Risk of over-engineering relative to a *static* surface reduction — and the manifest could be mistaken for the adaptive-selection work explicitly deferred to t_20dcb192.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 1
**Rationale**: It captures the one genuinely shared concern the audit exposes — deterministic, idempotent truncation reused by both active.md and the post-write reminder — without forcing the four MCP-surface children into a single high-churn manifest refactor that endangers the pinned registry contract and the one-PR-per-version rule. The two thin seams (text-budget kernel, registry guard) give the P2 guard tests a single enumeration to key off while keeping the P4 bugfix and consolidation independently shippable, fitting the project's strict TDD, fail-soft hook, and deprecation-window constraints far better than either the duplication of Variant 2 or the over-build of Variant 3.
