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
