# CLI reference

The full set of `o2b` verbs. After `o2b install-cli` they are on PATH; the local checkout can also be used without installing the symlinks by running commands through `scripts/o2b` and `scripts/vault-log`.

Most verbs accept `--vault <path>` and `--config <path>`; the values default to the active profile from `o2b init`. JSON output is available via `--json` on every read verb. Commands that do not own a semantic JSON contract return a redacted fallback envelope when `--json` is passed.

## Core

```text
o2b status                    Show config / vault status
o2b init                      Bootstrap the vault profile (idempotent)
o2b init --interactive        Guided first-time setup wizard
o2b install-cli               Symlink o2b and o2b-hook into ~/.local/bin
o2b doctor                    Run vault + adapter checks
o2b index                     Rebuild the Markdown page index
o2b export-config             Write a redacted config snapshot
o2b secrets list|status       Inspect $secret:NAME references without printing values
o2b mcp                       Run the MCP tool server (stdio); --scope full|writer|catalog, --tool-profile full|writer|catalog|recall|minimal, --probe, --allow-tool, --disable-tool, --max-tools
o2b tool-call                 Invoke an MCP tool handler from the CLI
o2b help --json               Print the command/flag manifest as JSON
o2b completions --shell zsh   Print completions for bash|zsh|fish|elvish|nushell|powershell
o2b uninstall                 Print uninstall plan; --apply-local cleans config; --remove-cli removes symlinks
o2b update                    Update Open Second Brain across all detected runtimes; --target <name> / --dry-run / --force / --json
```

## Brain (observing memory)

