# ADR: Agent capability + CLI integration foundation

## Status

Accepted for implementation in this feature branch.

## Context

The board comments for `t_4acb2c72` note that runtime tool capability verification needs an ADR before implementation because Open Second Brain currently has only static MCP `ToolScope` filtering. The same PR also includes two CLI integration tasks: inherited `--json` output and shell completions.

## Decision

Add two separate foundations:

- MCP runtime capabilities remain a small layer above static `ToolScope`. They can withhold tools only after static scope has already selected the candidate set, and every withheld tool must appear in a diagnostic report with a reason.
- CLI discovery/completions use a CLI-only command manifest. This manifest does not own command dispatch; it owns machine-readable metadata for help JSON, fallback JSON, and shell completion generation.

## Consequences

- Static writer scope remains the access-control baseline.
- Agents can ask why a tool is unavailable instead of inferring from a missing tool list.
- CLI completions and discovery share metadata without a new CLI framework dependency.
- The project keeps two intentionally small registries rather than one large cross-surface registry.
