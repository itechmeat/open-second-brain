# ZCode

[ZCode](https://github.com/zai-org/ZCode) reads MCP servers from its own
config file. There is no `o2b install --target zcode` yet, so the two
Open Second Brain servers are added by hand. Verified with the ZCode CLI
0.16.9 on Linux.

## 1. Prerequisites

- `o2b` on `PATH` and a vault initialized with `o2b init` - see
  [`prerequisites.md`](prerequisites.md#get-the-o2b-cli).

## 2. Add the MCP servers

Print the server entries for your vault:

```bash
o2b install --target generic --apply --out - --vault /path/to/vault
```

The printout is keyed `mcpServers`. ZCode expects the same entries under
`mcp.servers` in one of these files:

| Scope | File |
|---|---|
| User | `~/.zcode/cli/config.json` |
| One project | `<project>/.zcode/config.json` |

Merge the entries into the existing file; keep its other keys:

```json
{
  "mcp": {
    "servers": {
      "open-second-brain": {
        "command": "o2b",
        "args": ["mcp", "--vault", "/path/to/vault"]
      },
      "open-second-brain-writer": {
        "command": "o2b",
        "args": ["mcp", "--writer-only", "--vault", "/path/to/vault"]
      }
    }
  }
}
```

The `env` block from the printout (`VAULT_AGENT_NAME`, `VAULT_TIMEZONE`)
can be kept as is. If ZCode cannot find `o2b`, set `command` to the
absolute launcher path (for example `/home/<user>/.local/bin/o2b`). Start a
new ZCode session to load the servers.

## 3. Verify

In the ZCode TUI, `/mcp list` shows both servers. The CLI can also run
one prompt headless (`-p`) that calls a tool:

```bash
zcode -p "Call second_brain_status on the open-second-brain MCP server and report the vault path" --mode plan
```

The answer names the vault from step 2. ZCode exposes the tools as
`mcp__open-second-brain__<tool>` and `mcp__open-second-brain-writer__<tool>`.

## Plugin marketplace

ZCode can also install this repository as a plugin from its marketplace.
With ZCode 0.16.9 on Linux the bundled MCP servers do not start: the
plugin cache copy of `scripts/o2b` loses its executable bit and the spawn
fails with `EACCES`. On Linux, use the config above instead.

## Uninstall

Remove the two entries from `mcp.servers`. The vault is not touched.
