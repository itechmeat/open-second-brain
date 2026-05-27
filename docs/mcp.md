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
| `vault_health` | Run vault, config, and plugin manifest health checks. | — |
| `payment_memory_init` | Bootstrap `Brain/payments/{policies,assets,drafts,reports}/ (+ dated YYYY-MM-DD receipt subdirs)` and write the spending policy template. | — |
| `payment_receipt_append` | Save a Markdown receipt for one paid API call. `raw_output` is redacted before persisting. | `service`, `status`, `reason` |
| `asset_capture` | Save a Markdown note for an asset produced by a paid call, linked to its receipt. | `title`, `service`, `result_url` |
| `payment_report_generate` | Aggregate a date's receipts into a Markdown report under `Brain/payments/reports/`. | `date` |
| `payment_policy_check` | Evaluate a prospective paid call against `policies/spending.json` (allowed / approval_required / denied). | `service` |
| `payment_request_approval` | Create a pending-payment-request the user must approve before the agent runs `pay`. | `service`, `reason` |
| `payment_request_status` | Look up a pending request by id; agent uses this to poll for approval. | `id` |
| `payment_request_consume` | Mark an `approved` request as `consumed` and link the resulting receipt. | `id`, `receipt` |

`second_brain_query` accepts `pattern` (string) and `limit` (1–500, default 50).
`vault_health` accepts `repo` (string) for plugin manifest validation.

`payment_memory_init` accepts `agent` (string) and `overwrite` (boolean — to
refresh the policy template). `payment_receipt_append` accepts the same
optional fields as the CLI: `agent`, `category`, `endpoint`, `expected_cost`,
`actual_amount`, `currency`, `payment_proof`, `result_ref`, `result_note`,
`raw_output`, `slug`, `date` (`YYYY-MM-DD`), `time` (`HH:MM`), `overwrite`.
`asset_capture` accepts `source_receipt`, `prompt`, `used_in`, `slug`,
`overwrite`. `payment_report_generate` accepts `title`, `task`, `slug`,
`overwrite`.

> **Date format note.** Brain and Pay Memory tools use ISO 8601
> `YYYY-MM-DD` throughout; the `Brain/log/<date>.md` and
> `Brain/payments/<date>/` subdirectory layouts share that convention.

`payment_policy_check` accepts `expected_amount` (number or numeric
string), `currency`, `category`, and `date`. `payment_request_approval`
mirrors `payment_receipt_append` for the descriptive fields plus
`expected_output`, `vault_files` (array of strings), and `enforce_policy`
(boolean — refuses to create the request when the policy denies the call
outright). `payment_request_status` returns the named request's `status`
plus a curated subset of frontmatter fields (`service`, `reason`,
`expected_amount`, `currency`, `created`, `approved_by`, `approved_at`,
`rejected_by`, `rejected_at`, `rejection_reason`, `receipt`,
`policy_status`, `policy_rule`) — agents poll this to see whether their
request has moved from `pending` to `approved`. Fields that were not
captured at request time (e.g. `vault_files`, `endpoint`) are not
re-derived; read the underlying Markdown file via the path returned in
the response if you need them.

The Pay Memory tools never execute payments themselves — the agent makes the
paid call through its own `pay` CLI and passes the resulting metadata into
these tools, which only persist it as Markdown.

All tool results contain both an unstructured `content` text block (a JSON
serialization of the structured payload) and a `structuredContent` object so
clients that prefer typed results can use it directly.

## Resources

The server also exposes a `resources` capability for hosts that prefer
pull-style access (no tool call, no arguments). Three concrete URIs
come back from `resources/list`:

- `osb://preferences/active` — body of `Brain/active.md`, the auto-
  generated digest of confirmed + quarantined preferences plus the
  last three retired entries. Auto-regenerated on first read if the
  file does not exist yet.
- `osb://digest/latest` — same body as the `brain_digest` tool's
  default (24h) Markdown window.
- `osb://status` — Brain operational snapshot: counts (inbox /
  preferences by status / retired / log_days / snapshots), last
  `dream` and `apply-evidence` timestamps, and a sanity flag for
  signals awaiting `dream`. Same data the `second_brain_status`
  tool returns under its `brain` field, rendered as markdown.

Four templated URIs come back from `resources/templates/list`:

- `osb://preference/{id}` — body of `pref-{id}.md`, with fallback to
  `ret-{id}.md` when the active copy is gone. Accepts the bare slug
  (`my-rule`) or the prefixed form (`pref-my-rule` / `ret-my-rule`).
- `osb://topic/{slug}` — synthesised markdown of every signal, the
  current preference (or retired), and the most recent log entries
  for the topic.
