# Updating Open Second Brain safely

Open Second Brain installs into version-rotating plugin caches (Claude Code:
`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`; Codex: a local or
git marketplace snapshot). **An update must never break an existing install or
the agent.** This document is the contract that guarantees it, for both
operators and any agent that edits the plugin.

## Upgrading from 0.x to 1.0.0

1.0.0 is the first major release and ships exactly one breaking
change: the 18 hidden MCP alias tools left over from the token-diet
consolidation are removed. They were already absent from `tools/list`;
since 1.0.0 calling one through `tools/call` answers an INVALID_PARAMS
tombstone naming the replacement instead of executing. Everything else
- CLI verbs, config keys, on-disk formats, the search schema ladder -
is unchanged and now formally frozen under the stability policy
([`docs/stability.md`](stability.md)).

Migrate by switching each removed name to its consolidated tool with
the matching `view` argument; every other parameter keeps its old name
and meaning:

| Removed tool | Replacement |
| --- | --- |
| `brain_digest` | `brain_brief` with `view: "digest"` |
| `brain_daily_brief` | `brain_brief` with `view: "daily"` |
| `brain_morning_brief` | `brain_brief` with `view: "morning"` |
| `brain_weekly_synthesis` | `brain_brief` with `view: "weekly"` |
| `brain_monthly_review` | `brain_brief` with `view: "monthly"` |
| `brain_operator_summary` | `brain_brief` with `view: "operator"` |
| `brain_timeline` | `brain_analytics` with `view: "timeline"` |
| `brain_attention_flows` | `brain_analytics` with `view: "attention_flows"` |
| `brain_belief_evolution` | `brain_analytics` with `view: "belief_evolution"` |
| `brain_concept_synthesis` | `brain_analytics` with `view: "concept_synthesis"` |
| `get_active_schema_pack` | `schema_inspect` with `view: "active_pack"` |
| `list_schema_packs` | `schema_inspect` with `view: "packs"` |
| `schema_stats` | `schema_inspect` with `view: "stats"` |
| `schema_lint` | `schema_inspect` with `view: "lint"` |
| `schema_graph` | `schema_inspect` with `view: "graph"` |
| `schema_explain_type` | `schema_inspect` with `view: "explain_type"` |
| `schema_review_orphans` | `schema_inspect` with `view: "orphans"` |
| `reload_schema_pack` | `schema_inspect` with `view: "active_pack"` |

`o2b brain doctor` scans your vault-side surfaces (Brain notes, root
instruction files such as `CLAUDE.md`/`AGENTS.md`, installed
`.claude/skills/`) and warns with the exact replacement for any stale
reference it finds (`removed-tool-reference`).

## Upgrading to 1.76.0

No step is required. Searches and session starts now keep the search
index current on their own: an index older than a minute gets one
background incremental run. If you scheduled `o2b search index` or
`o2b search reindex` only to keep keyword search fresh, that job can go;
keep it if it computes embeddings. To turn the background runs off, set
`search_freshen_interval_s: "0"`.

## Upgrading to 1.73.0

No step is required unless you set a positive `embedding_cost_gate_usd`
on a model with no known price, run a model the curated table does not
list, or want to send extra request fields to your embedding endpoint.

**Hooks and MCP searches under a positive gate fall back to keyword-only
and say so.** The query embed of a search that is not at local reach
(every MCP tool and the recall-inject and gap-promote hooks) now passes
the same price gate as the embedding runs of 1.72.0. With a positive
`embedding_cost_gate_usd` on a model with no known price, a hybrid
search answers keyword-only and records `semantic-cost-unpriced` in its
trail, a hook names the code on its local audit line
(`retrieval_degraded`), and an explicit semantic search fails with
`EMBEDDING_COST_UNPRICED`. `o2b search` at the CLI runs at local reach
and is unchanged. Declare the price of a self-hosted model to keep the
semantic lane:

```yaml
embedding_price_model: nomic-embed-text:latest
embedding_price_usd_per_mtok: 0
```

`brain_tune` now refuses to save a winner measured without the semantic
lane, and recall feedback on such a search no longer moves the learned
weights.

**Declare the input window of an uncurated model.** A query longer than
the model's input window is now cut to it before the embed and the trail
records `semantic-query-truncated`. For a model the curated table does
not list the window is unknown and nothing is cut; set
`embedding_input_window_tokens` to the model's window (in its own
tokens) so long queries are cut and disclosed instead of truncated or
refused silently by the server. The key is refused for the `local`
provider.

**Extra request fields need `openai-compat`.** `embedding_extra_body`
takes one JSON object, is sent only by the `openai-compat` provider
(refused for others, inert for `disabled`), refuses `model`, `input` and
`encoding_format`, and a `dimensions` field needs `embedding_dimension`
set to the same width.

**Upgrades refuse a file edited after the plan was read.**
`o2b brain upgrade --apply` and the automatic upgrade worker now apply
the plan they computed. When a managed file changed in between, nothing
is overwritten: re-run `o2b brain upgrade --dry-run` and apply the new
plan. Under `--apply --json` a refusal prints
`{ "ok": false, "error", "run_id", "drifted" }`. In the `--dry-run --json`
plan, a file that does not exist yet still reports `before_size: 0`.

`brain_recall_feedback` gains an additive `degraded` array, and
`brain_context_pack` in `semantic` mode resolves an omitted reach to
remote and counts the instruction prefix in `query_tokens`.

## Upgrading to 1.72.0

No step is required unless you set a positive `embedding_cost_gate_usd`,
left a numeric search setting blank, or an integration reads the JSON embedding cost estimates, which can now
be `null` whatever the gate (see below).

**A positive cost gate now refuses a model with no known price.**
Before this release, a model missing from the built-in price table was
priced at $0, so a gate never stopped it. Now its price is `unknown`,
and an embedding reindex, maintenance reindex or vector backfill with
pending chunks on that model is refused with `EMBEDDING_COST_UNPRICED`
while the gate is positive. This affects local servers (Ollama, LM
Studio, llama.cpp) and any model the table does not list. Run
`o2b search check`: it names the model and the keys to set. Declare the
price once to restore unattended runs:

```yaml
embedding_price_model: nomic-embed-text:latest
embedding_price_usd_per_mtok: 0
```

`0` declares the model free; use the provider's real rate otherwise.
`--force-cost` (MCP `force_cost`) passes a single run without a
declaration. With the gate at 0, the default, nothing is refused.

