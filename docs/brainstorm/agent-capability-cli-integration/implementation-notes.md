# Implementation notes

- Prefer small pure helpers for capability evaluation and completion generation.
- Keep manifest metadata descriptive, not dispatch-owning.
- Avoid a full command-registry refactor in this PR.
- Existing semantic JSON branches should not be double-wrapped.
- Fallback JSON should capture command stdout/stderr only when the command has no semantic JSON contract.
