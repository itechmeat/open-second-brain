# Consultant output - actionable-now batch

In host execution mode the consultant role ran as an in-session subagent of the orchestrator; external CLIs are forbidden by host-mode rules, so no external consultant process was launched. The prompt that would have been sent is at `cli-output/prompt.md`.

The consultant's output is the three architectural variants recorded in [`../variants.md`](../variants.md):

1. Variant 1: Four disjoint lanes per card cluster, one integrator (recommended)
2. Variant 2: One lane per card, sequential integration chain
3. Variant 3: Two mega-lanes splitting core-vs-surface

The orchestrator accepted Variant 1; the acceptance rationale is the closing paragraph of `variants.md`, and the chosen approach in `design.md` is its concrete realization.
