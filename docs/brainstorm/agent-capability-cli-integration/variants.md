# Agent capability + CLI integration - variants

## Consultant output

See `cli-output/claude.md` for the primary consultant output.

## Parsed variants

### Variant 1: Independent additive layers

Implement the capability filter, inherited `--json`, and shell completions as three independent additions.

- **Complexity**: medium
- **Risk**: low
- **Trade-off**: low blast radius, but completions and JSON discovery can drift because they duplicate command metadata.

### Variant 2: Single declarative manifest spine

Introduce one registry that drives MCP tool capability predicates, CLI flags, help JSON, and completions.

- **Complexity**: large
- **Risk**: high
- **Trade-off**: best anti-drift property, but too much refactor and too much coupling for this scope.

### Variant 3: Phased - shared CLI registry now, ADR-gated capability layer

Use a CLI-only manifest for JSON discovery and completions, then add a separate transparent MCP capability filter layered on top of static scope.

- **Complexity**: medium
- **Risk**: low
- **Trade-off**: two registries instead of one, but each owns a smaller and clearer boundary.

## Orchestrator decision

Chosen: **Variant 3**.

The CLI tasks have a real shared abstraction: command/flag metadata. A manifest lets `help --json`, fallback JSON handling, and shell completions use the same source of truth without forcing the MCP tool registry through a broad refactor. The runtime capability check stays separate, additive, and transparent: it filters after static `ToolScope` and exposes a report through the MCP surface and probe path so tools are never hidden without a way to inspect why.
