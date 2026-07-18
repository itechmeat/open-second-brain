# MCP tool server

The optional Model Context Protocol (MCP) server exposes Open Second Brain's
deterministic operations as tools that Hermes Agent (or any other MCP client)
can route through its tool registry.

The server is **optional**: the `o2b` CLI remains the supported baseline. Nothing
in Open Second Brain depends on the MCP server being running.

## Protocol

- Transport: stdio (JSON-RPC 2.0, newline-delimited) by default; optional
  Streamable HTTP on the same JSON-RPC core with per-request API-key auth.
- Protocol version: `2025-06-18`.
- Capabilities advertised: `tools` and `resources` (see "Resources"
  below). No `prompts` or `sampling`.
- Standard MCP lifecycle: `initialize`, `notifications/initialized`,
  `tools/list`, `tools/call`, optional `ping`.

## Tool Highlights

The full server currently advertises 79 tools; the 18 deprecated predecessor
names were removed in 1.0.0 and now answer a precise INVALID_PARAMS tombstone
(see "Consolidated views and deprecated aliases" below). The table highlights
the operator-facing core,
schema, agent-source, health, and recovery tools; the full surface
also includes Brain writer, review, query, temporal, link-graph, and search
tools. In Claude Code, the full schema can push MCP definitions beyond 10% of
the context window, causing `MCPSearch` tool-search deferral; use the writer
split below for the always-loaded writer subset, or the runtime capability
flags for a narrower per-process full server.

