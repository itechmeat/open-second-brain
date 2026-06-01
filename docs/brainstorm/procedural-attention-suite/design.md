# Procedural Attention Suite - derived graph and scoped ingest

**Status:** draft
**Author:** GitHub Copilot (feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain shipped procedural-learning foundations in v0.30.0, but the selected scope still lacks full graph/entity surfaces for procedural memory, write-time prospective recall hints, scoped ingest filtering, and declarative attention flows that can feed context outputs. The operator requires full delivery for six related tasks in one cohesive release and wants architecture that avoids rework when adding Hermes memory-provider compatibility in the next PR. The implementation must remain deterministic, local-first, additive, and auditable.

## Scope

- Add a derived procedural graph projection built from canonical procedural/proposal artifacts.
- Add deterministic entity/link extraction for procedural entries and include links in projection/export.
- Add CLI and MCP export/introspection surfaces for the procedural graph.
- Add write-time prospective recall hints as derived artifacts.
- Add scoped ingest context and filtered write mode for import/synthesis pipelines.
- Add declarative attention-flow recipes (open loops/learnings) with evaluation + context-pack integration.
- Add tests for core, CLI, and MCP for all new flows.

## Out of scope

- Full Hermes memory-provider plugin compatibility lifecycle (separate PR).
- Non-deterministic/LLM-required hint or recipe generation.
- Breaking changes to existing CLI/MCP contracts.

## Chosen approach

Use a deterministic derived-projection architecture: markdown/frontmatter artifacts remain canonical source-of-truth, while a derived projection persists graph nodes/edges/entities/hints for fast introspection and export. Declarative attention recipes read from the same projection and known runtime indexes. This creates a stable provider-ready seam (projection contract) without a high-risk kernel rewrite.

## Design decisions

- Projection-first seam: add a single read/write contract for procedural graph/hints so the next provider-adapter PR can target one boundary.
- Deterministic derivation: projection can be rebuilt from canonical artifacts; no hidden remote state.
- Additive CLI/MCP: new verbs/tools are appended; existing commands retain behavior.
- Scoped ingest context as explicit input contract: filters and context-hints are optional, default behavior unchanged.
- Declarative recipes as data: YAML recipes compiled/executed by bounded deterministic evaluator.
- Backwards compatibility: existing procedural-memory index and skill-proposal flows remain valid.

## File changes

- Core
  - src/core/brain/procedural-graph.ts (new)
  - src/core/brain/procedural-hints.ts (new)
  - src/core/brain/attention-flows.ts (new)
  - src/core/brain/procedural-memory.ts (update)
  - src/core/brain/skill-proposals.ts (update)
  - src/core/brain/context-pack.ts (update)
  - src/core/brain/paths.ts (update)
  - src/core/brain/sessions/import.ts (update)
- CLI
  - src/cli/brain/verbs/procedural-graph.ts (new)
  - src/cli/brain/verbs/attention-flows.ts (new)
  - src/cli/brain/verbs/index.ts (update)
  - src/cli/brain/help-text.ts (update)
- MCP
  - src/mcp/brain-tools.ts (update)
- Tests
  - tests/core/brain/procedural-graph.test.ts (new)
  - tests/core/brain/procedural-hints.test.ts (new)
  - tests/core/brain/attention-flows.test.ts (new)
  - tests/cli/brain-procedural-graph.test.ts (new)
  - tests/mcp/procedural-graph-tools.test.ts (new)
  - existing related tests updated as needed

## Risks and open questions

- Risk: projection drift if updates are not triggered consistently.
  - Mitigation: explicit reconcile hooks + tests for rebuild/idempotence.
- Risk: over-broad ingest filters can hide required context.
  - Mitigation: explicit diagnostics in JSON outputs and safe defaults.
- Risk: recipe complexity creep.
  - Mitigation: small bounded action set in v1 and strict schema validation.
