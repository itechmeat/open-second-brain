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

### Argument contract (since v1.46.0)

Every advertised tool declares `additionalProperties: false`, and since
v1.46.0 the server enforces it. A `tools/call` carrying an argument the
tool does not declare is refused with `-32602` (invalid params) naming
every undeclared argument, with a did-you-mean where a declared name is
close enough by edit distance:

```
brain_search: unknown argument 'quiery' (did you mean 'query'?). This
tool's inputSchema declares the <n> argument names it accepts.
```

An argument with no near match is told so rather than pointed at an
unrelated parameter: `unknown argument 'wombat' (no close match)`.

The error carries structured `data` for machine callers: `tool`,
`unknown_arguments` (each `{name, suggestion?}`) and `declared_arguments`.
Before this, a mistyped argument was ignored and the call returned a
normal success envelope computed from defaults.

The gate is top-level only. Nested object properties that declare their
own `additionalProperties: false` are not enforced; an unknown key inside
`usage` or inside an `operations` entry still reaches the handler.

Every advertised parameter also carries a description, enforced in CI by
the schema-completeness audit in `src/mcp/registry-guard.ts`. Output
schemas are out of scope for that audit - their vocabulary declares
union-typed fields with no `type` on purpose, and responses are validated
against them at request time instead.

### Progress notifications

A client asks for liveness on a long call by putting a token on the
request, `params._meta.progressToken`. Per the specification the token is
a string or an integer; anything else — a boolean, `null`, an object, a
fractional number — is refused with `-32602` naming what arrived, rather
than coerced into a value the client could not match back to its request.
A request with no `_meta`, or a `_meta` carrying other members but no
`progressToken`, asks for nothing and is answered exactly as before.

**What each transport does with the token:**

| Transport | With a token | With no token |
|---|---|---|
| stdio | Emits `notifications/progress` frames as the operation runs, all of them ahead of the response frame | No notification frames at all |
| HTTP | Answers the call normally and carries a typed refusal on `result._meta` | No `_meta` on the result |

stdio owns a duplex newline-delimited stream, so it can write a frame
nobody asked for. Each frame carries the spec's own `progressToken`,
`progress` and (when the operation knows a denominator) `total`, so a
client that knows nothing about Open Second Brain still renders a bar.
The typed event travels beside them under
`params._meta["open-second-brain/progress"]`: `schema`, `operation`,
`kind`, `stage`, `completed`, optional `total` and `reason`. `stage` is
an identifier from the emitting operation's own vocabulary, never a
sentence — the sentence is rendered at the edge.

The HTTP transport answers one request with one response and closes it
(see "Run from the CLI" below), so it cannot carry a notification at all.
Accepting the token and silently dropping the events would advertise
liveness support that does not exist, so the response carries a refusal
instead:

```json
{
  "result": {
    "content": [ ... ],
    "structuredContent": { ... },
    "isError": false,
    "_meta": {
      "open-second-brain/progress": {
        "schema": "o2b.progress.v1",
        "kind": "refused",
        "reason": "transport-single-response",
        "progressToken": "tok-42"
      }
    }
  }
}
```

It rides on `_meta` — MCP's reserved place for implementation metadata,
and the reciprocal of where the request carried the token — because the
two alternatives corrupt a payload a caller parses: `structuredContent`
is validated against the tool's `outputSchema`, and `content[0].text` is
that same payload rendered. The refusal is visible to a client that asked
for progress and entirely absent for one that did not.

**Which tools report.** The MCP surface that can genuinely run for
minutes is `brain_dream`, `brain_bridges`, `brain_clusters` and
`brain_maintenance`. Index management verbs (`index`, `reindex`,
`check`) are deliberately not exposed over MCP, so they are not on this
list. `brain_maintenance` is a dispatcher over the other four
operations and forwards the sink to each task, so its events name the
task that emitted them (`dream`, `reindex`, `bridges`, `clusters`) rather
than the lane. Two more reach a consolidation pass without carrying its
name and report on the same terms: `brain_brief` with `view: "operator"`,
whose operator summary runs a dry-run pass, and
`brain_review_candidates`, whose projection is that same dry run
reshaped. A single-step `brain_dream` call reports too, under the stage
that names the step rather than the five stages of a full pass — the
step owns the stream, because on that path it IS the run.

**Which tools are bounded.** Every call that reaches one of those long
operations runs under a cooperative deadline resolved from
`safeguard_timeout_<operation>_seconds`, then `safeguard_timeout_seconds`,
then the built-in default. Bounded and observed are now the same
population with no exception: the `step` row below was the one that read
**none**, because the two step functions took no guard and dropped the
sink, and a single step over a large tree therefore held the server for
its whole duration with nothing to show for it. Both halves are wired.
That sentence is not left to prose — `tests/mcp/long-running-tools.test.ts`
reads the rows out of this table, fails on any row whose deadline or
`reports` cell reads `none`, and fails on a row naming a tool it does not
itself drive through both halves. The `**none**` row went stale for a
release because nothing checked it; its replacement is checked.

| tool | long operation it reaches | deadline | reports |
| --- | --- | --- | --- |
| `brain_dream` (`run`) | `dream`, twice when `expect`/`strict` asks for a guard preview | `dream` — one budget for the whole call, preview included | yes |
| `brain_dream` (`stage`/`validate`/`apply`) | `dream`, through the staged bundle | `dream` | yes |
| `brain_dream` (`step`) | one step (`scan` or `heal-enrich`), not a pass | `dream` — a step is part of a dream pass, so it draws on that budget. Checked per file and per directory in `scan`, and per page in each of `heal-enrich`'s two loops, plus around the two phases that cross no boundary of their own — the vault listing (checkpoint after it only) and the one-shot title/alias phrase build (before and after). So it stops within one page **plus** whichever of those two is running, not within one page flat | yes, under the step's own stage (`scan` / `heal-enrich`) |
| `brain_bridges` (`discover`) | `bridges` | `bridges` | yes |
| `brain_clusters` (`run`) | `clusters` | `clusters` | yes |
| `brain_maintenance` (`run`) | all four, sequentially | one fresh guard per task; a tripped task is a `timed_out` row, not an aborted call | yes, in its tasks' voices |
| `brain_brief` (`view: "operator"`) | `dream`, dry run | `dream` | yes |
| `brain_review_candidates` | `dream`, dry run | `dream` | yes |

