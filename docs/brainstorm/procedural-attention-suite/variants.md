# Variants audit - procedural-attention-suite

## Source

- Prompt: docs/brainstorm/procedural-attention-suite/cli-output/prompt.md
- Consultant output: docs/brainstorm/procedural-attention-suite/cli-output/claude.md

## Variant 1: Additive In-Place Extension

- Extend existing modules directly with minimal abstraction.
- Pros: smallest diff, low API risk, fast landing.
- Cons: provider-readiness becomes implicit, higher duplication risk.
- Complexity: medium
- Risk: low

## Variant 2: Memory-Graph Kernel Behind a Provider Port

- Introduce full graph kernel + provider port and adapt all features on top.
- Pros: strongest DIP/provider seam.
- Cons: biggest refactor and regression risk for one release.
- Complexity: large
- Risk: high

## Variant 3: Derived Graph Projection + Declarative Recipe Engine

- Keep canonical artifacts, add deterministic derived projection and declarative attention recipes.
- Pros: provider-ready seam without full rewrite, deterministic and auditable, additive APIs.
- Cons: requires projection reconcile discipline and bounded recipe design.
- Complexity: medium
- Risk: medium

## Decision

Chosen variant: Variant 3.

### Rationale

Variant 3 gives the best balance for the required six-task full scope: it enables graph/export and attention/hints flows on a shared projection contract while preserving local-first deterministic behavior and minimizing rewrite risk. It is explicitly provider-ready for the next PR by introducing a stable projection seam, but avoids the high-risk kernel refactor from Variant 2.
