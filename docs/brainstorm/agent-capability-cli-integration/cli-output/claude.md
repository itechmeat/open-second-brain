### Variant 1: Independent additive layers

- **Approach**: Implement each of the three tasks in its own seam with no shared abstraction. The runtime capability check becomes a thin predicate wrapper around `buildToolTable` in `server.ts`; the `--json` work adds an inheritable `FlagSpec` plus a new `src/cli/json-helpers.ts`; completions ship as a generator that walks each command's existing `FlagsSchema`. Nothing is unified - three small, independently revertible additions.
- **Trade-offs**:
  - Pro: smallest blast radius; each piece is independently testable and revertible.
  - Pro: respects the "small, dependency-free CLI grammar" convention with minimal disruption.
  - Pro: capability layer stays additive on top of static scope, easy to keep transparent.
  - Con: three sources of truth - the completion generator must re-walk command schemas and can drift from real flags unless carefully wired (tension with the anti-drift constraint).
  - Con: no synergy; the `--json` discovery contract and completions duplicate command-metadata traversal.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Single declarative manifest spine

- **Approach**: Introduce one declarative registry describing both MCP tools (scope plus runtime capability predicates) and CLI commands (flags, including an inherited `--json`). The runtime capability filter, the shell-completion generator, and the JSON-envelope contract all derive from this single manifest, so `help --json`, `completions`, and tool exposure share one source of truth.
- **Trade-offs**:
  - Pro: anti-drift by construction - completions and help cannot diverge from declared flags (directly satisfies the registry/manifest constraint).
  - Pro: agent-discoverable surface (`help --json` enumerates every command/flag) and a coherent capability model across CLI and MCP.
  - Con: large refactor touching `argparse`, every CLI verb, `tools.ts`, and `server.ts`; high chance of brushing against public-API backward-compat constraints.
  - Con: over-engineers two priority-1 ergonomic tasks by coupling them to the design-heavy capability system that the board says needs an ADR first.
  - Con: a single registry change has wide blast radius and harder review.
- **Complexity**: large
- **Risk**: high

### Variant 3: Phased - shared CLI registry now, ADR-gated capability layer

- **Approach**: Ship the two priority-1 ergonomic tasks together this PR behind a shared _CLI command manifest_ (used both by the inheritable `--json` flag + `json-helpers.ts` and by the completion generator, so they cannot drift), scoped to the CLI only. Land the runtime capability verification as a separate, transparent layer that wraps static `ToolScope` with a capability predicate plus a probe/diagnostic path, designed ADR-first and kept minimal in this scope.
- **Trade-offs**:
  - Pro: matches the actual priorities (1/1/3) and the board's "needs an ADR before build" note for the capability system.
  - Pro: one shared CLI manifest covers `--json` and completions without dragging MCP into the refactor, satisfying the anti-drift constraint where it matters.
  - Pro: capability filtering stays additive on top of static scope with an explicit probe (satisfies "no silent hiding of tools").
  - Con: two registries (CLI command manifest + MCP capability predicates) rather than one unified spine.
  - Con: the capability piece may land partially or as a thin first cut, deferring full dynamism.
- **Complexity**: medium
- **Risk**: low

### Recommended: Variant 3

**Rationale**: It honors the triage reality - two ergonomic priority-1 tasks that are cheap and a priority-3 capability system the board explicitly says needs an ADR before build - instead of forcing them into one coupled abstraction as Variant 2 does. The shared CLI manifest captures the real synergy (completions + `--json` from one source of truth, satisfying the anti-drift constraint) that Variant 1 misses, while keeping the capability layer additive, transparent via a probe path, and on top of static scope as the constraints require. This sequencing keeps the core deterministic and dependency-light while letting the design-heavy piece mature behind an ADR rather than blocking the easy wins.
