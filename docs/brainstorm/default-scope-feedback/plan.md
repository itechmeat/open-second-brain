# Configurable default_scope for feedback signals implementation plan

Branch: `feat/default-scope-feedback`
Design: `docs/brainstorm/default-scope-feedback/design.md`

## t_d8a58683 - [upstream:mnemosyne] feat(hermes): configurable default_scope for remember()/feedback calls

### Files

- `src/core/brain/types.ts`
- `src/core/brain/policy.ts`
- `src/core/brain/signal.ts`
- `src/mcp/brain/feedback-tools.ts`
- `src/cli/brain/verbs/feedback.ts`
- Existing focused tests for Brain config validation, signal writing, CLI feedback, and MCP feedback, with new tests added where coverage is missing
- `docs/cli-reference.md`
- `docs/mcp.md`
- `CHANGELOG.md`

### Acceptance

A focused test suite passes that proves:

- With no `feedback.default_scope` and no explicit `scope`, signal output remains unchanged and omits `scope` frontmatter.
- With `feedback.default_scope: coding` and no explicit `scope`, both `brain_feedback` and `o2b brain feedback` write signals with `scope: coding` and the normal scope tag behavior.
- With `feedback.default_scope: coding` and explicit `scope: docs`, the explicit scope wins for both CLI and MCP paths.
- Invalid configured defaults are rejected or surfaced through normal config validation/doctor behavior rather than silently ignored.
- Force-confirmed preference creation uses the same effective scope as the signal when a default applies.

Suggested verification command for the worker:

```bash
bun test <focused config test> <focused signal test> <focused CLI feedback test> <focused MCP feedback test>
bun run typecheck
```

### Depends on

No sibling card needs to land first. This is the only in-scope implementation card for the patch release and should be driven on `feat/default-scope-feedback` under TDD.
