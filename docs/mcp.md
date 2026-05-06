# MCP tool server

The optional Model Context Protocol (MCP) server exposes Open Second Brain's
deterministic operations as tools that Hermes Agent (or any other MCP client)
can route through its tool registry.

The server is **optional**: the `o2b` CLI remains the supported baseline. Nothing
in Open Second Brain depends on the MCP server being running.

## Protocol

- Transport: stdio (JSON-RPC 2.0, newline-delimited).
- Protocol version: `2025-06-18`.
- Capabilities advertised: `tools` only. No `resources`, `prompts`, or
  `sampling`.
- Standard MCP lifecycle: `initialize`, `notifications/initialized`,
  `tools/list`, `tools/call`, optional `ping`.

## Tools

| Tool | Purpose | Required arguments |
| --- | --- | --- |
| `second_brain_status` | Report config and vault status, with secrets redacted. | — |
| `second_brain_query` | List vault pages with an optional case-insensitive title substring. | — |
| `second_brain_capture` | Write a Markdown note under `AI Wiki/notes/` with frontmatter. | `title`, `content` |
| `event_log_append` | Append a single-line event to the daily Markdown event log. | `message` |
| `vault_health` | Run vault, config, and plugin manifest health checks. | — |

`second_brain_query` accepts `pattern` (string) and `limit` (1–500, default 50).
`second_brain_capture` also accepts `tags` (array of strings) and `overwrite`
(boolean). `event_log_append` accepts `agent`, `date` (YYYY.MM.DD), and `time`
(HH:MM). `vault_health` accepts `repo` (string) for plugin manifest validation.

All tool results contain both an unstructured `content` text block (a JSON
serialization of the structured payload) and a `structuredContent` object so
clients that prefer typed results can use it directly.

## Run from the CLI

```bash
scripts/o2b mcp --vault /path/to/vault
```

Optional flags:

- `--config PATH` — override the Open Second Brain config file location.
- `--repo PATH` — repository root used for plugin manifest checks.

The server logs its banner to `stderr` and only writes JSON-RPC frames to
`stdout`, so it is safe to use as a subprocess in any MCP client.

## Hermes integration

Hermes discovers MCP servers from `~/.hermes/config.yaml` under the
`mcp_servers` key. After installing this plugin, register the MCP server on
the same machine that hosts the vault:

```yaml
mcp_servers:
  open-second-brain:
    command: o2b
    args: ["mcp", "--vault", "/path/to/vault"]
    enabled: true
    timeout: 30
    tools:
      include:
        - second_brain_status
        - second_brain_query
        - second_brain_capture
        - event_log_append
        - vault_health
```

If you run Open Second Brain from a checkout instead of an installed package,
point `command` at the absolute path of `scripts/o2b`:

```yaml
mcp_servers:
  open-second-brain:
    command: /srv/projects/open-second-brain/scripts/o2b
    args: ["mcp", "--vault", "/path/to/vault"]
```

After editing the file, run `/reload-mcp` inside Hermes to pick up the new
server.

The Hermes plugin manifest (`plugin.yaml`) advertises this MCP entrypoint via
the `mcp_server` field so future Hermes releases can auto-register the server,
but the official Hermes config flow is the source of truth today.

## Claude Code and Codex

The Claude Code plugin manifest exposes `o2b mcp` as a regular command that
Claude Code can invoke. Codex installs the same `scripts/o2b` script through
its plugin manifest, so the MCP entrypoint is reachable from a Codex shell as
well. There is no auto-registration into Codex's MCP discovery — add the
server to your Codex MCP config the same way as Hermes.

## Safety notes

- The vault path is bound to the server instance at startup. Tools cannot
  escape it.
- `second_brain_capture` writes only under `<vault>/AI Wiki/notes/` and rejects
  collisions unless `overwrite: true` is supplied.
- `second_brain_status` reuses the same redaction logic as `o2b export-config`.
- `event_log_append` appends below the `## Raw events` section using the same
  locking strategy as the CLI.
