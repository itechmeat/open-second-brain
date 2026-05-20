# kiro

`o2b install --target kiro --apply` writes the two OSB MCP servers
into `~/.kiro/settings.json` via JSON-merge. User-authored entries
are preserved.

## Install

```bash
o2b install --target kiro --apply
```

Restart kiro to load the new servers.

## Verify

```bash
o2b install --check --target kiro
```

## Uninstall

```bash
o2b uninstall --target kiro --apply
```

## Notes

- Confirm the upstream kiro MCP config path against the project's
  current docs before adopting on a new release.