```text
o2b brain init                Bootstrap Brain/{inbox,preferences,retired,log,.snapshots}/ + _brain.yaml + _BRAIN.md; --starter drops the bundled example set
o2b brain feedback            Record one taste signal (--topic, --signal, --principle, ...)
o2b brain dream               Run the deterministic consolidation pass (idempotent; usually cron'd)
o2b brain apply-evidence      Record applied / violated against a preference for a durable artifact
o2b brain note <text>         Append a one-line narrative milestone to Brain/log/<today>.md (cron / shell mirror of brain_note)
o2b brain digest              Render a Markdown or JSON summary of recent Brain transitions; --window 7d for arbitrary lookback; Markdown links follow link_output_format / OBSIDIAN_LINK_FORMAT
o2b brain intent-review       Read-only pre-dream review of active signal clusters; --now ISO; --json mirrors brain_intent_review
o2b brain retention           Recommendation-only lifecycle review over retired preferences and processed signals; --now ISO; --json mirrors brain_retention
o2b brain monthly             Month-level Brain synthesis over timeline events, transitions, retirements, contradictions, and neglected areas; --month YYYY-MM; --json mirrors brain_monthly_review
o2b brain query               Read helper: by preference, by topic, or by log timestamp
o2b brain agent-query         Read source-agent provenance; filters by --agent, --topic, --query, --kind, --limit; --json mirrors brain_agent_query
o2b brain agent-diff          Compare source-agent coverage in browse/search/diff/map modes; --json mirrors brain_agent_diff
o2b brain reject              (CLI-only) Retire a preference; requires --reason "<text>". Subsequent signals on the same topic are suppressed.
o2b brain merge               (CLI-only) Fold one confirmed/quarantine pref into another (<keep> <drop>); --dry-run / --force; drop retires with reason 'merged-into'
o2b brain pin / unpin         (CLI-only) Toggle pinned: true on a preference (exempt from auto-retire)
o2b brain set-primary         (CLI-only) Declare or clear primary_agent in Brain/_brain.yaml (--clear)
o2b brain protect             (CLI-only) Emit / apply native deny rules for Brain/ (--target {claudecode|codex} [--apply])
o2b brain unprotect           (CLI-only) Remove the Open-Second-Brain-managed deny rules for the chosen target
o2b brain snapshot diff       (CLI-only) Read-only diff between two snapshots, or snapshot vs live Brain/
o2b brain rollback            (CLI-only) Restore Brain/ from a pre-dream snapshot (--dry-run previews; drift abort vs --force-rollback)
o2b brain upgrade             (CLI-only) Migrate release-owned files forward (_brain.yaml, _BRAIN.md, _OPEN_SECOND_BRAIN.md); --dry-run / --check / --apply --yes
o2b brain export              Read-only dump of active preferences (--format json|llms-txt [--out <path>] [--force])
o2b brain explorer            (CLI-only) Force-directed HTML graph of Brain/preferences + retired; live HTTP on 127.0.0.1 or --export <path> single-file. Keyboard-accessible listbox + localStorage layout persistence. Double-click a node to open it in Obsidian (live mode).
o2b brain doctor              Check Brain-specific invariants (status-vs-folder, broken wikilinks, ...). --remediate [--dry-run] plans a dependency-ordered repair and applies auto-safe content-hash re-stamps
o2b brain health              Semantic-health report (since v0.14.0): contradictory confirmed preferences, recurring concepts with no dedicated preference, stale claims, plus a clean | watch | investigate verdict
o2b brain history             Render a preference's edit-history timeline (since v0.14.0): one entry per content mutation (principle / scope / status before -> after)
o2b brain audit               Render a preference's full mutation audit trail (since v0.21.0): create / promote / update / retire / merge with agent, reason, revision + content-hash before/after. ret- or bare-slug arg resolves to the same trail
o2b brain morning-brief       Read-only session-start summary (since v0.21.0): top confirmed preferences, recent reconcile open questions, recent notes; bounded by --max-chars-per-memory / --max-total-chars; --top-k / --lookback-days
o2b brain codec               Deterministic lossless session codec (since v0.22.0): --compress | --expand over stdin or --in <file>; structured content preserved byte-for-byte
o2b brain sources             Read-only dashboard of signals by (agent, source_type) (since v0.22.0): active/processed + distinct-topic counts; --json
o2b brain schema              Runtime schema report/admin (since v0.26.0): report|stats|lint|graph|explain|orphans|apply|sync; mutation writes are locked and audited
o2b brain watchdog            Probe Brain config/dirs/search index and plan safe recovery (since v0.26.0): --remediate [--dry-run], --restore <run_id> [--force-restore], --json
o2b brain graph-export        Serialise the vault knowledge graph (pages, wikilinks, typed relations) to a stable graph.json (since v0.22.0): stdout or --out <file>
o2b brain graph-import        Reconstruct vault page stubs from a graph.json (since v0.22.0): --mode skip|overwrite|merge; vault-guarded writes
o2b brain backlinks           List inbound references to a Brain artifact id
o2b brain semantics-backfill  Dry-run typed preference-edge backfill preview (since v0.24.0): --json returns missing inverse superseded_by proposals; no writes
o2b brain mcp-landscape       List MCP servers configured across the vault (since v0.19.0): name, source file, packages, required env-var names (values never read)
o2b brain scan-inline         Capture `@osb` markers from folders listed under `notes.read_paths` in _brain.yaml
o2b brain import-session      Replay signals from a registered agent session .jsonl (or directory); --recall also stores turns in the session recall DAG
o2b brain session-hook        Internal hook bridge: read one lifecycle payload from stdin, capture prompt markers / brain_feedback, append lifecycle audit/log rows
o2b brain context-receipts    List/show opt-in prompt context receipt continuity records (since v0.29.0)
o2b brain recall-telemetry    List/summarise opt-in recall telemetry continuity records (since v0.29.0)
o2b brain context-presets     Show/suggest/diff read-only context budget presets (since v0.29.0)
o2b brain pre-compact-extract Extract decision/commitment/outcome/rule/open-question continuity records from bounded text (since v0.29.0)
o2b brain session-grep        Search imported session recall raw turns and summary nodes (since v0.29.0)
o2b brain session-describe    Count raw turns and deterministic summary depths for one session recall DAG (since v0.29.0)
o2b brain session-expand      Expand a session recall node to immediate sources and paginated raw turn content (since v0.29.0)
o2b brain import-claude-memory (CLI-only) Import metadata.type=feedback entries from a Claude Code memory directory into Brain/preferences/. --dry-run / --apply, sidecar manifest for idempotency, UPDATE preserves accumulated evidence
```

### Time axis (since v0.10.18)

```text
o2b brain timeline            Chronological event list; filter by --pref-id / --topic / --kind / --since / --until / --limit
o2b brain evolution           Per-preference or per-topic belief evolution with running evidence counts, walks supersedes / superseded_by retire chains
o2b brain stale               Structural staleness report (preferences / signals / log files) using configurable per-kind thresholds
o2b brain daily               Daily brief: counters, transitions, source pointers
o2b brain weekly              7-day synthesis with contradictions list (signal-suppressed events + apply-evidence violated rows)
o2b brain monthly             Monthly synthesis: event count, status transitions, retirements, contradictions, neglected areas
```

### Maintenance and operator surfaces

