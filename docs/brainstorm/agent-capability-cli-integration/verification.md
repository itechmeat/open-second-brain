# Verification plan

Focused checks during implementation:

- `bun test tests/mcp/runtime-capabilities.test.ts`
- `bun test tests/cli/cli-json-contract.test.ts`
- `bun test tests/cli/completions.test.ts`

QA checks before pre-push gate:

- `bun run typecheck`
- `bun run lint`
- `bun run test`
- `bun run sync-version:check`
- `code_checker`
