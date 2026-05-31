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

## Tool Highlights

The full server currently advertises 58 tools. The table below highlights the
operator-facing core, schema, agent-source, health, recovery, and Pay Memory
tools; the full surface also includes Brain writer, review, query, temporal,
link-graph, and search tools. In Claude Code, that full schema can push MCP definitions beyond
10% of the context window, causing `MCPSearch` tool-search deferral; use the
writer split below for the always-loaded writer subset, or the runtime
capability flags for a narrower per-process full server.

| Tool                        | Purpose                                                                                                                                        | Required arguments               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `second_brain_capabilities` | Report the tools available to this MCP process and the withheld-tool reasons after runtime capability filtering.                               | —                                |
| `second_brain_status`       | Report config and vault status, with secrets redacted.                                                                                         | —                                |
| `second_brain_query`        | List vault pages with an optional case-insensitive title substring.                                                                            | —                                |
| `vault_health`              | Run vault, config, and plugin manifest health checks.                                                                                          | —                                |
| `brain_health`              | Run semantic Brain Health checks and return the health verdict/domains.                                                                        | —                                |
| `brain_mcp_landscape`       | List the MCP servers configured across the vault: name, source config file, packages, and required env-var names. Env values never read.       | —                                |
| `brain_agent_query`         | Read-only source-agent retrieval over Brain provenance. Filters by agents, topic, free-text query, contribution kind, and limit.               | —                                |
| `brain_agent_diff`          | Read-only comparison between source agents using browse/search/diff/map modes over the same provenance foundation.                             | —                                |
| `brain_audit`               | Read-only per-preference mutation trail (create / promote / update / retire / merge) with agent, reason, revision + content-hash before/after. | `pref_id`                        |
| `brain_morning_brief`       | Read-only session-start summary: top confirmed preferences, recent reconcile open questions, recent notes; character-budgeted.                 | —                                |
| `brain_search`              | Read-only vault search with optional structured query lanes, explicit focus hints, and evidence-pack diagnostics.                              | `query`                          |
| `brain_recall_gate`         | Read-only classifier for whether an automatic recall attempt should run; returns `retrieve` plus a stable reason.                              | `prompt`                         |
| `brain_context_pack`        | Budgeted context slice; pass `lanes: true` to return directives, constraints, and consider lanes. Filtered items include `safety.reasons`.     | `max_tokens`                     |
| `brain_sources`             | Read-only dashboard of signals grouped by (agent, source_type) with active/processed and distinct-topic counts.                                | —                                |
| `get_active_schema_pack`    | Return the active runtime schema pack resolved from `Brain/_brain.yaml`.                                                                       | —                                |
| `list_schema_packs`         | List schema packs available to the vault/runtime.                                                                                              | —                                |
| `schema_stats`              | Summarise declared schema tokens and observed artifact usage.                                                                                  | —                                |
| `schema_lint`               | Report unknown, unused, and invalid schema references without writing.                                                                         | —                                |
| `schema_graph`              | Return a schema relationship graph for declared types, aliases, prefixes, and link types.                                                      | —                                |
| `schema_explain_type`       | Explain one schema token, including aliases, references, and usage.                                                                            | `token`                          |
| `schema_review_orphans`     | Review declared schema tokens that have no observed usage.                                                                                     | —                                |
| `schema_apply_mutations`    | Apply audited, locked schema mutations to `Brain/_brain.yaml`.                                                                                 | `mutations`                      |
| `reload_schema_pack`        | Reload and validate the active schema pack after local edits.                                                                                  | —                                |
| `brain_watchdog`            | Probe Brain config, required dirs, and search-index health; optionally apply safe directory remediation.                                       | —                                |
| `brain_switch_vault`        | Activate a named vault profile; the change takes effect on the next server launch.                                                             | `name`                           |
| `payment_memory_init`       | Bootstrap `Brain/payments/{policies,assets,drafts,reports}/ (+ dated YYYY-MM-DD receipt subdirs)` and write the spending policy template.      | —                                |
| `payment_receipt_append`    | Save a Markdown receipt for one paid API call. `raw_output` is redacted before persisting.                                                     | `service`, `status`, `reason`    |
| `asset_capture`             | Save a Markdown note for an asset produced by a paid call, linked to its receipt.                                                              | `title`, `service`, `result_url` |
| `payment_report_generate`   | Aggregate a date's receipts into a Markdown report under `Brain/payments/reports/`.                                                            | `date`                           |
| `payment_policy_check`      | Evaluate a prospective paid call against `policies/spending.json` (allowed / approval_required / denied).                                      | `service`                        |
| `payment_request_approval`  | Create a pending-payment-request the user must approve before the agent runs `pay`.                                                            | `service`, `reason`              |
| `payment_request_status`    | Look up a pending request by id; agent uses this to poll for approval.                                                                         | `id`                             |
| `payment_request_consume`   | Mark an `approved` request as `consumed` and link the resulting receipt.                                                                       | `id`, `receipt`                  |

