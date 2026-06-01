You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Implement a single cohesive release scope that fully completes these kanban tasks together:

- t_ee819f4b
- t_02e22d4e
- t_2fe5cffa
- t_25d4dbfb
- t_5d63937b
- t_f935fe84

Operator constraints:

- Full completion for the selected tasks, not partial delivery.
- Keep architecture provider-ready so a next PR can adapt OpenSecondBrain as a Hermes-compatible memory provider without rework.
- Follow SOLID, KISS, DRY.
- Implementation by TDD with atomic commits.
- Run formatter and linter before each commit.
- Self-review must compare all changes to main.
- Version must be bumped before push.

Task intent summary:

- Extend procedural memory from flat index to graph/entity-linked memory with export/introspection surfaces.
- Add prospective recall hints generated at write time.
- Add scoped ingest context and filtered write mode.
- Add declarative attention flow recipes for open loops and learnings that can feed context surfaces.
- Preserve deterministic/local-first behavior and auditability.

# Project context

open-second-brain; TypeScript + Bun; Obsidian-native markdown brain with CLI+MCP surfaces.

Recent commits:

- 1f3a218 Feat/self learning skill proposals (#57)
- 0162d13 feat(brain): add context continuity and receipts suite (#56)
- 3b7b3a5 feat(brain): add safety governance foundations (#55)
- 794ee45 feat(search): ship recall control and trust surfaces (#54)

Related files:

- src/core/brain/skill-proposals.ts
- src/core/brain/procedural-memory.ts
- src/core/brain/recurrence.ts
- src/core/brain/context-pack.ts
- src/core/search/search.ts
- src/mcp/brain-tools.ts
- src/cli/brain/verbs/\*
- tests/core/brain/\*
- tests/mcp/\*

Conventions:

- Deterministic, local-first core behavior is preferred.
- CLI and MCP both need first-class surfaces for new capabilities.
- Tests are required for core/CLI/MCP paths.
- Changelog versioned releases are maintained in CHANGELOG.md.
- Bun toolchain (fmt/lint/test/typecheck) is standard.

Constraints:

- Do not break existing public CLI/MCP APIs unless additive and backwards-compatible.
- Keep feature scope cohesive around procedural memory + attention/recall readiness.
- Avoid introducing unnecessary external dependencies.
- Keep migration paths explicit and auditable.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>

- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N

**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