The deadline is cooperative, not preemptive: `dream()` and the graph
sweeps are synchronous, so nothing can interrupt them from outside — past
the deadline the operation's next checkpoint throws, at a boundary where
writes are already atomic. Setting `safeguard_timeout_dream_seconds: 0`
disables the deadline for every row above whose budget is `dream`.

Cooperative also means the guarantee is "stops at the next boundary", and
a phase that crosses no boundary is therefore not interruptible however
long the budget has been gone. Two such phases exist and both are in
`heal-enrich`. They are NOT bracketed alike, and the difference is worth
stating rather than rounding to "both sides":

- the **vault listing**, which walks every page and parses its frontmatter
  in one call, is the first thing the step does. Its only checkpoint is the
  one immediately AFTER it — there is nothing before it to check — so a
  budget that has already elapsed still pays for the listing once.
- the **phrase build**, which sorts and regex-escapes the whole title/alias
  set in one, is bracketed on both sides: the checkpoint immediately before
  it means an elapsed budget refuses to pay for it, and the first page of
  the rewrite loop honours it again on the far side.

Either way a call that has already entered one of them runs it to the end.
`src/core/brain/heal-run.ts` names the same two and the same asymmetry.

## Tool Highlights

The full server currently advertises 110 tools; the 18 deprecated predecessor
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
| `vault_health`              | Run vault, config, and plugin manifest health checks. Since v1.50.0 the response also carries `state_surfaces`: the same inventory `o2b state status` renders (every declared in-vault state surface with its resolved path, tier, reachability verdict and the configuration layer that placed it), as a sibling FIELD rather than a contribution to `ok` — an absent surface is normal on a young vault and an unchecked one carries its own reason. An unreadable machine config resolves to no overrides here rather than failing the report; the `checks` array already names that fault. | —                                              |
| `brain_health`              | Run semantic Brain Health checks and return the health verdict/domains.                                                                        | —                                              |
| `brain_mcp_landscape`       | List the MCP servers configured across the vault: name, source config file, packages, and required env-var names. Env values never read.       | —                                              |
| `brain_codegraph_report`    | Read-only codegraph partner report: in-scope code project, index state (`no_project`/`absent`/`not_indexed`/`indexed` with counts/`error`), and structural `Cargo.toml` workspace members. When indexed, attaches a non-blocking `index.health` graph-health gate (`empty-graph`, `collapsed-edges`, `dangling-references`, `self-loops`, `cache-root-mismatch`) surfaced before labeling/import/recall trust the graph. Never installs, extracts, or mutates; non-Rust projects report `cargo_workspace: null` with a reason. | —                                              |
| `brain_agent_query`         | Read-only source-agent retrieval over Brain provenance. Filters by agents, topic, free-text query, contribution kind, and limit.               | —                                              |
| `brain_agent_diff`          | Read-only comparison between source agents using browse/search/diff/map modes over the same provenance foundation.                             | —                                              |
| `brain_audit`               | Read-only per-preference mutation trail (create / promote / update / retire / merge) with agent, reason, revision + content-hash before/after. | `pref_id`                                      |
| `brain_brief`               | Read-only Brain summary for any window: `view: morning \| daily \| weekly \| monthly \| operator \| digest`.                                   | `view`                                         |
| `brain_analytics`           | Read-only Brain analytics for any lens: `view: timeline \| attention_flows \| belief_evolution \| concept_synthesis \| dedup`. `view=dedup` summarises the persisted exact-hash ingest dedup records into a trend plus a per-source re-ingest ranking; every count is an exact sha-256 drop, never a semantic figure (the semantic detectors nominate merge candidates and never drop). | `view`                                         |
| `brain_search`              | Read-only vault search with optional structured query lanes, explicit focus hints, time ranges, evidence-pack diagnostics, and a selectable recall `profile` (`fast \| balanced \| thorough`). | `query`                                        |
| `brain_recall_feedback`     | Record explicit up/down recall feedback for one search result; feeds the deterministic learned-weight fold.                                     | `query`, `result_path`, `verdict`              |
| `brain_recall_gate`         | Read-only classifier for whether an automatic recall attempt should run; returns `retrieve` plus a stable reason. When the caller passes `scores` AND `match_quality` (the `idf_weighted_coverage` a search outcome reports - the two stand or fall together, and an incomplete pair is refused), also attaches an adequacy verdict (`sufficient` \| `weak` \| `insufficient`), a recommended action (`proceed` \| `re_recall` \| `abstain`), and an optional `escalate` flag. The LEVEL is decided by `match_quality` alone; the scores decide only the usable-result count. Thresholds via `recall_adequacy_sufficient` / `recall_adequacy_weak` / `recall_adequacy_min_results`.                              | `prompt`                                       |
| `brain_context_pack`        | Budgeted context slice; pass `lanes: true` to return directives, constraints, and consider lanes. Filtered items include `safety.reasons`. Each item carries a structural `epistemic` status (`observed` \| `derived` \| `hypothesis` \| `plan` \| `unknown`) plus `evidence_refs` derived from existing graph metadata; fields are absent when the status is `unknown`.     | `max_tokens`                                   |
| `brain_context_receipts`    | List or show opt-in prompt context receipt continuity records with budgets, hashes, source refs, safety/redaction metadata, and item IDs.      | `operation`                                    |
| `brain_recall_telemetry`    | List or summarise opt-in recall telemetry records for search, context-pack, and pre-compress calls.                                            | `operation`                                    |
| `brain_route_metrics`       | List or summarise opt-in route-level MCP tool latency (`mcp_route_latency` records); `summary` rolls each tool up into count, error count, and min/avg/max + p50/p95/p99 latency, slowest-first. Emitted only when `mcp_route_metrics_enabled` is on; payload-safe (tool, scope, status, duration, arg key names). Read-only. | `operation`                                    |
| `brain_retrieval_plan`      | Shadow-only retrieval advisor for one `question`: composes query intent/weights, the summary-surface route, the context-pack density allocation, the token-impact ledger, and observed route p95 latency into a strategy, token-budget allocation, graph-expansion advice, reliability, and a marginal-value stop. Optional `token_budget`. Read-only; exposes no mutating parameters and changes no ranking. | `question`                                     |
| `brain_token_impact`        | Durable value-of-memory ledger: `record` posts a context pack's tokenizer-exact prompt-token delta (`baseline` − `packed`, `method` exact/fallback) plus an optional modeled inference-avoidance estimate; `outcome` posts first-pass/repair/retry to calibrate the model; `summary` keeps EXACT prompt-token savings strictly separate from the MODELED (outcome-calibrated) figure; `list` reads raw samples. Writes gated on `token_impact_ledger_enabled` (default off); payload-safe (counts + opaque pack id only). Reads ignore the gate. | `operation`                                    |
| `brain_context_pack_outcome`| Agent-operable outcome loop over the context-pack quality ledger: `post` records one compact outcome row for a carried context-pack quality-sample id — first-pass/repair/retry counters plus three STRICTLY SEPARATE token signals (`exact_prompt_token_savings`, `modeled_inference_avoidance`, `observed_provider_tokens`) — and composes the token-impact ledger by posting a matching first-pass/repair/retry calibration outcome; `list`/`summary` read the rows keeping the signals separate. Writes gated on `context_pack_outcome_enabled` (default off); payload-safe (counters + opaque sample id only), a field the caller omits is never invented. An optional `agent_id` names the ACTING agent and is recorded on every row the post lands; it is a tool ARGUMENT rather than the server's own config identity, so a config the server cannot read can never fail a telemetry post, and omitting it records no actor rather than a guessed one. Reads ignore the gate. | `operation`                                    |
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
| `brain_create_note`         | Write an actual vault note file (path + frontmatter + content) atomically inside the vault. Distinct from `brain_note` (log append); refuses traversal, the Brain root, excluded paths, any destination outside the declared write binding, and — by default — clobbering. Opt-in: `if_exists: "skip"` returns `outcome: "skipped"` instead of creating, `strict` validates the document before writing and reports coded violations, and `template` + `template_variables` render the body through a closed two-construct grammar (`{{name}}` substitution; `{{#name}}…{{/name}}` presence sections and list iteration with `{{.}}`). Unknown placeholders are left intact. | `path`                                         |
| `brain_note_lifecycle`      | Note-FILE lifecycle, dispatched on `action`: `rename` (new filename, same directory), `move` (new directory, same filename), `archive` (displaces the note under `Archive/`, mirroring its path), `delete` (removes it). Both the source and the destination go through the same nine-step path envelope `brain_create_note` uses, so a destination cannot reach where a create could not. Dry-run unless `apply: true`; `delete` additionally requires `confirm: true` and honours `expect` / `strict` over the inbound-reference count. A relocation rewrites inbound `[[links]]` vault-wide - both path spellings always, the bare basename only when exactly one note carries it - and the result names what it rewrote, what it withheld and how stale the search index still is (`references.index`). A delete rewrites nothing, reports the references it strands, and returns a `recoverability` verdict saying the archive it took does not cover a note living outside `Brain/`. | `action`, `path` |
| `brain_scaffold_stub`       | Unresolved wikilink targets. `action: "list"` reads them from the search index and REFUSES - `state` plus a `next_command` - when that index is missing, unreadable or only partially resolved, rather than reporting zero: an empty list from an index nobody finished resolving is a clean bill of health for a vault nobody measured. `action: "write"` materialises a stub for one target through the same `createNote` envelope and `if_exists` semantics as `brain_create_note` - its title is the target the link spelled and its body links back to the `sources` documents, each of which must be an existing Markdown note inside the vault or the call is refused with `unknown_source` - so nothing the stub cites is invented, though whether a cited document really carries the reference is `action: "list"`'s claim, read from the index, not this write's. A target that already resolves, or that names more than one note, is refused with its candidates. Dry-run unless `apply: true`. | `action` |
| `brain_file_context`        | Given a file path, surface prior vault work that mentions it (decisions, bug notes, refactor history) by querying the index with path-derived terms. Size gate skips trivial files. Read-only; no LLM. | `file_path`                                    |
| `brain_session_summary`     | Session-scoped structured digest over request/decisions/learnings/next_steps: `write` stores agent-extracted categories, `get` returns a session's latest digest, `list` returns all. Append-only, deduped; an all-empty digest is rejected. | `operation`                                    |
| `brain_idea_lineage`        | Read-only provenance tracer: reconstruct how a derived artifact was reached as an observation -> synthesis -> conclusion graph. A `ctn_` id walks the sourceRefs graph; a `pref-`/`ret-` id adapts belief-evolution. Cycle-guarded, depth-bounded; unknown id errors. | `id`                                           |
| `brain_note_history`        | Decompose a note's git history into recallable episodic phases split on a deterministic commit-time gap (default 72h, language-agnostic). Each phase carries subjects/dates/authors. Missing repo → `available: false`; no commits → zero phases. Read-only. | `path`                                         |
| `schema_inspect`            | Read-only schema inspection for any view: `view: graph \| lint \| stats \| orphans \| explain_type \| active_pack \| packs`.                   | `view` (`token` for `explain_type`)            |
| `schema_apply_mutations`    | Apply audited, locked schema mutations to `Brain/_brain.yaml`. `dry_run: true` previews instead: the pack that would result plus its leaf-level `diff`, no config write, no audit record. The preview runs the same pack validator the apply runs, so a batch that validator rejects raises identically in both. It does NOT cover the two checks that exist only because the apply writes: the vault-identity write guard, and the atomic writer's re-parse of the rendered YAML. A batch that renders to unparseable YAML therefore previews clean and fails on apply. | `mutations` (`dry_run` to preview)             |
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
filtered on event time - frontmatter validity first, then the
body-derived anchor, with document mtime only as the last rung);
`include_superseded: true` to keep superseded
predecessors undemoted (history mode); and `evidence_pack: true` to return
significant/matched/missing terms, abstention text, terminal-state downrank
reasons, per-result `why_retrieved`, IDF-weighted coverage with rare-term
classification, per-token `union_records` for uncovered terms, and a
`completeness` verdict whose `uncovered_but_present_in_corpus` list is the
false-absence guard. It can also emit opt-in recall telemetry with
`telemetry: true`.
Since v1.44.0 `explain: true` adds two top-level receipts alongside the
per-result `score_breakdown`: `retrieval_decision_trace` (evaluated /
surfaced / excluded counts plus every excluded candidate as a compact
reference with its structural reasons) and `memory_trust_assessment` (the
same exclusion set as a reason histogram). Both are by-products of the
retrieval trust gate; with the gate off the response carries
`retrieval_trace_unavailable` naming the switch that produces them
(`search_trust_gate_enabled`) instead of going quiet. Without `explain` no
key appears at all. In the same release `total` stopped echoing the row
count: it is the ranked candidate pool the `limit` sliced the returned rows
from, so `total > results.length` means the ranker had more candidates
than it handed you. Read it as candidates ranked, not as a corpus
statistic: the pool is capped at roughly three times the requested
`limit`, so it moves with `limit` and saturates on a large vault, and
link traversal can add a document that matched no term at all.
A deterministic summary-search router (t_7b96f242) inspects each query for
structural summary signals - a source-targeted `source:<path>` token, or a
`kind:<t>`/`type:<t>` token whose value is a declared artifact kind in the
vault schema pack (`schema.page_types`). When a query is summary-shaped it
carries `surface: "summary"` in the response, naming the summary-search
surface as the intended route (target a source or artifact kind rather than
running a generic hybrid search over raw chunks); ranking is never altered
and non-summary queries omit the field entirely, so the generic-surface
response stays byte-identical. `brain_recall_feedback` records one feedback event as a
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
`source_turn_ids`, `host`, `project_scope`). `project_scope` is the same
project axis `brain_search` filters on, normalized to the same `[a-z0-9-]` slug:
on `write` it files the digest under that project and folds it into the dedupe
key, so the same content under two projects is two digests; on `list` it returns
only that project's digests. Omitted, the digest and its dedupe key are
byte-identical to the pre-project shape. A value with no alphanumeric is an
`INVALID_PARAMS` error naming the argument, never a silent drop to unscoped.
This is unrelated to the `o2b brain project` verb, which links a code directory
to its owning vault at the configuration level. `brain_idea_lineage` accepts `id` and optional
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
- `--tool-profile full|writer|catalog|recall|minimal` — a named scope-plus-window bundle (see "Tool-surface profiles" below).
- `--host-target <runtime>` — name the runtime that launched this server, so the capability report can cite that host's published tool ceiling. Install adapters write it into the registration they generate; an unrecognised value exits `2` naming the known ids. It changes nothing else.
- `--probe` — start an in-process handshake and print whether the server can advertise tools, then exit.
- `--transport stdio|http` — choose stdio (default) or Streamable HTTP.
- `--host HOST` — HTTP bind host (default `127.0.0.1`).
- `--port PORT` — HTTP bind port (default `0`, choose an available port).
- `--api-key KEY` — optional on the loopback default, REQUIRED when `--host` names a non-loopback interface; accepted as `Authorization: Bearer KEY` or `X-API-Key: KEY` on every request.
- `--json` — with `--probe`, print a machine-readable capability report.
- `--allow-tool NAME` — expose only named tools from the static scope. Repeatable.
- `--disable-tool NAME` — withhold named tools from the static scope. Repeatable.
- `--max-tools N` — expose only the first N non-diagnostic tools from the static scope.