| Tool                        | Purpose                                                                                                                                        | Required arguments                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `second_brain_capabilities` | Report the tools available to this MCP process and the withheld-tool reasons after runtime capability filtering.                               | —                                              |
| `second_brain_status`       | Report config and vault status, with secrets redacted.                                                                                         | —                                              |
| `second_brain_query`        | List vault pages with an optional case-insensitive title substring.                                                                            | —                                              |
| `vault_health`              | Run vault, config, and plugin manifest health checks.                                                                                          | —                                              |
| `brain_health`              | Run semantic Brain Health checks and return the health verdict/domains.                                                                        | —                                              |
| `brain_mcp_landscape`       | List the MCP servers configured across the vault: name, source config file, packages, and required env-var names. Env values never read.       | —                                              |
| `brain_codegraph_report`    | Read-only codegraph partner report: in-scope code project, index state (`no_project`/`absent`/`not_indexed`/`indexed` with counts/`error`), and structural `Cargo.toml` workspace members. When indexed, attaches a non-blocking `index.health` graph-health gate (`empty-graph`, `collapsed-edges`, `dangling-references`, `self-loops`, `cache-root-mismatch`) surfaced before labeling/import/recall trust the graph. Never installs, extracts, or mutates; non-Rust projects report `cargo_workspace: null` with a reason. | —                                              |
| `brain_agent_query`         | Read-only source-agent retrieval over Brain provenance. Filters by agents, topic, free-text query, contribution kind, and limit.               | —                                              |
| `brain_agent_diff`          | Read-only comparison between source agents using browse/search/diff/map modes over the same provenance foundation.                             | —                                              |
| `brain_audit`               | Read-only per-preference mutation trail (create / promote / update / retire / merge) with agent, reason, revision + content-hash before/after. | `pref_id`                                      |
| `brain_brief`               | Read-only Brain summary for any window: `view: morning \| daily \| weekly \| monthly \| operator \| digest`.                                   | `view`                                         |
| `brain_analytics`           | Read-only Brain analytics for any lens: `view: timeline \| attention_flows \| belief_evolution \| concept_synthesis`.                          | `view`                                         |
| `brain_search`              | Read-only vault search with optional structured query lanes, explicit focus hints, time ranges, evidence-pack diagnostics, and a selectable recall `profile` (`fast \| balanced \| thorough`). | `query`                                        |
| `brain_recall_feedback`     | Record explicit up/down recall feedback for one search result; feeds the deterministic learned-weight fold.                                     | `query`, `result_path`, `verdict`              |
| `brain_recall_gate`         | Read-only classifier for whether an automatic recall attempt should run; returns `retrieve` plus a stable reason. When the caller passes `scores`, also attaches an adequacy verdict (`sufficient` \| `weak` \| `insufficient`), a recommended action (`proceed` \| `re_recall` \| `abstain`), and an optional `escalate` flag over the gate-telemetry relevance scores plus the epistemic mix; thresholds via `recall_adequacy_sufficient` / `recall_adequacy_weak` / `recall_adequacy_min_results`.                              | `prompt`                                       |
| `brain_context_pack`        | Budgeted context slice; pass `lanes: true` to return directives, constraints, and consider lanes. Filtered items include `safety.reasons`. Each item carries a structural `epistemic` status (`observed` \| `derived` \| `hypothesis` \| `plan` \| `unknown`) plus `evidence_refs` derived from existing graph metadata; fields are absent when the status is `unknown`.     | `max_tokens`                                   |
| `brain_context_receipts`    | List or show opt-in prompt context receipt continuity records with budgets, hashes, source refs, safety/redaction metadata, and item IDs.      | `operation`                                    |
| `brain_recall_telemetry`    | List or summarise opt-in recall telemetry records for search, context-pack, and pre-compress calls.                                            | `operation`                                    |
| `brain_route_metrics`       | List or summarise opt-in route-level MCP tool latency (`mcp_route_latency` records); `summary` rolls each tool up into count, error count, and min/avg/max + p50/p95/p99 latency, slowest-first. Emitted only when `mcp_route_metrics_enabled` is on; payload-safe (tool, scope, status, duration, arg key names). Read-only. | `operation`                                    |
| `brain_token_impact`        | Durable value-of-memory ledger: `record` posts a context pack's tokenizer-exact prompt-token delta (`baseline` − `packed`, `method` exact/fallback) plus an optional modeled inference-avoidance estimate; `outcome` posts first-pass/repair/retry to calibrate the model; `summary` keeps EXACT prompt-token savings strictly separate from the MODELED (outcome-calibrated) figure; `list` reads raw samples. Writes gated on `token_impact_ledger_enabled` (default off); payload-safe (counts + opaque pack id only). Reads ignore the gate. | `operation`                                    |
| `brain_context_pack_outcome`| Agent-operable outcome loop over the context-pack quality ledger: `post` records one compact outcome row for a carried context-pack quality-sample id — first-pass/repair/retry counters plus three STRICTLY SEPARATE token signals (`exact_prompt_token_savings`, `modeled_inference_avoidance`, `observed_provider_tokens`) — and composes the token-impact ledger by posting a matching first-pass/repair/retry calibration outcome; `list`/`summary` read the rows keeping the signals separate. Writes gated on `context_pack_outcome_enabled` (default off); payload-safe (counters + opaque sample id only), a field the caller omits is never invented. Reads ignore the gate. | `operation`                                    |
| `brain_knowledge_gaps`      | Aggregate the persisted cross-query demand log into recurring queries the vault answers poorly, ranked by frequency × (1 − IDF-weighted coverage). Read-only; the log is written only by opt-in recall telemetry.                              | —                                              |
| `brain_generation_reports`  | Inbound, opt-in LLM generation tracing: `record` posts a generation's usage for a handoff (gated, default off; stores prompt hash + token counts only); `list`/`summary` read records and join them to memory paths. Kernel never calls an LLM. | `action`                                       |
| `brain_obligation`          | Recurring obligations under `Brain/obligations/` with a deterministic cadence-driven next-due date: `add`, `done` (advances next_due by one cadence interval), `list` (optionally overdue-only), `show`, `remove`. Cadences: daily/weekly/biweekly/monthly/quarterly/yearly/every-<N>-days. | `operation`                                    |
| `brain_agenda`              | Stateless agenda synthesis over caller-provided calendar events (the host fetches them; the Brain never calls a calendar API): overlap conflicts, free focus blocks (optionally clipped to a workday window), and events organised outside the operator's own email domain(s). No vault writes. | `events`                                       |
| `brain_context_presets`     | Show, suggest, or diff read-only context budget presets (`tight-context`, `long-context`) without writing config.                              | `operation`                                    |
| `brain_pre_compact_extract` | Extract decision/commitment/outcome/rule/open-question records from bounded text into continuity storage.                                      | `session_id`, `turn_start`, `turn_end`, `text` |
| `brain_hygiene`             | Memory hygiene: `scan` findings (conflicts, dedup, freshness, usefulness), `apply` selected ids, `refresh` stale pages. Resolver command comes from `_brain.yaml` only. | `mode`                                         |
| `brain_anticipatory_context` | Turn-specific context bundle kept warm by lifecycle hooks, keyed by the session's lineage root; reports `cache_state` warm / stale / miss.   | `session_id`                                   |
| `brain_session_grep`        | Search imported session recall raw turns and deterministic summary nodes.                                                                      | `query`                                        |
| `brain_session_describe`    | Describe raw-turn counts and summary depths for one imported session recall DAG.                                                               | `session_id`                                   |
| `brain_session_expand`      | Expand a raw or summary session recall node to immediate sources and paginated raw turn content.                                               | `id`                                           |
| `brain_sources`             | Read-only dashboard of signals grouped by (agent, source_type) with active/processed and distinct-topic counts.                                | —                                              |
| `brain_create_note`         | Write an actual vault note file (path + frontmatter + content) atomically inside the vault. Distinct from `brain_note` (log append); refuses traversal, the Brain root, excluded paths, and clobbering. | `path`                                         |
| `brain_file_context`        | Given a file path, surface prior vault work that mentions it (decisions, bug notes, refactor history) by querying the index with path-derived terms. Size gate skips trivial files. Read-only; no LLM. | `file_path`                                    |
| `brain_session_summary`     | Session-scoped structured digest over request/decisions/learnings/next_steps: `write` stores agent-extracted categories, `get` returns a session's latest digest, `list` returns all. Append-only, deduped; an all-empty digest is rejected. | `operation`                                    |
| `brain_idea_lineage`        | Read-only provenance tracer: reconstruct how a derived artifact was reached as an observation -> synthesis -> conclusion graph. A `ctn_` id walks the sourceRefs graph; a `pref-`/`ret-` id adapts belief-evolution. Cycle-guarded, depth-bounded; unknown id errors. | `id`                                           |
| `brain_note_history`        | Decompose a note's git history into recallable episodic phases split on a deterministic commit-time gap (default 72h, language-agnostic). Each phase carries subjects/dates/authors. Missing repo → `available: false`; no commits → zero phases. Read-only. | `path`                                         |
| `schema_inspect`            | Read-only schema inspection for any view: `view: graph \| lint \| stats \| orphans \| explain_type \| active_pack \| packs`.                   | `view` (`token` for `explain_type`)            |
| `schema_apply_mutations`    | Apply audited, locked schema mutations to `Brain/_brain.yaml`.                                                                                 | `mutations`                                    |
| `brain_watchdog`            | Probe Brain config, required dirs, and search-index health; optionally apply safe directory remediation.                                       | —                                              |
| `brain_switch_vault`        | Activate a named vault profile; the change takes effect on the next server launch.                                                             | `name`                                         |