```text
o2b brain actions             Ranked next-step list combining doctor / dream warnings and lint candidates
o2b brain summary             Operator dashboard - trust verdict (clean | watch | investigate), doctor / dream counts, verification delta, instruction-file ceiling warnings, top maintenance actions
o2b brain page-dedup          Page-level duplicate detector (by content hash + frontmatter similarity)
o2b brain lint                Self-healing structural drift fixer; --consolidate folds multi-source duplicates
o2b brain token-footprint     Token-budget monitor across instruction files and active.md
o2b brain context-pack        Bounded-token vault slice for priming an agent's context window (--max-tokens N, --lanes for directives/constraints/consider; v0.29.0 adds opt-in --receipt, --telemetry, --cache-stable, --dedup-repeated)
o2b brain synthesise          Concept-scoped JSON envelope: target node + linkers + optional unlinked mentions
o2b brain moc-audit           Per-MOC coverage audit: classify cluster members into well-covered / fragile / candidate-missing
o2b brain unlinked            Raw-text mentions outside `[[...]]` (Unicode-aware boundaries)
```

### Context continuity and receipts (since v0.29.0)

```text
o2b brain context-pack        Existing budgeted context pack; add --receipt to emit a context receipt, --telemetry to emit redacted recall telemetry, --cache-stable for stable ordering diagnostics, and --dedup-repeated for repeated-context reference hints
o2b brain context-receipts    list [--trigger context_pack|pre_compress] [--host <name>] [--session-id <id>] [--limit <n>] [--json]; show <receipt-id> [--json]
o2b brain recall-telemetry    list|summary [--mode search|context_pack|pre_compress] [--status ok|empty|error|timeout] [--host <name>] [--since <iso>] [--until <iso>] [--limit <n>] [--json]
o2b brain context-presets     show [tight-context|long-context] --json; suggest --model <name> --context-window <tokens> --json; diff <preset-id> [current-value flags] [--override <path>...] --json
o2b brain pre-compact-extract --session-id <id> --turn-start <id> --turn-end <id> --text <bounded-text> [--host <name>] [--max-chars <n>] [--json]
o2b brain import-session      <path> --recall [--recall-session-id <id>] [--recall-summary-group-size <n>] [--json]
o2b brain session-grep        --query <text> [--session-id <id>] [--limit <n>] [--snippet-chars <n>] [--json]
o2b brain session-describe    --session-id <id> [--json]
o2b brain session-expand      <record-id> [--raw-limit <n>] [--cursor <offset>] [--json]
o2b brain handoff             <session-file> [--session-id <id>] [--format auto|claude|codex|hermes] [--json] - write Brain/handoffs/<date>-<scope>.md (since v0.37.0)
o2b brain intention           set|show|list|move [--scope S] [--text T] [--json] - scoped current-intention chains under Brain/intentions/ (since v0.37.0)
```

Receipts, telemetry, transforms, and session recall import are opt-in. Receipt and telemetry records store redaction-safe payloads, source references, hashes, counters, and bounded snippets rather than raw private prompt context; session recall stores redacted turn text only when explicitly imported for later expansion.

## Vault scope

Single exclusion policy for every vault walker.

```text
o2b vault status              Walks the vault under the active policy; reports include / exclude counts and which rules fired
o2b vault inspect <relpath>   Point-check one vault-relative path; reports matched rule, source, and whether the path exists on disk
o2b vault profile <sub>       Manage named multi-vault profiles (since v0.22.0): list | create <name> <vault> | switch <name>; pointer-based activation in profiles.json
o2b vault map [show]          Print the resolved vault-map role tokens -> folders (since v0.22.0), merging an optional Brain/_vault-map.yaml over defaults; read-only
```

## Discipline (daily logging cron)

```text
o2b discipline report         Render the daily MarkdownV2 block to stdout (brain-event counts per agent vs git/mtime/vault activity plus complexity-to-thinking ratio); status ok | info | alert
o2b discipline install        Register the Hermes cron job that delivers the report. --telegram-target is required; --at defaults to "59 4 * * *" UTC; --weekly installs a Monday 08:59 weekly digest
o2b discipline uninstall      Remove the cron job; --weekly removes only the weekly digest, without flag removes both
```

See [`hermes-cron.md`](hermes-cron.md) for the cron envelope and Telegram delivery shape.

## Pay Memory

```text
o2b init-pay-memory           Bootstrap Brain/payments/{policies,assets,drafts,reports}/ (+ dated YYYY-MM-DD receipt subdirs)
o2b append-payment-receipt    Save a Markdown receipt for a paid API call
o2b capture-asset             Save a Markdown note for a generated asset
o2b payment-report            Aggregate a date's receipts into a Markdown report
o2b check-payment-policy      Evaluate a paid call against policies/spending.json
o2b request-payment-approval  Create a pending payment request (human must approve)
o2b approve-payment-request   Mark a pending request as approved
o2b reject-payment-request    Mark a pending request as rejected
o2b consume-payment-request   Link an approved request to its resulting receipt
o2b list-pending-payments     List pending / approved / etc. requests
o2b payment-digest            Render a 4-line digest for a date
```