**Unknown prices read as unknown.** Where an estimate used to print
`$0.0000` for an unlisted model, the maintenance banner, the backfill
dry run and `search status` now print `price unknown`, and the JSON
estimates (`estimated_cost_usd`, `estimated_usd`, the status refresh
estimate) are `null`. A consumer that read `0` as free must treat `null`
as unknown. The backfill's `estimated_cost_usd` used to be omitted for an
unknown price and is now always present. Spend receipts, the
`maintenance_spend` metric, the backfill JSON and the status JSON gain
`price_source` (`refresh_price_source` on status); journal rows written
before this release list their price source as `unrecorded`.

**Edits re-embed less.** An edited note keeps the vectors of its
unchanged chunks, so the next embedding pass pays only for what changed.
Nothing needs reindexing to benefit.

`o2b search vector-backfill` gains a repeatable `--path`, and
`brain_context_pack` gains `query_mode: "semantic"`; both are additive.

**Blank numeric settings and long feedback queries are refused.** A
whitespace-only `embedding_cost_gate_usd` or `search_rerank_min_score`
(in config or through its env twin) used to read as 0; it now fails config
resolution with `INVALID_INPUT`, so remove the key or give it a number.
`brain_recall_feedback` now enforces its advertised 2000-character `query`
cap and refuses a longer query with `INVALID_PARAMS`.

## Upgrading to 1.71.0

No step is required. Three changes are visible to an operator who runs
with `recall_inject_enabled` on, and one to every Claude Code and Codex
install.

**The recall brief no longer repeats notes within a session.**
`recall_inject_dedupe` (env `OPEN_SECOND_BRAIN_RECALL_INJECT_DEDUPE`)
defaults to `true`: with a host that sends a `session_id`, a note span
already shown in the session, by an earlier brief or by the SessionStart
digest, is not injected again until the next SessionStart, and a prompt
whose candidates were all shown before abstains with
`all_already_injected`. Set `recall_inject_dedupe: "false"` (or `"0"`) to
restore the previous behaviour. See "Session dedupe and slices" in
[`decision-models/recall-inject.md`](decision-models/recall-inject.md).

**The recall caps are configurable.** `recall_inject_max_notes`,
`recall_inject_max_chars`, `recall_inject_time_budget_ms` and
`recall_inject_confidence_floor` keep their previous values as defaults;
an out-of-range value keeps the default and is named (by its env
variable when it came from the env) as `config_invalid` on the audit
line.

**Recall slices are opt-in vault policy.** A `recall_inject:` block in
`Brain/_brain.yaml` is new and absent from the generated template; a vault
without it recalls exactly as before. A malformed block makes
`_brain.yaml` fail to load, and the recall decision then ends in `error`
with fault `retriever_failed` until the file is fixed. The contract is in
[`cli-reference.md`](cli-reference.md).

**A new `reground-deliver` hook is registered.** The Claude Code and
Codex hook manifests run it on every `PostToolUse` and `UserPromptSubmit`
event. It does nothing unless `reground_parts_enabled` is on (default
off), and it checks that flag before resolving the vault. Turn the flag
on to have an oversized SessionStart payload split into parts instead of
emitted whole; the keys and the receipt fields are in
[`cli-reference.md`](cli-reference.md) and
[`observability.md`](observability.md).

**Hook-state files are private and some are renamed.** The per-session
files under `.open-second-brain/hook-state/` are now written with mode
`0600`, because the re-grounding queue holds parts of the SessionStart
payload. Existing files become private on their next write; a file never
written again stays as it was until the prune removes it. A session id
that is not already a lowercase slug (one with upper case, separators or
more than 64 characters) now gets a file name with a hash suffix, so two
such ids no longer share a file. Claude Code and Codex session ids keep
their file names. A host that sends other ids starts its hook state
afresh once after the upgrade: once-per-session nudges can repeat in an
open session, and the old file is pruned after seven days.

The last-good SessionStart snapshot under
`.open-second-brain/inject-cache/` and the search session focus file are
written with mode `0600` as well, and setting a focus answers
`INVALID_INPUT` when a directory on the way to the focus file is a
symbolic link. A search `path_prefix` that starts with a drive letter is
now refused with `INVALID_INPUT`, like one containing `..` or starting
with `/`.

## Upgrading to 1.70.0

One step is required for Hermes users: update the `o2b` CLI and the
Hermes plugin together. Seven changes are visible to an operator or a
client.

**Update `o2b` and the Hermes plugin together.** The Hermes plugin now
launches its MCP bridge as `o2b mcp --harness hermes`, and an `o2b`
older than 1.70.0 refuses `--harness` as an unknown flag, so the bridge
does not start; the bridge's stderr in the gateway log names the flag.
The `o2b` links that `scripts/o2b install-cli` creates follow the
plugin; an `o2b` installed some other way must be updated as well. The
Claude Code plugin's two MCP registrations gain `--harness claude-code`
in the same release, so they need no step.