### Consolidated views and deprecated aliases

`brain_brief`, `brain_analytics`, and `schema_inspect` replaced three
overlapping tool families in v0.34.0; per-view output is identical to the
predecessor tools because dispatch goes to the same handlers. The 18
predecessor names were removed in 1.0.0: calling one answers a precise
INVALID_PARAMS tombstone naming the replacement tool and `view` (for
example `brain_digest was removed in 1.0.0; call brain_brief with
view="digest"`), so a stale client learns the migration from the error
itself. Per-view parameters keep their old names (for example
`brain_brief` with `view: "daily"` accepts the same `date` argument
`brain_daily_brief` did, and `brain_analytics` with
`view: "attention_flows"` defaults `operation` to `list`). The full
alias-to-replacement table lives in `docs/updating.md`.

`second_brain_query` accepts `pattern` (string) and `limit` (1–500, default 50).
`vault_health` accepts `repo` (string) for plugin manifest validation.
`brain_agent_query` accepts `agents` (string array), `topic`, `query`, `kind`
(`signal`, `preference`, `log`), and `limit` (1-500, default 50).
`brain_agent_diff` accepts the same filters plus `mode` (`browse`, `search`,
`diff`, `map`). Omitting `agents` means all known source agents.
`brain_search` accepts `query_document` with line-oriented `intent:`, `lex:`,
`vec:`, and `hyde:` lanes; `focus_query` / `focus_path_prefix` to steer a
single call; `since` / `until` time ranges (ISO date/datetime, `today`,
`yesterday`, `last week`, `last month`, or `<n>h`/`<n>d`/`<n>w` shorthand,
filtered on document mtime); `include_superseded: true` to keep superseded
predecessors undemoted (history mode); and `evidence_pack: true` to return
significant/matched/missing terms, abstention text, terminal-state downrank
reasons, per-result `why_retrieved`, IDF-weighted coverage with rare-term
classification, per-token `union_records` for uncovered terms, and a
`completeness` verdict whose `uncovered_but_present_in_corpus` list is the
false-absence guard. It can also emit opt-in recall telemetry with
`telemetry: true`. `brain_recall_feedback` records one feedback event as a
JSON file under `Brain/search/feedback/` and returns the refreshed learned
weights (applied to ranking only when `search_learned_weights_enabled` is on).
`brain_context_pack` accepts opt-in `receipt`, `telemetry`, `cache_stable`, and
`dedup_repeated` diagnostics; `brain_pre_compress_pack` accepts opt-in `receipt`
and `telemetry`. `brain_context_receipts` supports `operation: "list"|"show"`;
`brain_recall_telemetry` supports `operation: "list"|"summary"|"cost"` (`cost`
folds write volume - feedback/apply-evidence/note plus host-bridge writes -
against reads into a write-vs-read ratio, a `write_heavy` flag, and a rough
weighted cost signal per period; tune with `write_cost`/`read_cost`/`write_heavy_ratio`);
`brain_context_presets` supports `operation: "show"|"suggest"|"diff"`; and
`brain_generation_reports` supports `action: "record"|"list"|"summary"` -
`record` is gated (default off) by a per-call `enable` flag or the
`generation_trace_enabled` config and persists only `prompt_hash` plus token
counts, never the prompt.
`brain_pre_compact_extract` writes idempotent typed continuity records after
deterministic media/base64 sanitization. `brain_session_grep`,
`brain_session_describe`, and `brain_session_expand` inspect the opt-in session
recall DAG populated by CLI `import-session --recall` or the core API.
`brain_session_summary` accepts `operation: "write"|"get"|"list"` (write takes
`session_id` plus any of `request`, `decisions`, `learnings`, `next_steps`,
`source_turn_ids`, `host`). `brain_idea_lineage` accepts `id` and optional
`max_depth`. `brain_note_history` accepts `path` and optional `gap_hours` /
`max_count`.
`brain_recall_gate` accepts optional `previous_prompt` and
`explicit`; `explicit: true` always returns `retrieve: true`.