Full Pay Memory walkthrough: [`pay-memory.md`](pay-memory.md).

## Search

```text
o2b search "<query>"          Hybrid full-text + semantic search across the vault
                              --property type=decision --property status=open
                              filters on frontmatter scalars (post-FTS phase)
                              --query-doc '<lanes>' separates intent/lex/vec/hyde recall lanes
                              --evidence-pack adds matched/missing term diagnostics, abstention text,
                              IDF-weighted coverage, per-token union records, and a completeness verdict
                              --since/--until scope recall by document mtime (ISO date/datetime,
                              today / yesterday / last week / last month, or 24h / 7d / 2w shorthand)
                              --include-superseded keeps superseded predecessors undemoted (history mode)
                              --verbose adds per-result why_retrieved reasons
                              --json for structured output (includes reasons[])
                              CJK text is expanded for FTS recall without polluting returned content
o2b search feedback           Record explicit recall feedback for one result
                              (--query Q --result <path> --verdict up|down; one JSON event file
                              under Brain/search/feedback/, learned weights refresh deterministically)
o2b search weights            Show base weights, learned multipliers, event count, and bounds
                              --reset removes the derived learned-weights file (events kept)
o2b search focus set          Persist a 120-minute ranking focus (--query Q and/or --path P; --ttl-minutes N; --session S binds it to one session, since v0.37.0)
o2b search focus status       Show the active focus; --json emits { active, focus }
o2b search focus clear        Clear the persisted focus file next to the search index (--session S clears one session's focus)
o2b search reindex            Rebuild the SQLite + FTS5 index from scratch
                              (required after upgrading to v0.13.0 recall schema or v0.26.0 CJK FTS content)
                              --force-cost bypasses the embedding cost gate for this run (since v0.36.0)
o2b search index              Incrementally update the index; --embeddings computes vectors
                              --force-cost bypasses the embedding cost gate (since v0.36.0)
o2b search status             Index status; since v0.36.0 also reports the active embedding
                              signature (<provider>:<model>:<dimension>) and a refresh-cost estimate
o2b search provider add NAME  Register an OpenAI-compatible embedding endpoint (since v0.36.0)
                              --base-url U --model M --env-key K (K is the env var NAME holding the key);
                              persisted to Brain/search/embedding-providers.json, resolved after built-ins
o2b search provider list      List registered provider profiles (--json for the array)
o2b search provider show NAME Show one registered profile (--json)
o2b search provider remove    Remove a registered profile by NAME
```

Embedding providers (since v0.36.0): `embedding_provider` accepts the
built-in `openai-compat`, the offline `local` feature-hashing embedder
(no cloud, no key, no model download; `embedding_dimension` default 256),
`disabled`, or any name registered via `o2b search provider add`.
`embedding_cost_gate_usd` (default 0 = off) refuses an embedding run whose
estimated spend exceeds it unless `--force-cost`. `search_fusion_mode`
(default `linear`) may be set to `rrf` to fuse the keyword and semantic
lanes by reciprocal rank (`search_rrf_k`, default 60); `linear` keeps
ranking bit-identical.

Typed relations participate in ranking (relation polarity): a page whose
frontmatter declares `superseded_by:` is demoted when it matches and its
successor is boosted or pulled in, `contradicts:` surfaces warning-style
`why_retrieved` reasons on both endpoints without endorsement, and
`related` / `extends` / `depends_on` / `refines` grant a small bounded boost
between co-retrieved pages. Vaults without typed relations rank identically;
`search_relation_polarity_enabled: false` (or
`OPEN_SECOND_BRAIN_SEARCH_RELATION_POLARITY=false`) is the kill switch. Learned
recall weights are opt-in via `search_learned_weights_enabled: true` (or
`OPEN_SECOND_BRAIN_SEARCH_LEARNED_WEIGHTS=true`); multipliers stay within
[0.8, 1.2] and affected results carry a `learned_weights:` reason.

Structured recall query documents are line-oriented. `intent:` accepts
`neutral`, `exact`, `entity`, or `broad`; `lex:` accepts bare or quoted terms
and `-excluded` tokens; `vec:` and `hyde:` provide semantic text lanes when the
semantic layer is configured. Example:

```text
intent: entity
lex: "project alpha" -archived
vec: active implementation context
hyde: a note that explains the current project alpha decision
```

The fused ranking is sharpened by a recall-quality suite (v0.13.0), each
layer config-tunable and bounded:

