# CLI reference

The full set of `o2b` verbs. After `o2b install-cli` they are on PATH; the local checkout can also be used without installing the symlinks by running commands through `scripts/o2b` and `scripts/vault-log`.

Most verbs accept `--vault <path>` and `--config <path>`; the values default to the active profile from `o2b init`. JSON output is available via `--json` on every read verb. Commands that do not own a semantic JSON contract return a redacted fallback envelope when `--json` is passed.

## Core

```text
o2b status                    Show config / vault status
o2b init                      Bootstrap the vault profile (idempotent)
o2b init --interactive        Guided first-time setup wizard
o2b install-cli               Symlink o2b and vault-log into ~/.local/bin
o2b-mcp                       Console-script alias for `o2b mcp`, forwards all flags
o2b doctor                    Run vault + adapter checks
o2b index                     Rebuild the Markdown page index
o2b export-config             Write a redacted config snapshot
o2b secrets list|status       Inspect $secret:NAME references without printing values
o2b mcp                       Run the MCP tool server (stdio by default; --transport http requires --api-key); --scope full|writer|catalog, --tool-profile full|writer|catalog|recall|minimal, --probe, --allow-tool, --disable-tool, --max-tools
o2b tool-call                 Invoke an MCP tool handler from the CLI
o2b help --json               Print the command/flag manifest as JSON
o2b completions --shell zsh   Print completions for bash|zsh|fish|elvish|nushell|powershell
o2b uninstall                 Print uninstall plan; --apply-local cleans config; --remove-cli removes symlinks
o2b update                    Update Open Second Brain across all detected runtimes; --target <name> / --dry-run / --force / --json
```

## Brain (observing memory)