> **Date format note.** Brain tools use ISO 8601 `YYYY-MM-DD`
> throughout; the `Brain/log/<date>.md` subdirectory layout shares that
> convention.

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
- `osb://lessons` — body of `Brain/lessons.md`, the auto-generated,
  signed and recency-scored lessons corpus that unifies preferences and
  dead-ends into corroboration-tiered lessons (`preferred` / `tentative`
  / `contested` / `avoid`). Auto-regenerated on first read if the file
  does not exist yet. The SessionStart / PostCompact hook injects it
  alongside `active.md`.
- `osb://digest/latest` — same body as `brain_brief` `view="digest"`
  in its default (24h) Markdown window.
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
  current preference (or retired), the most recent log entries, and a
  deterministic **Strongest objection** steelman against the current
  preference (a retired/quarantined rule, a recorded negative
  counter-signal, or an unconfirmed-trial caveat) for the topic.
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
scripts/o2b-mcp --vault /path/to/vault
```

`o2b-mcp` is a console-script alias for `o2b mcp`; it injects the `mcp`
subcommand and forwards every flag verbatim.

Optional flags:

- `--config PATH` — override the Open Second Brain config file location.
- `--repo PATH` — repository root used for plugin manifest checks.
- `--scope full|writer` — choose the full server or the always-loaded writer subset.
- `--writer-only` — alias for `--scope writer`.
- `--probe` — start an in-process handshake and print whether the server can advertise tools, then exit.
- `--transport stdio|http` — choose stdio (default) or Streamable HTTP.
- `--host HOST` — HTTP bind host (default `127.0.0.1`).
- `--port PORT` — HTTP bind port (default `0`, choose an available port).
- `--api-key KEY` — required for `--transport http`; accepted as `Authorization: Bearer KEY` or `X-API-Key: KEY` on every request.
- `--json` — with `--probe`, print a machine-readable capability report.
- `--allow-tool NAME` — expose only named tools from the static scope. Repeatable.
- `--disable-tool NAME` — withhold named tools from the static scope. Repeatable.
- `--max-tools N` — expose only the first N non-diagnostic tools from the static scope.

The stdio server logs its banner to `stderr` and only writes JSON-RPC frames to
`stdout`, so it is safe to use as a subprocess in any MCP client. HTTP refuses
to start without `--api-key`, checks the key on every request using a generic
constant-time comparison, and returns the same `401 Unauthorized` body for a
missing or wrong key. JSON responses are the default; clients that send
`Accept: text/event-stream` receive a single SSE `message` event for the same
JSON-RPC response.

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

## Tool-surface profiles and the two-pass catalog (since v0.37.0)

Named profiles bundle a scope plus capability window so hosts stop
hand-rolling allow/deny flag lists:

```bash
o2b mcp --vault /path/to/vault --tool-profile catalog
o2b mcp --vault /path/to/vault --tool-profile recall --probe
```

Profiles: `full` (default), `writer`, `catalog`, `recall` (memory
read/write surface, no admin tools), and `minimal` (writers + context +
search). The `mcp_tool_profile` config key (env:
`OPEN_SECOND_BRAIN_MCP_TOOL_PROFILE`) selects one without flags; an
explicit `--scope` or window flag wins over the profile's fields. An
unknown profile name FAILS OPEN to the full surface with a stderr note -
a typo can never lock an agent out. Hard-window profiles always retain
`second_brain_capabilities`, so withheld tools stay discoverable with
reasons.

The `catalog` scope is the two-pass surface: `tools/list` advertises
only the capability diagnostic, the five always-loaded Brain tools, and
`tool_hydrate`; every other tool stays callable through `tools/call`.
Call `tool_hydrate` with no arguments for the compact catalog (name,
one-line description, group), then with `names: [...]` for the full
input/output schemas of exactly the tools you need - unknown names are
reported per-name without failing the batch.

## Skill surface (since v0.37.0)

`list_skills` returns the agent skills shipped in the plugin's
`skills/` directory plus vault-local `Brain/skills/` (vault entries
shadow shipped ones by name). `get_skill` fetches a skill's SKILL.md by
name; an optional `file_path` reads an auxiliary file and is
path-traversal-guarded to the skill directory. `skills_attach` scores
skills against the current turn text with a deterministic BM25-style
scorer and returns a char-budgeted block of top matches; it returns
`enabled: false` with an empty block unless the `skill_auto_attach`
config key is `"true"`, so default per-turn injection is unchanged. The
native Hermes provider calls it from `prefetch()` fail-soft.

Two optional config keys (each with a matching environment variable)
tune the surface; both are off/unset by default, so behaviour is
unchanged unless an operator opts in:

- `skills_dir` (`OPEN_SECOND_BRAIN_SKILLS_DIR`) overrides the skill
  discovery root, replacing vault-local `Brain/skills/` with an arbitrary
  path (e.g. an external `~/.hermes/skills/`) without symlinks. `~` is
  expanded; a relative value is anchored to the directory of the resolved
  config file so the root is the same regardless of the process working
  directory. The shipped `skills/` root is still scanned.
- `skills_attach_triggers` (`OPEN_SECOND_BRAIN_SKILLS_ATTACH_TRIGGERS`),
  when `"true"` or `"1"`, folds each skill's `triggers` frontmatter field
  into the scorer as a 2x BM25 tag signal (alongside name at 3x and
  description at 1x). When unset, `triggers` is ignored and scoring stays
  name + description only. The `triggers` field accepts a scalar string
  (`triggers: "research lookup"`) or an inline array
  (`triggers: [research, lookup]`); the scorer also emits overlapping
  bigrams for runs of Han characters, so a spaceless CJK query can match a
  trigger keyword.

## Workspace Insight Suite tools (since v0.38.0)

`brain_search` accepts `global: true` for cross-vault union search:
one query fans out over the active vault, registered profile vaults,
and read-only recall sources (managed by `o2b brain source`), merging
results by score. Each result carries an additive `origin` field plus
an `origin:<label>` reason (`local`, `profile/<name>`,
`source/<alias>`). Non-active origins search with self-healing and the
query cache disabled, so an external vault is never written to; a
missing index degrades to a per-origin warning.

`brain_trigger` is the consolidated trigger-queue tool: `scan`
generates deduped triggers from semantic-health and retention data,
`list` / `history` read by effective lifecycle status,
`acknowledge` / `dismiss` / `act` transition one trigger. Cooldown keys
keep the same issue from reappearing while an earlier trigger is open
or cooling down; `brain_brief` `view="morning"` surfaces capped pending
triggers and marks them delivered (once per `trigger_cooldown_days`).

`brain_deep_synthesis` assembles a deterministic topic dossier
(matched notes, agreements, contradictions, stale claims, knowledge
gaps; `triggers: true` enqueues findings). It also returns a
`strongest_objection` — the single best-formed counter-finding
(`basis`: contradiction → superseded → stale → knowledge_gap →
thin_evidence) framed as a steelman seed against the dossier's implicit
conclusion, or `null` for a larger internally-consistent body.
`brain_idea_discovery`
ranks next-direction candidates from open questions, orphan notes, and
aging inbox signals.

`brain_recall_gate` emits a `gate_telemetry` continuity record per
decision when the `recall_gate_telemetry` config key is `"true"`
(default off) - decision, stable reason, host, SHA-256 prompt prefix;
never the raw prompt. `brain_recall_telemetry` gains `gate_list` /
`gate_summary` operations.

The MCP server emits one `mcp_route_latency` continuity record per tool
call when the `mcp_route_metrics_enabled` config key
(`OPEN_SECOND_BRAIN_MCP_ROUTE_METRICS_ENABLED`) is `"true"` (default
off): tool name, scope, status (`ok`/`error`), duration, and the sorted
set of argument KEY NAMES only - never argument values. The emit is
gated and fail-open, so it can never fail or slow-fail the call it
measures beyond one synchronous continuity append. `brain_route_metrics`
reads them back (`operation: "list"|"summary"`).

The full observability contract behind these tools - event kinds,
always-on vs opt-in status, correlation IDs, payload safety, and the
continuity schema version - lives in `docs/observability.md`.

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
        # Drop any line below to disable a specific tool, or remove the
        # whole `tools.include` block to expose every advertised tool.
        - second_brain_status
        - second_brain_query
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

- `open-second-brain` - the full surface: 49 advertised tools (including the consolidated `brain_brief`, `brain_analytics`, and `schema_inspect`, plus `brain_health`, `brain_mcp_landscape`, `brain_agent_query`, `brain_agent_diff`, `brain_recall_gate`, `brain_pinned_context`, `brain_memory_bridge`, `brain_pre_compress_pack`, `brain_audit`, `brain_sources`, and `brain_switch_vault`) and 18 hidden deprecated aliases listed under "Consolidated views and deprecated aliases" above; subject to Claude Code's `MCPSearch` tool-search deferral when MCP definitions push the system prompt past 10% of the context window.
- `open-second-brain-writer` - a minimal always-loaded surface of five tools: `brain_feedback`, `brain_apply_evidence`, `brain_note`, `brain_pinned_context` (writers) and `brain_context` (read-only pull-bootstrap of `Brain/active.md` plus pinned context, v0.16.0). The agent records taste signals, evidence events, milestone notes, and current-task pinned facts - and fetches the active rule digest at session start in runtimes without a SessionStart hook - without a ToolSearch round-trip on every session boot.

Both servers reuse the same backing CLI (`o2b mcp --scope writer` vs the default `--scope full`). Handlers are byte-identical; the writer-mode instructions text explicitly tells the agent to prefer the writer copy over any duplicate the full server still exposes (both call the same code path).

`brain_feedback`'s `scope` argument stays optional. When the vault declares `feedback.default_scope` in `Brain/_brain.yaml`, a call that omits `scope` records the signal under that default category; an explicit `scope` always wins, and with no default configured a scope-less call stays scope-less. The same effective scope is reused for a `force_confirmed: true` preference so the preference and its signal share one scope. The configured value is validated against the same constraints as any signal `scope` (non-empty after trim, single-line, at most 128 characters).

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
- Since v1.32.0 the `vault_path` fields returned by the core tools carry a
  stable opaque store reference (`vault://<hash>`) instead of the absolute
  host path, because tool responses land in model context. Set
  `expose_host_paths: true` (or `OPEN_SECOND_BRAIN_EXPOSE_HOST_PATHS=true`)
  to restore the raw path.
- Since v1.32.0 `brain_feedback` responses include a conflict advisory when
  the incoming principle closely resembles a confirmed same-scope preference
  (the write still proceeds); the advisory names the preference id and the
  similarity evidence.
