# Context summary

## Repository

- Language/runtime: TypeScript on Bun.
- Version at start: `0.22.0`.
- Current branch at start: `main`, synced to `origin/main`.
- Feature branch: `feat/agent-capability-cli-integration`.

## Relevant surfaces

- `src/mcp/tools.ts` owns `ToolDefinition`, `ServerContext`, static `ToolScope`, and `buildToolTable(scope)`.
- `src/mcp/server.ts` builds a fixed tool list at construction and serves it through `tools/list` and `tools/call`.
- `src/cli/argparse.ts` owns the dependency-free parser and rejects unknown flags per-command.
- `src/cli/main.ts` dispatches root commands and contains existing `mcp --probe`, `tool-call`, and static help.
- `src/cli/brain/helpers.ts` provides the parse facade used by brain verbs.
- `src/cli/output.ts` already has `okJson`, `writeJson`, and `failWith`, but no uniform JSON envelope or redactor.

## Constraints

- MCP is optional; CLI remains supported baseline.
- Default behavior should stay unchanged unless a user opts into a new flag or runtime constraint.
- No new CLI framework dependency.
- Runtime capability filtering must not silently hide tools without a diagnostic path.