```text
o2b brain init                Bootstrap Brain/{inbox,preferences,retired,log,.snapshots}/ + _brain.yaml + _BRAIN.md; --starter drops the bundled example set
o2b brain feedback            Record one taste signal (--topic, --signal, --principle, --scope, ...); --scope is optional and falls back to feedback.default_scope from _brain.yaml when set
o2b brain dream               Run the deterministic consolidation pass (idempotent; usually cron'd)
o2b brain apply-evidence      Record applied / violated against a preference for a durable artifact
o2b brain note <text>         Append a one-line narrative milestone to Brain/log/<today>.md (cron / shell mirror of brain_note)
o2b brain digest              Render a Markdown or JSON summary of recent Brain transitions; --window 7d for arbitrary lookback; Markdown links follow link_output_format / OBSIDIAN_LINK_FORMAT
o2b brain intent-review       Read-only pre-dream review of active signal clusters; --now ISO; --json mirrors brain_intent_review
o2b brain retention           Recommendation-only lifecycle review over retired preferences and processed signals; --now ISO; --json mirrors brain_retention
o2b brain monthly             Month-level Brain synthesis over timeline events, transitions, retirements, contradictions, and neglected areas; --month YYYY-MM; --json mirrors brain_brief view=monthly
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
o2b brain generation-reports  Record/list/summarise opt-in inbound LLM generation traces (prompt hash + token counts only; kernel never calls an LLM)
o2b brain context-presets     Show/suggest/diff read-only context budget presets (since v0.29.0)
o2b brain pre-compact-extract Extract decision/commitment/outcome/rule/open-question continuity records from bounded text (since v0.29.0)
o2b brain post-compact-audit  Audit pinned-anchor survival after a compaction and re-assert drifted anchors (gated by post_compact_survival_audit)
o2b brain session-grep        Search imported session recall raw turns and summary nodes (since v0.29.0)
o2b brain session-describe    Count raw turns and deterministic summary depths for one session recall DAG (since v0.29.0)
o2b brain session-expand      Expand a session recall node to immediate sources and paginated raw turn content (since v0.29.0)
o2b brain session-summary     write|get|list a session-scoped structured digest (request/decisions/learnings/next_steps) (since v1.11.0)
o2b brain idea-lineage        Trace how a derived artifact was reached: observation -> synthesis -> conclusion over continuity sourceRefs or belief-evolution (since v1.11.0)
o2b brain note-history        Decompose a note's git history into episodic phases split on a commit-time gap (since v1.11.0)
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
o2b brain generation-reports  record <write_session|context_pack|dream_stage> --ref <id> --agent <name> --prompt <text> [--enable] [--provider <p>] [--model <m>] [--finish-reason <r>] [--latency-ms <n>] [--input-tokens <n>] [--output-tokens <n>] [--cached-tokens <n>] [--total-tokens <n>] [--scope <s>] [--source <id[=path]>...] [--created-at <iso>] [--json]; list|summary [--handoff <kind>] [--agent <name>] [--since <iso>] [--until <iso>] [--limit <n>] [--json]; show <report-id> [--json] - record is gated (default off) by --enable or generation_trace_enabled; stores prompt_hash + counts only
o2b brain context-presets     show [tight-context|long-context] --json; suggest --model <name> --context-window <tokens> --json; diff <preset-id> [current-value flags] [--override <path>...] --json
o2b brain pre-compact-extract --session-id <id> --turn-start <id> --turn-end <id> --text <bounded-text> [--host <name>] [--max-chars <n>] [--json]
o2b brain post-compact-audit  [--session-id <id>] [--no-reassert] [--force] [--vault <path>] [--json] - reads { session_id, messages } JSON from stdin; gated off by default (post_compact_survival_audit), --force overrides
o2b brain import-session      <path> --recall [--recall-session-id <id>] [--recall-summary-group-size <n>] [--json]
o2b brain session-grep        --query <text> [--session-id <id>] [--limit <n>] [--snippet-chars <n>] [--json]
o2b brain session-describe    --session-id <id> [--json]
o2b brain session-expand      <record-id> [--raw-limit <n>] [--cursor <offset>] [--json]
o2b brain handoff             <session-file> [--session-id <id>] [--format auto|claude|codex|hermes] [--json] - write Brain/handoffs/<date>-<scope>.md (since v0.37.0)
o2b brain hygiene             scan | apply --ids <id,...> [--detectors conflicts,dedup,freshness,usefulness] [--dry-run] [--json] - hygiene findings pipeline; review findings never execute (since v1.3.0)
o2b brain refresh             --stale [--dry-run] [--json] - targeted recompile of stale derived pages; orphans archive into Brain/.snapshots (since v1.3.0)
o2b brain anticipate          --session <id> [--refresh] [--signal <text>] [--json] - read or warm the anticipatory context cache for the session's lineage root (since v1.3.0)
o2b brain intention           set|show|list|move [--scope S] [--text T] [--json] - scoped current-intention chains under Brain/intentions/ (since v0.37.0)
o2b brain obligation          add|done|list|show|remove [--title T] [--cadence C] [--anchor YYYY-MM-DD] [--date YYYY-MM-DD] [--slug S] [--notes N] [--overdue] [--json] - recurring obligations under Brain/obligations/ with a deterministic cadence-driven next-due date; cadences: daily|weekly|biweekly|monthly|quarterly|yearly|every-<N>-days (since v1.15.0)
o2b brain agenda              --events <file|-> [--focus-min N] [--owner-domain D[,D2]] [--workday-start HH:MM --workday-end HH:MM] [--json] - stateless agenda synthesis over caller-provided calendar events: overlap conflicts, free focus blocks, external-organizer flags; no vault writes (since v1.15.0)
o2b brain okf-export          --out <dir> [--force] [--json] - write a portable Open Knowledge Format bundle (concepts/queries/references + date-grouped log.md + okf.json manifest) to a directory; read-only on the vault (since v1.15.0)
o2b brain okf-import          <bundle-dir> [--trusted] [--json] - import an Open Knowledge Format bundle; default stages pages under OKF Review/ as review candidates, --trusted writes them to their recorded paths; foreign-producer provenance is stamped (since v1.15.0)
```

Receipts, telemetry, transforms, and session recall import are opt-in. Receipt and telemetry records store redaction-safe payloads, source references, hashes, counters, and bounded snippets rather than raw private prompt context; session recall stores redacted turn text only when explicitly imported for later expansion.

### Workspace reach and proactive insight (since v0.38.0)

```text
o2b brain project             link <path> [--vault V] | list | remove <path> | status [path] [--json] - .o2b-vault.json pointer files; resolveVault honours the nearest pointer (env override still wins)
o2b brain source              add <vault> --alias <name> | list | remove <alias> [--json] - read-only recall sources of the active vault; BROKEN flag for missing targets
o2b brain links               normalize [path-prefix] [--mode preserve|full|short] [--write] [--json] - wikilink path format rewrite; dry-run by default; config key wiki_link_format
o2b brain profile             [--stale-seconds N] [--force] [--json] - materialize Brain/profile.md digest + .o2bfs root marker (age-gated)
o2b brain sgrep               <query> [path-prefix] [--limit N] [--keyword-only] [--json] - grep-shaped semantic search; path:line: lines; exit 1 on no matches
o2b brain trigger             scan | list [--status S] | ack <id> | dismiss <id> | act <id> | history [--json] - grounded trigger queue; cooldown via trigger_cooldown_days (default 7)
o2b brain deep-synthesis      <topic> [--limit N] [--triggers] [--json] - deterministic topic dossier: agreements, contradictions, stale claims, knowledge gaps, plus a strongest-objection steelman
o2b brain ideas               [--cap N] [--triggers] [--json] - ranked next-direction candidates from open questions, orphan notes, aging signals
o2b brain recall-telemetry    gate-list | gate-summary [--host <name>] [--since <iso>] [--until <iso>] [--limit <n>] [--json] - recall-gate decision telemetry (recall_gate_telemetry, default off)
o2b search <query> --global   Cross-vault union over profiles + read-only sources; origin-labelled results; external vaults are never written to
```

