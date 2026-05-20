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

- Confirm the upstream `sst/opencode` MCP config path against the
  current docs before adopting on a new release. The adapter
  defaults to `~/.config/opencode/mcp.json` but reads
  `XDG_CONFIG_HOME` when set.