The stdio server logs its banner to `stderr` and only writes JSON-RPC frames to
`stdout`, so it is safe to use as a subprocess in any MCP client. HTTP refuses
to start when `--host` is not loopback and no `--api-key` was given; with a key
configured it checks that key on every request using a generic constant-time
comparison, and returns the same `401 Unauthorized` body for a
missing or wrong key. JSON responses are the default; clients that send
`Accept: text/event-stream` receive a single SSE `message` event for the same
JSON-RPC response — one event, then the connection closes, which is why a
progress token sent over HTTP is refused by name rather than honoured (see
"Progress notifications" above).

## Shutdown and draining (since v1.50.0)

Neither transport could stop without cutting a request in half. The HTTP
handle's `close` was `server.close()` and nothing else — it stops the
listener and returns, while the promise the request callback returns was
floated, so a `tools/call` in flight was answered with a dead socket. The
stdio loop had no shutdown path at all: a SIGTERM took the default
disposition and killed the process mid-dispatch with no frame written.

`SIGINT` and `SIGTERM` now drain. The sequence is the same on both
transports:

1. stop accepting NEW work;
2. wait for the requests already begun, to a bounded deadline;
3. close the transport;
4. exit **130** (SIGINT) or **143** (SIGTERM).

**The deadline is 10 000 ms**, overridable with `O2B_MCP_DRAIN_MS` (a
non-negative number of milliseconds). A value that is not one THROWS rather
than falling back: an operator who set the variable did so to change the
behaviour, and quietly using ten seconds because they typed `10s` is the
misleading quiet the drain exists to remove.