Trigger generation, brief delivery, and gate telemetry are pull-based or config-gated; pointer resolution activates only when a pointer file exists.

### Memory observability (since v0.39.0)

```text
o2b brain continuity          export --format atof|atif [--session <id>] [--month YYYY-MM] [--out <dir>] [--json] - read-only trajectory export of the continuity store; private records dropped, redacted text stays masked
o2b brain bench               memory --fixture <name|path> [--resume <run-id>] [--runs-dir <dir>] [--json] - memory quality benchmark over a disposable fixture vault; quality, latency, and context cost reported separately; checkpoint/resume by run id; exit 1 on any failed question
```

The benchmark never touches the configured vault - the fixture materializes into `<runs-dir>/<run-id>/vault` (default runs dir `.open-second-brain/bench-runs/`, gitignored). The optional `bench_judge_cmd` config key (env `OPEN_SECOND_BRAIN_BENCH_JUDGE_CMD`) arms an advisory external judge; absent means the judge phase is skipped. The full observability contract (event kinds, gates, correlation ids, payload safety, schema version) lives in `docs/observability.md`.

### Project history (since v0.40.0)

```text
o2b brain git                 ingest <repo-path> [--max-count N] - read-only walk of a worktree; commit/tag/release records + digest note land under Brain/projects/git/<repo-key>/; incremental via SHA-validated watermark, full re-scan with a reported warning on force-push or tampered state
                              status - per-repo watermarks and record counts
                              find [text] [--repo K] [--file F] [--author A] [--since S] [--until U] [--limit N] - query ingested history newest-first; no live git on the query path
                              mine [--repo K] - surface decision-shaped commits as draft ADR candidate notes under Brain/decisions/candidates/ (sha-stable identity, skip-existing)
o2b brain architect           <project-path> - deterministic stdlib-only project scan rendered as architecture notes under Brain/projects/arch/<repo-key>/; generated content lives in o2b:begin/o2b:end sentinel regions, operator prose outside regions survives every re-scan byte-for-byte
```

All flags accept `--vault V` and `--json`. The ingest never modifies the scanned repository; every caller-supplied sha is validated against the full-40-hex grammar before it can reach a git argument.

### Agent write sessions (since v0.41.0)

```text
o2b brain session             open --target <Brain/...md> [--schema-type S] [--intent create|overwrite|merge] [--prompt P] [--require-review] [--retry-cap N] - open an artifact write session; the envelope carries the generation prompt, schema hints, and collision metadata for an occupied target
                              submit <id> [--file F|-] - submit the generated artifact (stdin without --file); done | needs-correction with coded errors and a compact correction prompt | needs-review
                              approve <id> - operator-side commit of a needs-review session
                              abandon <id> - terminal abandon
                              status <id> | list | sweep - inspect or clean the session store (Brain/.sessions/write/, lazy TTL default 24h)
o2b brain panel               open <topic...> [--personas a,b,c] [--target T] [--require-review] - convene a decision panel; personas from Brain/personas/ (built-in defaults: technical, strategic, risk, user-experience)
                              submit <id> [--file F|-] - answer the current persona step or the synthesis; the committed note lands under Brain/decisions/panels/
                              status <id> - live envelope of a panel session
```

Envelopes are stable JSON with `--json` (`status`, `step`, `prompt`, `errors`, `attempts_left`, `expires_at`, `target_path`, `existing`) - the same contract the MCP `brain_write_session` tool returns. `create` intent never overwrites an existing target; `merge` appends a session-stamped delimited section; reserved namespaces (`Brain/preferences/`, `Brain/log/`, `Brain/_brain.yaml`, dot-stores) are refused. The Brain never generates content - the calling agent does.

### Recall activation (since v0.42.0)

