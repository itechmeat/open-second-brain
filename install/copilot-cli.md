# GitHub Copilot CLI

`o2b install --target copilot-cli --apply` registers the two OSB
MCP servers with the GitHub Copilot CLI. The primary path calls
`copilot mcp add` per server name; if the CLI is missing or its
`add` step fails, the adapter falls back to writing
`${XDG_CONFIG_HOME:-$HOME/.config}/github-copilot/mcp.json`
directly and prints a stderr note.

## Install

```bash
o2b install --target copilot-cli --apply
```

The adapter records which mode it used (`subprocess` or
`json-merge` fallback) in the sidecar manifest so `uninstall`
mirrors the same path.

## Verify

```bash
o2b install --check --target copilot-cli
```

Verify queries `copilot mcp list` when the CLI is available, or
inspects the fallback file otherwise.

## Uninstall

```bash
o2b uninstall --target copilot-cli --apply
```

## Notes

- Upstream reference:
  `docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers`.
- The exact `copilot mcp add` flag names are pinned to the CLI
  version current at v0.10.11 implementation time. If a Copilot CLI
  release renames flags, expect the adapter to fall back to the
  file-merge path automatically — `o2b install --check` will
  surface the change.