**Hermes settings come from the profile on a multiplexed gateway.** With
`gateway.multiplex_profiles: true`, `VAULT_DIR`, `VAULT_AGENT_NAME`,
`VAULT_TIMEZONE`, `OPEN_SECOND_BRAIN_CONFIG` and
`OPEN_SECOND_BRAIN_MCP_TIMEOUT` are read from each turn's profile scope
(the profile's `.env`), no longer from the gateway process environment.
A profile that relied on the launch profile's environment now falls
through to the Open Second Brain config chain instead; move such a
setting into that profile's `.env`. The gateway log names each ignored
variable once with a WARNING. A single-profile gateway is unchanged.
See "Multiple Hermes profiles" in [`install/hermes.md`](../install/hermes.md).

**`hermes open-second-brain config` prints the settings source first.**
The first line is now `settings_source: ...`, naming the source this
command resolved from (`profile scope (multiplexed gateway)`, or
`process environment` with a note that a multiplexed gateway reads each
profile's `.env`), and `config_path:` follows it; when no profile
scope is bound, the named error replaces the path. A script that reads
`config_path:` from the first line must look for it by name. On a
multiplexed gateway each profile identity (vault, agent name, timezone,
config path and timeout) gets its own `o2b mcp` child, so the gateway
runs more child processes, and a child whose identity changed (for
example after an edited `.env`) stays alive until the gateway exits. A
call with no bound profile scope reports a `ProfileScopeError` naming
the variable, and `prefetch` omits the vault reminder for that turn with
one WARNING.

**Scoped operator rules.** Files under `Brain/standing-rules/project/`,
`Brain/standing-rules/harness/` and `Brain/standing-rules/host/` are
now rendered for the matching project, harness and device, after the
operator standing rules, in the SessionStart hook (project and host
only) and in `brain_context`, for a local caller only. A vault without
the directory renders exactly as before. The block is charged against
`active.inject_budget_chars` and capped by the new
`active.scoped_rules_max_chars` (default 2,000); the hook receipt's
`budget` block gains `scoped_rules_chars`, and `brain_context` gains an
optional `scoped_rules` key. Every write path now refuses paths inside
`Brain/standing-rules/`. See "Scoped operator rules" in
[`how-it-works.md`](how-it-works.md).

**`o2b mcp --harness <id>`.** A new optional flag naming the harness;
an unknown value exits `2`. `--host-target` now also stands in for it
when it is absent, and a refused `--host-target` value is now echoed as
a JSON string with its control characters escaped, as a refused
`--harness` value is; a script that matches the raw value on stderr must
match the quoted one.

**More brief and doctor counts answer at the caller's reach.** Below
local reach `brain_brief` `view="today"` no longer lists an open loop
or obligation from a page the caller cannot read, `view="monthly"`
counts from the events the caller may see, `view="operator"` computes
its doctor and digest counts, top actions, verification entries and
trust verdict from what the caller may see, and the `brain_doctor`
removed-tool warning cap, `uncertain` cap, stale-dependency counts,
concept-gap and contradiction detectors and instruction-file warnings
leave out what the caller cannot read, and the `brain_doctor` `repair`
preview plans from the same checks. `brain_obligation`,
`brain_intention`, `brain_health`, `brain_trigger` scans,
`brain_stale_scan`, `brain_review_candidates`, `brain_intent_review`,
`brain_retention`, `brain_tension` and `brain_context_receipts` answer
the same way. A local caller and the CLI see no change.

**A remote client runs only a dry dream.** Below local reach (an HTTP
bind on a non-loopback interface) `brain_dream` serves a dry run and
refuses a real pass, a step and the staged lifecycle, and
`brain_maintenance` refuses `run`; schedule them on the vault's own
host (`o2b brain dream`, `o2b brain maintenance run`, or a stdio or
loopback client). The lifecycle (including the chain tip), expire,
evidence, feedback, derived-fact, decision, label, scaffold, dead-end,
diarize, hygiene refresh and anticipatory-context tools treat a page the
caller cannot read as absent, and a write aimed at such a page is
refused before anything is written.

**Derived pages keep the visibility of their sources.** A preference
the dream pass drafts from signals reserved with `visibility`, or that
supersedes or rebuts a reserved record, now carries the strictest
`visibility` of those sources, and a tension page carries the stricter
`visibility` of its two source notes, refreshed when it is detected
again. Such pages were written without a `visibility` line before, so
they may now be withheld from a remote caller.

## Upgrading to 1.69.0

No step below is required. Ten changes are visible to an operator or a
client.

**CSV, TSV and HTML files are planned by default.** `o2b brain
batch-plan` and `brain_ingest_batch_plan` now discover `.csv`, `.tsv`,
`.html` and `.htm` files beside the Markdown and plain-text ones, and a
planned file of one of these formats carries its `format`. The plan id
of a tree holding such files therefore changes, and a resume checkpoint
written for that tree before the upgrade no longer matches it; a tree of
Markdown and plain-text files plans exactly as before. An `extensions`
override is honoured as before.

**PDF, Office, EPUB, RTF and image files are named, not counted.** A
`.png`, `.pdf`, `.docx` or another file of a format the registry names
but does not extract moves from the `unclassifiable` counts to
`skipped_non_extractable`, one entry per file with reason
`format-not-extractable` and the format as `detail`, so
`skip_reason_counts` gains the `format-not-extractable` key and the plan
id of a tree holding such files changes too. A reader that summed
`unclassifiable` sees fewer files there and finds them in
`skipped_non_extractable`.

**Ingesting an HTML, CSV or TSV source adds a derived section.**
`brain_ingest_source` writes a `## Parts` section (HTML headings and
their line spans) or a `## Table` section (the rows as fenced plain
text) onto the summary page of an in-vault source of these formats,
with `source_format`, `source_content_hash` and, for a table, five
`table_*` frontmatter keys, and returns `parts` or `table`. The first
ingest after the upgrade of a CSV, TSV or HTML source already ingested
rewrites its page once with the new section and keys. Text and Markdown
sources are unchanged. A leading frontmatter block in such a source is
not data: it is never rendered as a table row or as text. Table cells
and headings pass the redactor; see [`mcp.md`](mcp.md) for what it
catches and what it does not.

**A summary page carries its source's visibility, and a re-ingest keeps
the operator's.** A summary page with a derived section takes on its
source's `visibility`, so a source an operator reserved yields a summary
page reserved the same way. When both the page and the source declare
tokens, the page gets the audience both the operator and the source
allow; when they share none, the page is withheld below local reach. An
operator-set `visibility` on any summary page used to be dropped when
the source was ingested again; it is now kept, the way `created_at` is,
for every source format. A byte-order mark before a frontmatter block
no longer hides that block, on any page.

**`brain_recall_gate` accepts `turn_id` and bounds its correlation
arguments.** The optional argument (at most 512 characters) the Hermes
plugin sends was refused by the closed input schema; it is now accepted
and recorded on the `gate_telemetry` record. A `turn_id`, `session_id`
or `telemetry_host` longer than its bound (512, 512 and 200 characters)
is now refused with `INVALID_PARAMS` before the gate runs, with
telemetry on or off; it used to be dropped from the telemetry record
without a word, and not checked at all with telemetry off.

**Multi-line prompts that start with a command name are now admitted.**
The recall surfacing gate skipped a prompt whose first word is a command
name such as `git` or `ls` as a shell command, even when the prompt went
on over more lines. Such a multi-line prompt now retrieves. A
single-line prompt that starts with a command name is still skipped as
`shell_command`.

**The daily and weekly briefs and the recall verdict answer at the
caller's reach.** Below local reach the daily and weekly `brain_brief`
views leave out rows and source pointers that only a record the caller
cannot read accounts for, recompute `events_by_kind` and `vault_delta`
from the events the caller may see, take no report snapshot and show no
`delta`. The empty-search coverage verdict of `brain_search` and
`brain_recall_gate` counts a root as reached only through a page the
caller can read, so it no longer flips on a root that holds only pages
the caller cannot read.

**More readers treat a page or record the caller cannot read at its
reach as absent.** Below local reach the daily log pages are no longer
served by the generic page readers (`brain_search` and every tool that
reads a page by path). `brain_analytics` `view="timeline"`,
`view="belief_evolution"` and `view="concept_synthesis"`, the today,
digest and `brain_event_trace` views, `brain_claims`, `brain_backlinks`,
the `osb://backlinks`, `osb://log`, `osb://topic` and `osb://preference`
resources, `brain_query` with `since`, `topic` or `preference`,
`brain_moc_audit` and every `brain_doctor` finding answer at the
caller's reach. `brain_search_by_source` and `brain_delete_by_source`
honour the reach of a derived summary page, and a `brain_ingest_source`
below local reach leaves a summary page the caller cannot read
untouched. An entity intake of a source reserved against remote reads
records no `source_content_hash`. The `brain_doctor` findings
`orphan-evidence` and `malformed-evidence-range` gain `sources`, and
`removed-tool-reference` gains `path` (vault-relative on the wire); the
messages are unchanged. A local caller and the CLI see no change. See
[`mcp.md`](mcp.md) for the full list.

**Private regions open more readily.** An open `<private>` tag whose
attributes hold a `<`, or that never closes, now opens a region, in the
redactor, the session-recall externalisation and the continuity
redaction alike; the text after it is hidden or flagged private where
it used to pass. Private regions and table cells are now redacted in
linear time.

**Architecture notes name the edges a link cannot carry.**
`o2b brain architect` no longer says that no module depends on another
when every declared edge touches a module whose name a link cannot
carry: it lists those edges as code spans, so an overview or module note
in that state reports `updated` once.

## Upgrading to 1.68.0

No step below is required. Six changes are visible to an operator or a
client.

**Architecture notes gain dependency regions and one owned frontmatter
key.** `o2b brain architect` now reads dependency manifests at the root
and at each module. On an existing project the first run appends a
`module-dependencies` region to the overview and a `dependencies`
region to each module note, so it reports those notes `updated` once.
A module note whose manifest depends on another module gets a
`depends_on` frontmatter key that the generator owns and rewrites on
every run; a value typed under that key is replaced. `--json` gains a
`manifests` list. A malformed root `package.json`, which used to be read
as no manifest at all, is now reported `malformed`, and the `detail` of
every malformed manifest is a fixed reason such as `invalid JSON`, not
the parser's message. A dependency name that cannot be written into a
note is counted as `unrepresentable` instead of listed, and a module
whose directory name a link cannot carry is named once on the overview
and left out of every link and edge. See
[`how-it-works.md`](how-it-works.md).

**The pre-extractor reads Terraform.** `o2b brain pre-extract` and
`brain_ingest_source` with `pre_extract` now return seeds for `.tf` and
`.tfvars` files, which used to report `extracted: false`.

**Credentials in import specifiers are redacted.** In every family's
`imports` seeds, the userinfo of an http(s) or `git::` specifier (a
`user:password` pair such as `https://user:pass@host/m.js`, or a bare
token such as `git::https://<token>@github.com/o/r.git`) and the value
of a named credential query parameter (`sshkey`, `token`,
`access_token`, `password`, `signature`, the S3 and GCS access-key and
signing parameters) are replaced, the query parameter also on a
specifier that is not a URL, such as `git@host:org/repo.git?sshkey=...`.
A conventional login such as `ssh://git@` is kept. A credential in a
path segment, a fragment or an unnamed query parameter is not
recognised. Specifiers without credentials are unchanged; a specifier
longer than 2048 characters is replaced whole. With `pre_extract`,
`brain_ingest_source` skips a source larger than 1 MiB and says so.

**A remote search with no match no longer states index counts.** The
answer of an empty `brain_search` and of `brain_recall_gate` below local
reach carries no coverage receipt, since its counts include pages the
caller cannot read: a `not_found` names the index time only, and an
`unknown` gives a fixed reason for its `unknown_reason`. A local caller and the
CLI keep the receipt.

**More tools treat a record the caller cannot read at its reach as
absent.** A remote client now gets, for such a record, exactly the
answer an absent one gets from `brain_context`, the
`osb://preferences/active` resource, `brain_pre_compress_pack`,
`brain_brief` `view="digest"` and `view="morning"`, the
`osb://digest/latest` and `osb://lessons` resources, `brain_health` and
the `brain_doctor` repair plan and apply. The first three now always
hand a remote client a render stamped with the file's `generated_at`
instead of the file's bytes. A remote `view="digest"` takes no report
snapshot and shows no delta, and a remote `view="morning"` shows no
pending-triggers section and marks no trigger delivered. The `osb://preferences/active`
resource also follows the owner gate under
`integrity.owner_scope_delivery: fail`, as `brain_context` does. A local
caller and the CLI see no change.

**Remote search no longer returns the compiled digest pages.**
`Brain/active.md` and `Brain/lessons.md` compile preferences and dead-ends
that may reserve themselves against remote reads, so `brain_search` and the
other generic page readers withhold both pages from a remote client. The
active digest stays available remotely through `brain_context`, the
`osb://preferences/active` resource and `brain_pre_compress_pack`, each
rendered without the records that client cannot read. Local search is
unchanged. See the 1.68.0 entry in [`CHANGELOG.md`](../CHANGELOG.md).

## Upgrading to 1.67.0

No step below is required. Six changes are visible to an operator or a
client.

**A distilled quote that does not verify loses its quotation marks.**
`brain_distill_source` and `o2b brain distill` now check every quoted span
in a claim against the block it cites, or the whole source. A span the
source does not hold is written without its two quotation marks and named
in the result's `quotes` report; the words stay and the write lands. Pass
`strict_quotes: true` (or `--strict-quotes`) to refuse such a write instead,
with `error.data.code` `quote_unverified` over MCP and exit 1 on the CLI.
See "Source distillation" in [`mcp.md`](mcp.md).

**New frontmatter keys appear only on pages that are not `full-local`.**
`capture_scope`, `capture_scopes` and `excerpt_hash` are written for a
source that is `bounded-local` or `url-only`, and `quotes_verified` /
`quotes_unquoted` only when a claim holds a quoted span. A distillation,
ingest summary or research report over local sources is written
byte-identical to before.

**A claim or a research title that spans more than one line is refused.**
A distillation claim holding a line break, or more than 1000 claims in one
call, is refused, and so is a `brain_research_report` title holding a line
break. Both used to be written as given.

**Links inside a fenced block are masked up to its own closing fence.**
Wikilink extraction and search indexing close a fenced block only on a run
of its own character at least as long. Links inside a tilde fence are no
longer extracted, and a longer fence holding a shorter backtick run no
longer leaks the rest of its content as links. An inline code span closes
only on a backtick run of its own length, and a backtick run with no closer
is plain text that hides no link after it. Such a vault may show different
backlinks and link hits after its next index pass.

**The `capture-scope` hygiene detector is on by default.** A default
`brain_hygiene` or `o2b brain hygiene` scan may report new warnings on an
existing vault where a distillation, ingest summary, research report or
canonical entity cites only URLs. The findings propose review and never
change a page. Callers that pin the default detector list see the new id
at the end. See [`cli-reference.md`](cli-reference.md).

**More tools treat a page the caller cannot read at its reach as absent.**
A remote client now gets, for such a page, exactly the answer an absent
page gets: `brain_delete_by_source`, `brain_note_lifecycle`,
`brain_append_note`, `brain_update_note`, `brain_write_batch`,
`brain_note_history`, `brain_tiers`, `brain_event_trace`,
`brain_agent_query`, `brain_agent_diff`, `brain_diarize`,
`brain_design_note`, `brain_dream`, `brain_idea_discovery`,
`brain_procedural_memory`, `brain_doctor`, `schema_inspect` and
`brain_writes plan_revert` leave it out of their lists and counts or
refuse it as missing, and the `brain_hygiene` `link_integrity` block
reports `measured: false` with reason `reach`. A local caller and the CLI
see no change. See the 1.67.0 entry in
[`CHANGELOG.md`](../CHANGELOG.md).

## Upgrading to 1.66.0

No step below is required. Three changes are visible to a client or an
operator.

**Every JSON-RPC error answer now carries `error.data`.** It is always an
object with a string `code` (for example `unknown_argument`,
`vault_frozen` or the default `invalid_params`), and an `isError` tool
result carries its code on `_meta["open-second-brain/error"].code`. The
error messages and text blocks are unchanged, so a client that matched
prose keeps working; a client that asserted `"data" not in error` sees the
new member. The Hermes bridge exposes the code as `BridgeError.code`. See
"Tool errors" in [`mcp.md`](mcp.md).

**An install with an enabled `openai-compat` rerank sees one query-cache
miss per query.** The cache key now carries the rerank sunset survey's
review date, and an answer whose rerank endpoint failed is no longer
cached, so the next identical query asks the endpoint again. Every other
install keeps its cache keys.

**`o2b brain doctor` checks the rerank configuration.** With
`search_rerank_enabled` on and the `openai-compat` kind, a missing or blank
base URL, model or key now fails the doctor as
`rerank-endpoint-unconfigured`, and a model with an announced
decommission date warns. A model outside the shipped survey is reported
as uncertain (`rerank-model-sunset-unsurveyed`), which says only that no
statement was made about it. The check reads configuration only and sends
no request. See the rerank doctor table in
[`cli-reference.md`](cli-reference.md).

## Upgrading to 1.65.0

No step below is required, and an existing install sees no change in what
the maintenance lane runs.

**Custom maintenance lane tasks are a new opt-in.** An install can declare
its own upkeep commands in the machine config file
(`maintenance_custom_<name>: <command>`, with optional `_cwd` and
`_timeout_seconds` keys); they run only once `maintenance_custom_tasks: true`
(env `OPEN_SECOND_BRAIN_MAINTENANCE_CUSTOM_TASKS`) is set, after the four
built-in tasks and under the same gates. Without the switch nothing runs,
and `o2b brain maintenance status` says so when keys are declared. A task
runs from the running user's home directory unless it declares `_cwd`
(the vault only when named), its environment drops every variable whose
name declares a credential (`*_API_KEY`, `*_TOKEN`, `*_SECRET` and the
like) while keeping `PATH`, `HOME`, `LANG`, `LC_*`, `TZ`, `TMPDIR` and
`O2B_VAULT`, and the declared timeouts (default 120 s each) together stay
within 1200 s of the 30-minute lease. See the maintenance lane in
[`cli-reference.md`](cli-reference.md).

**The lane can print its own schedule.** `o2b brain maintenance run
--cron-template` prints a cron recipe, or a systemd user timer with
`--format systemd`; it installs nothing, so an existing hand-written cron
line keeps working as it is.

**`o2b discipline install` writes the Hermes jobs file of the running
user.** The default moved from a fixed path under the root user's home to
`~/.hermes/cron/jobs.json`. On a host where Hermes runs as root the path is
the same; on any other host the install used to fail and now works.
`OSB_HERMES_JOBS` still overrides it.

**A served `o2b mcp` exits 70 on an uncaught exception** and survives an
unhandled promise rejection, naming it on stderr. A supervisor that treated
every exit of the server the same way can now tell a fault (70) from a
signal (130 / 143). See "Background faults" in [`mcp.md`](mcp.md).

## Upgrading to 1.64.0

No step below is required. Two changes are visible to a nightly cron, and
one is an on-disk migration that applies itself.

**The maintenance lane's reindex can spend embedding budget, but only
when you opt in.** By default the quiet-window reindex stays keyword-only
and contacts no provider, exactly as before. Set `maintenance_embeddings:
true` (env `OPEN_SECOND_BRAIN_MAINTENANCE_EMBEDDINGS`) and the reindex
requests the embedding phase whenever the resolved semantic config can
reach a provider. The spend is announced before the pass (the
pending-spend estimate), receipted after it (the `maintenance_spend` metrics surface and the task
row), and a positive `embedding_cost_gate_usd` refuses the phase unless
`--force-cost` (MCP `force_cost`) is set for that run. The gate's default
is 0, which means OFF - a vault that wants the leash must set a positive
value. Leaving `maintenance_embeddings` unset (or `false`) keeps the old
behaviour outright, whatever provider the config can reach.

**A maintenance task killed at its safeguard deadline exits 6, not 1.** A
cron script that treated every non-zero exit as a broken pass now sees 6
for a pass that merely did not finish; 1 still means a task failed and 7
still means a streak refusal, with a proved failure outranking a timeout
and a timeout outranking a refusal in the same run.

**The search index migrates to schema v13 on the next open.** Two nullable
columns (`event_time_min` / `event_time_max`) and a `pinned` flag join the
`documents` table; the migration is additive and no reindex is required.
Existing rows keep NULLs until their next content change refreshes them,
and a `o2b search reindex` fills every row eagerly. A vault that reindexes
nothing behaves byte-identically.

## Upgrading to 1.58.0

No step below is required for a vault that uses none of the named
features. Each one refuses something an earlier release accepted, so a
script, a config or an agent routine that relied on it stops with a named
error rather than a silent change.

**Plain-http embedding and rerank endpoints are refused.** The embedding and
rerank base URLs must be `https`, except for a loopback host. A local server
on another machine (LM Studio on the Windows host seen from WSL, Ollama on
the LAN, a tailnet address) needs the per-endpoint opt-out in the operator
config or environment:

```yaml
embedding_allow_insecure_http: true        # OPEN_SECOND_BRAIN_EMBEDDING_ALLOW_INSECURE_HTTP
search_rerank_allow_insecure_http: true    # OPEN_SECOND_BRAIN_SEARCH_RERANK_ALLOW_INSECURE_HTTP
```

Both default to false, apply only to a base URL from the config or the
environment (never to one from the in-vault provider registry), and warn
once per endpoint. The refusal names the switch.

**An unknown tool profile stops the server.** `o2b mcp` with a
`--tool-profile` or `mcp_tool_profile` naming a profile that does not exist
exits `2`, naming the value, where it came from and the known profiles. It
used to serve the full tool surface. **Fix:** correct the profile name.

**`bank-import` resets every preference row by default.** Untrusted is the
default: each row lands `unconfirmed`, unpinned, at low confidence, on a
fresh trial window dated from the restore, including a row the bundle
already marked unconfirmed, and the run names every row it reset. **Fix:**
for a backup you vouch for, pass `--trusted-restore`.

**OKF import strips machinery frontmatter unless `--trusted`.** The bundle's
`producer` field no longer decides it. Without `--trusted`, `_status`,
`owner`, `origin_channel` and the other machinery keys are stripped, and only
`--trusted` admits the `Brain/sources/` and `Brain/reports/` lanes. A
round trip of your own export needs `--trusted` to stay lossless.

**Labels and attributes refuse `Brain/` machinery and non-Markdown files.**
`o2b brain label`, `o2b brain attr`, `brain_labels` and marker write-back
accept a Markdown note, and under `Brain/` only pages in `sources/`,
`reports/` and `distillations/`. A marker whose target is refused is reported
as `refused` and left unconsumed.

**Write sessions commit only into agent page lanes.** `brain_write_session`
and `o2b brain session open --target` accept a target under
`Brain/sources/`, `Brain/reports/`, `Brain/distillations/`, `Brain/notes/`
or `Brain/decisions/panels/`. Any other path under `Brain/` is refused with
`target-reserved`, and the commit refuses a target that a symbolic link
carries outside those lanes. **Fix:** point the session at one of those
lanes.

**A folder named `brain` in any letter case is treated as `Brain/`.** Note
writes and graph import compare the first path segment case-folded, the way
macOS and Windows resolve it, and refuse it as they refuse the machinery root.
On a case-sensitive filesystem a separate top-level user folder spelled
`brain` or `BRAIN` is refused for writes. **Fix:** rename that folder.

**Remote callers no longer see private session rows.** Over a remote
transport, `brain_session_grep`, `brain_session_describe`,
`brain_session_expand` and `brain_idea_lineage` answer a continuity row
flagged `private` as if it did not exist, and the three session recall
tools do the same for a session summary built from one. Local callers are unchanged. **Fix:** read those rows from a local
session.

**Every search index is rebuilt once.** The chunker now counts Chinese,
Japanese, Korean, Thai and similar text per character, and the index records
the `chunker_version` it was cut under. The first start after the update
rebuilds each existing index in the background, as described under
[Vault state migrates itself](#vault-state-migrates-itself). Short notes in
any language chunk as before. A note long enough to span several chunks may
split at slightly different points in every language, because the overlap
between chunks now counts toward the chunk cap. With embeddings on, the
chunks that changed are re-embedded, so expect one round of embedding calls
for multi-chunk notes and for text in the scripts above. Nothing to run by
hand.

**`brain_secrets run` allowlist patterns match the argv element by element.**
Each space-separated token of an `--allow` pattern matches one argument, a `*`
inside a token globs within that argument, and a trailing `*` token stands
for one or more further arguments. A pattern that relied on matching across
the joined command line, such as `tool*` for `tool sub --flag`, now matches
only a single-element argv. **Fix:** write it as `tool *`.

**`brain_update_note` refuses `visibility` and `origin_channel`.** A
frontmatter update carrying either key fails with `reserved_frontmatter_key`.
Edit them in the file.

## Upgrading to 1.50.0

Nothing below needs a migration step. Two of the four change what an
existing script or supervisor sees, so they are written here rather than
left to be discovered at the terminal.

**The first `o2b install --check` after upgrading reports `drift` on a
target installed by an earlier release.** A generated registration now
carries `--host-target <runtime>` on both server entries, and Cursor's also
carries `--tool-profile catalog`. Verification works by re-construction, so
an entry written by 1.49.0 no longer equals what this build would write.
Seven targets gain the flags — `codex`, `copilot-cli`, `cursor`,
`gemini-cli`, `grok`, `kiro`, `opencode` — and the ones whose `verify`
compares the entry byte for byte will say so. (`aider`, `generic` and `pi`
write no MCP command line and are unaffected; a Codex installed through
`codex mcp add` is also unaffected, because there `verify` checks only that
the two tables are still declared, the CLI's own serialisation having no
published grammar to compare against.) **Fix:** `o2b install --target <name> --apply`, or
`o2b update`, which now hashes the payload AS WRITTEN and so stops reporting
"up-to-date, payload unchanged" for a target whose host dimensions moved.
The Cursor case is not cosmetic: without the profile that host silently
drops every tool past its 40-tool ceiling.

**`codex` joins `copilot-cli` as a target that can exit `5`.** `o2b install
--check --target codex` now asks `codex mcp list` what the host has
registered instead of only reading `$CODEX_HOME/config.toml`, so a Codex
that has not loaded a correct configuration is reported as
`mcp-unreachable` and exits `5` rather than `0`. A script that treated a
zero exit as "everything is fine" for Codex was reading a file comparison
as a liveness answer. **Fix:** restart Codex when the configuration is
right (the check says so); `--apply` when it is not.

**A running `o2b mcp` server no longer dies instantly on SIGTERM.** Both
transports now stop accepting, wait for in-flight requests to a **10 000 ms**
deadline, close, and exit 130/143. A supervisor with a shorter kill timeout
than that will escalate to SIGKILL where it previously saw a clean exit; the
`GET /health` body gains `"status": "draining"` and `in_flight` so the wait
is observable. **Fix:** raise the supervisor's stop timeout, or lower the
deadline with `O2B_MCP_DRAIN_MS` (a non-negative number of milliseconds; a
value that is not one is refused rather than silently defaulted).

**`o2b brain export --format` accepts a third value.** `json` and
`llms-txt` are unchanged byte for byte. `transcripts-jsonl` is additive and
requires `--transcripts <file|dir>`; a `--format` typo is still exit `2`,
now listing three names instead of two.

## Upgrading to 1.49.0

1.49.0 is a MINOR release that nevertheless changes behaviour for input
and vaults that 1.48.0 accepted. [`docs/stability.md`](stability.md) lists
"tightening validation so previously accepted input is rejected" as a
breaking change, so each one is written here rather than left to be
discovered at the terminal. Nothing below needs a migration step; they all
need a reader.

**A recall-gate call that passed `scores` alone is now refused.**
`brain_recall_gate` and `brain_context_pack` decide the adequacy level
from `match_quality` (a search outcome's `idf_weighted_coverage`) and no
longer derive one from the scores, because the keyword lane is min-max
normalised inside its own candidate set and its top row is pinned at the
configured weight however well it matched. The two arguments now stand or
fall together: `scores` without `match_quality`, or `match_quality`
without `scores`, answers `INVALID_PARAMS` naming both. The tool schema
states the pairing as `dependentRequired`, and the verdict now echoes
`match_quality` back so the quantity that decided the level travels with
it. **Fix:** send both, taking `match_quality` from the search outcome's
`idf_weighted_coverage`. Omit both to get the structural gate alone, which
is unchanged.

**An unreadable preference file now fails the verb instead of being
skipped.** `collectExportRows` used to `continue` past a `pref-*.md` it
could not parse, so an export silently omitted rules - and an export that
omits a rule reads exactly like a vault that never had it. It now collects
every failure in the directory (one run names them all) and refuses. Three
verbs that exited 0 on such a vault now exit **1** with
`N preference file(s) could not be parsed …`:

- `o2b brain export` (the two preference formats, `json` and `llms-txt`,
  with or without `--out`; the `transcripts-jsonl` format added in 1.50.0
  reads no vault and so reads no preference file either)
- `o2b brain bank-export`
- `o2b brain explorer --export <path>` - and nothing is written

`o2b brain doctor` reports the same files. **Fix:** repair or remove the
named files, then re-run. A vault with no malformed preference is
unaffected.

**`o2b brain bank-import` is deliberately NOT in that list.** It calls the
same collector against the DESTINATION vault, to learn which topics its
existing rules already claim. A pre-existing malformed rule there has
nothing to do with the bundle being carried, so the import proceeds on the
rules it could read and prints `topic-key check incomplete: <path> …` for
each one it could not - the topic-key collision list beside it is a
partial answer, not an empty one. The rows still restore, and the exit
code is still governed by the bundle's own failed rows.

**`o2b brain explorer` (live mode) refuses to start on an unparseable
Brain file.** The live server re-reads the vault on every request, so the
refusal is applied once at boot: a browser showing a silently smaller
graph is the same lie as a written file. Previously the server started and
served the incomplete graph. **Fix:** the refusal names every file;
repair or remove them.

**`o2b brain explorer --export` output content changes.** The exported
HTML now passes the shared egress redactor before the template
substitution, so a preference whose text contains a credential-shaped
value exports with a placeholder in place of it, and stderr carries a
one-line notice when anything was removed. Byte-for-byte comparisons of
exports across this boundary will differ on vaults that contain such
values; a vault that contains none produces the same document.

**`o2b brain feedback --json` mirror fields.** When a shared namespace is
configured, the payload carried a single `mirror` string. It now carries
`mirror` plus an optional `mirror_reason`, and the vocabulary changed:

| 1.48.0 | 1.49.0 |
| --- | --- |
| `mirror: "ok"` | unchanged |
| `mirror: "failed"` for an I/O failure | unchanged, plus `mirror_reason` |
| `mirror: "failed"` for a self-mirror | `mirror: "misconfigured"` plus `mirror_reason` |
| `mirror: "off"` | the key is absent entirely |

A self-mirror - `shared_namespace` resolving to the origin vault - is
decided before any I/O and is repaired by editing one config key, while
`failed` is a write that was attempted and raised; reporting them
identically sent the operator after the wrong fault. `off` was never
producible: no caller ever emitted it, and the absence of a mirror is
expressed by the key not being there. **Fix:** a consumer switching on
`mirror` must handle `misconfigured` and must not expect `off`.

**Four thresholds now measure something different for an unchanged
config.** No threshold VALUE changed; what each compares against did. The
recall-inject floor (`RECALL_INJECT_CONFIDENCE_FLOOR`), the recall-adequacy
verdict (`recall_adequacy_sufficient` / `recall_adequacy_weak`), the
gap-loop auto-close floor (`GAP_LOOP_AUTO_CLOSE_FLOOR`) and the cross-vault
chain stop (`search_chain_stop_score`) all compared their constant against
a result SCORE. The keyword lane is min-max normalised within its
candidate set, so the top row of any non-empty recall scored exactly
`search_keyword_weight` - shipped at 0.6, identical to
`recall_adequacy_sufficient`. Every keyword recall graded
`sufficient / proceed`, `weak` and `insufficient` were unreachable, a gap
task auto-closed on a hit of any quality, and the chain stop meant
opposite things under the two fusion modes (unreachable in `linear`,
always met in `rrf`). All four now read IDF-weighted coverage, which is
absolute and pool-independent. **Expect different outcomes from the same
numbers**: recall-inject abstains more often on weak matches, adequacy
verdicts span all three levels, gap tasks stay open on a poor hit, and a
configured chain stop starts firing (or stops firing) where it did not.
If you tuned any of these against the old behaviour, re-tune them against
`idf_weighted_coverage`, which `o2b search --evidence-pack` reports.

## For operators

Normal updates need no manual steps:

```bash
# Claude Code
claude plugin update open-second-brain@open-second-brain   # restart to apply

# Codex
codex plugin marketplace upgrade        # git marketplaces
codex plugin add open-second-brain@open-second-brain   # re-stage local marketplace

# Hermes (server: the plugin dir is a symlink to the checkout)
hermes plugins update open-second-brain
```

You do **not** need to delete or re-create any `~/.local/bin` symlink by hand.
The hooks resolve the current version on their own, and the global
`o2b`/`o2b-hook`/`vault-log` symlinks self-heal on the next session start. If
you ever want to force a re-point explicitly:

```bash
o2b install-cli      # idempotent: re-points dangling or stale OSB symlinks
```

`o2b install-cli` only touches its own (Open Second Brain) symlinks or dangling
links; it never overwrites a real file or a symlink owned by another tool.

### Vault state migrates itself

You also do **not** need to run `o2b search reindex` or `o2b brain upgrade`
after an update. On the next start of any runtime (the `o2b mcp` server boot,
which Hermes/Claude Code/Codex all spawn, and the Claude Code SessionStart
hook), `ensureVaultCurrent` brings an already-initialised vault current,
hands-off:

- a stale `_brain.yaml` / `_BRAIN.md` is migrated (snapshot-backed, additive;
  user content untouched) by a detached worker, so the server answers its
  first request and the hook returns without waiting for the planning, the
  pre-apply snapshot or the rewrite. One worker runs per vault per machine:
  the caller claims a lock file before the spawn and the worker releases it.
  A failed attempt is recorded (`o2b doctor` check `self_heal_upgrade`,
  `o2b brain status`, `o2b brain upgrade --dry-run`) and the next automatic
  attempt waits a cooldown (one hour, doubling per consecutive failure, at
  most 24 hours) instead of running again on every start;
- a stale-schema or missing search index is rebuilt in the **background** (a
  detached reindex), so startup never blocks; and as a safety net the search
  read path self-heals a stale/missing index on first query;
- an index whose chunks were cut by older chunking rules (its `index_state`
  `chunker_version` is missing or older than the running chunker's) is rebuilt
  the same way, once. Unchanged notes are otherwise never re-chunked, so
  without it a chunking fix would never reach them. The first start after the
  update that introduced the stamp (the #186 fix for Chinese, Japanese, Korean,
  Thai and similar text) rebuilds every existing index once; with embeddings
  on, that re-embeds whichever chunks changed.

A schema bump makes every session that starts afterwards find the index stale
at once, so the spawn is checked against the index writer lock first: a rebuild
that can already be seen to lose is not started at all. That check reads an
instant and cannot exclude anything - the writer lock still does that - so a
child can still lose a real race, and it now says so. Every detached rebuild
records what it decided and how it ended on the `self_heal_reindex` metrics
surface (`docs/metrics.md`), because the child runs with its streams pointed at
nothing and a failure would otherwise be reported nowhere.

It is **state-driven, not version-stamped.** Each step keys off actual on-disk
state - the search index `schema_version` and `chunker_version`, the
`_brain.yaml` pending-changes plan, directory existence - rather than a "last
version" marker (both index cells live in the per-device index, not the
vault, and describe what that index holds). This is
deliberate: a vault is often synced across devices (Syncthing), so a stamp
written into the vault would let one device mark the work done and make another
skip its own per-device step (the search index is per-device). State checks are
cheap reads on every start; only a real migration does work, and the approach
also handles interrupted migrations and downgrades. Any per-device version note
lives outside the vault and is for logging only, never for gating. The one
per-device record that does gate, the failed-upgrade marker under
`.open-second-brain/`, only ever delays a retry after a failure; it never marks
an upgrade done.

The manual `o2b search reindex` / `o2b brain upgrade` commands still exist for
explicit use; auto-migration just reuses their logic.

## Why updates used to break (and no longer do)

`hooks/hooks.json` previously invoked the bare `o2b-hook` launcher through a
`~/.local/bin` symlink that `o2b install-cli` pinned to a *versioned* cache
directory. When Claude Code rotated that directory on update, the symlink
dangled, the launcher resolved an old checkout, and it `exit 2`-ed — the one
hook exit code that blocks the agent. Every prompt was rejected until the user
deleted the symlink by hand. That manual step is exactly what this design
removes.

## Invariants — REQUIRED for any change to hooks, the launcher, or install-cli

If you are an agent (or human) editing `hooks/`, `scripts/o2b-hook`,
`scripts/o2b`, or `src/cli/install-cli.ts`, you MUST preserve all of these.
**A later update must always be able to repair an install made by an earlier
version — never assume a clean prior state.**

1. **Resolve version-currently, never version-pinned.** Resolve the launcher
   via `$CLAUDE_PLUGIN_ROOT` first (Claude Code sets it to the active version
   and re-reads `hooks.json` from that version every session — so a correct
   command shape here repairs an already-broken install on the next update),
   then the script's own realpath, then `$OSB_PLUGIN_ROOT`. Never hard-code a
   version, a cache path, or a stored absolute path that a future update will
   orphan.
2. **Hooks fail soft — never block.** `scripts/o2b-hook` and every
   `hooks.json` command must `exit 0` on any internal error (unresolved hook,
   missing Bun, missing launcher). Never `exit 2`; never let a hard
   `command not found` be the only outcome. A broken hook must degrade to a
   no-op, not a bricked agent.
3. **Self-heal conservatively.** Symlink repair (`healCliSymlinks`, and
   `install-cli`'s reclaim path) may re-point only dangling links or stale
   Open Second Brain `scripts/<name>` links; it must never touch a real file,
   a foreign tool's symlink, or a stable-directory install (e.g. a server
   checkout under `/srv/...` shared by Hermes/Codex).
4. **Codex has no plugin-root env var.** Keep the PATH `o2b-hook` fallback so
   Codex (and any runtime without `CLAUDE_PLUGIN_ROOT`) still works.
5. **Post-upgrade migration is state-driven and best-effort.** `ensureVaultCurrent`
   must key off actual on-disk state (index `schema_version`, `_brain.yaml`
   pending plan, dir existence), never a stamp written into the (possibly synced)
   vault. It must never throw and never block startup - slow work (reindex) runs
   detached in the background. Any new manual-after-upgrade step a future change
   introduces must be folded into `ensureVaultCurrent` so the user never runs it.

These properties are locked by tests; do not weaken them:

- `tests/hooks/o2b-hook.test.ts` — fail-soft + `$CLAUDE_PLUGIN_ROOT`-first resolution.
- `tests/hooks/hooks-json-shape.test.ts` — every command is version-current, has a PATH fallback, and ends with `exit 0`.
- `tests/cli/install-cli.test.ts` — idempotent reclaim and conservative self-heal.
- `tests/core/search/self-heal.test.ts` — search rebuilds a stale/missing index on read.
- `tests/core/maintenance/ensure-current.test.ts` — state-driven migration, idempotent, never throws.
- `tests/core/maintenance/self-heal-reindex.test.ts` — the herd is thinned against the writer lock, and a detached rebuild's outcome is readable.