A drain that hits its deadline still exits, and the requests it gave up on
are NAMED on stderr first, each with how long it had been open, plus the
variable that lengthens the wait — a shutdown that silently truncates a tool
call is indistinguishable from a crash to whoever was waiting on it.

**The `exit` hooks still run.** This is why the signal handler calls
`process.exit(128 + signo)` instead of re-raising, which is what every
foreground CLI verb does. Two `process.on("exit")` hooks have to run after
the transport closes — the search store synchronously checkpoints the WAL of
every open writer, and the sync lockfile unlinks every held lock — and the
default disposition for a terminating signal runs neither, because the
process dies by signal and no `exit` event is emitted. Exiting reports the
same thing to the shell AND emits `exit`, which is why the drain has to
complete before the exit rather than beside it.

A SECOND signal is not intercepted and falls through to the default
handler, so an operator who decides the drain is taking too long is never
trapped by it.

**What each transport does while draining:**

| | HTTP | stdio |
| --- | --- | --- |
| new work | answered `503` with `Retry-After: 1` and `Connection: close` — a code a client retries, not a protocol error | the next line is left unread; the loop stops cleanly at a request boundary rather than half-serving the shutdown |
| the listener | deliberately stays up until the drain finishes, so a supervisor can watch | — |
| in-flight | tracked from the first header to the response's `close` event, so a request is not counted as finished while its bytes are still queued | tracked across the dispatch AND the response write |

`GET /health` gains a third field and is **never refused during a drain** — a
shutdown a supervisor cannot observe is a shutdown it will report as a
crash:

```json
{ "status": "draining", "transport": "http", "in_flight": 2 }
```

`status` is `ok` while serving and `draining` once a drain has started;
`in_flight` says how much of the wait is left. The probe is not counted as
in-flight work itself: counting it would make the number a supervisor reads
include the act of reading it, and a probe arriving as the last request
finishes would restart the wait it was checking on. A request that arrives
after the drain started is not counted either — it is refused, never
dispatched, and counting it would let a client retrying in a tight loop hold
the shutdown open for its whole deadline over work the server had already
declined.

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

