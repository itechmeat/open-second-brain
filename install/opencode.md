# opencode

`o2b install --target opencode --apply` writes the two OSB MCP
servers into `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/mcp.json`
via JSON-merge. User-authored entries in `mcpServers` are preserved.

## Install

```bash
o2b install --target opencode --apply
```

Restart `opencode` to load the new servers.

## Verify

```bash
o2b install --check --target opencode
```

## Uninstall

```bash
o2b uninstall --target opencode --apply
```

## Notes

- Upstream is `anomalyco/opencode` (formerly hosted under
  `sst/opencode`). Confirm the MCP config path against the current
  upstream docs before adopting on a new release — the project has
  moved its config layout between releases. The adapter defaults to
  `~/.config/opencode/mcp.json` and reads `XDG_CONFIG_HOME` when
  set; if upstream renames the file (e.g. to `opencode.json`),
  the JSON-merge adapter pattern keeps working — only the
  resolver function in `src/core/install/adapters/opencode.ts`
  needs an update.