| Config key                     | Env var                                          | Default | Effect                                                            |
| ------------------------------ | ------------------------------------------------ | ------- | ----------------------------------------------------------------- |
| `search_mmr_lambda`            | `OPEN_SECOND_BRAIN_SEARCH_MMR_LAMBDA`            | `0.7`   | MMR relevance-vs-diversity tradeoff; `1` disables diversification |
| `search_max_hops`              | `OPEN_SECOND_BRAIN_SEARCH_MAX_HOPS`              | `1`     | Link-graph traversal depth during recall; `0` disables            |
| `search_hop_decay`             | `OPEN_SECOND_BRAIN_SEARCH_HOP_DECAY`             | `0.5`   | Per-hop score multiplier for traversal-surfaced docs              |
| `search_max_expansion_per_hit` | `OPEN_SECOND_BRAIN_SEARCH_MAX_EXPANSION_PER_HIT` | `3`     | Cap on outbound links followed per node                           |

Recall and ranking quality (v0.20.0), each tunable and bounded:

| Config key                 | Env var                                      | Default | Effect                                                           |
| -------------------------- | -------------------------------------------- | ------- | ---------------------------------------------------------------- |
| `search_recency_shape`     | `OPEN_SECOND_BRAIN_SEARCH_RECENCY_SHAPE`     | `0.8`   | Weibull recency curve shape (k)                                  |
| `search_recency_scale`     | `OPEN_SECOND_BRAIN_SEARCH_RECENCY_SCALE`     | `30`    | Weibull characteristic lifetime in days                          |
| `search_recency_amplitude` | `OPEN_SECOND_BRAIN_SEARCH_RECENCY_AMPLITUDE` | `0.05`  | Max recency boost at age 0; `0` disables the recency layer       |
| `search_intent_enabled`    | `OPEN_SECOND_BRAIN_SEARCH_INTENT_ENABLED`    | `true`  | Re-weight ranking by structural query intent; `false` is neutral |
| `search_synonym_enabled`   | `OPEN_SECOND_BRAIN_SEARCH_SYNONYM_ENABLED`   | `false` | Opt-in co-occurrence query expansion (language-agnostic)         |
| `search_synonym_max_terms` | `OPEN_SECOND_BRAIN_SEARCH_SYNONYM_MAX_TERMS` | `3`     | Cap on expansion terms OR'd onto the query                       |
| `search_cache_enabled`     | `OPEN_SECOND_BRAIN_SEARCH_CACHE_ENABLED`     | `false` | Opt-in persistent query cache, gated by corpus generation        |
| `search_cache_ttl_seconds` | `OPEN_SECOND_BRAIN_SEARCH_CACHE_TTL`         | `300`   | Cache row time-to-live in seconds                                |

`brain_context_pack` also accepts `max_chars_per_memory` and
`max_total_chars` (code-point caps). Pass `--lanes` to keep the legacy flat
items while also returning `directives`, `constraints`, and `consider` lanes
derived from polarity cues and page tier. Surfaced item bodies are guarded by
deterministic prompt-injection checks; filtered items return a placeholder and
`safety.reasons` rather than hostile note text. The read-only
`brain_pre_compress_pack` MCP tool returns a budgeted
top-preferences-plus-`active.md` addendum for a host runtime to inject
before a context-compression event, with the same safety report shape.

Entity-boosted retrieval and header-anchored chunking populate on the
next reindex and need no configuration. Every result carries a
`why_retrieved` list naming the scoring layers that ranked it.

## Helpers

```text
o2b-hook                      Internal launcher invoked by hooks/hooks.json (Claude Code & Codex)
vault-log                     Shell mirror of brain_note (one-liner narrative milestones)
```

## Conventions

- Every CLI mutation that touches Brain takes a pre-run snapshot under `Brain/.snapshots/` with a SHA-256 sidecar manifest. `o2b brain rollback` aborts on drift unless `--force-rollback`.
- `o2b ... --json` exists on every read verb and most write verbs (the JSON payload mirrors the MCP tool's response shape).
- Root-level `--json` is inherited by every command parser; existing semantic JSON commands keep their native payloads, while other commands emit a redacted fallback envelope.
- MCP-only `brain_pinned_context` manages `Brain/pinned.md`, a transient current-task scratchpad loaded by `brain_context`; it is intentionally not a learned preference CLI verb.
- `--dry-run` is supported by every mutating verb that touches more than a single file (`brain merge`, `brain rollback`, `brain upgrade`, `brain import-claude-memory`, `update`, ...).
- `--vault` always overrides the profile path; useful for multi-vault hosts where the config-resolved default is not the right target.