`second_brain_capabilities` returns `scope`, `server_name`,
`static_tool_count`, `available_tool_count`, `advertised_tool_count`,
`host_ceiling`, an `available[]` list, and a `withheld[]` list. Withheld
reasons are stable strings such as `disabled by runtime capability window`,
`not allowed by runtime capability window`, and `outside runtime capability
max tool window`.

`advertised_tool_count` is the number a host actually LISTS: available minus
the tools marked hidden, which `tools/list` filters out. Under the `catalog`
surface the two numbers are a hundred and three apart, and it is the
advertised one a host's ceiling applies to.

### The host ceiling (since v1.50.0)

`host_ceiling` reports what this build can say about the per-workspace tool
limit of the runtime that launched the server, and it is present on every
report — especially when the answer is "nobody has established one". A host
that caps a workspace at forty tools and is handed a hundred and ten drops
the excess in silence, so omitting the field where no limit is known would
be indistinguishable from a host with no limit at all.

| Field | Meaning |
| --- | --- |
| `target` | the install target from `--host-target`; `null` when the server was never told |
| `kind` | `declared`, `unbounded`, or `unknown` — three states, and `unknown` is never read as `unbounded` |
| `max_tools` | the published limit; `null` unless `kind` is `declared` |
| `source` | where the limit, or the published absence of one, is stated; `null` when `kind` is `unknown` |
| `reason` | why there is no answer; `null` unless `kind` is `unknown` |
| `within_ceiling` | `advertised_tool_count` against `max_tools`; `null` when there is no number to compare |

A server started by hand, or by a registration written before
`--host-target` existed, reports `kind: "unknown"` with a reason naming the
flag and the `o2b install --target <runtime> --apply` that regenerates a
registration carrying it. That is an UNCHECKED ceiling, not an absent one.

Today exactly one runtime declares a limit — Cursor, 40 tools across every
enabled MCP server — which is why the generated Cursor registration selects
the `catalog` profile. No runtime is `unbounded`; the member exists so a
host that publishes "no limit" is not recorded as unchecked. The full
resolution ladder for the profile that ends up in a registration is
documented under "Tool ceilings, `--host-target`, and the tool-profile
ladder" in [`cli-reference.md`](cli-reference.md).

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

Three properties of that surface come from the offer chain (v1.43.0):

- **`list_skills` reports what a skill shadows.** Each entry carries a
  `shadowed` array of the same-named skill directories it overrode, in
  discovery order. Previously the losing path was discarded, so an
  operator reading a surprising skill body had nothing telling them a
  second copy existed. An empty array means discovery found none.
- **`skills_attach` returns an `offer_id`.** It is a content-addressed
  digest of the offer itself - the normalised turn text plus the offered
  `(name, path)` pairs in rank order - so anyone holding the offer can
  recompute it and no offer store has to exist. It is `null` when nothing
  was offered; an offer that was never made has no identity. The rendered
  block cites the id too, so an agent that reads only the block can quote
  it back.
- **`get_skill` accepts that `offer_id`.** The runtime's session log then
  records which offer the fetch came from, and `o2b brain import-session`
  stamps it onto the `skill_invoked` continuity record, where
  `joinSkillInvocationsToOffers` joins the invocation back to its offer.
  A malformed id is refused rather than dropped AT `get_skill`, which can
  answer its caller: `isSkillOfferId` rejects it with `INVALID_PARAMS`. The
  import boundary cannot refuse anyone - the session log is historical and
  its author is gone - so `readSkillOfferId` reports a non-conforming value
  the same as absence, and a host-native skill call carrying a junk id is
  stamped with no offer and reads as unattributed. The two surfaces answer
  the same malformed value differently, on purpose, and only one of them
  can tell anybody. A call citing no offer is stamped exactly as before and
  reads as unattributed, never as belonging
  to a nearby offer. The id is the acting agent's claim about where an
  invocation came from: checkable (well formed, and recomputable from the
  offer), not authenticated - this system has no credentials to
  authenticate it with. The join is also retrospective, because an
  invocation is only observed when a session log is imported.

The join surfaces as ONE count under two spellings, which is worth stating
because they look like two figures: `brain_skill_proposals` with
`operation: "usage"` returns `offerAttributedCount` per skill, and the same
number prints as `from_offer=` on `o2b brain skill-proposals usage`. It
counts the invocations of that skill which cited an offer, out of
`invocationCount` total. The remainder are not unattributed by error - most
runtimes' skill calls follow no offer at all.

`skills_attach` additionally applies a discriminating-term floor: a
candidate whose entire match rests on terms more than half the descriptor
corpus carries is dropped rather than offered, because such a term is
evidence for no skill in particular. The only input is corpus document
frequency, so the rule holds in any language and there is no word list
anywhere in its derivation. A single-skill corpus carries no
discrimination at all, so the floor abstains there rather than dropping
the only candidate.

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
`suppress` silences a cooldown key indefinitely - it is legal from any
status and carries no clock, so the finding never re-nags - and
`unsuppress` restores the status suppression interrupted along with its
original cooldown arithmetic. Suppressed triggers are terminal: hidden
from `list`, present in `history`, never in the brief. A candidate an
existing record silenced increments `occurrences` and stamps
`last_seen_at` on that record, whatever silenced it - suppression, an
open twin, a cooldown window, or the per-kind cap - so silence is
auditable. Two limits are exact rather than implied: one scan seeing the
same finding twice counts once, so `occurrences` counts scans and not
candidates, and a candidate silenced before any record for its cooldown
key existed has no ledger to write to and is reported only in `skipped`.

One unreadable record never costs the operator the rest of the queue.
`scan`, `list` and `history` each return an additive `unreadable` array -
`path`, the frontmatter `key` at fault (`null` when the file itself could
not be read), and the refusal text - so a hand-edited record is named
instead of omitted, and the readable records stay listable and
transitionable while it is broken. `brain_brief` `view="morning"` carries
the same information as `triggers_unreadable` plus a
`trigger_queue_error` when the queue could not be read at all, and
renders both into the brief text: an absent pending-trigger section now
means the queue was read and held nothing.

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

## Write-time page lint (since v1.46.0)

The four note-write tools - `brain_create_note`, `brain_update_note`,
`brain_append_note` and `brain_write_batch` - can now return a top-level
`lint` key carrying ranked findings about exactly the pages that call
committed.

