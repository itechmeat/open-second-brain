# Self-Learning Skill Proposals - variants

## Consultant variants

### Variant 1: Three Parallel Queue Modules (file-first, dream-adjacent)

- **Approach:** Implement each board task as its own self-contained core module with its own artifact and CLI verb group, sharing only existing primitives (`log-jsonl` reader, `paths`, `types`). Skill proposals land in a new `Brain/proposals/` queue, the procedural index as a sidecar under `Brain/skills-index/`, and recurrence/reference counters as frontmatter fields on existing Brain entries. Each exposes an opt-in scan command that borrows the `dream` watermark pattern without modifying `dream` itself.
- **Trade-offs:**
  - Pro: Clean separation maps 1:1 to the three acceptance-criteria sets and their test suites; each ships and is reviewed independently.
  - Pro: Zero regression risk to the existing preference-learning `dream` path; honors "companion workflow, not replacement."
  - Pro: Smallest coherent first slice; easy to defer any one task without blocking the others.
  - Con: Three watermark/scan loops mean some duplicated scan scaffolding, mitigated by a shared helper, not a shared engine.
  - Con: Leaves synergy on the table; recurrence support counts do not automatically feed proposal confidence in the first slice.
- **Complexity:** medium
- **Risk:** low

### Variant 2: Unified Procedural-Knowledge Engine with Shared Recurrence Ledger

- **Approach:** Build one new subsystem centered on a content-hash recurrence ledger that becomes the common substrate for all three concerns. Skill proposals become derived views whose confidence is supplied by ledger support counts, installed skills become graph nodes in the same store carrying usage and recurrence counters, and scope-promotion/commitment escalation is one set of thresholded logic applied uniformly across preferences, proposals, and skills. A single scan and single watermark drive everything.
- **Trade-offs:**
  - Pro: Maximal reuse and a single source of truth for support/recurrence/confidence; strongest "the brain learns how it works" payoff.
  - Pro: Cross-scope promotion naturally lifts proposals and procedural entries, not just preferences.
  - Con: Large surface area; the three upstreams have genuinely different data shapes forced into one model, fighting KISS.
  - Con: High coupling makes a coherent first slice hard to scope and a partial ship hard to test in isolation.
  - Con: Highest regression and design-churn risk for an initial release.
- **Complexity:** large
- **Risk:** high

### Variant 3: Dream-Pipeline Phase Extension + Thin Review CLIs

- **Approach:** Add three new deterministic phases to the existing multi-phase `dream` pass: proposal detection, procedural reconciliation, and recurrence/reference accounting. Each phase emits Brain artifacts with audit-log entries alongside the current preference promotion. Accept/reject/promote actions are handled by thin CLI and read/diagnostic MCP verbs layered over those artifacts, giving the operator one learning cadence.
- **Trade-offs:**
  - Pro: Reuses watermark, batch orchestration, audit-log, and scheduling infra; strong DRY.
  - Pro: One operator mental model and one scheduled pass; preview-first falls out naturally from `dream`'s dry-run.
  - Con: Meaningfully grows `dream` and couples three independent concerns to one scheduler cadence, risking regression to the protected preference path.
  - Con: Per-task test isolation is harder when all phases share one pipeline entry point.
  - Con: Procedural reconciliation, filesystem-driven rather than journal-driven, is an awkward fit for a journal-watermark pipeline.
- **Complexity:** medium
- **Risk:** medium

## Orchestrator decision

Recommended: Variant 1.

The three board tasks have different source data and write semantics, so parallel modules keep the first release simpler and more testable than a shared procedural engine. This also minimizes risk to the existing deterministic `dream` preference path while leaving room to consolidate recurrence support into proposal confidence in a later release after the artifact shapes prove themselves.
