# Cursor

`o2b install --target cursor --apply` writes the OSB MCP servers
into `~/.cursor/mcp.json` via JSON-merge. The two registered names
are `open-second-brain` (full tool set) and `open-second-brain-writer`
(always-loaded writer / `brain_context` subset).

## Prerequisites

See `install/prerequisites.md`. Then run `o2b init --vault <path>
--agent-name <name> --timezone <tz>` to persist identity that the
MCP servers will pick up at spawn time.

## Install

```bash
o2b install --target cursor --apply
```

This preserves any pre-existing `mcpServers.*` keys; only
`mcpServers.open-second-brain` and `mcpServers.open-second-brain-writer`
are owned by OSB.

After install, **restart the Cursor app** for the new MCP servers
to load. `o2b install --check --target cursor` confirms the file
state regardless of whether Cursor has reloaded yet.

## Uninstall

```bash
o2b uninstall --target cursor --apply
```

Removes exactly the two OSB keys from `mcpServers` (the sidecar
manifest at `<vault>/.open-second-brain/install.lock.json` records
which keys to remove). User-authored entries stay intact.

## Notes

- `--scope project` (writing into `<cwd>/.cursor/mcp.json`) is
  deferred to a follow-up release. v0.10.11 always targets the
  user-scope path.
- If a previous OSB version wrote to `.cursor/mcp.json` without
  recording a manifest entry, use
  `o2b uninstall --target cursor --apply --force-from-snippet`
  for a one-time cleanup.
