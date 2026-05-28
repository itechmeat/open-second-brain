# CLI reference

The full set of `o2b` verbs. After `o2b install-cli` they are on PATH; the local checkout can also be used without installing the symlinks by running commands through `scripts/o2b` and `scripts/vault-log`.

Most verbs accept `--vault <path>` and `--config <path>`; the values default to the active profile from `o2b init`. JSON output is available via `--json` on every read verb.

## Core

```text
o2b status                    Show config / vault status
o2b init                      Bootstrap the vault profile (idempotent)
o2b init --interactive        Guided first-time setup wizard
o2b install-cli               Symlink o2b and o2b-hook into ~/.local/bin
o2b doctor                    Run vault + adapter checks
o2b index                     Rebuild the Markdown page index
o2b export-config             Write a redacted config snapshot
o2b mcp                       Run the MCP tool server (stdio)
o2b tool-call                 Invoke an MCP tool handler from the CLI
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
o2b brain backlinks           List inbound references to a Brain artifact id
o2b brain scan-inline         Capture `@osb` markers from folders listed under `notes.read_paths` in _brain.yaml
o2b brain import-session      Replay signals from a registered agent session .jsonl (or directory)
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
o2b brain context-pack        Bounded-token vault slice for priming an agent's context window (--max-tokens N)
o2b brain synthesise          Concept-scoped JSON envelope: target node + linkers + optional unlinked mentions
o2b brain moc-audit           Per-MOC coverage audit: classify cluster members into well-covered / fragile / candidate-missing
o2b brain unlinked            Raw-text mentions outside `[[...]]` (Unicode-aware boundaries)
```

## Vault scope

Single exclusion policy for every vault walker.

```text
o2b vault status              Walks the vault under the active policy; reports include / exclude counts and which rules fired
o2b vault inspect <relpath>   Point-check one vault-relative path; reports matched rule, source, and whether the path exists on disk
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
                              --verbose adds per-result why_retrieved reasons
                              --json for structured output (includes reasons[])
o2b search reindex            Rebuild the SQLite + FTS5 index from scratch
                              (required after upgrading to the v0.13.0 schema)
```

The fused ranking is sharpened by a recall-quality suite (v0.13.0), each
layer config-tunable and bounded:

| Config key                     | Env var                                          | Default | Effect                                                            |
| ------------------------------ | ------------------------------------------------ | ------- | ----------------------------------------------------------------- |
| `search_mmr_lambda`            | `OPEN_SECOND_BRAIN_SEARCH_MMR_LAMBDA`            | `0.7`   | MMR relevance-vs-diversity tradeoff; `1` disables diversification |
| `search_max_hops`              | `OPEN_SECOND_BRAIN_SEARCH_MAX_HOPS`              | `1`     | Link-graph traversal depth during recall; `0` disables            |
| `search_hop_decay`             | `OPEN_SECOND_BRAIN_SEARCH_HOP_DECAY`             | `0.5`   | Per-hop score multiplier for traversal-surfaced docs              |
| `search_max_expansion_per_hit` | `OPEN_SECOND_BRAIN_SEARCH_MAX_EXPANSION_PER_HIT` | `3`     | Cap on outbound links followed per node                           |

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
- MCP-only `brain_pinned_context` manages `Brain/pinned.md`, a transient current-task scratchpad loaded by `brain_context`; it is intentionally not a learned preference CLI verb.
- `--dry-run` is supported by every mutating verb that touches more than a single file (`brain merge`, `brain rollback`, `brain upgrade`, `brain import-claude-memory`, `update`, ...).
- `--vault` always overrides the profile path; useful for multi-vault hosts where the config-resolved default is not the right target.
