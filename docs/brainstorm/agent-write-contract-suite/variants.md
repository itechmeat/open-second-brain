# Agent Write Contract Suite - variants audit trail

Consultant: Claude Code (`claude -p`), primary, single run, no fallback needed.
Prompt: `cli-output/prompt.md`. Raw output: `cli-output/claude.md` (verbatim copy below).

## Consultant output (verbatim)

### Variant 1: Unified session kernel
- **Approach**: Build one generic, file-backed write-session state machine in `core/brain/session/` (envelope with `status`/`session_id`/`step`, TTL + retry store, audit log) that is the literal deliverable of Task 1. Task 4's decision panel becomes a session *kind* (`panel`) riding the same kernel - OSB emits per-persona prompts as steps and validates the synthesis on submit - so it needs no parallel lifecycle. Task 2 stays a narrow `AgentBackend` boundary the session consults for render/validation strategy; Task 3 is an independent fail-soft mirror hooked at the existing `signal`/`note`/`preference-txn` chokepoints.
- **Trade-offs**:
  - Pro: TTL, retry cap, collision metadata, and audit log are built exactly once and shared by both agent-facing flows.
  - Pro: Task 4 collapses to persona-loading + a synthesis schema, since it inherits the correction loop and operator-gate (`needs-review`) for free.
  - Pro: Fewer new MCP tools (one session surface with a `kind` discriminator) keeps the 65-tool growth deliberate.
  - Con: Kernel must be generic enough on day one to serve both an artifact-write and a multi-step panel - some up-front design tax.
  - Con: Couples panel and write-session evolution; a panel-specific need could leak into the shared envelope.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Four independent modules sharing only contracts
- **Approach**: Ship each task as a self-contained module sharing nothing but type contracts (`SchemaValidationResult`, envelope types). Write-session, backend registry, shared-namespace mirror, and decision panel each own their store, surface, and tests; the panel calls the write-session as a library but persists to its own state. Each module maps one-to-one to a kanban task.
- **Trade-offs**:
  - Pro: Independently shippable, testable, and revertable - clean blast-radius isolation per task.
  - Pro: Strongly additive; no module reshapes another's write path, fitting the "additive-only" and fail-closed/fail-soft split naturally.
  - Pro: Lowest design risk - no premature generalization.
  - Con: Session lifecycle, TTL, retry, and audit logic get duplicated (or near-duplicated) between Task 1 and the panel.
  - Con: More MCP tools and two session-ish state machines that can drift apart over time.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Backend-protocol-first (everything is a backend capability)
- **Approach**: Make Task 2's `AgentBackend` protocol the central abstraction and route the write-session, persona panel, and shared-namespace mirroring through it as backend-dispatched capabilities. The Claude memory render becomes the first backend; selection is config-driven, and all agent-write behavior is expressed as capabilities a backend declares.
- **Trade-offs**:
  - Pro: Maximum extensibility - a future runtime gains write-session, panel, and mirror behavior through one seam.
  - Pro: Single dispatch point for all agent-facing format concerns.
  - Con: Over-abstraction when only one backend (Claude) exists; the deterministic-core rule means backends are format adapters, not generation engines, so the seam carries little real variation today.
  - Con: Largest refactor - pulls the `claude-memory-*` flow and core write paths under a new boundary, straining the "do not change existing public APIs / additive-only" constraint.
  - Con: High YAGNI risk; couples four independently-valuable tasks to one speculative abstraction.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 1
**Rationale**: Task 4 is specified to run *as* a write-session, so a shared session kernel turns the panel into a thin persona-and-synthesis layer instead of a second state machine - the strongest reuse for the least surface, which directly serves the deliberate-MCP-growth and no-LLM-in-core constraints. It keeps Task 2 as a deliberately narrow render/validation boundary and Task 3 as a fail-soft hook at the existing chokepoints, avoiding both the duplication of Variant 2 and the premature, core-reshaping generalization of Variant 3.

## Orchestrator decision

Variant 1 accepted, with two containment refinements against the consultant's literal text:

1. **The session kernel does not consult backends.** The consultant suggested Task 2 as "a boundary the session consults for render/validation strategy" - that is speculative coupling with no consumer today. The backend boundary stays scoped to the memory-import flow (`claude-memory-*`); the write-session validates against schema-pack contracts directly. If a real second runtime ever needs format-specific session validation, the seam can grow then.
2. **Module path is `src/core/brain/write-session/`, not `core/brain/session/`.** The repo already has `session-lifecycle.ts`, `session-recall.ts`, `session-scope.ts`, and `sessions/` (import adapters); an unqualified `session/` directory would collide with that vocabulary.

Variant 2 was the runner-up; its decisive flaw is the duplicated lifecycle between the artifact flow and the panel (two TTL/retry/audit implementations drifting apart). Variant 3 was rejected on YAGNI and on the additive-only constraint it admits to straining.