This closes a real hole rather than adding a nicety. Document validation
used to run only under `strict` on `brain_create_note`; update, append and
every batch operation committed with NO document validation at all and
returned a hardcoded success flag. Callers will therefore now see findings
on pages that used to be accepted in silence. The lint is not a new
policy: it runs the same error-severity validator a strict create runs,
plus the merged-link and broken-Brain-wikilink detectors the doctor
already reports, so a strict create and a linted update agree on what a
valid document is.

**The key is absent when there is nothing to say, and that absence means
clean.** A receipt for a clean write is byte-identical to the one that
shipped before. Because absence carries that meaning, a lint that could
not run reports itself rather than going quiet: the report then carries an
`unavailable` object (`code: "page-lint-unavailable"`, plus a message
composed from an errno code, never a path) with all counters at zero.

The report's shape:

- `findings` - ranked errors first, then by page, code and location, and
  capped at 25 entries. Each finding carries `severity` (`error` or
  `warning`), `code`, `page` (the vault-relative file), `path` (the
  location WITHIN the document: `body`, `frontmatter`, `tags`, or a link
  target), `message`, and `next_command` where the code has a registered
  exit.
- `total` / `returned` / `truncated` - findings detected, findings
  carried, and whether the cap dropped any. A capped list can never be
  read as a complete one.
- `skipped` - written pages that were not linted, each with a `page`, a
  `reason` from the closed set `page-over-byte-cap`, `page-unreadable`,
  `page-lint-failed`, and a `detail` carrying the measurement or the errno
  code. A page too large to validate, or one the lint threw on, lands here
  rather than vanishing - and one page's failure never discards the
  findings already collected for the others.

The lint runs AFTER the commit and reads what is on disk. It never gates
the write, and it never throws. A call that authored no bytes - a
`brain_create_note` with `if_exists: "skip"` that skipped, a log-only
batch - names no page and so carries no lint key.

Three write paths are deliberately outside this envelope, stated rather
than implied. `brain_write_session` keeps its own `errors[]` channel and
its own correction prompt: it validates BEFORE committing and refuses,
which is a different contract from an advisory computed after the fact,
and folding it in would give one tool two error channels. The write-session
engine and source distillation write through their own lexical validation
and bypass the note-write path entirely. Log appends (`brain_note`,
`brain_apply_evidence`) name no note path and are not linted, because the
log line is machine-composed rather than authored.

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
  to restore the raw path. Until v1.49.0 only three sites honoured that
  rule and every other `vault_path` returned the raw host path; the field
  now comes from one function (`src/mcp/vault-path-field.ts`) at every
  emitting site, and `tests/core/architecture/vault-path-census.test.ts`
  enumerates those sites from the source so a new one cannot opt out. On
  a device config that cannot be read the field carries
  `{ "error": "..." }` naming the file, rather than falling back to the
  path it exists to redact.
- Since v1.32.0 `brain_feedback` responses include a conflict advisory when
  the incoming principle closely resembles a confirmed same-scope preference
  (the write still proceeds); the advisory names the preference id and the
  similarity evidence.
- Since v1.33.0 four belief-lifecycle tools join the surface (102 total):
  `brain_lifecycle` (tombstone / supersede / temporal-replace / tip /
  curator), `brain_claims` (claim-graph queries: current truth,
  truth-at-instant, replaced-by, contested-by), `brain_decision`
  (record / outcome / rate / list / compare / similar / history / recall),
  and `brain_tension` (detect / list / show / confirm / dismiss / resolve).
  Decision-change receipts store only accountable provenance; free-text
  hidden-reasoning fields are rejected by the closed schema.
- Since v1.33.0 `brain_session_grep` accepts `since` / `before` turn-time
  bounds and `brain_search` results carry `authoredAt` when the indexed
  document preserved a turn instant. Context-pack reports list unresolved
  tension warnings for injected subject notes.
- Since v1.34.0 `brain_status` joins the surface (103 total): one
  consolidated operator snapshot over doctor, semantic health, hygiene,
  stale scan, review queue, active profile, and state-file health, with a
  next-command hint on every problem line.
- Since v1.34.0 existing tools gain optional params: `brain_ingest_batch_plan`
  accepts `src_subpath`, `exclude`, and `reconcile` (dispatched-vs-ingested
  gap report), `brain_ingest_source` accepts `pre_extract` (deterministic
  code-structure seeds), `brain_doctor` accepts `repair` / `apply` (guarded
  fixes for doctor-detected classes), and `brain_search` accepts `degree`
  (backlink/outlink cardinality predicates). Omitting every new param keeps
  each tool's output byte-identical.
- Since v1.35.0 three note-write tools join the surface (106 total):
  `brain_update_note` (update an existing note's body and/or merge
  frontmatter keys), `brain_append_note` (append to an existing note's
  body), and `brain_write_batch` (an ordered mixed batch of create note,
  update body or frontmatter, append note, apply evidence, and append log
  line operations, validated and projected in memory first and committed
  all-or-nothing; the first invalid operation aborts with a typed error
  naming its index and nothing touches disk). All three enforce the exact
  create-note safety envelope: path traversal, the Brain machinery root,
  and vault-scope-excluded paths are refused, and a missing target is a
  typed error.
- Since v1.35.0 `brain_session_grep` accepts `include_raw` (carry the
  original raw capture inline beside each derived record, every item
  stamped with an `extracted` boolean discriminator) and
  `raw_budget_chars` (clip raw payloads while identity fields survive).
  Search outcomes carry the `memory_trust_assessment` and
  `retrieval_decision_trace` receipts when the retrieval trust gate is
  enabled. Omitting the new params keeps each tool byte-identical.
- Since v1.36.0 `brain_diarize` joins the surface (107 total): a
  read-only entity profile with a deterministically computed
  stated-vs-evidenced section (each line carrying an evidence identity)
  and one needs-llm-step envelope for the prose; unknown entities are a
  typed error.
- Since v1.36.0 `brain_deep_synthesis` structured content additively
  exposes per-finding `causal_context`, decomposed `confidence`
  components (support, opposition, freshness, coverage), and the
  `excluded_findings` ledger with `excluded_finding_count`; prior fields
  are unchanged.
- Since v1.37.0 `brain_retrieval_plan` joins the surface (108 total): a
  shadow-only per-question retrieval advisor composing query
  intent/weights, the summary-surface route, impact-per-token
  allocation, the calibrated token-impact ledger, and observed route p95
  latency into a read-only plan with a marginal-value stop; it exposes
  no mutating parameters and changes no ranking.