```text
o2b brain activation          status [--top N] - folded activation state: event/path/co-access counts plus the strongest paths
                              sweep [--retention-days N] [--max-events N] - drop access events outside the retention window or beyond the newest-N cap and refold (--max-events 0 clears every retained event)
```

CLI and MCP searches record which documents they surfaced as one JSON event per access under `Brain/search/activation/` (query hashed, never raw text). `o2b search <query> --no-record-access` suppresses recording for one query; the MCP `brain_search` tool accepts `record_access: false`. Cross-vault (`--global`) and query-cache-hit searches never record, so reinforcement is miss-driven. The derived `Brain/search/activation-state.json` is a replayable fold - deleting it loses nothing. `search_activation_enabled: false` disables both the boost and recording; `search_two_pass_enabled: false` disables the evidence-pack broadened retry.

### Entity truth and self-improving dream (since v0.43.0)

```text
o2b brain truth               ingest --entity E --aspect A --value V --source S [--quantity-value N --quantity-unit U --quantity-action W] - append one claim to the ledger
                              slots [--entity E] - current values with superseded history and CONTESTED flags
                              conflicts [--window-days N] - value conflicts (independent sources within the window; resolution always ask_user)
                              aggregate --action W [--unit U] [--entity E] - sum exact (entity, action, unit) quantity matches
                              collisions [--window-days N] - cross-agent convergence on one entity
                              sweep [--max-events N] - keep the newest N claim events and refold
o2b brain facts               decompose (--file <path> | --text <text>) [--ingest --entity E] - deterministic atomic assertions; --ingest appends structured-family claims
o2b brain dead-end            record --approach T --reason T [--context T] | list - negative-knowledge registry under Brain/dead-ends/
o2b brain foresight           [--horizon-days N] [--write] - forward projection: routines coming due, open commitments, open questions
```

Claims live as device-sharded append-only JSONL under `Brain/truth/` with a recomputable `state.json` fold - deleting the cache loses nothing. The merge guard rides `o2b brain merge` (an `entity-guard` refusal when the two preferences anchor disjoint people/orgs; `--force` bypasses). `o2b brain apply-evidence` accepts `--outcome success|failure|unknown`; the dream pass stages `outcome_regressions` with a deterministic confidence penalty when applied events carry repeated failures. `brain_review_candidates` annotates inbox signals with `signal_novelty` when the vault has indexed embeddings.

### Write-time integrity and governance (since v0.44.0)

```text
o2b brain label               <path> <dimension>=<value> | --remove <dimension> | --show - controlled-vocabulary classification; fail-closed against the schema pack's labels field
o2b brain attr                <path> <field>=<value> | --remove <field> | --show - per-type attribute fields; an undeclared field error lists the declared fields WITH descriptions
o2b brain tiers               check | restore <path> [--field F] --apply | accept <path> [--field F] - staged repair for identity-tier frontmatter hand-edits
o2b brain secret              set <name> [--env-var V] [--allow PATTERN]... [--from-env SRC] | list | rm <name> | run <name> -- <command...> - capability-gated custody; the value enters via stdin, never argv
o2b brain maintenance         run [--force] [--window H-H] [--tz ZONE] [--busy-minutes N] [--busy-threshold N] | status [--limit N] - quiet-window lease-guarded lane for dream + reindex
```

The schema pack gains four additive ontology fields (`labels`, `link_constraints`, `attributes`, `frontmatter_tiers`) with audited mutations through `o2b brain schema apply`. Link constraints enforce at index materialization: a typed edge whose endpoint page types violate the declared pairs falls back to an untyped link, `o2b brain schema lint` lists each violation, and removing the constraint restores the edges on the next index run. Tier drift detection rides the same index pass - the snapshot keeps the expected value, so reindexes never absorb a hand-edit, and `brain_doctor` warns with the open count. Filter labelled recall with `o2b search <q> --property labels=<dim>/<value>`. Secrets protect against context leakage and vault sync exposure, not against root; every custody operation lands a no-values record in `Brain/log/secret-custody/`. A maintenance gate skip exits 0 so cron never alarms on a quiet hour.

### Link and recall intelligence (since v0.45.0)