`second_brain_query` accepts `pattern` (string) and `limit` (1–500, default 50).
`vault_health` accepts `repo` (string) for plugin manifest validation.
`brain_agent_query` accepts `agents` (string array), `topic`, `query`, `kind`
(`signal`, `preference`, `log`), and `limit` (1-500, default 50).
`brain_agent_diff` accepts the same filters plus `mode` (`browse`, `search`,
`diff`, `map`). Omitting `agents` means all known source agents.
`brain_search` accepts `query_document` with line-oriented `intent:`, `lex:`,
`vec:`, and `hyde:` lanes; `focus_query` / `focus_path_prefix` to steer a
single call; and `evidence_pack: true` to return significant/matched/missing
terms, abstention text, terminal-state downrank reasons, and per-result
`why_retrieved`. `brain_recall_gate` accepts optional `previous_prompt` and
`explicit`; `explicit: true` always returns `retrieve: true`.

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
- `--scope full|writer` — choose the full server or the always-loaded writer subset.
- `--writer-only` — alias for `--scope writer`.
- `--probe` — start an in-process handshake and print whether the server can advertise tools, then exit.
- `--json` — with `--probe`, print a machine-readable capability report.
- `--allow-tool NAME` — expose only named tools from the static scope. Repeatable.
- `--disable-tool NAME` — withhold named tools from the static scope. Repeatable.
- `--max-tools N` — expose only the first N non-diagnostic tools from the static scope.

The server logs its banner to `stderr` and only writes JSON-RPC frames to
`stdout`, so it is safe to use as a subprocess in any MCP client.

## Runtime capability window

Runtime capability flags are evaluated after the static scope. They can narrow
the tool list a process advertises, but they cannot widen `--scope writer` into
full-server tools. The full server always keeps `second_brain_capabilities`
available so clients and operators can inspect which tools were available or
withheld and why.

Examples:

```bash
o2b mcp --vault /path/to/vault --probe --json --disable-tool second_brain_query
o2b mcp --vault /path/to/vault --allow-tool brain_context --allow-tool brain_feedback
o2b mcp --vault /path/to/vault --max-tools 12
```

`second_brain_capabilities` returns `scope`, `server_name`, static and available
tool counts, an `available[]` list, and a `withheld[]` list. Withheld reasons
are stable strings such as `disabled by runtime capability window`, `not allowed
by runtime capability window`, and `outside runtime capability max tool window`.

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

- `open-second-brain` - the full surface (58 tools, including `brain_health`, `brain_mcp_landscape`, `brain_agent_query`, `brain_agent_diff`, `brain_recall_gate`, `brain_pinned_context`, `brain_pre_compress_pack`, `brain_audit`, `brain_morning_brief`, `brain_sources`, and `brain_switch_vault`); subject to Claude Code's `MCPSearch` tool-search deferral when MCP definitions push the system prompt past 10% of the context window.
- `open-second-brain-writer` - a minimal always-loaded surface of five tools: `brain_feedback`, `brain_apply_evidence`, `brain_note`, `brain_pinned_context` (writers) and `brain_context` (read-only pull-bootstrap of `Brain/active.md` plus pinned context, v0.16.0). The agent records taste signals, evidence events, milestone notes, and current-task pinned facts - and fetches the active rule digest at session start in runtimes without a SessionStart hook - without a ToolSearch round-trip on every session boot.

Both servers reuse the same backing CLI (`o2b mcp --scope writer` vs the default `--scope full`). Handlers are byte-identical; the writer-mode instructions text explicitly tells the agent to prefer the writer copy over any duplicate the full server still exposes (both call the same code path).

## Safety notes

- The vault path is bound to the server instance at startup. Tools cannot
  escape it.
- `second_brain_status` reuses the same redaction logic as `o2b export-config`.
- Brain writers (`brain_feedback`, `brain_apply_evidence`, `brain_note`,
  `brain_pinned_context`)
  go through atomic-rename writes so an interrupted call leaves either
  the prior or the new file, never a torn hybrid.
- MCP tools can declare lightweight output contracts; declared contracts are
  validated against `structuredContent` before the text mirror is emitted.