- Since v1.37.0 `brain_search` accepts optional `session_scope` and
  `project_scope` filters (composite scope keys; omitting them keeps
  results byte-identical) and its outcome carries an advisory `surface`
  field when the deterministic router selects the summary surface;
  non-summary queries are unchanged.
- Since v1.38.0 `brain_health` additively carries a
  `suppressed: { concept_gaps, batch_inflation, baseline }` object when
  the optional `health.silence_before` watermark hides at least one
  advisory finding whose underlying entries are entirely older than the
  baseline date; the verdict is computed from the surfaced findings, the
  key is absent whenever nothing is hidden, and with no watermark set
  the output is byte-identical to v1.37.0.
- Since v1.39.0 eleven content-returning tools accept an optional
  `agent_scope` argument (`brain_context_pack`, `brain_pre_compress_pack`,
  `brain_anticipatory_context`, `brain_brief`, `brain_retrieval_plan`,
  `brain_file_context`, `brain_search_expand`, `brain_deep_synthesis`,
  `brain_search_by_source`, `brain_agent_query`, `second_brain_query`),
  joining `brain_search` and `brain_query` which already had one. A page
  that is ownerless matches every scope; an owner-tagged page matches
  only its owner; a page whose ownership cannot be read is withheld. The
  preference-backed surfaces additionally require
  `integrity.owner_scope_delivery` to be `warn` or `fail`; the
  search-backed ones filter whenever a scope is passed. Five `brain_brief`
  views that cannot honour a scope (`daily`, `weekly`, `monthly`,
  `operator`, `today`) reject an explicit `agent_scope` with
  `INVALID_PARAMS` naming the view rather than accepting and ignoring it.
  The tool count is unchanged at 108 and no output schema changed.
- Since v1.49.0 the no-argument surfaces that reach owner-taggable artifacts
  apply the ownership rule using the server-resolved agent identity, and only
  under `integrity.owner_scope_delivery: fail`. They are `brain_backlinks`,
  `brain_unlinked_mentions`, `brain_moc_audit`, `brain_hygiene` (both `scan`
  and `apply`), `brain_scaffold_stub`, `brain_doctor` (including `repair`),
  `brain_claims`, `brain_idea_discovery`, `brain_stale_scan`,
  `brain_event_trace`, `brain_agent_diff`, `brain_analytics` (every view that
  names an artifact: `timeline`, `concept_synthesis`, `belief_evolution`,
  `dedup`), `brain_health`, `brain_retention`, `brain_review_candidates`,
  `brain_clusters`, `brain_trigger` and `brain_dream` - plus the `preference`,
  `topic`, `backlinks` and `log` MCP RESOURCE templates, which had no
  ownership filtering at all and returned another owner's file verbatim. A
  withheld row is dropped and no count reports it, so a filtered report reads
  exactly like a report over a vault that never held the rows; a withheld
  resource answers with the same not-found message an absent one produces.
  `brain_hygiene apply` and `brain_doctor repair` bound the PLAN, so the write
  is bounded and not only the payload. With the gate `off` or `warn` all of
  them are byte-identical - `warn` observes nothing here by construction,
  because reporting what `fail` would withhold is itself the disclosure. `brain_backlinks` additionally gains an `unparsed` key,
  present only when the walk skipped an artifact it could not parse: a `count`
  of 0 beside a non-empty `unparsed` is not a measurement, which is the
  distinction a legacy-frontmatter vault previously could not make.
- Since v1.39.0 `brain_context_receipts` accepts a third `summary`
  operation, plus `since`, `until`, and `max_receipts`. The summary folds
  existing receipt records for one session into counts, distinct items,
  and per-item injection frequency and token cost. Receipt emission is
  opt-in, so a window with no receipts returns `recorded: false` carrying
  no counters at all - a consumer must branch before it can read a
  number, so "nobody enabled receipts" can never be read as "retrieval
  injected nothing". An uncomparable `since`/`until` value is rejected
  with `INVALID_PARAMS` rather than filtered into an empty result.
- Since v1.39.0 `brain_doctor` additively carries an `uncertain` array
  for conditions the doctor attempted but cannot claim completed
  cleanly - dropped frontmatter lines, lineage-ledger findings, stale
  lock files, and a missing vault identity marker. The key is absent
  when there is nothing to report. `brain_hygiene` likewise gains an
  additive top-level `link_integrity` key, which reports
  `measured: false` with a reason rather than a misleading zero when the
  index's last run was not a forced full pass.
- Since v1.39.0 `brain_anticipatory_context` reports a `cache_refusal`
  reason when a cached pack is refused because the vault state it was
  built from has moved or its validity window has expired, instead of
  silently serving or silently rebuilding.
- Since v1.40.0 `brain_doctor` additively carries `next_command` on each
  reported issue whose code has a registered exit, and a `no_exit` object
  giving, once per code, the reason a class has no single command. The
  two are complementary: a caller can tell a class it can act on from one
  that needs a human judgement over content, and neither is silent. Both
  keys are absent when every reported code has an exit, so the payload is
  byte-identical for a vault whose findings all resolve.
- Since v1.40.0 `vault_health` notices carry the same `next_command`
  field, resolved from the same registry, so the notice channel no longer
  requires a consumer to match the command out of an English sentence.
- Since v1.40.0 `brain_dream` accepts `step` and `gates`. `step` runs one
  independently-runnable step; any other value, including the five phase
  labels, is refused with the coupling named rather than silently running
  more than was asked. `gates` overrides a dream gate for that run only
  and never writes to `_brain.yaml`. `step` is deliberately not a schema
  enum, because an enum would swallow the per-step refusal reason, which
  is the deliverable for the steps that cannot run alone.
- Since v1.40.0 `brain_skill_proposals` accepts a `recover` operation and
  four contract arguments on `accept` (`prerequisites`, `rollback`,
  `side_effects`, `verification`), plus an `evidence` operation that
  reports a proposal's self-declared support beside the independently
  recorded procedural outcomes. Three states stay distinct: recorded
  successes, recorded failures, and no recorded outcome at all - the last
  is never reported as a zero success rate. `recover` is the operator
  surface for an accept sequence a crash left outstanding.
- Since v1.40.0 `brain_procedural_memory` entries carry the four contract
  fields back on `list`, so a contract written at acceptance is readable
  rather than write-only.
