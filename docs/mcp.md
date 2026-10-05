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

### Vault-relative paths are forward-slash on every host

A vault-relative path a tool returns (`path`, `signal_path`, `page`,
`log_path`, ...) is spelled with `/` on every operating system, including
a server running natively on Windows: `Brain/inbox/sig-x.md`, never
`Brain\inbox\sig-x.md`. The path names a note inside the vault, not a
file on the host, so it takes the vault's own Obsidian-style form. That
keeps the answer portable: an agent can feed it straight back into a tool,
match it against a wikilink, and compare it with the answer another device
sharing the same vault gives, whatever OS each device runs. A path outside
the vault is returned unchanged in its host form.

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
| `brain_maintenance` (`run`) | the four built-ins plus declared custom tasks (since v1.65.0), sequentially; since v1.64.0 the reindex task stays keyword-only unless config `maintenance_embeddings` is `true`; then it requests the embedding phase when the resolved semantic config can reach a provider, announcing the predicted spend and receipting the completed pass (additive `spend` block: `banner` estimate, `receipt` with model, tokens, `estimated_usd` and whether `force_cost` overrode a refusing gate) | one fresh guard per task; a tripped task is a `timed_out` row, not an aborted call | yes, in its tasks' voices |
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

### Tool errors (since v1.66.0)

Every failed call now carries a stable, machine-readable code, so a
client can branch on the failure without matching English prose. The
prose itself is unchanged: every error message and every error text
block reads byte for byte as it did before, and a successful result
never gains the envelope. The one message that changed is the HTTP
transport's answer to a throw that escapes its dispatch: it used to be
the raw error message, and it is now `internal error: <message>` with the
message redacted for the bind's reach, the same answer the dispatcher
gives an internal error.

A failure reaches the client on one of two channels, and the code rides
in a different place on each:

| Channel | When | Where the code is |
| --- | --- | --- |
| JSON-RPC error | the request was refused before or around the tool: an unknown method, invalid params, an undeclared argument, a refusal the tool raises as a protocol error, a transport parse error | `error.data.code` |
| tool error result | the tool ran and failed: `isError: true` with one text block | `result._meta["open-second-brain/error"].code` |