- `osb://log/{date}` — body of `Brain/log/<date>.md` (date is
  `YYYY-MM-DD`).
- `osb://backlinks/{id}` — inbound references to the given Brain
  artifact id, rendered as a count plus a list grouped by source
  kind. Same data as the `brain_backlinks` tool.

`resources/read` accepts both shapes uniformly and returns
`text/markdown` content. Malformed slug/date arguments produce
`INVALID_PARAMS`; missing files produce a tool-level error envelope
with a `not found` message — same shape as `brain_query`'s
`BrainNotFoundError`.

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
the same machine that hosts the vault.

The Hermes CLI accepts the registration directly:

```bash
hermes mcp add open-second-brain --command o2b --args mcp --vault /path/to/vault
```

`--args` is a single flag; everything after it on the line (here
`mcp --vault /path/to/vault`) is collected as the argument list and forwarded
to the MCP server's command line. Do not wrap all of those arguments into one
quoted shell string and do not repeat `--args` per token — both forms make
Hermes pass a single concatenated argument to the MCP server.

You can also edit `~/.hermes/config.yaml` by hand:

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
        - vault_health
        # Pay Memory tools (v0.8.0+); drop any line below to disable a
        # specific tool, or remove the whole `tools.include` block to
        # expose every advertised tool.
        - payment_memory_init
        - payment_receipt_append
        - asset_capture
        - payment_report_generate
        - payment_policy_check
        - payment_request_approval
        - payment_request_status
        - payment_request_consume
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

## Updating the MCP registration

Updating the plugin via `hermes plugins update open-second-brain` does not
rewrite `~/.hermes/config.yaml`. Your existing `mcp_servers.open-second-brain`
entry keeps working as long as the `command` and `args` you originally
registered still resolve.

After an update:

- Restart the gateway so the MCP subprocess is reloaded:

  ```bash
  hermes gateway restart
  ```

- If the new release adds a flag, re-add the registration with the updated
  `--args` list (or edit the YAML by hand):

  ```bash
  hermes mcp remove open-second-brain
  hermes mcp add open-second-brain --command o2b --args mcp --vault /path/to/vault
  ```

`scripts/o2b mcp --vault /path/to/vault` from the checkout can be used to
sanity-check the server before re-registering it.

## Removing the MCP registration

To remove just the MCP server without uninstalling the plugin, run:

```bash
hermes mcp remove open-second-brain
hermes gateway restart
```

`hermes mcp remove` deletes the registration entry. Open Second Brain runs
over stdio (JSON-RPC 2.0) and does not use OAuth, so there are no tokens for
this server specifically; the OAuth-token cleanup `hermes mcp remove` performs
only matters for transports that authenticate that way. The installed plugin
and its CLI commands stay in place, so `hermes plugins update` will continue
to track new releases.

To remove both the MCP server and the plugin itself, follow the
`Uninstalling` section in the project README. Open Second Brain never edits
`~/.hermes/config.yaml` on your behalf, and `o2b uninstall` is a read-only
helper that prints the exact Hermes commands to run.

## Claude Code and Codex

The Claude Code plugin manifest exposes `o2b mcp` as a regular command that
Claude Code can invoke. Codex installs the same `scripts/o2b` script through
its plugin manifest, so the MCP entrypoint is reachable from a Codex shell as
well. There is no auto-registration into Codex's MCP discovery — add the
server to your Codex MCP config the same way as Hermes.

## Writer split (Claude Code 2.1.121+)

The plugin's `.mcp.json` ships **two** MCP-server entries:

- `open-second-brain` - the full surface (33 tools, including `brain_health` since v0.14.0); subject to Claude Code's `MCPSearch` tool-search deferral when MCP definitions push the system prompt past 10% of the context window.
- `open-second-brain-writer` - a minimal always-loaded surface of four tools: `brain_feedback`, `brain_apply_evidence`, `brain_note` (writers) and `brain_context` (read-only pull-bootstrap of `Brain/active.md`, v0.10.10). The agent records taste signals, evidence events, and milestone notes - and fetches the active rule digest at session start in runtimes without a SessionStart hook - without a ToolSearch round-trip on every session boot.

Both servers reuse the same backing CLI (`o2b mcp --scope writer` vs the default `--scope full`). Handlers are byte-identical; the writer-mode instructions text explicitly tells the agent to prefer the writer copy over any duplicate the full server still exposes (both call the same code path).

## Safety notes

- The vault path is bound to the server instance at startup. Tools cannot
  escape it.
- `second_brain_status` reuses the same redaction logic as `o2b export-config`.
- Brain writers (`brain_feedback`, `brain_apply_evidence`, `brain_note`)
  go through atomic-rename writes so an interrupted call leaves either
  the prior or the new file, never a torn hybrid.
