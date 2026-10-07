# Variants - context-injection-pipeline

Audit trail for the phase-0 brainstorm. All variants verbatim from the consultant output, followed by the orchestrator decision.

Host-mode note: the feature-release-playbook's primary and fallback consultant CLIs (claude, codex) were not launched. The run operates under a binding host-mode override that forbids external agent CLIs; the assembled consultant prompt is preserved at `cli-output/prompt.md` and the consultant role was performed in-session, with the output preserved verbatim below and at `cli-output/consultant.md`.

## Consultant output (verbatim)

### Variant 1: Instruction-file parity (install-target route)

- **Approach**: Deliver the subagent context through the install surface: a new claude-code install adapter writes a marker-fenced managed block (the standing-rules digest plus a pointer to `brain_context`) into the workspace CLAUDE.md/AGENTS.md via `insertManagedBlock`, kept fresh by a fire-and-forget sync on SessionStart when the assembled context hash diverges. The hygiene digest ships on the Stop channel as a full default sweep per changed turn, deduplicated by a vault-level hash ledger. The headline tier parses the inline tag grammar (first parenthesized group after the item id) to rank bullets deterministically.
- **Trade-offs**:
  - Pros: covers every host that loads instruction files natively, not only hook-capable runtimes; the static digest survives /compact and /clear by construction; near-zero hook-time cost for the subagent lane (one file rewrite at session start).
  - Cons: the core delivery claim (workspace CLAUDE.md content reaching Task-subagent turns) cannot be verified in this repo, so the PR's headline feature would rest on an unmeasured host assumption; it writes into files the project's own writeback contract treats as read-only and that the instruction-file ceiling caps; it adds an install target, a census update, and a sync mechanism — the largest surface of the three variants, spread across install, hooks and core.
- **Complexity**: large
- **Risk**: high

### Variant 2: Hook-only carriers (smallest proven channel)

- **Approach**: Deliver the full budgeted active digest into subagent turns from a PostToolUse hook that fires only when the payload carries a non-empty agent_id, once per subagent via an injection-ledger key — every element of that channel (PostToolUse inside subagent turns, agent_id, additionalContext, ledger) is already proven in-tree. The hygiene digest at Stop runs only a cheap detector subset (conflicts, slug-collisions plus the index-backed dangling-link count) to stay safely inside the 10-second Stop timeout. The headline tier threads structured entries from the active render through a new optional parameter on the budget entry point instead of parsing display text.
- **Trade-offs**:
  - Pros: no unverified host assumptions anywhere; smallest blast radius per lane; structured ranking cannot misparse the display grammar; the detector subset removes the scan-latency risk by construction.
  - Cons: the full digest per subagent costs more tokens than a rules-only digest; the cheap detector subset permanently drops freshness and usefulness from the pushed digest (they stay pull-only), which weakens the card's own example (done notes sitting in the active folder); threading structured entries touches the shared budget entry point that lessons.md also consumes, so the signature change reaches a consumer this PR otherwise would not touch.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Tiered hybrid (carrier for rules, full-sweep Stop digest, constrained-parse tier)

- **Approach**: Split delivery by audience: a PostToolUse hook carries only the standing-rules digest into subagent turns (once per agent_id via the ledger, capped by the existing standing-rules policy limit), while the full active digest remains a session-start concern; this targets exactly the gap where writes happen without learned rules. The hygiene digest runs the full default detector sweep at Stop, but only on turns that wrote an artifact, and emits one line once per change through a vault-level hash ledger, so scan cost is amortized and silence stays the steady state. The headline tier is a constrained deterministic parse — the first parenthesized group after the item id only, never the principle text — applied to non-keep-guard sections before eviction, with render-order tie-break, a named top-N constant, and the headLines guard set so a headlines-only remnant drops cleanly; the doctor pressure probe is updated to mirror the tier step.
- **Trade-offs**:
  - Pros: every delivery claim is verified in this tree (PostToolUse additionalContext, Stop additionalContext, the shared section-budget core); smallest token cost per subagent while covering the exact rule gap; full hygiene coverage without permanently surrendering detectors; the tier lives in the shared budget core with the probe kept consistent, and lessons.md degrades safely to render order when no recognizable tags are present.
  - Cons: PostToolUse delivery covers only hook-capable runtimes (instruction-file hosts stay uncovered, matching today's coverage); the constrained parse depends on a display grammar even though it reads only the first parenthesized group; scan latency on very large vaults still has to be measured against the 10-second Stop timeout before the full sweep is trusted.
- **Complexity**: medium
- **Risk**: medium

### Recommended: Variant 3

**Rationale**: Variant 3 puts all three cards on channels this repository already proves — PostToolUse additionalContext with agent_id, the Stop one-line channel, and the deterministic section-budget core — while Variant 1 risks the PR's headline feature on a host behavior (workspace CLAUDE.md reaching Task subagent turns) that cannot be verified here and writes into files the project audits as read-only. Against Variant 2, it keeps full hygiene coverage instead of permanently dropping the detectors behind the card's own example, and solves ranking locally with a constrained parse rather than changing the shared budget signature that lessons.md also consumes. Its residual risks (subagent delivery confirmation, scan latency, parse grammar) are measurable during QA, whereas Variant 1's core assumption is not measurable from this repo at all.

## Orchestrator decision

Chosen: Variant 3.

Rationale: the orchestrator agrees with the consultant. Every delivery claim in Variant 3 lands on a channel verified against this exact tree, keeping the PR shippable without betting on unmeasured host behavior, and the lane split (carrier, Stop digest, budget core) gives three implementation lanes with disjoint file ownership. Variant 1's instruction-file route stays a documented follow-up: its blocking unknown — whether workspace CLAUDE.md content reaches Task-subagent turns — is exactly the kind of claim this project prefers to measure before building on.
