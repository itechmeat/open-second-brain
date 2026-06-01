# Procedural Attention Suite - implementation plan

## Tasks

### Task 1: Projection contract and paths

- **Files**: src/core/brain/paths.ts, src/core/brain/procedural-graph.ts
- **Acceptance**: projection read/write/rebuild primitives exist with deterministic ordering and schema version.
- **Depends on**: none

### Task 2: Procedural graph/entity linking

- **Files**: src/core/brain/procedural-memory.ts, src/core/brain/skill-proposals.ts, src/core/brain/procedural-graph.ts
- **Acceptance**: reconcile emits graph nodes/edges/entities; entity links appear in projection.
- **Depends on**: Task 1

### Task 3: Graph export and introspection surfaces

- **Files**: src/cli/brain/verbs/procedural-graph.ts, src/cli/brain/verbs/index.ts, src/cli/brain/help-text.ts, src/mcp/brain-tools.ts
- **Acceptance**: CLI/MCP expose list/show/export/rebuild operations for procedural graph.
- **Depends on**: Task 2

### Task 4: Prospective recall hints at write time

- **Files**: src/core/brain/procedural-hints.ts, src/core/brain/procedural-memory.ts, src/core/brain/skill-proposals.ts, src/mcp/brain-tools.ts
- **Acceptance**: derived hints are generated deterministically on writes/reconcile and queryable.
- **Depends on**: Task 2

### Task 5: Scoped ingest context and filtered write mode

- **Files**: src/core/brain/sessions/import.ts, src/core/brain/context-pack.ts, src/mcp/brain-tools.ts, CLI import surfaces
- **Acceptance**: ingest path accepts scoped filters/hints and reports applied filters; default behavior unchanged.
- **Depends on**: Task 1

### Task 6: Declarative attention flows

- **Files**: src/core/brain/attention-flows.ts, src/core/brain/context-pack.ts, src/cli/brain/verbs/attention-flows.ts, src/mcp/brain-tools.ts
- **Acceptance**: YAML recipes validate and execute bounded actions for open loops/learnings; outputs consumable by context-pack.
- **Depends on**: Task 1, Task 2

### Task 7: Test suite and compatibility hardening

- **Files**: tests/core/brain/_, tests/cli/_, tests/mcp/\*
- **Acceptance**: new core/CLI/MCP tests pass; existing procedural-learning tests remain green.
- **Depends on**: Tasks 2-6

### Task 8: Release/docs/version

- **Files**: README.md, CHANGELOG.md, package.json + synced version files
- **Acceptance**: docs updated, changelog entry added, version bumped and sync check passes.
- **Depends on**: Task 7