```text
o2b brain bridges             discover [--max N] [--min-similarity X] | list | accept <source> <target> | dismiss <source> <target> - embedding-near link proposals over the vec index, reviewable artifact, accept writes one related: wikilink
o2b brain clusters            run [--min-size N] [--batch-size N] | list - graph-wide community detection; derived digests under Brain/clusters/, regenerated per run; --batch-size materializes in chunks with isolated, reported per-batch failures
o2b brain vitals               [--orphan-threshold N] - aggregate governance scorecard over confirmed preferences: domain_diversity (scope entropy), connectivity_index (mean evidenced_by count), orphan_preferences (below threshold, default 2), gap_pressure (open concept-gap findings ÷ preference count, reused from doctor); records the vault_vitals metric
o2b brain benchmark           run --dataset <path> [--k N] [--expand] - hit@k + MRR against the live hybrid recall; records the recall_benchmark metric
o2b brain tune                run --dataset <path> [--k N] | status | reset - bounded self-tuning grid judged by the benchmark; persisted to Brain/search/tuning.json
o2b search <query> --expand   deterministic lex/vec/hyde expansion of a bare query (stopword-stripped lex, entity-context vec line, template hyde passage)
```

Wikilinks to frontmatter `aliases:` resolve at index materialization (schema v7): exact paths always win, a real basename is never shadowed, collisions resolve first-wins by sorted path, and `o2b search status` counts the pass via `IndexStats.aliasResolved`. Bridge discovery and clusters also run as maintenance-lane tasks after `reindex`. Self-tuning only changes behavior under `search_self_tuning_enabled` (or `OPEN_SECOND_BRAIN_SEARCH_SELF_TUNING=1`); an explicit `--expand`/`expand` always wins over the tuned default. Every surface appends one run-level record to `Brain/metrics/<surface>.jsonl` - the dashboard data contract documented in `docs/metrics.md`.

## Stability and trust (since v1.0.0)

```text
o2b brain dream               [run] [--dry-run] | stage | validate <run-id> | apply <run-id> | discard <run-id> | list - staged lifecycle over a persisted proposal bundle; validate/apply exit 1 on drift
o2b brain doctor              gains the removed-tool-reference warning: vault notes, root instruction files, and installed skills naming a tool removed in 1.0.0 are flagged with the replacement
o2b brain doctor              opt-in `entity-alias-candidate` lint (off by default): with `entity_semantic_dedup_enabled: true` surfaces lexical entity-name variants ("Google LLC" vs "Google Inc") as PROPOSAL-ONLY alias-merge candidates via a deterministic jaccard layer (`entity_semantic_dedup_lexical_threshold`, default 0.8); never auto-merges or rewrites the identity key. The embedding-cosine layer (`entity_semantic_dedup_threshold`, default 0.92, reuses the configured embedding provider) is exposed as a library reader for apply plans
o2b brain daily | weekly | monthly | morning-brief | timeline
                              gain additive timezone + local_time JSON fields when `timezone:` is configured; storage stays canonical UTC
o2b brain digest | daily | weekly
                              with report_snapshots_enabled persist Brain/reports/<surface>/<date>.json and report a deterministic Since-last-run delta
```

Long-running operations (dream, `o2b search index | reindex`, bridges discover, clusters run, the maintenance lane) run under a cooperative safeguard deadline: `safeguard_timeout_seconds` (default 600, `0` disables, env `OPEN_SECOND_BRAIN_SAFEGUARD_TIMEOUT`) with per-operation overrides like `safeguard_timeout_dream_seconds`. A tripped deadline aborts at the next checkpoint - between atomic writes - and reports `{ok:false, timed_out:true}` on exit 1; maintenance-lane task results carry `timed_out` per task. The frozen-surface policy lives in `docs/stability.md`; the 0.x to 1.0.0 migration table in `docs/updating.md`.

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

## Partner (read-only, since v1.12.0)

Reports on external code-project partners. Strictly read-only: never installs, initializes, extracts, or mutates a partner index or the vault.

```text
o2b partner codegraph report  Resolve the in-scope code project and report the codegraph index state (no_project | absent | not_indexed | indexed with node/file/edge counts | error) plus a structural Cargo.toml workspace-member list. When indexed, runs a read-only, non-blocking graph-health gate (index.health) that flags empty-graph, collapsed-edges, dangling-references, self-loops, and cache-root-mismatch before labeling/import/recall trust the graph. Non-Rust projects report cargo_workspace: null with a reason. --vault sharpens the scan scope; --json emits the schema-versioned report
```

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
| `search_chain_stop_enabled`| `OPEN_SECOND_BRAIN_SEARCH_CHAIN_STOP`        | `false` | Opt-in cross-vault early termination once an origin answers confidently |
| `search_chain_stop_score`  | `OPEN_SECOND_BRAIN_SEARCH_CHAIN_STOP_SCORE`  | `0.8`   | Normalized `[0,1]` top-score threshold that triggers the chain-stop |

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