- Since v1.40.0 `brain_session_summary` accepts an optional
  `project_scope`, normalized by the same slug rule as the session axis.
  A digest written without one keeps its existing dedupe key byte for
  byte, so deduplication of pre-existing digests is unaffected.
- Since v1.40.0 `brain_analytics` accepts `view: dedup`, folding the new
  `ingest_dedup` continuity records into a trend. The counts are exact-hash
  drops only; the semantic layers nominate candidates and never drop, so
  nothing in this view may be read as a semantic discard.
- Since v1.41.0 `brain_ingest_batch_plan` scopes `src_subpath` by the
  repository's own declarations, so a scoped plan answers the same about a
  tree as an unscoped one. Beyond the existing typed error for a value
  escaping the source root, two refusals are reachable. A `src_subpath` that
  crosses a submodule or nested checkout is refused with an error naming
  the boundary directory: those files belong to that repository, no `exclude`
  pattern can re-open a boundary, and the error says to plan against that
  repository directly. A `src_subpath` that starts below a directory the
  repository ignores is not walked: the plan returns no batches and carries
  an `ignore_warnings` entry whose `source` is `--src-subpath`, naming the
  ignored directory and the `exclude` `!` re-include that opens it.
- Since v1.41.0 a batch plan carries `ignore_warnings` whenever the walk
  could not apply something as declared: a malformed pattern in one of the
  repository's own ignore files, an ignore file that exists but could not be
  read, or the `--src-subpath` case above. Each entry carries `source`,
  `line`, `pattern`, and `reason`; `line` is 0 for a warning that concerns no
  single pattern line. The key is absent when there is nothing to report, so
  a tree that declares no ignore files serializes exactly as before. None of
  these warnings fails the plan - the repository is an input, not operator
  intent - while a malformed operator `exclude` pattern still fails the call,
  naming the pattern and the reason it would not compile.
- Since v1.43.0 the four caller-named write tools -- `brain_create_note`,
  `brain_update_note`, `brain_append_note`, and the note operations of
  `brain_write_batch` -- name the write binding among their refusals. All
  four share one envelope, so all four raise it; the tool descriptions
  previously enumerated a refusal list it was missing from, which a caller
  reads as complete. The binding is declared in
  `write_binding.path_prefixes` in `Brain/_brain.yaml`; absent block, no
  binding, and every write path is byte-identical to before the key
  existed.
- Since v1.43.0 a refused write reports BOTH spellings of its reason, so an
  agent can act on the one it received. `data.code` is the surface code
  (`write_binding`, `invalid_path`, `excluded`, `exists`, `config_invalid`,
  ...): snake_case, the same enumeration every other refusal on the write
  surface uses, and what a client branches on. `data.diagnostic_code` is the
  advisory registry spelling of the same state (`write_binding` ->
  `write-binding-refused`, `config_invalid` -> `config-invalid`), and
  `data.next_command` is the command that registry code resolves to (`o2b
  vault inspect <relpath>` and `o2b brain doctor` respectively). A surface
  code with no registered advisory code carries neither key rather than a
  null.
- Since v1.43.0 a vault whose `Brain/_brain.yaml` exists and does not
  validate refuses caller-named writes with `data.code: "config_invalid"`
  naming the config by its VAULT-RELATIVE path (`Brain/_brain.yaml`) and
  carrying `next_command`, instead of a bare fault carrying an absolute
  host filesystem path. It stays a JSON-RPC INTERNAL_ERROR rather than
  INVALID_PARAMS on purpose: no argument the caller could send would
  succeed, and the operator holds the fix.
- Since v1.43.0 a `frontmatter` key must be a key this format can read
  back -- a letter or underscore followed by letters, digits, `_` or `-`.
  The emitter escaped values but wrote keys raw, so a key containing a
  newline emitted extra frontmatter lines; combined with `brain_update_note`
  merging caller keys over existing ones and a last-wins reader, that let a
  caller overwrite a key it never named. `template_variables` keys are
  unaffected: they are not frontmatter keys and never become a line of a
  file.
- Since v1.46.0 `brain_intake_entities` requires bytes behind the source it
  cites. An extraction whose `source` names no file this vault holds is
  committed to the quarantine lane, where it used to land its entities
  active. The tool's response reports the lane it actually committed in as
  `trust` (`trusted` or `untrusted`), so a caller told only which ids it
  created is no longer left to guess whether it can read them back.
  Quarantine is one-way, which is why the shape gate that decides "could
  this identity be ours at all" errs toward the operator's own notes: an
  identity is trusted only when it is shaped like a location inside this
  vault AND that location holds a readable file. An unreadable file is not
  a verdict - only "nothing is there" answers the trust question, and a
  permission denial or an I/O failure is refused with the vault-relative
  identity and the errno code rather than quarantining the operator's own
  note over a `chmod`. **What this does not buy, stated plainly:** a caller
  forced to name a real file can still name an unrelated one. This removes
  a free bypass - a plausible-looking string no longer suffices - and makes
  the claim auditable afterwards through the SHA-256 of the cited bytes
  recorded beside a trusted intake. It does not make the claim true, and
  nothing on this side of the boundary can: there is no unforgeable caller
  identity in the MCP surface.
- Since v1.46.0 `brain_search` carries a `retrieval_trail` key on any answer
  that narrowed or came back empty: `retrieved` (rows handed back, which
  `total` does not state), `pool`, a `degraded` array over a closed
  vocabulary of stable identifiers, and an `empty` corpus statement on a
  zero-result answer no degradation accounts for. Every `degraded[].detail`
  carries identifiers and integers only, never a provider message, a
  filesystem path, or the query text. The response schema declares the code
  enum, so a build emitting a code outside the vocabulary fails its own
  contract rather than handing a client a value it cannot interpret. The
  key is absent - never null - on a healthy answer, so an existing
  consumer's bytes are unchanged. The vocabulary and the matching CLI
  surface are in [`cli-reference.md`](cli-reference.md).
- Since v1.46.0 every `recall_telemetry` record carries a `channel` naming
  the seam it came through (`mcp`, `cli`, `hook`). It is stamped by the emit
  site and is not a tool argument, so no caller can claim a channel it did
  not use. `brain_recall_telemetry` `list` and `summary` accept it as a
  read filter and `summary` returns a `by_channel` rollup; an unrecognised
  value is `INVALID_PARAMS` naming the accepted set. Records predating the
  field carry no channel and fall into no bucket - see
  [`observability.md`](observability.md).