On the JSON-RPC channel every error response carries `error.data.code`.
A code the refusing site chose (`vault_frozen`, `budget_exceeded`,
`unknown_argument`, a search error code) wins. Otherwise the server fills
in the default for the numeric JSON-RPC code: `parse_error` (-32700),
`invalid_request` (-32600), `method_not_found` (-32601), `invalid_params`
(-32602), `internal_error` (-32603). Existing `data` members such as
`tool`, `unknown_arguments` or `errors` are kept as they were, with
`code` added after them. A refusing site's code is itself a registry
member; the server checks it, still sends an unregistered one as it is,
and names it on stderr, JSON-quoted and capped at 120 characters
(`warning: unregistered error code on the wire: "<code>"`).
A `code` member that is not a string is replaced by the default, and
`data` is always an object, never an array.

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "error": {
    "code": -32602,
    "message": "brain_search: unknown argument 'quiery' (did you mean 'query'?). ...",
    "data": {
      "tool": "brain_search",
      "unknown_arguments": [{ "name": "quiery", "suggestion": "query" }],
      "declared_arguments": ["query", "..."],
      "code": "unknown_argument"
    }
  }
}
```

On the tool-result channel the code rides on `_meta` under a namespaced
key, with a schema tag like the progress envelope's:

```json
{
  "result": {
    "content": [{ "type": "text", "text": "<the error message, unchanged>" }],
    "isError": true,
    "_meta": {
      "open-second-brain/error": {
        "schema": "o2b.error.v1",
        "code": "safeguard_timeout"
      }
    }
  }
}
```

It is not placed in `structuredContent`: a strict client validates
`structuredContent` against the tool's `outputSchema` even on an error
result, and an error object there would fail that check. When the same
call also carries a progress refusal, both keys sit side by side on the
one `_meta` object. A call refused on the JSON-RPC channel carries its
progress refusal in `error.data`, under the same
`open-second-brain/progress` key, beside `code`.

**The code list is closed.** Every code the server can send is a member
of one registry, so a client can treat an unknown value as a newer
server rather than as a malformed reply. It is the union of these
generic tokens:

| Code | Meaning |
| --- | --- |
| `parse_error`, `invalid_request`, `method_not_found`, `invalid_params`, `internal_error` | the default for each JSON-RPC error code, used when nothing more precise applies |
| `safeguard_timeout` | the operation outlived its cooperative deadline (see "Which tools are bounded" above) |
| `safeguard_aborted` | the operation's abort signal fired and it stopped at a checkpoint |
| `output_contract_failed` | the tool produced a payload that does not satisfy its own `outputSchema` |
| `config_unreadable` | the configuration file could not be read |
| `skill_not_found`, `skill_invalid_path`, `unknown_skill` | a skill tool could not resolve the named skill, refused its path, or does not know it |
| `unknown_operation` | a tool that dispatches on an `operation`, `op` or `action` argument (or a `brain_write_batch` operation's `op`) was asked for one it does not have; every operation-dispatching tool shares this code, except that a `brain_memory_bridge` host write keeps its pinned `invalid_action` |
| `invalid_status` | `brain_trigger` was given a status outside its vocabulary |
| `trigger_transition_refused` | a trigger transition was refused; an absent trigger and one the caller may not see answer with the same code and the same message |
| `write_session_unknown`, `write_session_terminal`, `session_id_required` | a write-session call named no session, an unknown one, or one that has already ended |
| `unknown_argument` | the call carried an argument the tool does not declare (see "Argument contract" above) |
| `brain_artifact_unparseable` | a Brain artifact file (a preference or a retired rule, for example) could not be parsed |
| `argument_forbidden` | `brain_scaffold_stub` was given an argument that belongs to its other action |
| `quote_unverified` | `brain_distill_source` with `strict_quotes: true` refused the write because a quoted span in a claim did not verify against its source (see "Source distillation" below) |

plus every member of the vocabularies the core already defines, passed
through unchanged:

- search errors (`SEARCH_ERROR_CODES`, for example `INDEX_MISSING`,
  `EMBEDDING_QUOTA_EXHAUSTED`); the bracketed `[CODE]` suffix some search
  messages already carried stays in the text;
- response-shape and semantic response violations
  (`SHAPE_VIOLATION_CODES`, `SEMANTIC_VIOLATION_CODES`);
- the frozen-vault refusal `vault_frozen`, the write-binding refusal
  `write-binding-refused`, the reach refusal `caller-supplied-reach`, and
  the owner-scope refusals `foreign-owner` and `unresolved-identity`;
- the codes of write batches (`budget_exceeded`, `invalid_action`,
  `invalid_target`, ...), note creation, note lifecycle, note revert,
  stub scaffolding, note title resolution, note templates, pinned
  context, exact state, host memory writes, the count guard
  (`count_guard`), and the shared `config_invalid` and
  `preference_not_found`;
- the `brain_expire` refusals, sent under their error class names:
  `ExpirationValueError` (the date is not one the server can compare),
  `ExpirationTargetNotFoundError` (no signal or preference has that id)
  and `InvalidExpirationTargetError` (the id has no addressable shape).

The canonical list is `TOOL_ERROR_CODES` in `src/mcp/tool-error-codes.ts`.

**Casing follows the vocabulary.** New tokens are lower snake_case. A
code that was already on the wire keeps its spelling: search codes stay
UPPER_SNAKE, the write-binding, reach and owner-scope refusals stay
kebab-case, and the `brain_expire` refusals keep their class names. Nothing was
renamed, so a client that already matched `vault_frozen` or
`budget_exceeded` keeps working.

**No blank code and no guess.** The server classifies a failure by its
error class, never by reading an arbitrary `.code` property, so an
operating-system code such as `ENOENT` never leaks onto the wire. A
failure the registry does not recognise is reported as `internal_error`
and the server writes one stderr line naming the error class (never its
message):

```text
warning: unclassified tool error mapped to internal_error: <error name>
```

Codes are fixed tokens; none is ever built from a path, a note name or
a query.

The Hermes bridge surfaces the JSON-RPC channel's code as `BridgeError.code`
(the string `error.data.code`, or `None` for a transport failure and for a
response whose code is missing or not a string), so a Hermes caller
branches on the token without parsing the rendered message; `str(err)` is
unchanged.

## Tool Highlights

The full server currently advertises 115 tools; the 18 deprecated predecessor
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
| `second_brain_wiring`       | Report what this install is wired into. `view=projects` lists every registered project link with its pointer state and whether the vault it names still exists; `view=hosts` verifies every registered install target through the same `verify()` call `o2b install --check` makes. See "Installation wiring" below for the path policy and the probe cost. | `view` |
| `vault_health`              | Run vault, config, and plugin manifest health checks. Since v1.50.0 the response also carries `state_surfaces`: the same inventory `o2b state status` renders (every declared in-vault state surface with its resolved path, tier, reachability verdict and the configuration layer that placed it), as a sibling FIELD rather than a contribution to `ok` — an absent surface is normal on a young vault and an unchecked one carries its own reason. An unreadable machine config resolves to no overrides here rather than failing the report; the `checks` array already names that fault. | —                                              |
| `brain_health`              | Run semantic Brain Health checks and return the health verdict/domains.                                                                        | —                                              |
| `brain_mcp_landscape`       | List the MCP servers configured across the vault: name, source config file, packages, and required env-var names. Env values never read.       | —                                              |
| `brain_codegraph_report`    | Read-only codegraph partner report: in-scope code project, index state (`no_project`/`absent`/`not_indexed`/`indexed` with counts/`error`), and structural `Cargo.toml` workspace members. When indexed, attaches a non-blocking `index.health` graph-health gate (`empty-graph`, `collapsed-edges`, `dangling-references`, `self-loops`, `cache-root-mismatch`) surfaced before labeling/import/recall trust the graph. Never installs, extracts, or mutates; non-Rust projects report `cargo_workspace: null` with a reason. | —                                              |
| `brain_agent_query`         | Read-only source-agent retrieval over Brain provenance. Filters by agents, topic, free-text query, contribution kind, and limit.               | —                                              |
| `brain_agent_diff`          | Read-only comparison between source agents using browse/search/diff/map modes over the same provenance foundation.                             | —                                              |
| `brain_writes`              | Read-only listing of recorded note writes (create / update / append / revert), newest first, with the agent, the device the log shard names, the target path and the content digest on each side. Filters by agent, device, path, op and time window. `action: plan_revert` returns the sealed plan for undoing a selection of those writes - one entry per target with its action, refusal reason and both digests - and never applies it; applying is CLI-only. | — |
| `brain_audit`               | Read-only per-preference mutation trail (create / promote / update / retire / merge) with agent, reason, revision + content-hash before/after. | `pref_id`                                      |
| `brain_brief`               | Read-only Brain summary for any window: `view: morning \| daily \| weekly \| monthly \| operator \| digest`.                                   | `view`                                         |
| `brain_analytics`           | Read-only Brain analytics for any lens: `view: timeline \| attention_flows \| belief_evolution \| concept_synthesis \| dedup`. `view=dedup` summarises the persisted exact-hash ingest dedup records into a trend plus a per-source re-ingest ranking; every count is an exact sha-256 drop, never a semantic figure (the semantic detectors nominate merge candidates and never drop). | `view`                                         |
| `brain_search`              | Read-only vault search with optional structured query lanes, explicit focus hints, time ranges, evidence-pack diagnostics, a selectable recall `profile` (`fast \| balanced \| thorough`), and an FTS `match_mode` (`all` \| `any`). | `query`                                        |
| `brain_recall_feedback`     | Record explicit up/down recall feedback for one search result; feeds the deterministic learned-weight fold.                                     | `query`, `result_path`, `verdict`              |
| `brain_recall_gate`         | Read-only classifier for whether an automatic recall attempt should run; returns `retrieve` plus a stable reason. When the caller passes `scores` AND `match_quality` (the `idf_weighted_coverage` a search outcome reports - the two stand or fall together, and an incomplete pair is refused), also attaches an adequacy verdict (`sufficient` \| `weak` \| `insufficient`), a recommended action (`proceed` \| `re_recall` \| `abstain`), and an optional `escalate` flag. The LEVEL is decided by `match_quality` alone; the scores decide only the usable-result count. Thresholds via `recall_adequacy_sufficient` / `recall_adequacy_weak` / `recall_adequacy_min_results`.                              | `prompt`                                       |
| `brain_context_pack`        | Budgeted context slice; pass `lanes: true` to return directives, constraints, and consider lanes. Filtered items include `safety.reasons`. Each item carries a structural `epistemic` status (`observed` \| `derived` \| `hypothesis` \| `plan` \| `unknown`) plus `evidence_refs` derived from existing graph metadata; fields are absent when the status is `unknown`. Takes the same adequacy pair as `brain_recall_gate` under its own spelling, `recall_scores` AND `match_quality`: both or neither, an incomplete pair is refused, and the schema states it as `dependentRequired` keyed on this tool's own scores name. | `max_tokens`                                   |
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
| `brain_hygiene`             | Memory hygiene: `scan` findings (conflicts, dedup, freshness, usefulness; since v1.64.0 `slug-collisions` is default-on — same-stem allocation residue such as `topic.md` beside `topic-2.md` — and `tags` is opt-in, auditing inline body tags only, never frontmatter tags arrays; since v1.67.0 `capture-scope` is default-on and warns when active knowledge rests only on `url-only` sources; the default is the sweep of every registered detector except the opt-in ones), `apply` selected ids, `refresh` stale pages. Resolver command comes from `_brain.yaml` only. With the optional `dedup` decision-model use in enforce, `scan` dedup findings carry an advisory `decision_model` verdict; `apply` never reads it. | `mode`                                         |
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
`diff`, `map`). Omitting `agents` means all known source agents. Both accept
`kind: note`, which lists the notes an agent wrote: the vault provider maps
every `note-write` log event to a contribution whose `path` is the note and
whose title is the operation.
`brain_writes` accepts `action` (`list`, default; `plan_revert`), `agent`,
`device`, `path`, `op` (`create`,
`update`, `append`, `revert`), `since` / `until` (a bare `YYYY-MM-DD` or an
ISO-8601 UTC timestamp; a bare `until` date covers the whole day it names), and
`limit` (1-500, default 50). It answers with `total_matched` beside `returned`,
so a capped list is legible as one, and each row carries `write_id`, both
content digests, both byte counts and the device the log shard names - the
empty string being the legacy un-sharded log rather than an unknown machine.
`action: plan_revert` takes the same selector (`agent`, `device`, `path`,
`since`, `until`) and returns the sealed plan for undoing the writes it names:
one entry per target with `action` (`restore`, `delete`, `refuse`), `reason`
when refused (`drift`, `interleaved`, `image-missing`, `unrecorded`,
`already-reverted`), the selected `writes` oldest first, and `hash_now` /
`hash_to`; plus the `digest` that seals it and `next_command`. A selector
naming none of `agent`, `device` or `path` is refused with `INVALID_PARAMS`
carrying `unbounded_selector` - a time window alone is a vault rollback. There
is no apply here: applying moves bytes on targets the caller may never have
written, so `o2b brain writes revert --apply <digest>` is where a human types
the digest.
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
`explicit`; `explicit: true` always returns `retrieve: true`. Since
v1.69.0 it also accepts an optional `turn_id` (a string of at most 512
characters), recorded on the `gate_telemetry` record when that telemetry
is on.

Optional decision-model `answerable` signal (see
[decision-models/answerable.md](decision-models/answerable.md)): with rerank
kind `decision-model` and the `answerable` use in `shadow` or `enforce`,
`brain_search` adds `decision_model: { answerable: { probability, model,
calibrated } }`; the field is absent when the use is off, for any other kind
and when the request degraded. `brain_recall_gate` and `brain_context_pack`
accept that probability as `decision_answerable` (a number in [0,1]), only
together with the scores and `match_quality` pair (`dependentRequired`;
alone it is `INVALID_PARAMS`). With the use on, the `adequacy` verdict gains
`decision_answerable: { probability, disagrees }`, where `disagrees` is true
for `sufficient` below 0.3 or `insufficient` above 0.8; `level` and `action`
never change. The context-pack receipt stores the field next to its verdict.
With the use off the argument is ignored and the response carries one
`warnings` entry saying so.

> **Date format note.** Brain tools use ISO 8601 `YYYY-MM-DD`
> throughout; the `Brain/log/<date>.md` subdirectory layout shares that
> convention.

All tool results contain both an unstructured `content` text block (a JSON
serialization of the structured payload) and a `structuredContent` object so
clients that prefer typed results can use it directly.

### Paging externalized session payloads

Session recall import moves oversized turn content into `Brain/.payloads/`
and leaves `[payload: osb-payload://<sha256> chars=N]` in the recalled turn
(see `o2b brain payload` in `docs/cli-reference.md`). `brain_session_expand`
pages the exact stored content when it is called with `payload` instead of
`id`: `{payload: "osb-payload://<sha256>", payload_chars?: n, cursor?: "<offset>"}`
returns `{payload: {ref, offset, limit, total_chars, content}, next_cursor}`
(4000 chars per page by default). `payload` cannot be combined with `id` or
`raw_limit`, and a malformed ref is `INVALID_PARAMS` before any path is built.
This rides the existing tool rather than adding one, so the tool count and
every profile are unchanged.

Reach follows the session data the payload came from. A local caller reads any
stored payload. A remote caller reads one only when a non-private session turn
references it, directly or through another remotely readable payload; a
payload referenced only by a private turn, a page (the Brain log included) or
nothing gets the same refusal. Pages and summary nodes keep a payload live for
`o2b brain payload gc` but grant no remote read, because a page can be written
by tools that a session turn is not.

At remote reach `brain_session_grep`, `brain_session_describe`,
`brain_session_expand` and `brain_idea_lineage` also withhold continuity rows
flagged `private` (a `<private>` region was stripped from them), and the
session recall tools withhold the summary nodes built from them. A withheld
row is answered exactly like one that does not exist. Local callers see every
row.

## Installation wiring (since v1.56.0)

`second_brain_wiring` answers what this install is wired into. Both answers
existed before it and neither was reachable from this surface: the linked
project registry was readable only through `o2b brain project status`, and
the per-adapter verify aggregate only through `o2b install --check`. Nothing
here computes health of its own - each view is a seam onto the reader that
already produced the answer.

`view` is required and there is no aggregate member, so a projects read never
pays for a host probe. An absent or unknown `view` is refused with `-32602`
naming the accepted members, and `view=hosts` without a resolved vault is
refused with the same code and the sentence `o2b install --check` gives -
verify reads a per-vault manifest, so an unset vault would report every
runtime absent.

Every payload carries `vault_path` and `view` at the top level, whichever view
answered.

**`view=projects`** returns one entry per registered project link:

| Field | Meaning |
| --- | --- |
| `project_ref` | The project directory, under the path policy below. |
| `vault_ref` | The vault it points at, under the same policy. |
| `pointer` | `ok`, `missing`, `malformed`, or `mismatch` - the state of that project's `.o2b-vault.json` against the registry. |
| `vault_exists` | Whether the vault directory is still present. |

Beside `projects` the payload carries `total` (links found), `returned`
(entries actually carried) and `truncated`. The list is capped at 25: nothing
caps `projects.json` - every `o2b brain project link` appends to it - and this
response lands in model context, so the bound is in the payload rather than in
an assumption about how many projects an operator links. The `view=hosts` list
is not capped; a registry this build closes bounds it already. The CLI verb
stays uncapped too - it renders to a terminal.

A registry file damaged by hand reads as no links at all - not as the entries
it can still parse - and the call succeeds. That is the tolerance the CLI
reader already has (`listLinkedProjects` parses the registry as a whole), and
this view answers what `o2b brain project status` answers rather than refusing
where the verb tolerates. A server started without a config path reads the
machine default, as `view=hosts` does.

**`view=hosts`** returns one entry per registered install target, carrying
`target`, the `VerifyStatus` member (`ok`, `drift`, `not-installed`,
`mcp-unreachable`), the `details` the adapter observed, and `fix_hint`. Those
last two are the adapter's own sentences and name the host config files it
looked at, so the home prefix in them is folded to `~` under the same
`expose_host_paths` flag that governs the reference fields below. It is
the same `verify()` call over the same registry and the same `InstallEnv` that
`o2b install --check` makes, so connector health has one implementation rather
than two that can drift.

Two things this view states rather than hides. It may ask host CLIs: two of the
registered targets declare a host probe (`codex mcp list`, `copilot mcp list`),
so a worst-case call adds two subprocess round trips, each bounded by the same
ten-second deadline `--check` uses, and a probe that could not run renders its
named reason instead of an assumed `ok`. And an unresolved vault is refused by
name with the sentence `o2b install --check` gives, because `verify()` reads
the per-vault sidecar manifest and an unset vault would otherwise report every
target as not-installed off a path that does not exist.

**Paths.** The project registry is keyed on absolute host paths, and an MCP
response lands in model context, so `project_ref` and `vault_ref` follow the
same `expose_host_paths` contract `vault_path` obeys: an opaque, stable
`vault://<hex>` reference by default, the raw path when the operator sets the
flag. A config that cannot be read renders `{ "error": "..." }` in the field
rather than degrading to the path the reference exists to hide. That reason is
path-safe: it does not name the config file either, because the file lives
under the operator's home and this is the field that exists to keep host paths
out of model context. `second_brain_status` and `vault_health` name it, from
fields whose contract is to name it.

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
- `--host-target <runtime>` — name the runtime that launched this server, so the capability report can cite that host's published tool ceiling. Install adapters write it into the registration they generate; an unrecognised value exits `2` naming the known ids. It also stands in for `--harness` when that option is absent, and changes nothing else.
- `--harness <id>` — name the harness this server runs under (since v1.70.0), from a closed list: `aider`, `claude-code`, `codex`, `copilot-cli`, `cursor`, `gemini-cli`, `generic`, `grok`, `hermes`, `kiro`, `openclaw`, `opencode`, `pi`. It selects which `Brain/standing-rules/harness/<id>.md` file `brain_context` renders (see "Scoped operator rules" in [`how-it-works.md`](how-it-works.md)); the Claude Code plugin passes `--harness claude-code` and the Hermes plugin `--harness hermes`. An unrecognised value exits `2` naming the accepted ids. No tool argument names the harness.
- `--probe` — start an in-process handshake and print whether the server can advertise tools, then exit.
- `--transport stdio|http` — choose stdio (default) or Streamable HTTP.
- `--host HOST` — HTTP bind host (default `127.0.0.1`).
- `--port PORT` — HTTP bind port (default `0`, choose an available port).
- `--api-key KEY` — optional on the loopback default, REQUIRED when `--host` names a non-loopback interface; accepted as `Authorization: Bearer KEY` or `X-API-Key: KEY` on every request. A flag is visible in every process listing on the host, so prefer the environment: `OPEN_SECOND_BRAIN_MCP_API_KEY` supplies the same key (the flag wins when both are set).
- `--json` — with `--probe`, print a machine-readable capability report.
- `--allow-tool NAME` — expose only named tools from the static scope. Repeatable.
- `--disable-tool NAME` — withhold named tools from the static scope. Repeatable.
- `--max-tools N` — expose only the first N non-diagnostic tools from the static scope.

The stdio server logs its banner to `stderr` and only writes JSON-RPC frames to
`stdout`, so it is safe to use as a subprocess in any MCP client. HTTP refuses
to start when `--host` is not loopback and no key was given (`--api-key` or
`OPEN_SECOND_BRAIN_MCP_API_KEY`); with a key
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

## Background faults (since v1.65.0)

A promise rejection nobody awaited used to end the server: no process-level
fault handler was registered, so the runtime default ended the process and one
stray rejection anywhere in core took the whole tool surface down
mid-session, with no line on stderr that named it.

`o2b mcp` now installs a fault guard on both served transports (stdio and
`--transport http`), before the background vault refresh and before the
transport starts, and releases it when the server stops, so the CLI's own
top-level error handling applies again once it has:

- **An unhandled rejection is survived.** It is logged on stderr by name -
  `[mcp] unhandled_rejection #N: <reason> (server keeps serving)` plus the
  first stack frame, and a non-Error reason is named as
  `non-error reason: <value>` - counted, and the server goes on answering.
  Each line is redacted before it is written, so a credential in an error
  message (a token, or a password in a URL) does not reach the host's log.
- **The log is rate-limited, the count is not.** Five full lines per 60
  seconds, then one summary line (`[mcp] unhandled_rejection: N more
  suppressed in the last 60000ms`). The summary is printed when the window
  ends, or when the server stops first, so a suppressed count is never
  lost; past the window the next rejection is logged in full again. A loop
  that rejects on every request therefore cannot fill the log, and the
  count still says how often it happened.
- **An uncaught exception exits 70.** It is logged by name -
  `[mcp] uncaught_exception: <reason>; exiting 70 so the exit hooks
  checkpoint the index and release locks` plus the first stack frame - and
  the process exits through `process.exit(70)`. A second exception thrown
  while the process is already exiting goes straight to the exit, without
  another line. A thrown exception
  leaves the process in a state nothing measured, so continuing to serve
  from it would answer requests from unknown state. Exiting rather than
  dying keeps the two `exit` hooks described under "Shutdown and draining":
  the search store checkpoints its WAL and the sync lockfile releases every
  held lock.
- **No drain on an exception.** A drain keeps serving the requests already
  begun, which is exactly the unknown state the exit is there to leave. The
  drain stays the answer to a signal, where the process is healthy and was
  asked to stop.
- **A closed stderr does not turn the guard into the crash:** the write is
  dropped and the fault is still counted.

`GET /health` on the HTTP transport carries the counts beside the drain
fields:

```json
{
  "status": "ok",
  "transport": "http",
  "in_flight": 0,
  "faults": { "unhandled_rejection": 3, "uncaught_exception": 0, "last_fault_at": "2026-10-01T03:12:40.000Z" }
}
```

`last_fault_at` is `null` before any fault. A supervisor can see a server
that is surviving rejections before an operator reads its log.

What happens after an exit 70 depends on the client. The Hermes bridge
restarts the server once; Claude Code and Codex do not restart it, and the
tools stay unavailable until the session reconnects the server. The guard is
installed only on the served transports: `o2b mcp --probe` and every other
`o2b` verb keep the runtime's default behaviour.

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
surface it is seven whatever the tool table's size - the capability
diagnostic, the five always-loaded Brain tools and `tool_hydrate` - and
everything the surface merely hides stays callable through `tools/call`. It
is the advertised number a host's ceiling applies to.

Seven is the no-window count. The window is applied before the count, so a
window that withholds one of those seven lowers `advertised_tool_count` with
it, and a tool the window withheld is not callable through `tools/call`
either - unlike one the catalog surface merely hid. The capability
diagnostic is the one tool no window withholds.

### The handshake instructions follow the window (since v1.56.0)

`initialize.instructions` used to be one frozen string per scope, so a host
that disabled `brain_note` still received a paragraph telling the agent to call
it. The text is now rendered from the same capability report: guidance whose
tool this runtime withheld is REMOVED rather than contradicted, and a block at
the end names each removed tool with the reason the evaluator produced.

A runtime that withholds nothing renders text byte-identical to what shipped
before, so the only difference is in the withheld cases. The one deliberate
exception is in the `catalog` body: the frozen string said every tool omitted
from `tools/list` stays callable through `tools/call`, which holds for the
tools the catalog surface hides and not for the ones a window withholds, so
that sentence now separates the two cases. The block lists the
tools this text would have instructed and cannot, not the whole withheld set -
a `--max-tools` window can withhold over a hundred tools, and pasting that list
into the first thing every agent reads would cost more than the removed
guidance did. On a surface that registers `second_brain_capabilities` the
block closes by pointing there for the complete report; no capability window
ever withholds that tool. The writer scope does not register it at all, so
there the block ends with the names - a handshake sending an agent to a tool
its own server answers `unknown tool` for would be the defect this rendering
removes, reintroduced by the sentence that explains the removal.

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
unknown profile name FAILS CLOSED: `o2b mcp` exits `2` naming the known
profiles and where the bad name came from, rather than serving the full
surface - a typo in a profile meant to narrow an agent's tools must not
widen them (changed in the security hardening release; earlier versions
failed open with a stderr note). Hard-window profiles always retain
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

When the optional `skills` decision-model use is `shadow` or `enforce`,
`skills_attach` also returns `decision_model: { mode, applied, degraded?, model? }`
and, in `enforce`, may offer a subset or reorder of the BM25 shortlist chosen
by two decision requests. The field is absent while the use is `off`, the
default. See [Skill selection](decision-models/skills.md).

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
triggers and marks them delivered (once per `trigger_cooldown_days`) for
a caller at local reach; below local reach it shows no trigger section
and marks nothing delivered, because the queue is the operator's own.
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

The plugin manifest `.claude-plugin/plugin.json` declares **two** MCP-server entries inline under `mcpServers` (there is deliberately no `.mcp.json` at the repository root: Claude Code would also load it as a project config for sessions started in a checkout, where `${CLAUDE_PLUGIN_ROOT}` is unset and both servers fail to spawn):

- `open-second-brain` - the full surface, whose advertised tool count is stated once under "Tool Highlights" above (including the consolidated `brain_brief`, `brain_analytics`, and `schema_inspect`, plus `brain_health`, `brain_mcp_landscape`, `brain_agent_query`, `brain_agent_diff`, `brain_recall_gate`, `brain_pinned_context`, `brain_memory_bridge`, `brain_pre_compress_pack`, `brain_audit`, `brain_sources`, and `brain_switch_vault`) and 18 hidden deprecated aliases listed under "Consolidated views and deprecated aliases" above; subject to Claude Code's `MCPSearch` tool-search deferral when MCP definitions push the system prompt past 10% of the context window.
- `open-second-brain-writer` - a minimal always-loaded surface of five tools: `brain_feedback`, `brain_apply_evidence`, `brain_note`, `brain_pinned_context` (writers) and `brain_context` (read-only pull-bootstrap of `Brain/active.md` plus pinned context, v0.16.0). The agent records taste signals, evidence events, milestone notes, and current-task pinned facts - and fetches the active rule digest at session start in runtimes without a SessionStart hook - without a ToolSearch round-trip on every session boot.

Both servers reuse the same backing CLI (`o2b mcp --scope writer` vs the default `--scope full`), and since v1.70.0 both are registered with `--harness claude-code`. Handlers are byte-identical; the writer-mode instructions text explicitly tells the agent to prefer the writer copy over any duplicate the full server still exposes (both call the same code path).

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

Since v1.64.0 the report can also carry a `near-duplicate` finding: the
authored body scores at least 0.8 Jaccard against an existing page in the
same directory and scope bucket. Exact duplicates were refused before;
close ones landed in silence. The score is computed over the body exactly
as authored, frontmatter is never compared or touched, an unreadable or
over-cap sibling is excluded as a candidate, and the finding never gates
the write - the receipt says what landed next to what.

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

## Source distillation

`brain_distill_source` writes one idempotent distillation page per source
from atomic claims the calling agent supplies. Open Second Brain runs no
model here: it validates the claims, checks every quotation inside them
against the source, and writes the page. The page cites each claim as
`[[source#^block]]` when the claim names a block.

Inputs:

| Argument | Type | Meaning |
| --- | --- | --- |
| `source_path` | string, required | the source identity: a vault-relative path or a URL |
| `claims` | array, required | `{ text, block? }` items; `block` is the source block id (`^abc` or `abc`); at most 1000 per call, and a claim's text is one line |
| `strict_quotes` | boolean, optional | since v1.67.0, refuse the whole write when any quoted span fails the check |
| `excerpt` | string, optional | since v1.67.0, the verbatim text the caller read from a `url-only` source, stored on the page |
| `agent` | string, optional | agent identity override |

Result keys: `distillation_path`, `created`, `claim_count`, `source_hash`
(absent when the source had no bytes to hash), `trust` (`trusted` or
`untrusted`), and since v1.67.0 `capture_scope` (always present) and
`quotes` (present only when at least one claim contains a quoted span).

### The quote check

Since v1.67.0, every quoted span in a claim is checked before the page is
written. A quoted span is the text between a pair of quotation marks in a
claim. A quotation mark is any character with the Unicode
`Quotation_Mark` property, so straight, curly, low-high, guillemet and
corner-bracket quotes all count without a list of languages. Marks pair
by position: an opener follows the start of the text, whitespace or
punctuation other than a mark that just closed, a closer is followed by
the end, whitespace or punctuation. A mark whose Unicode category is
opening or closing punctuation (low-9 marks, corner brackets) is
directional by itself, so corner brackets pair even when glued to CJK
letters. Any other mark with a letter on both sides (an apostrophe
inside a word) is never a delimiter. A closer pairs only with an opener
of its own width (single with single, double with double), so a
possessive apostrophe never ends a double quote. Only the outermost
closed span is checked; a quote inside it is part of its text. A mark
that finds no partner is counted as `unpaired` and left on the page
untouched, and it hides no later quote. A mark separated from its text by
an ordinary space is counted as unpaired, not checked; a single no-break
or thin space, as in spaced guillemets, is allowed. A pair holding fewer
than two letters or digits (`rock 'n' roll`) is not a quote and counts
as two unpaired marks. An empty span is not a quote.

Each span is compared with the evidence after the same normalisation is
applied to both sides: Unicode NFC, inline Markdown reduced to its
display text (paired emphasis and code markers, so `snake_case` and
`2*3` stay as written, `[text](url)`, `[[target|alias]]`,
`[[target]]`), line-leading block markers (on the evidence side only: a
span's own leading `3. `, `- ` or `> ` is wording) and a trailing ` ^id`
removed, quotation-mark variants folded, whitespace runs collapsed. Case,
punctuation and wording are never folded. The normalised span must then
be an exact substring of the normalised evidence that starts and ends on
a word boundary, by the Unicode word rules, so `"safe"` does not verify
inside `unsafe`. A span holding an ellipsis (`…` or three or more dots)
is split there, and every fragment must appear in order without overlap;
an edge next to an ellipsis may fall inside a word. A bracketed insertion such as
`[sic]` is not interpreted and fails as a mismatch. The page bytes are
never normalised; normalisation is used for the comparison only.

The evidence depends on the claim:

- A claim with `block` is compared with that block only. A block id that
  resolves nowhere gives `block-not-found`, an id defined twice gives
  `block-ambiguous`; neither falls back to the whole source, because the
  citation is part of what the page asserts.
- A claim without `block` is compared with the whole source and verifies
  as `verified-in-source`, a weaker outcome than `verified-in-block`.
- A source whose bytes are not valid UTF-8 gives `source-not-text` for
  every span. A source with no local bytes gives `url-only`.
- A vault source the caller may not read at its transport reach (or, with
  `integrity.owner_scope_delivery: fail`, another owner's page) is treated
  exactly as an absent source: every span gives `url-only`, no
  `source_hash` is returned or recorded on the page, the page lands in the
  untrusted lane with `capture_scope: url-only`, and an `excerpt` is
  accepted for it.

The bytes checked are the bytes read once for `source_hash`, so the
verdict and the digest on the page always describe the same content.

**A failed span is unquoted by default.** Its two quotation marks are
removed, the words stay, the write lands, and the result names the
failure. The page never shows an unverified quote. Unquoting changes the
bytes the caller supplied; this is deliberate, the change is reported in
`quotes.findings`, and an identical re-run produces an identical page.

**Strict refusal.** With `strict_quotes: true` the whole write is refused
when any span would be unquoted, and nothing is written. The refusal is a
JSON-RPC error with `INVALID_PARAMS` and `error.data.code` set to
`quote_unverified`; its message names claim indices and outcomes
(`claim 0: not-in-block`), never claim text or paths. Unpaired marks
never trigger a refusal.

The `quotes` report:

| Key | Meaning |
| --- | --- |
| `checked` | quoted spans examined |
| `verified_in_block` | spans found verbatim in the cited block |
| `verified_in_source` | spans found verbatim in the whole source (claims without `block`) |
| `unquoted` | spans that failed and lost their quotation marks |
| `unpaired` | quotation marks without a partner, counted only |
| `findings` | one `{ claim, outcome, span }` per unquoted span: `claim` is the 0-based claim index, `outcome` one of `not-in-block`, `not-in-source`, `block-not-found`, `block-ambiguous`, `source-not-text`, `url-only`, `span` the span text capped at 120 characters |
| `total`, `returned`, `truncated` | the findings list is capped at 25 and declares its own truncation |

A page whose claims held spans carries `quotes_verified` and
`quotes_unquoted` in its frontmatter. A page without spans is
byte-identical to the one earlier releases wrote.

### Capture scope and the excerpt

Since v1.67.0, `capture_scope` says how much of the source the vault
actually holds:

| Value | Meaning |
| --- | --- |
| `full-local` | the source is a file this vault holds |
| `bounded-local` | the source has no local bytes, and the page stores a verbatim excerpt the caller read |
| `url-only` | the source is a URL, or a vault-shaped path with no file behind it |

The page records `capture_scope` in its frontmatter only when the value is
not `full-local`, so a page over a local source stays byte-identical.
`excerpt` makes `bounded-local` reachable: for a `url-only` source the
caller passes the text it read, at most 65,536 bytes of UTF-8. The page
stores it under a `## Excerpt` heading in a fenced block with the info
string `excerpt`, records its sha256 as `excerpt_hash`, and quotes are
checked against it. An excerpt is refused with `INVALID_PARAMS`, before
anything is written, when the source is a file the vault holds (the file
is the evidence), when it holds no text (only whitespace, control or
format characters), when it contains NUL, or when it exceeds the cap.

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
- Since v1.51.0 `brain_extract_signals` joins the surface (111 total): the
  batch counterpart to the regex fact extractor. Called with a `session`
  alone it is read-only and returns that session's imported USER turns plus
  exactly one needs-llm-step envelope; called with `items` it validates the
  mined signals - structurally, then against a per-session cap and a
  per-item confidence floor - and writes the accepted ones into
  `Brain/inbox/` as `source_type: auto_extract` signals, subject to the
  durability denylist and to `Brain/pending/` staging when write approval is
  on. `auto_extract` is a new member of the closed `source_type` vocabulary,
  distinct from `extracted` (regex) forever, because their trust profiles
  differ; a reader from an older build refuses a file carrying it rather
  than misreading it. A payload over the cap or below the floor is refused
  whole, naming the limit and the offending value - nothing partial lands.
- Since v1.51.0 `brain_skill_proposals` accepts two further operations and
  no new tool. `page_candidates` is read-only: it gates the vault's user
  pages on the page-meta trio (`tier: core`, a non-stale lifecycle,
  `_confidence: high`) and an observed-reuse floor, skips any page an
  installed skill already covers, and returns one needs-llm-step envelope
  per admitted page plus every skipped page with the reason and the
  measured value behind it. `page_draft` validates the returned SKILL.md
  draft - structurally, then against the rule that its `name` is a legal
  skill directory name - and STAGES it as a pending proposal under the new
  `mature_page` pattern kind, inside the vault. Nothing reaches the skills
  root until `accept`, which materializes a `SKILL.md` there through the
  same write-ahead journal the procedure branch uses; the journal records
  the absolute path it is about to write, so a rollback removes exactly
  that file (and the directory it created for it, only while empty).
  Sticky rejection applies as it does to every other pattern kind.
- Since v1.51.0 `brain_design_note` joins the surface (112 total): the
  one-shot sibling of the panel lane. Called with a `topic` alone it is
  read-only - it grounds the topic in the vault's tension records, decision
  records and truth projections using the same deterministic token overlap
  `brain_decision`'s similar-decision lookup ranks with, and returns one
  needs-llm-step envelope. A store this vault holds NOTHING in is named in
  `empty_stores`; a store that holds records and matched none of them is
  not, because those are different facts and lead to different next moves.
  An empty vault is a grounded report, never a refusal. Called with a
  `note` it validates the written note - structurally, then against the
  rule that EXACTLY ONE alternative sets `recommended: true` - and commits
  it as `Brain/decisions/design-<date>-<topic>.md`, beside the panel
  outputs. Zero and two-plus recommendations are both refused and the
  refusal states the count found; a note for the same topic on the same day
  is refused rather than overwriting the first.
- Since v1.52.0 the three needs-llm-step lanes whose artifact is a wikilinked note -
  `brain_diarize`, `brain_design_note`, and the dream pass's rollup rungs -
  additively carry `link_candidates` on their envelope: the note basenames a
  `[[wikilink]]` in the answer can actually resolve to, with the `total` the
  vault holds and a `truncated` flag when the bound could not carry them
  all. It is built from the basename walker alone - no embedding, no vector
  store, no index - and a truncated manifest says so in its own schema hint
  rather than reading as the whole vault. The envelope spine is unchanged
  and the three lanes that produce no wikilinked note (`brain_extract_signals`,
  `brain_skill_proposals` page drafts, `brain_write_session`) carry nothing new.
- Since v1.52.0 `brain_extract_signals` is the one lane that commits SEVERAL artifacts from
  one validated payload - a file per mined item - so its result additively
  carries `reconciliation` (`attempted` / `found` / `missing`, the missing
  keys named, in the wave's shared vocabulary; a deduped or gate-rejected
  item is a named refusal, not an attempted write). A commit that fails part
  way still refuses with the same accounting AND the first real error, never
  a partial success, and now also leaves a durable record of the partial
  write under `<vault>/.open-second-brain/dead-letters/` - the new
  `write_dead_letters` state surface - so a caller that drops the response is
  not the only record that it happened. Nothing in this tool removes a dead
  letter; `o2b state status` names the location and the records are listable
  from core. Single-artifact lanes are deliberately excluded: their one
  failure IS the response. No new tool - the surface stays at 113.
- Since v1.53.0 `brain_context_pack` reads its `query` two ways. The default is
  the substring filter it has always been - a case/Unicode-insensitive match
  against `topic + principle`, every miss dropped with a `filter-miss` skip -
  and an omitted `query_mode` keeps that reading byte-identical. `query_mode:
  "ranked"` instead ORDERS the curated candidates by structural token overlap
  (the same deterministic, stopword-free kernel the rated-decision matcher
  uses - no model, no embedding, so it works on an install that has never
  indexed a vector) and excludes none of them, so a natural-language turn
  prioritises the budget rather than emptying the pack. `query_mode` requires
  `query`; the schema states the pairing as `dependentRequired` and the
  handler refuses a mode with nothing to read. Everything the lane exists for
  - the containment guard, the curated preference pool, the tombstone and
  supersession-tip filters, owner-scope delivery, `max_tokens`, the named skip
  reasons, and the server-issued `receipt_id` - applies unchanged in both
  modes. The tool also stops discarding the report's `warnings`: injection-time
  tension warnings and the owner-scope observation now reach the caller as
  `brain_pre_compress_pack` has always passed them, absent when empty. No new
  tool - the surface stays at 113.
- Since v1.54.0 a page may RESERVE itself against remote reads, and the
  reservation is enforced rather than advisory. A vault page whose
  `visibility:` frontmatter carries the reserved token is not returned, not
  counted, and not named in an error when the request arrived at `remote`
  reach. The other visibility tokens are unchanged: they remain opaque,
  caller-scoped view filters, and the caller's own `visibility` argument
  still narrows exactly as before - what it can no longer do is name the
  reserved token and be handed the page. A vault that never wrote the token
  sees no change.
- Since v1.54.0 the reach a request arrived at is MINTED by the transport
  and refused when a caller supplies it. stdio mints `local`, because the
  caller started this process and holds whatever filesystem access it runs
  with. An HTTP bind mints from the bind host alone: loopback is `local`,
  every other interface is `remote`. The value is set after the caller's
  runtime options are spread, so a runtime option cannot claim a reach the
  bind did not establish, and a `Host` header is never read for it. A
  `tools/call` carrying a reach-shaped argument is refused with `-32602`,
  the refusal token `caller-supplied-reach`, and structured `data`
  (`tool`, `refused_arguments`, `reserved_argument_names`). The check runs
  ahead of the unknown-argument gate and does not consult the tool's
  schema, so an open schema is covered too; argument names are compared
  case-folded and separator-free, so `reach`, `transport_reach` and
  `transport-reach` are one argument rather than three. `disclosure` is
  deliberately not reserved - it is the unrelated result-depth mode on the
  recall surfaces.
- Since v1.55.0 a write attempted while the vault is FROZEN
  (`o2b brain freeze`, marker `Brain/.state/frozen.json`) is refused with
  `-32602`, the refusal token `vault_frozen`, and structured `data`:
  `code`, `tool`, `frozen_at`, `by`, `reason`, and
  `next_command: "o2b brain unfreeze"`. The refusal is raised by the vault
  write guard, so it covers every tool that puts bytes in the vault -
  including the internal writers a tool composes - rather than a list of
  write tools somebody maintained. Each refused call also appends one
  `write-refused` event to the Brain log naming the tool, the caller and
  the marker's reason; when that append itself fails, the payload carries
  an `audit_reason` saying why rather than reporting a record that does
  not exist. No MCP tool sets or clears the freeze: lifting one is an
  operator decision about a fleet an agent cannot see, so `freeze` and
  `unfreeze` are CLI-only. `brain_status` reports the state as
  `frozen: null | { frozen_at, by, device_id, reason }`.
- Since v1.54.0 a withheld page is reported exactly as an absent one. On
  the key-addressed reads - a chunk id, a preference id, the templated
  `osb://` readers - the message is byte-identical to the one an absent
  subject produces, because both key spaces are enumerable and a
  distinguishable refusal would be an existence oracle over exactly the
  population the boundary hides. What the `local` bypass proves is
  filesystem-equivalent access, or a request that originated on this host.
  It does NOT prove operator intent: a remote host can spawn a stdio
  subprocess. The alternative - no bypass at all - would take an operator's
  own reserved notes away from the operator's own shell.
- Since v1.55.0 every note write is attributable. `brain_create_note`,
  `brain_update_note`, `brain_append_note` and the note operations of
  `brain_write_batch` each append exactly ONE `note-write` log event carrying
  a write id, the operation, the target path, the content hash and byte size on
  both sides, and the agent the server's own config names; the bytes an update
  or append replaced are kept content-addressed under
  `Brain/.state/write-images/<sha256>` so a recorded write can be undone from
  what it displaced. The bytes land BEFORE the event is appended, which is the
  ordering that keeps a log failure from failing a write - and the receipts say
  so rather than staying silent: every note-write receipt carries `write_id`,
  and `write_id: null` arrives with an `audit_reason` naming what went wrong. A
  skipped create (`if_exists: "skip"`) authored no bytes, so it carries no
  `write_id` at all. `brain_writes` reads the record back. One new tool - the
  surface moves from 113 to 114.
- With the optional decision-model turn pre-filter (`extract_prefilter`, see
  [`decision-models/extract-prefilter.md`](decision-models/extract-prefilter.md)),
  the `brain_extract_signals` plan may additively carry `turns_dropped` (turn
  ids left out of the envelope; `turns_mined` then lists the kept turns),
  `skipped: { reason: "decision_model_prefilter", turns_dropped }` with
  `llm_step: null` when every turn scored below the threshold (nothing to
  mine, distinct from the no-user-turns refusal), and
  `decision_model: { degraded }` when a request failed and every turn was
  sent. With the use `off` none of these fields appears. Commit items accept
  an optional string `source_turn` naming the plan turn a rule came from.
- Advisory decision-model fields (optional, see
  [decision-models/dedup-tension.md](decision-models/dedup-tension.md) and
  [decision-models/labels.md](decision-models/labels.md)). All of them are
  absent, and every output is byte-identical, while the use is off. With the
  `dedup` use in enforce, `brain_hygiene scan` dedup findings and
  `brain_doctor` `entity-alias-candidate` warnings gain
  `decision_model: { verdict, probabilities, model, calibrated }`
  (`same | related | different`); a confident `different` is listed last with
  `decision_model_low_priority: true`, never hidden. `brain_tension` gains the
  read-only `verify` action (`slug` optional; without it every unresolved
  tension) returning `available`, `mode` or `reason`, and the rows with the
  same field (`contradicts | compatible | unrelated`; a confident `compatible`
  or `unrelated` is listed last). `brain_labels` gains the read-only `suggest`
  operation (`path`, optional `dimensions`) returning per dimension
  `{ dimension, suggestion, probabilities, confidence, current, model,
  calibrated }`, `suggestion: null` in shadow, for `none` and below the
  confidence threshold; `{ available: false, reason: "decision_model_off" }`
  while the use is off, and a private note is refused. None of these writes to
  the vault, and `suggest` never assigns.
- Since v1.62.0 the ingest plan accounts for what it sets aside. Every
  `skipped_non_extractable` entry carries a `reason` from a closed, typed
  set and a `detail` naming the value behind it (the legacy free-text
  sentence still parses as input); `skipped` stays a list of path strings
  for unchanged files. The plan adds `skip_reason_counts` per reason, and extensionless regular files nothing
  can classify are counted in an `unclassifiable` object (`total`,
  `by_extension`); both keys are absent while empty, so a plan with nothing
  set aside serializes exactly as before. Note receipts gain an optional
  `path_advisory` when authored content mentions an absolute host path -
  absent when the content is clean, and never present for log-line
  operations; the advisory never blocks the write. `brain_doctor` reports
  `orphan-session-ref` warnings whose `fix` field names
  `o2b brain orphan-repair`, and an embeddings-health verdict
  (`embeddings-backlog`, `embeddings-census-unrecorded`,
  `embeddings-health-unmeasured`) that is fail-soft: an unrecorded census
  lands in `uncertain`, never in healthy.
- Since v1.63.0 `brain_write_batch` accepts an optional string `request_id`
  (at most 256 characters after trimming) that makes a retried batch apply
  once. With it, the result gains `request_id` and `receipt`:
  - `applied`: this call committed the batch and recorded the ID.
  - `duplicate`: the same ID with the same operations was already recorded.
    Every other field is the retained result of the call that committed;
    nothing is written, re-validated or linted.
  - `concurrent_duplicate`: this call committed, but a concurrent call
    recorded the same ID and payload in between. Both writes landed and the
    fields are this call's own.
  - `payload_conflict`: this call committed, but a concurrent call recorded
    the same ID for a different payload in between. The writes landed and
    this call's receipt is not recorded; a `receipt_note` says so and that
    the batch must never be resent under a new `request_id`.

  The same ID with different operations, found before any write, is refused
  with `INVALID_PARAMS` and the idempotency ledger's mismatch message; a
  blank ID, one over the cap or a non-string value is refused with
  `INVALID_PARAMS` before any write. The receipt is recorded in the
  idempotency ledger after the commit, with its log paths vault-relative
  (a duplicate rebuilds them under the vault serving the retry), under its
  own `write_batch` key space, so a request ID never collides with a
  `brain_feedback` or `brain_apply_evidence` `idempotency_key` of the same
  text. The one exception is a peer still running v1.62.0, which ignores the
  key space: there a feedback key equal to a synced batch request ID is
  refused with the named idempotency mismatch error, never silently
  deduplicated, until that peer is upgraded. Without `request_id` none of
  these keys appears and the payload is unchanged.
- Since v1.63.0 `brain_search` accepts `match_mode`: `all` (the default)
  requires every term, `any` matches a document carrying any one term.
  Caller-typed `AND` / `OR` / `NOT` / `NEAR` tokens are dropped in both
  modes, and an `any` search is cached apart from an `all` one. `match_mode`
  (`all` | `any`) and `disclosure` (`full` | `cards`) are literal enums; any
  other value is refused with `INVALID_PARAMS` naming the accepted values.
  The `brain_search` description now ends with a when-to-search cue: when a
  query misses, consult `brain_recall_gate` before widening recall.
- Since v1.63.0 `brain_ingest_source` with `pre_extract` adds `uses` edges
  from `.tsx` / `.jsx` sources to the components their opening tags name,
  and an `imports` seed whose relative specifier (`./` or `../` in
  TypeScript and JavaScript, leading-dot in Python) names exactly one
  ingested file carries `resolved_to`, that file's vault-relative path. A
  specifier that climbs above the vault root, or matches no file or several,
  binds nothing; `to` always keeps the raw specifier.
- Since v1.63.0 the `brain_doctor` `sync-conflict-log` finding also sweeps
  the audit week directories (`Brain/log/session-lifecycle/`, `hygiene/`,
  `secret-custody/`, `watchdog/`, `schema-mutations/`), the hook-audit and
  watchdog-audit directories under `.open-second-brain/`,
  `Brain/skill-proposals/`, `Brain/preferences/` and each repository
  directory under `Brain/projects/git/`; a directory it cannot list lands in
  `uncertain`. In the directories that also hold whole files, a conflict copy
  that is not a `.jsonl` shard (a proposal file, a preference note, a git
  `state.json`) keeps the same code with the whole-file remedy: compare it
  with the original, keep the right version by hand, then delete the copy.
  The maintenance journal's `.open-second-brain/` root is not swept.
- Since v1.64.0 `brain_maintenance` (`run`) takes `force_cost`, which
  bypasses a positive embedding cost gate for this run's reindex and is
  recorded on the spend receipt when it did. The reindex task stays
  keyword-only unless config `maintenance_embeddings` is `true` (env
  `OPEN_SECOND_BRAIN_MAINTENANCE_EMBEDDINGS`); with it, the task requests
  the embedding phase whenever the resolved semantic config can reach a
  provider, and the spend preview is computed inside the task, so a run a
  gate skips carries no `spend` block. The result gains an additive `spend` block - the `banner`
  estimate announced before the pass, and the `receipt` (model, tokens,
  `estimated_usd`, `forced`) the completed pass priced, also carried on its
  task row and journaled on the `maintenance_spend` metrics surface. A run
  killed mid-spend receipts nothing; a pass killed at its safeguard
  deadline is a `timed_out` row. `brain_hygiene`'s `detectors` enum
  widens to `slug-collisions` (default-on; same-stem allocation residue in
  one directory) and `tags` (opt-in; inline body tags only - malformed,
  inconsistent and orphan findings, never frontmatter tags arrays), and the
  default is the sweep of every registered detector except the opt-in ones.
  The `lint` key on note-write receipts can carry `near-duplicate`
  findings: an authored body at 0.8 Jaccard or above against an existing
  page in the same directory and scope bucket, advisory like every lint
  finding. `brain_doctor` reports `merge-chain-dangling` warnings for a
  `merged_into:` pointer whose canonical resolves to no file - reporting
  only, with the repair named as the content judgement it is.
- Since v1.65.0 `brain_maintenance` (`run`) also runs the custom lane tasks
  an install declares in its machine config (`maintenance_custom_<name>`,
  behind the default-off `maintenance_custom_tasks` switch), after the four
  built-ins and under the same gates; they appear as `custom:<name>` task
  rows. `retry_tasks` accepts `custom:<name>` for a declared task, refuses
  an undeclared one by name with the registered list, and refuses a list
  longer than the tasks this install registered; the schema `maxItems` is
  the built-ins plus the custom-task cap of 8. A refused declaration comes
  back in `custom_task_errors` while the valid tasks still run. No argument
  can add, edit or read a command: commands live only in the machine
  config, never in the vault. Once the switch is on, a caller with
  `force: true` and `retry_tasks` can run the declared commands whenever
  it calls, past the window and busy gates; leave the switch off on a
  server whose callers should not. A task runs from the home directory
  unless it declares a `_cwd`, without the variables whose names declare
  a credential, and its background processes are killed with its process
  group at its timeout or when the server exits. A duplicated
  `retry_tasks` entry counts once, and the `status` notice names the env
  override when that turned the tasks off.
- Since v1.67.0 `brain_distill_source` checks quoted spans in claims
  against the cited block or the source, unquotes a span that fails and
  reports it under `quotes`, refuses the write with `quote_unverified`
  under `strict_quotes: true`, accepts a bounded `excerpt` for a
  `url-only` source, and always returns `capture_scope` (see "Source
  distillation"). `brain_ingest_source` returns `capture_scope`;
  `brain_intake_entities` and `brain_ingest_source` treat a cited vault
  file the caller cannot read at its reach as an absent source (untrusted
  lane, no `source_content_hash`, `url-only`);
  `brain_research_report` returns `capture_scopes`, one per entry of
  `sources` in the same order, and stamps a `capture_scopes` frontmatter
  list when any source is not `full-local`; a source written without an
  extension is matched against its `.md` note, and a source backed by a
  vault file the caller cannot read at its reach is reported `url-only`,
  the same answer as an absent file; a cited file the filesystem refuses
  to stat never aborts the report and reads `url-only`; a title holding a
  line break is refused. `brain_hygiene` gains the
  default-on `capture-scope` detector: a retrievable page of active
  knowledge whose every cited source is currently `url-only` gets a
  `warning` finding with `proposed_action: review`. The scope is
  re-derived from each source identity at scan time, so a page whose
  local source was deleted reports as `url-only`, and a `bounded-local`
  page counts as backed only while its excerpt still matches
  `excerpt_hash`. Quarantined pages (those carrying the untrusted
  marker) are skipped; the marker already names the condition. A cited
  file the caller cannot read at its reach counts as `url-only` for that
  caller, in the scan and in the `brain_status` hygiene count. Below
  local reach the scan's `link_integrity` reports `measured: false` with
  reason `reach`, because its counts are taken over the whole index.
  `brain_ingest_batch_plan` plans a file the caller cannot read at its
  reach as an absent one (visibility is a rule over Markdown pages, so the
  plan's `unclassifiable` counts of other files are the same at every
  reach), and `brain_ingest_source` records a source in
  the content manifest only in the trusted lane.
- Since v1.68.0 more readers treat a record the caller cannot read at its
  reach as absent. `brain_context`, the `osb://preferences/active`
  resource and `brain_pre_compress_pack` hand a remote caller the active
  digest without such a preference or retired record: its line, its
  count and its most-applied entry go, and the pack's top-K walk skips
  it. A remote caller always gets that render, stamped with the file's
  `generated_at`; a local caller with no owner scope still gets the
  file's own bytes. `brain_brief` `view="digest"`, the
  `osb://digest/latest` resource and the `osb://lessons` resource do the
  same for the activity and lessons digests: such a record, its rows,
  its counts, the log events naming it and their share of the agent
  summary go, and a remote digest neither takes a report snapshot nor
  shows its delta. `brain_brief` `view="morning"` leaves such a
  preference out of its list, and below local reach it shows no pending
  trigger and marks none delivered. The resource also follows the owner gate now, as
  `brain_context` does, so under `integrity.owner_scope_delivery: fail`
  it answers with the caller's own view. `brain_health` drops a finding
  any of whose members the caller cannot read, and `brain_doctor` with
  `repair` derives its plan only from findings the caller can read: such
  a record is neither planned, counted under `unfixable`, nor written by
  `apply`. The generic page readers (`brain_search` and every other
  tool that reads a page by path) no longer return the compiled digest
  pages `Brain/active.md` and `Brain/lessons.md` to a remote caller,
  because those pages compile records that may be reserved; a remote
  client reads the active digest through the three readers above and the
  lessons digest through `osb://lessons`.
  `brain_ingest_source` with `pre_extract` reads Terraform
  (`.tf`, `.tfvars`) and redacts credentials in import specifiers
  (see `o2b brain pre-extract` in
  [`cli-reference.md`](cli-reference.md)).
- Since v1.69.0 ingest reads more than Markdown. One format registry
  maps a file's extension to a format: Markdown and the lightweight
  markups (`.md`, `.markdown`, `.txt`, `.text`, `.rst`, `.org`) are read
  as they are, CSV, TSV and HTML (`.csv`, `.tsv`, `.html`, `.htm`) are
  extracted, and PDF, the Office formats (`docx`, `xlsx`, `pptx`, `odt`,
  `ods`, `odp`), EPUB, RTF and images are named but not extracted.
  `brain_ingest_batch_plan` plans CSV, TSV and HTML files by default, and
  a planned file whose format is not text carries `format` beside
  `status`. A file of a named format that is not extracted is listed in
  `skipped_non_extractable` with reason `format-not-extractable` and the
  format as `detail` (before the schema skips, and counted in
  `skip_reason_counts`) instead of adding to `unclassifiable`; an
  `extensions` override that lists its extension still plans it.
  `brain_ingest_source` derives a section from an HTML, CSV or TSV file
  in the vault, by format and with no new argument, in the trusted lane
  and only from a file the caller can read at its reach. The page gains
  `source_format` and `source_content_hash`, and the derived section
  comes after `## Connections to existing notes`. For HTML, `## Parts`
  holds one fenced block with one line per heading, `h<level> <trail> |
  lines <a>-<b>` (the trail joins the ancestor headings with ` > `, the
  line span is 1-based in the extracted text), never body text: at most
  256 parts, each heading capped at 200 characters; the result gains
  `parts` (`{extracted: true, count, omitted?}` or `{extracted: false,
  reason}`). For CSV and TSV, `## Table` holds fenced plain-text row
  groups under `### Rows <a>-<b>`. The first record is always the header,
  and every group repeats it, so each search chunk of the page carries
  it, except the later pieces of a single row longer than a group's
  token budget, which can still be split across chunks; a group holds at
  most 50 rows and 600 tokens. A `.csv` file is read as
  semicolon-delimited when its first record has at least two fields on
  semicolons and more than on commas. Cells are joined by ` | `; inside
  a cell a backslash, `|`, a backtick, a line feed, a carriage return
  and a tab are written as `\\`, `\|`, ``\` ``, `\n`, `\r` and `\t`, and
  every other control character (C0, DEL and C1) as `\u{XXXX}` with its
  code point in four uppercase hexadecimal digits, so no cell can end the fence or reach a
  terminal raw. The caps are 1,000 rows, 64 columns, 256 characters per
  cell and 256 KiB per section, and each cut is named in
  `table_truncated`; only the first 4,096 code units of a cell are read
  for redaction, and a longer cell counts as cut. A `<private>` region
  is hidden before the records are split, so a region spanning records
  hides every row between its tags. Each HTML heading is redacted
  (`key=value` credentials and URL userinfo) before it is capped, only
  its first 4,096 code units are read for that (a longer heading ends in
  `…`), and in the parts list a backslash in a heading is written as
  `\\` and a `|` as `\|`. The page gains
  `table_delimiter`, `table_columns`, `table_rows`,
  `table_rows_rendered` and `table_truncated` (absent when nothing was
  cut); the result gains `table` (`{rendered: true, format, delimiter,
  columns, rows, rows_rendered, truncated?, redacted_cells}` or
  `{rendered: false, format, reason, detail?}`, with reasons
  `source-not-local`, `not-utf8`, `contains-nul`, `malformed-quoting`
  and `empty`). Every value in a column whose header names a credential
  is replaced, and every other cell goes through the output redactor
  with URL credentials included; `redacted_cells` counts both. A
  credential no pass recognises stays on the indexed page and in its
  embeddings, as it already sits in the file in the vault. A summary page
  that carries a derived section is at most as visible as its source: it
  takes on the source's own `visibility` tokens; when the page already
  had a `visibility`, it gets the audience both the operator and the
  source allow; when they share none, the page is withheld below local
  reach. A leading frontmatter block in an
  HTML, CSV or TSV source is not extracted, so it is never read as table
  data or text. A URL source, an absent file and a file the caller
  cannot read at its reach all answer `source-not-local`, with no digest and no section. A Markdown or
  text source has no `parts` and no `table` key and its page is
  unchanged. An operator-set `visibility` on a summary page is now kept
  when its source is ingested again. `brain_recall_gate` accepts an
  optional `turn_id` (a string of at most 512 characters), recorded on
  the `gate_telemetry` record, and refuses a `turn_id` or `session_id`
  over 512 characters or a `telemetry_host` over 200 with
  `INVALID_PARAMS` before it runs, with telemetry on or off. The recall
  verdict's root coverage and the ids of the daily and weekly
  `brain_brief` views answer at the caller's reach: below local reach a
  root counts as reached only through a page the caller can read, and
  the daily and weekly views leave out the status transitions,
  retirements and contradictions that name a record the caller cannot
  read (under its `pref-` or its `ret-` id), withhold a source pointer
  when every evidence event citing it is about such a record, or when
  the pointer names a page the caller cannot read, recompute the
  `events_by_kind` and `vault_delta` counts from the events the caller
  may see, and take no report snapshot and show no `delta`. Since
  v1.70.0 the today, monthly and operator views answer at the caller's
  reach too; only the operator view's `dream_summary` counts, and the
  dream warnings its trust verdict folds in, still count over the whole
  Brain layer, and they name no record. The read-only preview of the same
  extraction is the CLI verb `o2b brain extract` (see
  [`cli-reference.md`](cli-reference.md)).
- Since v1.69.0 more readers treat a page or record the caller cannot
  read at its reach as absent; a local caller and the CLI see no change.
  Below local reach the daily log pages (`Brain/log/`, the JSONL
  sidecars included) are not served by the generic page readers
  (`brain_search` and every other tool that reads a page by path).
  `brain_analytics` `view="timeline"`, `view="belief_evolution"` and
  `view="concept_synthesis"`, `brain_brief` `view="today"`,
  `view="digest"` and `brain_event_trace`, `brain_claims` (current and
  history), `brain_backlinks` and `osb://backlinks/{id}`,
  `osb://log/{date}`, `osb://topic/{topic}`, `osb://preference/{id}`,
  `brain_query` with `since`, `topic` or `preference`, `brain_moc_audit`
  and every `brain_doctor` finding answer at the caller's reach: a record
  is judged under each id it answers to (`pref-` and `ret-`), a log
  entry naming such a record is dropped before any limit or total, and a
  dream shared with a readable record is kept with its readable
  transitions only. `osb://log/{date}` re-renders the day from the kept
  entries. A refused preference or hub answers as an absent one, and a
  refused MOC member is neither listed nor sized. The `brain_doctor`
  findings `orphan-evidence` and `malformed-evidence-range` now carry
  `sources` (the preference the evidence is about) and
  `removed-tool-reference` carries `path` (vault-relative on the wire),
  so each names its record structurally; the messages are unchanged.
  `brain_search_by_source` and `brain_delete_by_source` honour the reach
  of a derived summary page: such a page, and the content-manifest entry
  of a source the caller cannot read, are left out of the answer and
  left in place. A `brain_ingest_source` below local reach leaves a
  summary page the caller cannot read untouched and answers as a first
  ingest would. An entity intake of a source that is reserved against
  remote reads records no `source_content_hash`. A byte-order mark
  before a frontmatter block no longer hides that block, so its
  `visibility` applies to the page. The empty-search coverage verdict no
  longer counts a root as reached through a page the caller cannot read.
  Some counts still run over the whole Brain layer and name no record:
  the operator view's `dream_summary` counts (and the dream warnings its
  trust verdict folds in) and the status views; the ranking statistics of `brain_search` are taken over
  the shared index.
- Since v1.70.0 `brain_context` renders the operator's scoped rules for a
  local caller. After the standing-rules block, and before the memory
  body, `content` carries a `## Scoped operator rules` block built from
  `Brain/standing-rules/project/<key>.md`,
  `Brain/standing-rules/harness/<harness id>.md` and
  `Brain/standing-rules/host/<device id>.md`, the files whose key matches
  the scope the server resolved: the project from the nearest
  `.o2b-vault.json` pointer above the directory the server was started
  in, the harness from `--harness` (falling back to `--host-target`) and
  the host from the device id. The result then carries an optional
  `scoped_rules` key, present only when at least one file matched or the
  block carries the notice that host-scoped rules were not applied:

  ```json
  {
    "scope": { "project": "proj-x", "harness": "claude-code", "host": null },
    "files": [
      { "path": "Brain/standing-rules/project/proj-x.md", "axis": "project", "truncated": false }
    ]
  }
  ```

  `path` is vault-relative, `axis` is `project`, `harness` or `host`, and
  `truncated` is `true` for a file the `active.scoped_rules_max_chars` cap
  cut; `brain_context` has no injection budget, so the cap applies as
  configured. The tool renders the notice that host-scoped rules were
  not applied, with `scope.host: null`, when the device id cannot be
  resolved but the call can still be answered, for example when no
  device id is stored yet and the configuration directory cannot be
  written; an unreadable configuration file, or a config home that
  cannot be created, fails the whole call first. The tool gains no
  input argument. Below local reach neither the
  block nor the key appears: the output is the same as for a vault
  without the directory. Every write tool refuses a path inside
  `Brain/standing-rules/`, as it refuses `Brain/standing-rules.md`. See
  "Scoped operator rules" in [`how-it-works.md`](how-it-works.md).
- Since v1.70.0 more brief and doctor counts answer at the caller's
  reach; a local caller and the CLI see no change. Below local reach
  `brain_brief` `view="today"` lists no open loop or obligation from a
  page the caller cannot read and counts only the files it may read in
  `scannedFiles`; `view="monthly"` counts events, status transitions,
  retirements, contradictions and neglected areas from the events the
  caller may see, the same rule as the daily and weekly views;
  `view="operator"` takes its doctor counts from the findings the caller
  may see, its digest counts from readable pages, its top actions from
  readable targets before the top entries are picked, its verification
  entries and their counts from the records and pages the caller may
  read, and recomputes its trust verdict from those; and `brain_doctor`
  fills the cap on `removed-tool-reference` warnings and the per-code
  cap of its `uncertain` stream from readable pages, counts the
  stale-dependency note's `states_changed` and each stale row's
  consumers from the pages and records the caller can read (a withheld
  page is neither a state nor a consumer), runs its concept-gap and
  contradiction detectors over readable preferences and signals only,
  and leaves out an `instruction_file_warnings` entry for a vault-root
  instruction file the caller cannot read; the operator view's
  `instruction_file_warnings` follow the same rule.
- Since v1.70.0 more readers answer at the caller's reach; a local
  caller and the CLI see no change. Below local reach
  `brain_obligation` lists, shows, completes and removes an obligation
  page the caller cannot read exactly as an absent one (`show` answers
  `present: false`, `done` and `remove` refuse with `no obligation`),
  `remove` leaves `archive_path` out of its answer, and `add` still
  refuses a slug whose page exists. `brain_intention` treats a chain the
  caller cannot read the same way (`list` leaves it out, `show` answers
  `present: false`, `move` refuses with `no active intention`), `move`
  leaves `archive_path` out, and `set` refuses a scope whose withheld
  chain exists instead of folding it into a new version. `brain_health`
  computes `concept_gaps`, the `suppressed` counts and the verdict
  over the preferences and signals the caller can read, so a term only
  withheld principles carry is not reported. `brain_trigger`
  `operation="scan"` builds its candidates from readable records only,
  so `candidates` counts none the caller cannot read and the scan
  writes no trigger about such a record; every trigger row and
  transition treats a trigger naming such a record as absent.
  `brain_stale_scan`, `brain_review_candidates` and `brain_retention`
  list no preference or signal the caller cannot read, and
  `brain_retention` counts its `summary` over the rows it returns.
  `brain_review_candidates` plans its dry run over the signals,
  preferences and retired records the caller can read, so its
  `clusters_below_threshold` and `intent_reviews` fold no withheld
  signal, and `brain_intent_review` folds the same readable records.
- Since v1.70.0 `brain_context_receipts` answers at the caller's reach
  for the operator rules. Below local reach a SessionStart injection
  receipt leaves out the `standing-rules` and `scoped-rules` items,
  their source references and every figure that counts or measures
  them (the item count, the whole-text hash and lengths, the total bytes
  and tokens, `scoped_rules_chars` and `budgeted_source_count`), and
  `summary` leaves them out of its item totals, counting a receipt left
  with no item in `empty_receipts`. A measured injection receipt whose
  every item was an operator-rule block (a session with no `active.md`
  body) is left out of `list` and `summary` before their limit and fold
  bound, and `show` answers it with `receipt not found`; the `budget`
  block is dropped from a receipt that has no budgeted body left. A
  stored receipt is otherwise returned as recorded, with no visibility
  check at read time.
- Since v1.70.0 `brain_doctor` with `repair` runs the checks behind its
  plan over the pages and records the caller can read, so below local
  reach the `unfixable` counts (the removed-tool cap, the concept gaps)
  are the counts a vault without the withheld pages gives.
- Since v1.70.0 `brain_tension`, `brain_lifecycle` and `brain_expire`
  answer at the caller's reach; a local caller and the CLI see no
  change. Below local reach `brain_tension` `detect` reads only the notes
  the caller may read (`scanned_files` counts those) and pairs nothing
  from the others; a persisted tension page carries the stricter
  `visibility` of its two source notes, and `list`, `verify` and `show`,
  `confirm`, `dismiss` and `resolve` treat a tension page the caller
  cannot read as absent (`no tension: <slug>`). `brain_lifecycle`
  `tombstone`, `supersede` and `temporal-replace`, and `brain_expire`,
  refuse a page or record the caller cannot read with the error a
  missing one gets (`note does not exist: <path>`, `no signal or
  preference with id`), before anything is written; `brain_lifecycle`
  `curator` leaves out a row whose key names such a page or record.
- Since v1.70.0 the writers that name a preference, a premise, a
  decision, a label target, a stub source or a chain id answer at the
  caller's reach; a local caller and the CLI see no change. Below local
  reach a page or record the caller cannot read is treated as absent
  before anything is written: `brain_apply_evidence` and the
  `apply_evidence` operation of `brain_write_batch` refuse it as a
  missing preference, `brain_derive_fact` as a missing premise,
  `brain_decision` `show`, `outcome` and `rate` with `no decision:
  <slug>` (and `list`, `compare`, `history`, `recall` and `similar`
  leave it out), `brain_labels` `assign` and `remove` with `note does
  not exist`, `brain_scaffold_stub` as an unknown source (and `list`
  leaves it out), and `brain_lifecycle` `tip` reads it as an unknown id.
  The `brain_feedback` conflict and routing hints score only
  readable preferences and signals, and `brain_design_note` grounds only
  on readable tensions and decisions.
- Since v1.70.0 `brain_dream` serves only a dry run below local reach,
  planned over the records the caller can read; a real pass, a single
  step and the staged lifecycle are refused, and `brain_maintenance`
  `run` is refused too (its `status` still answers). A preference the
  dream pass drafts carries the strictest `visibility` of the signals it
  is drafted from and of the record it supersedes or rebuts, at every
  reach.
- Since v1.70.0 `brain_dead_ends` `list`, `brain_diarize`, `brain_hygiene`
  `mode="refresh"` and `brain_anticipatory_context` answer at the
  caller's reach. Below local reach `brain_dead_ends` lists only readable
  dead ends and `record` leaves out the archived ids; `brain_diarize`
  answers a subject page the caller cannot read as an unknown entity and
  takes no evidence from a source page it cannot read; `refresh` plans,
  re-derives and archives only readable derived pages; and
  `brain_anticipatory_context` builds its bundle for the caller without
  reading or writing the shared cache, answering `cache_state: "miss"`.
- Since v1.72.0 `brain_context_pack` accepts `query_mode: "semantic"`,
  which orders the curated belief notes by the stored vectors of their
  chunks against one embedding of `query` (it still requires `query`).
  The response gains a `semantic` object: `model`, `price_source`,
  `query_tokens`, `estimated_usd` (null when the price is unknown),
  `scored` and `unembedded` (kept candidates with no usable vector, which
  sort after the scored ones within the same tier, then by recency;
  tier still decides first). The
  counts are taken after the reach filter, so a withheld page appears in
  neither. The mode refuses with a stable `error.data.code`: the semantic
  capability codes (`EMBEDDING_DISABLED`, `EMBEDDING_KEY_MISSING`) for a
  blocked tier, `VEC_EXTENSION_UNAVAILABLE`, and `BELIEF_VECTORS_MISSING`
  when no kept candidate has a usable vector, naming
  `o2b search vector-backfill --path Brain/preferences/ --path Brain/retired/ --apply`.
  The query embed is one paid call per request, disclosed in the
  response, and refused with `EMBEDDING_COST_UNPRICED` for a remote
  caller when the model has no known price and `embedding_cost_gate_usd`
  is positive. `query` is capped at 2000 characters in every query mode,
  counted in Unicode code points as the schema's `maxLength` counts them,
  and `brain_search` counts its 2000-character cap the same way.
  `brain_recall_feedback`, which advertised the same cap without checking
  it, now refuses a longer `query` with `INVALID_PARAMS` before it records
  anything. The
  `substring` and `ranked` modes are otherwise unchanged. The embedding spend
  surfaces also change: `EMBEDDING_COST_UNPRICED` joins the stable error
  codes (an embedding run refused under a positive cost gate because the
  model has no known price), `brain_maintenance` spend receipts carry
  `price_source` with a null `estimated_usd` for an unknown price. No new
  tool.
