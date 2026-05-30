# Agent capability + CLI integration - implementation plan

## Tasks

### Task 1: Runtime MCP capability report

- **Files**: `src/mcp/capabilities.ts`, `src/mcp/tools.ts`, `src/mcp/server.ts`, `src/cli/main.ts`, `tests/mcp/runtime-capabilities.test.ts`
- **Acceptance**: focused MCP tests show static scope is still enforced, runtime deny/allow constraints withhold tools deterministically, `second_brain_capabilities` reports reasons, and `o2b mcp --probe --json` emits the same report shape.
- **Depends on**: none

### Task 2: Inherited CLI JSON contract

- **Files**: `src/cli/argparse.ts`, `src/cli/json-helpers.ts`, `src/cli/main.ts`, `src/cli/brain/helpers.ts`, `tests/cli/cli-json-contract.test.ts`
- **Acceptance**: focused CLI tests show a command without bespoke JSON accepts `--json` and returns a fallback envelope, an existing semantic JSON command keeps its legacy JSON shape, and secret-shaped values are redacted in fallback output.
- **Depends on**: none

### Task 3: Manifest-backed CLI discovery and completions

- **Files**: `src/cli/command-manifest.ts`, `src/cli/completions.ts`, `src/cli/main.ts`, `docs/cli-reference.md`, `tests/cli/completions.test.ts`
- **Acceptance**: focused CLI tests show `o2b help --json` lists root/nested commands and flags from the manifest, and `o2b completions bash|zsh|fish|elvish|nushell|powershell` emits non-empty scripts containing the `o2b` command tree.
- **Depends on**: Task 2

### Task 4: Documentation, version, and release prep

- **Files**: `README.md`, `docs/mcp.md`, `docs/cli-reference.md`, `CHANGELOG.md`, `package.json`, synced version files if required by `sync-version`
- **Acceptance**: docs describe the capability diagnostic, inherited JSON fallback, completions, and the version bump requested before push; `bun run sync-version:check` passes.
- **Depends on**: Tasks 1-3
