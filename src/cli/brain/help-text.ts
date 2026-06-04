/**
 * Help text for `o2b brain` and each of its verbs.
 *
 * Pure data: no runtime imports beyond what the dispatcher needs.
 * Split out of `./helpers.ts` so the verb-handler bundle does not
 * have to load this ~200-line string table when it only needs
 * `parse` / `resolveBrainVault`.
 */

export const BRAIN_HELP = `usage: o2b brain <verb> [args...]

Brain verbs (observing memory):
  init             Bootstrap <vault>/Brain/ (idempotent; --force overwrites)
  feedback         Record a taste signal (--topic, --signal, --principle)
  dream            Run the deterministic dreaming pass (idempotent)
  apply-evidence   Log a real-work application of a preference
  note             Append a one-line narrative milestone to Brain/log/today
  digest           Render the recent-changes digest (markdown or --json)
  intent-review    Read-only pre-dream review of active signal clusters
  retention        Recommendation-only keep/improve/park/prune review
  monthly          Monthly synthesis over Brain timeline activity
  query            Read by --preference, --topic, or --since
  agent-query      Read Brain provenance by source agent (--agent; --json)
  agent-diff       Compare source-agent coverage (browse/search/diff/map)
  reject           Move a preference to retired (user-rejected); --yes if pinned
  pin              Mark a preference exempt from automatic retire (idempotent)
  unpin            Clear the pinned flag (idempotent)
  set-primary      Declare or clear primary_agent in _brain.yaml (--clear)
  protect          Emit / apply native deny rules for Brain/ (--target {claudecode|codex} [--apply])
  unprotect        Remove OSB-managed deny rules for the chosen target (--target)
  merge            Merge two near-duplicate preferences (<keep> <drop>; --dry-run, --force)
  upgrade          Migrate release-owned files forward (--dry-run by default; --apply --yes)
  export           Dump active preferences (--format json|llms-txt [--out <path>])
  explorer         Launch the loopback HTML explorer; --export <path> writes a single offline file
  snapshot diff    Read-only diff between two snapshots, or snapshot vs live
  rollback         Restore Brain/ from a snapshot (--list or <run_id>; --yes;
                   --dry-run previews via the same diff renderer)
  doctor              Validate Brain invariants (--strict; --remediate [--dry-run])
  watchdog            Probe Brain health and plan safe recovery (--remediate, --restore, --force-restore)
  health              Semantic-health report: contradictions, concept gaps, stale claims
  history             Render a preference's edit-history timeline
  activation          Activation event store: status and sweep
  audit               Render a preference's full mutation audit trail
  morning-brief       Session-start summary: top prefs, open questions, recent notes
  codec               Compress/expand session prose with the deterministic codec (stdin/--in)
  sources             Read-only dashboard of signals by (agent, source_type)
  schema              Inspect resolved schema vocabulary and artifact token usage
  graph-export        Serialise the vault knowledge graph to graph.json
  graph-import        Reconstruct vault pages from graph.json (--mode skip|overwrite|merge)
  backlinks           List inbound references to a Brain artifact id
  semantics-backfill  Preview deterministic typed preference-edge backfill proposals
  mcp-landscape       List MCP servers configured across the vault (packages, env names)
  scan-inline         Capture @osb markers from folders listed under notes.read_paths in _brain.yaml
  import-session      Replay signals from a registered agent session .jsonl (or directory)
  entity              Canonical entity registry: set, get, list, relate, archive
  session-hook        Capture one runtime hook payload from stdin (internal hook bridge)
  import-claude-memory  Import metadata.type:feedback MEMORY entries as confirmed preferences
  page-dedup          Detect (and optionally merge) near-duplicate vault pages
  token-footprint     Report per-category vault token size with a warn threshold
  context-pack        Return a tier-then-recency vault slice under a token budget
  context-receipts    List/show prompt context receipt records
  context-presets     Show/suggest/diff read-only context budget presets
  pre-compact-extract Extract typed continuity records from bounded text
  recall-telemetry    List/summarize opt-in recall telemetry records
  skill-proposals     Learn/list/review deterministic skill proposals
  procedural-memory   Reconcile/list procedural memory index and usage
  procedural-graph    Rebuild/show procedural graph and hint projections
  recurrence          Inspect and update recurrence/support diagnostics
  attention-flows     Declarative attention recipes for open loops and learnings
  session-grep        Search imported session recall turns and summaries
  session-describe    Describe an imported session recall DAG
  session-expand      Expand a session recall node to source turns
  lint                Self-healing structural checks (--consolidate); --apply to write
  actions             Ranked maintenance action list (dedup + lint + footprint)
  summary             Operator dashboard: trust verdict, doctor/dream counts, actions
  unlinked            Raw-text mentions of an artifact's title/aliases outside [[...]]
  synthesise          Concept cluster: target + linkers (depth-1), optionally + mentions
  moc-audit           Per-MOC coverage audit (well-covered/fragile/candidate-missing)
  timeline            Chronological event list filtered by pref-id/topic/kind/since/until
  evolution           Per-pref or per-topic story: status transitions + evidence + retire
  stale               Stale preferences/signals/log files (configurable thresholds)
  daily               Daily brief: events by kind, status transitions, vault delta
  weekly              7-day synthesis: transitions, retired, contradictions, vault delta
  project             Link project directories to their owning vault (link/list/remove/status)
  source              Read-only recall sources of the active vault (add/list/remove)
  links               Normalize wikilink path format (preserve/full/short); dry-run by default
  profile             Materialize Brain/profile.md digest + .o2bfs root marker (age-gated)
  sgrep               Grep-shaped semantic search: o2b brain sgrep <query> [path]
  trigger             Proactive trigger queue with anti-nag lifecycle (scan/list/ack/dismiss/act/history)
  deep-synthesis      Topic dossier: notes, agreements, contradictions, stale claims, gaps
  ideas               Ranked next-direction candidates from open loops (--triggers to enqueue)
  continuity          Export continuity records as ATOF/ATIF trajectories (read-only)
  bench               Memory quality benchmark over a disposable fixture vault
  git                 Git history as project memory: ingest, status, find, mine
  architect           Deterministic architecture notes for a code project
  session             Agent write sessions: open, submit, approve, abandon, status, list, sweep
  panel               Multi-persona decision panel riding the write-session kernel

Common flags:
  --vault <path>   Override the configured vault
  --json           Structured output where applicable
  --help           Per-verb help (run \`o2b brain <verb> --help\`)
`;

export const VERB_HELP: Record<string, string> = {
  init:
    "usage: o2b brain init [--vault <path>] [--force] [--primary-agent <name>] [--json]\n" +
    "Bootstrap <vault>/Brain/. Requires `o2b init` to have run first.\n" +
    "--primary-agent <name> writes the value into _brain.yaml on first init;\n" +
    "on re-run against an existing _brain.yaml use `o2b brain set-primary` instead.\n",
  feedback:
    "usage: o2b brain feedback --topic <slug> --signal positive|negative --principle <text>\n" +
    "  [--scope <slug>] [--source <wikilink>...] [--agent <name>] [--raw <text>|--raw-file <path>]\n" +
    "  [--force-confirmed] [--vault <path>] [--json]\n" +
    "Creates a `sig-*.md` in Brain/inbox/. With --force-confirmed also creates a `pref-*.md`.\n",
  dream:
    "usage: o2b brain dream [--vault <path>] [--dry-run] [--now <ISO-8601>] [--json]\n" +
    "Runs the deterministic dreaming algorithm. Idempotent on rerun.\n",
  "apply-evidence":
    "usage: o2b brain apply-evidence --pref <id> --artifact <wikilink> --result applied|violated|outdated\n" +
    "  [--agent <name>] [--note <text>] [--vault <path>] [--json]\n" +
    "Appends a single event to today's log. Missing preference exits 2.\n",
  note:
    "usage: o2b brain note <text> [--agent <name>] [--vault <path>] [--config <path>] [--json]\n" +
    "Append one narrative-milestone line to Brain/log/<today>.md under the `note`\n" +
    "event kind. CLI mirror of the MCP `brain_note` tool — same on-disk contract.\n" +
    "Use from cron jobs and shell scripts. Multi-line text collapses to one line.\n",
  digest:
    "usage: o2b brain digest [--vault <path>] [--since <ISO>] [--until <ISO>] [--json] [--silent-if-empty]\n" +
    "Renders the 24-hour change digest. Empty + --silent-if-empty exits 2.\n",
  "intent-review":
    "usage: o2b brain intent-review [--vault <path>] [--now <ISO-8601>] [--json]\n" +
    "Read-only pre-dream review of active signal clusters. Surfaces whether\n" +
    "each topic is ready for main dream review, needs more evidence, or is\n" +
    "blocked by conflicting signals.\n",
  retention:
    "usage: o2b brain retention [--vault <path>] [--now <ISO-8601>] [--json]\n" +
    "Recommendation-only lifecycle review over retired preferences and\n" +
    "processed signals. Reports keep/improve/park/prune candidates and never\n" +
    "deletes or moves artifacts.\n",
  monthly:
    "usage: o2b brain monthly [--vault <path>] [--month YYYY-MM] [--json]\n" +
    "Read-only monthly synthesis over the Brain timeline: event count, status\n" +
    "transitions, retirements, contradictions, and neglected areas when\n" +
    "expected areas are supplied by future callers.\n",
  query:
    "usage: o2b brain query --preference <id> | --topic <slug> | --since <ISO> [--vault <path>] [--json]\n" +
    "Read-only lookup. One of --preference / --topic / --since is required.\n",
  "agent-query":
    "usage: o2b brain agent-query [--agent <id>...] [--topic <slug>] [--query <text>]\n" +
    "                             [--kind signal|preference|log] [--limit <n>]\n" +
    "                             [--vault <path>] [--json]\n" +
    "Read-only source-agent retrieval over Brain provenance. Omit --agent to query all known agents.\n",
  "agent-diff":
    "usage: o2b brain agent-diff [--mode browse|search|diff|map] [--agent <id>...]\n" +
    "                            [--topic <slug>] [--query <text>]\n" +
    "                            [--kind signal|preference|log] [--limit <n>]\n" +
    "                            [--vault <path>] [--json]\n" +
    "Compare source-agent coverage using the same provenance foundation as agent-query.\n",
  reject:
    "usage: o2b brain reject --id <pref-id> --reason <text> [--yes] [--vault <path>] [--json]\n" +
    "Move a preference to retired/ with reason 'user-rejected'. --yes required when pinned.\n",
  pin:
    "usage: o2b brain pin --id <pref-id> [--vault <path>] [--json]\n" +
    "Set pinned: true. Idempotent. Exempts the preference from automatic retire.\n",
  unpin:
    "usage: o2b brain unpin --id <pref-id> [--vault <path>] [--json]\n" +
    "Clear pinned: true. Idempotent.\n",
  rollback:
    "usage: o2b brain rollback <run_id> [--vault <path>] [--yes]\n" +
    "                          [--force-rollback] [--json]\n" +
    "       o2b brain rollback <run_id> --dry-run [--vault <path>] [--json]\n" +
    "       o2b brain rollback --list [--vault <path>] [--json]\n" +
    "Restore Brain/ from a snapshot. Interactive prompt unless --yes.\n" +
    "--dry-run prints the would-be restore plan as live → snapshot\n" +
    "diff and exits 0 without writing.\n" +
    "From v0.10.6 each snapshot carries a sidecar sha256 manifest of\n" +
    "the Brain/ tree captured at snapshot time. rollback compares it\n" +
    "against the current Brain/ and aborts with exit 2 if they\n" +
    "differ — typically because another device (Syncthing) edited the\n" +
    "vault between snapshot and rollback. Pass --force-rollback to\n" +
    "overwrite anyway; the log entry records `drift_overridden: true`.\n" +
    "Snapshots produced before v0.10.6 have no sidecar; rollback emits\n" +
    "a stderr warning and falls through to the legacy direct-restore\n" +
    "path.\n",
  snapshot:
    "usage: o2b brain snapshot diff <run_id_a> [<run_id_b>]\n" +
    "                              [--vault <path>] [--json]\n" +
    "Read-only diff between two snapshots, or between a snapshot and\n" +
    "the live Brain/ tree (when <run_id_b> is omitted).\n",
  doctor:
    "usage: o2b brain doctor [--vault <path>] [--json] [--strict]\n" +
    "                        [--remediate [--dry-run]]\n" +
    "Validate invariants. Warnings exit 0 (or 2 with --strict). Errors always exit 1.\n" +
    "--remediate builds a dependency-ordered repair plan and applies the\n" +
    "auto-safe steps (content-hash re-stamp); --dry-run previews without writing.\n",
  watchdog:
    "usage: o2b brain watchdog [--vault <path>] [--json] [--remediate [--dry-run]]\n" +
    "                           [--restore <run_id> [--force-restore]] [--attempt <n>]\n" +
    "Probe Brain config/dirs/search index, emit recovery recommendations, and apply only explicit safe repairs.\n" +
    "Snapshot restore is refused unless --restore and --force-restore are both explicit; use rollback for execution.\n",
  health:
    "usage: o2b brain health [--vault <path>] [--json]\n" +
    "Semantic-health report: contradictory confirmed preferences, recurring\n" +
    "concepts with no dedicated preference, and confirmed preferences on stale\n" +
    "evidence, plus a clean/watch/investigate verdict. Read-only.\n",
  history:
    "usage: o2b brain history <slug> [--vault <path>] [--json]\n" +
    "Render a preference's edit-history timeline (one entry per content\n" +
    "mutation: principle/scope/status before -> after). Read-only.\n",
  activation:
    "usage: o2b brain activation <status|sweep> [--top N] [--retention-days N] [--max-events N] [--vault <path>] [--json]\n" +
    "Operator surface over the recall activation event store (Brain/search/activation/).\n" +
    "status reports the folded per-path activation and co-access pairs; sweep drops\n" +
    "events outside the retention window or beyond the newest-N cap and refolds.\n",
  audit:
    "usage: o2b brain audit <pref-id> [--vault <path>] [--json]\n" +
    "Render a preference's full mutation audit trail (create / promote /\n" +
    "update / retire / merge) with agent, reason, and revision + content-hash\n" +
    "before/after. A ret- or bare-slug argument resolves to the same trail.\n" +
    "Read-only.\n",
  "semantics-backfill":
    "usage: o2b brain semantics-backfill [--vault <path>] [--json]\n" +
    "Dry-run only. Previews deterministic typed preference-edge backfill\n" +
    "proposals, currently the inverse superseded_by edge when an active\n" +
    "preference supersedes a retired preference that lacks the pointer.\n",
  codec:
    "usage: o2b brain codec --compress | --expand [--in <file>]\n" +
    "Run the deterministic, lossless session codec over stdin (or --in <file>)\n" +
    "and print the result to stdout. Read-only; structured content preserved.\n",
  sources:
    "usage: o2b brain sources [--vault <path>] [--json]\n" +
    "Read-only dashboard of the brain's signals grouped by (agent, source_type)\n" +
    "with active/processed and distinct-topic counts.\n",
  schema:
    "usage: o2b brain schema [report|stats|lint|graph|explain|orphans|apply|sync] [--vault <path>] [--json]\n" +
    "Inspect and mutate the active runtime schema vocabulary through locked, audited writes.\n",
  "session-hook":
    "usage: o2b brain session-hook [--vault <path>] [--agent <name>] [--dry-run] [--json]\n" +
    "Read one runtime hook JSON payload from stdin, capture inline @osb markers / brain_feedback tool calls,\n" +
    "and append a non-blocking session-lifecycle audit/log observation. Intended for hooks/session-capture.ts.\n",
  "graph-export":
    "usage: o2b brain graph-export [--vault <path>] [--out <file>]\n" +
    "Serialise the vault knowledge graph (pages, wikilinks, typed relations) to a\n" +
    "stable graph.json. Prints to stdout, or writes to --out. Read-only.\n",
  "graph-import":
    "usage: o2b brain graph-import <file> [--mode skip|overwrite|merge] [--vault <path>] [--json]\n" +
    "Reconstruct vault page stubs from a graph.json. skip (default) never\n" +
    "overwrites; merge unions wikilinks/relations; writes are vault-guarded.\n",
  "morning-brief":
    "usage: o2b brain morning-brief [--vault <path>] [--json] [--top-k <n>]\n" +
    "  [--lookback-days <n>] [--max-chars-per-memory <n>] [--max-total-chars <n>]\n" +
    "Render a read-only session-start summary: top confirmed preferences\n" +
    "(confidence then recency), recent reconcile open questions, and recent\n" +
    "notes, bounded by the shared recall char budget. Read-only.\n",
  backlinks:
    "usage: o2b brain backlinks <id> [--vault <path>] [--json]\n" +
    "List inbound references to the given Brain artifact id (preference, retired, signal).\n",
  "mcp-landscape":
    "usage: o2b brain mcp-landscape [--vault <path>] [--json]\n" +
    "List the Model Context Protocol servers configured across the vault: each\n" +
    "server's name, the config file that declares it, the packages it pulls, and\n" +
    "the env-var NAMES it requires. Environment values are never read. Read-only.\n",
  "set-primary":
    "usage: o2b brain set-primary <name> [--vault <path>] [--json]\n" +
    "       o2b brain set-primary --clear [--vault <path>] [--json]\n" +
    "Declare which agent owns the dream consolidation pass for this vault.\n" +
    "Stored in Brain/_brain.yaml as `primary_agent:`. Dream runs from a\n" +
    "different agent emit a warning but still proceed (observability, not\n" +
    "access control). Use --clear to remove the declaration.\n",
  "scan-inline":
    "usage: o2b brain scan-inline [--vault <path>] [--path <subdir>...] [--exclude <subdir>...]\n" +
    "                              [--dry-run] [--strict] [--json] [--agent <name>]\n" +
    "Walk the vault for @osb markers (inline form and fenced 'osb' blocks),\n" +
    "create signals in Brain/inbox/, and annotate the source files with\n" +
    "@osb✓ [[sig-...]]. Brain/, .git, node_modules, and similar directories\n" +
    "are always skipped. Idempotent on re-run.\n",
  "import-claude-memory":
    "usage: o2b brain import-claude-memory [--vault <path>] [--memory <path>]\n" +
    "                                       [--dry-run | --apply] [--yes] [--json]\n" +
    "                                       [--allow-arbitrary-memory-path]\n" +
    "Read metadata.type:feedback entries from a Claude Code memory directory and\n" +
    "write them as confirmed Brain preferences. A sidecar manifest\n" +
    "Brain/.imports/claude-memory.json tracks idempotency. UPDATE preserves\n" +
    "accumulated evidence fields. CONFLICT (preference exists without a manifest\n" +
    "entry) exits 2 — never silent overwrites.\n" +
    "Default is --dry-run; --apply requires --yes in non-interactive mode.\n",
  entity:
    "usage: o2b brain entity <set|get|list|relate|archive> [args]\n" +
    "  set <category> <name> [--alias <a>]... [--body <md>] [--confidence <c>] [--json]\n" +
    "  get <name-or-alias> [--category <c>] [--json]      exit 2 when not found\n" +
    "  list [--category <c>] [--status active|archived] [--json]\n" +
    "  relate <from> <relation> <to> [--from-category <c>] [--to-category <c>] [--json]\n" +
    "  archive <name-or-alias> [--restore] [--category <c>] [--json]\n" +
    "One canonical entity per (category, name); aliases resolve to the canonical record.",
  "import-session":
    "usage: o2b brain import-session <path> [--vault <vault>]\n" +
    "                                [--format auto|<registered-adapter>]\n" +
    "                                [--agent <name>] [--since <ISO>] [--dry-run] [--recall]\n" +
    "                                [--ingest-scope <label>] [--filter-role <role> ...] [--filter-text <substring>]\n" +
    "                                [--recall-session-id <id>] [--recall-summary-group-size <n>] [--json]\n" +
    "Extract signals from a registered agent session .jsonl file (or\n" +
    "directory of .jsonl files). Two extraction paths run in parallel:\n" +
    "@osb markers in user/assistant messages, and replay of brain_feedback\n" +
    "tool_use calls. Dedup against the inbox by normalised payload hash.\n" +
    "With --recall, also stores normalized turns in the continuity-backed\n" +
    "session recall DAG.\n" +
    "Autodetect failure exits 2 — pass --format to override.\n",
  merge:
    "usage: o2b brain merge <keep-pref-id> <drop-pref-id>\n" +
    "                       [--dry-run] [--force] [--vault <path>] [--json]\n" +
    "                       [--agent <name>]\n" +
    "Merge two near-duplicate preferences. <keep> retains identity and\n" +
    "principle; <drop> retires with reason 'merged-into' and a\n" +
    "superseded_by wikilink to <keep>. <keep> picks up the sorted-dedup\n" +
    "union of evidenced_by, the summed applied_count / violated_count,\n" +
    "and max(last_evidence_at). Confidence is recomputed by the next\n" +
    "dream pass — not by merge itself.\n" +
    "--dry-run prints the plan and writes nothing.\n" +
    "--force skips the interactive prompt but does NOT bypass invariant\n" +
    "guards (topic/scope mismatch, pin parity).\n",
  export:
    "usage: o2b brain export --format json|llms-txt [--vault <path>]\n" +
    "                         [--out <path>] [--force]\n" +
    "Read-only dump of active preferences (confirmed | unconfirmed |\n" +
    "quarantine) from Brain/preferences/. Retired and signal entries\n" +
    "are not included. JSON is single-line; llms-txt follows the\n" +
    "llmstxt.org H1 + summary + H2-section shape.\n" +
    "Default sink is stdout; --out writes to <path> (refuses to\n" +
    "overwrite without --force).\n",
  upgrade:
    "usage: o2b brain upgrade [--vault <path>] [--dry-run | --apply | --check]\n" +
    "                          [--yes] [--json]\n" +
    "Migrate the release-owned files (`Brain/_brain.yaml`,\n" +
    "`Brain/_BRAIN.md`) forward to the shape the installed\n" +
    "open-second-brain release ships.\n" +
    "User-owned content (preferences/, retired/, inbox/, log/) is\n" +
    "never touched.\n" +
    "--dry-run (default) prints a per-file plan with a unified diff\n" +
    "for every pending update. Exit 0 regardless of pending count.\n" +
    "--check is dry-run + exit 2 when anything is pending or in error\n" +
    "(CI-friendly).\n" +
    "--apply takes a pre-apply snapshot named upgrade-<ts> (rollback\n" +
    "via run_id) and rewrites every pending file. Requires --yes in\n" +
    "non-interactive mode (--json or non-TTY stdin).\n" +
    "_brain.yaml merge is purely additive: missing schema-keys are\n" +
    "appended, existing values stay. _BRAIN.md is byte-compared\n" +
    "against the rendered template and overwritten when it differs.\n",
  explorer:
    "usage: o2b brain explorer [--port <n>] [--vault <path>]\n" +
    "       o2b brain explorer --export <path> [--force] [--vault <path>]\n" +
    "Live mode: bind a loopback HTTP server on 127.0.0.1:<port> (default\n" +
    "7777) that renders preferences and retired entries as a force-directed\n" +
    "graph. Press Ctrl+C to stop.\n" +
    "Export mode: write the same view as a single offline HTML file at\n" +
    "<path>. Without --force, refuses to overwrite an existing file.\n" +
    "Zero backend, no LLM, no network access. The page consumes a\n" +
    "prebuilt JSON graph; it does not parse vault Markdown client-side.\n",
  "page-dedup":
    "usage: o2b brain page-dedup [--apply] [--yes] [--vault <path>] [--json]\n" +
    "Detect near-duplicate vault pages by normalised topic+principle key.\n" +
    "Dry-run by default: lists each cluster with its canonical (oldest)\n" +
    "and secondary ids. --apply writes `merged_into:` on every secondary\n" +
    "and rewrites `[[secondary]]` wikilinks across the vault to the\n" +
    "canonical. Requires --yes in non-interactive mode (--json or non-TTY).\n",
  "token-footprint":
    "usage: o2b brain token-footprint [--warn-threshold <n>] [--vault <path>] [--json]\n" +
    "Report per-category vault token size (preferences, retired, inbox,\n" +
    "processed, log, other) using the language-agnostic\n" +
    "`ceil(utf8_bytes / 4)` heuristic. Flags vaults that cross the warn\n" +
    "threshold (default 200000; override via --warn-threshold or the\n" +
    "BRAIN_TOKEN_WARN_THRESHOLD env var).\n",
  "context-pack":
    "usage: o2b brain context-pack --max-tokens <n> [--query <q>] [--lanes] [--cache-stable] [--dedup-repeated]\n" +
    "                              [--receipt] [--receipt-host <name>] [--telemetry] [--telemetry-host <name>]\n" +
    "                              [--session-id <id>] [--turn-id <id>] [--vault <path>] [--json]\n" +
    "Return the highest-tier, most recent vault slice that fits under\n" +
    "<n> tokens. Items ordered core → supporting → peripheral, then\n" +
    "newest first. Stops adding pages when the next page would exceed\n" +
    "the budget. --query <q> filters by NFKC+casefold substring match\n" +
    "on topic + principle. --lanes also returns directives, constraints,\n" +
    "and consider lanes alongside the legacy flat items list.\n",
  "context-receipts":
    "usage: o2b brain context-receipts list [--trigger context_pack|pre_compress] [--host <name>] [--session-id <id>] [--limit <n>] [--vault <path>] [--json]\n" +
    "       o2b brain context-receipts show <receipt-id> [--vault <path>] [--json]\n" +
    "Read prompt context receipt continuity records emitted by opt-in callers.\n",
  "context-presets":
    "usage: o2b brain context-presets show [preset-id] [--json]\n" +
    "       o2b brain context-presets suggest [--model <name>] [--context-window <tokens>] [--json]\n" +
    "       o2b brain context-presets diff <preset-id> [current-value flags] [--override <path>...] [--json]\n" +
    "Dry-run model-aware context budget preset diagnostics. Never writes config.\n",
  "pre-compact-extract":
    "usage: o2b brain pre-compact-extract --vault <path> --session-id <id> --turn-start <id> --turn-end <id> --text <text> [--host <name>] [--max-chars <n>] [--json]\n" +
    "Extract Decision/Commitment/Outcome/Rule/Open question lines into idempotent continuity records.\n",
  "recall-telemetry":
    "usage: o2b brain recall-telemetry list [--mode search|context_pack|pre_compress] [--status ok|empty|error|timeout] [--host <name>] [--since <iso>] [--until <iso>] [--limit <n>] [--vault <path>] [--json]\n" +
    "       o2b brain recall-telemetry summary [same filters] [--vault <path>] [--json]\n" +
    "Read opt-in recall telemetry continuity records and aggregate coverage gaps.\n",
  "skill-proposals":
    "usage: o2b brain skill-proposals <learn|list|accept|reject> [args]\n" +
    "Deterministic proposal queue lifecycle.\n" +
    "  learn [--min-support <n>] [--vault <path>] [--json]\n" +
    "  list [--vault <path>] [--json]\n" +
    "  accept <slug> [--note <text>] [--vault <path>] [--json]\n" +
    "  reject <slug> --note <text> [--vault <path>] [--json]\n",
  "procedural-memory":
    "usage: o2b brain procedural-memory <reconcile|list|mark-used> [args]\n" +
    "Procedural index reconciliation and usage tracking sidecar.\n" +
    "  reconcile [--root <path> ...] [--vault <path>] [--json]\n" +
    "  list [--vault <path>] [--json]\n" +
    "  mark-used <entry-id> [--vault <path>] [--json]\n",
  "procedural-graph":
    "usage: o2b brain procedural-graph <rebuild|show|hints> [args]\n" +
    "Read/write procedural graph and prospective-hints projections.\n" +
    "  rebuild [--vault <path>] [--json]\n" +
    "  show [--vault <path>] [--json]\n" +
    "  hints [--vault <path>] [--json]\n",
  recurrence:
    "usage: o2b brain recurrence <list|show|learn|forget|purge-source> [args]\n" +
    "Recurrence/support diagnostics and reference-counted updates.\n" +
    "  list [--vault <path>] [--json]\n" +
    "  show <content-hash> [--vault <path>] [--json]\n" +
    "  learn --hash <h> --scope <scope> --source <id> [--vault <path>] [--json]\n" +
    "  forget --hash <h> --scope <scope> --source <id> [--vault <path>] [--json]\n" +
    "  purge-source --source <id> [--vault <path>] [--json]\n",
  "attention-flows":
    "usage: o2b brain attention-flows <list|evaluate|render> [args]\n" +
    "Declarative attention-flow recipes and evaluation surfaces.\n" +
    "  list [--vault <path>] [--json]\n" +
    "  evaluate <flow-id> [--vault <path>] [--json]\n" +
    "  render <flow-id> [--vault <path>] [--json]\n",
  "session-grep":
    "usage: o2b brain session-grep --query <text> [--session-id <id>] [--limit <n>] [--snippet-chars <n>] [--vault <path>] [--json]\n" +
    "Search imported session recall raw turns and summary nodes.\n",
  "session-describe":
    "usage: o2b brain session-describe --session-id <id> [--vault <path>] [--json]\n" +
    "Describe counts and summary depths for an imported session recall DAG.\n",
  "session-expand":
    "usage: o2b brain session-expand <record-id> [--raw-limit <n>] [--cursor <offset>] [--vault <path>] [--json]\n" +
    "Expand a raw or summary session recall node to immediate sources and paginated raw turn content.\n",
  lint:
    "usage: o2b brain lint --consolidate [--apply] [--yes] [--vault <path>] [--json]\n" +
    "Self-healing structural lint. Dry-run by default; --apply writes\n" +
    "the smallest possible fix per finding. Two operations:\n" +
    "  fix-merged-link    rewrite wikilinks pointing at a page that\n" +
    "                     carries `merged_into:` to the canonical.\n" +
    "  demote-stale-stable   demote `_lifecycle: stable` preferences\n" +
    "                        older than 180 days with no recent\n" +
    "                        evidence to `_lifecycle: draft`.\n" +
    "Requires --yes in non-interactive mode (--json or non-TTY).\n",
  actions:
    "usage: o2b brain actions [--top-n <n>] [--vault <path>] [--json]\n" +
    "Ranked maintenance action list. Aggregates page-dedup, lint\n" +
    "(dry-run), and token-footprint signals, scores each candidate\n" +
    "action by impact (dedup count × weight, staleness × age,\n" +
    "broken-link count, token-footprint excess), and prints the top N\n" +
    "(default 10) sorted by impact descending. Read-only.\n",
  summary:
    "usage: o2b brain summary [--skip-dream] [--top-actions <n>] [--vault <path>] [--json]\n" +
    "Operator dashboard. Aggregates trust verdict, doctor warnings/errors,\n" +
    "dream uncertain/quarantined counts, verification delta, top maintenance\n" +
    "actions, and instruction-file ceiling warnings into one report.\n" +
    "Runs a dry-run dream pass by default; --skip-dream omits it. Read-only.\n",
  unlinked:
    "usage: o2b brain unlinked <id> [--limit <n>] [--vault <path>] [--json]\n" +
    "Raw-text mentions of <id>'s title and frontmatter aliases that are NOT\n" +
    "already inside a [[...]] wikilink. Match boundary is Unicode-aware\n" +
    "(codepoint class), language-agnostic. Walks Brain/preferences/ and\n" +
    "Brain/retired/. Read-only.\n",
  synthesise:
    "usage: o2b brain synthesise <id> [--include-unlinked] [--vault <path>] [--json]\n" +
    "Assemble the concept-cluster envelope: target note + every artifact\n" +
    "that wikilinks to it (depth-1). With --include-unlinked also include\n" +
    "raw-text mentions outside [[...]]. Pure assembler, no LLM call. Output\n" +
    "is a deterministic JSON envelope downstream consumers can feed to\n" +
    "any synthesis prompt. Read-only.\n",
  "moc-audit":
    "usage: o2b brain moc-audit <hub-id> [--vault <path>] [--json]\n" +
    "Per-MOC coverage audit. Given a hub note id, classifies cluster\n" +
    "members into well-covered / fragile / candidate-missing buckets and\n" +
    "surfaces a suggested-next candidate. MOC detection is purely\n" +
    "structural (outbound link count + link density thresholds from\n" +
    "_brain.yaml). Read-only.\n",
  timeline:
    "usage: o2b brain timeline [--pref-id <id>] [--topic <slug>]\n" +
    "  [--kind <event-kind>] [--since <iso>] [--until <iso>]\n" +
    "  [--limit <n>] [--vault <path>] [--json]\n" +
    "Chronological list of Brain events filtered by any combination of\n" +
    "pref-id / topic / kind / since / until / limit. Reads JSONL log via\n" +
    "the canonical TimelineIndex. Read-only.\n",
  evolution:
    "usage: o2b brain evolution (--pref-id <id> | --topic <slug>)\n" +
    "  [--vault <path>] [--json]\n" +
    "Per-preference or per-topic story: status transitions (creation,\n" +
    "promotion, retirement) derived from dream summaries; evidence\n" +
    "rollup with running applied / violated / outdated counts; retirement\n" +
    "chain walked via supersedes / superseded_by links. Read-only.\n",
  stale:
    "usage: o2b brain stale [--vault <path>] [--json]\n" +
    "Structural staleness report. Lists preferences, signals, and log\n" +
    "files inactive longer than the configured `temporal:` thresholds\n" +
    "(stale_pref_days / stale_signal_days / stale_log_days). Read-only.\n",
  daily:
    "usage: o2b brain daily [--date <YYYY-MM-DD>] [--vault <path>] [--json]\n" +
    "Per-day deterministic brief: events grouped by kind, status\n" +
    "transitions, vault delta, deduplicated artifact wikilinks. Defaults\n" +
    "to today UTC. Read-only.\n",
  weekly:
    "usage: o2b brain weekly [--week-end <YYYY-MM-DD>] [--vault <path>] [--json]\n" +
    "7-day deterministic synthesis: events by kind, status transitions,\n" +
    "retired-in-window list, contradictions (signal-suppressed plus\n" +
    "apply-evidence violated), vault delta, source pointers. Defaults to\n" +
    "today UTC for week-end. Read-only.\n",
  project:
    "usage: o2b brain project <link|list|remove|status> [path] [--vault <path>] [--json]\n" +
    "Link a project directory to its owning vault via a .o2b-vault.json pointer.\n" +
    "resolveVault honours the nearest pointer above the working directory\n" +
    "(VAULT_DIR still wins). status reports resolution mode and registry health.\n",
  source:
    "usage: o2b brain source <add|list|remove> [path|alias] [--alias <name>] [--vault <path>] [--json]\n" +
    "Read-only recall sources of the active vault. add validates self-links,\n" +
    "duplicates, and direct circular references; list flags missing targets\n" +
    "as BROKEN. Distinct from `o2b brain sources` (signals dashboard).\n",
  links:
    "usage: o2b brain links normalize [path-prefix] [--mode preserve|full|short] [--write] [--json]\n" +
    "Rewrite wikilink targets to the configured path format (wiki_link_format).\n" +
    "Dry-run by default; decorations, code fences, and media embeds stay\n" +
    "verbatim; ambiguous targets are reported and left as typed.\n",
  profile:
    "usage: o2b brain profile [--stale-seconds <n>] [--force] [--vault <path>] [--json]\n" +
    "Materialize the compact Brain/profile.md digest plus the .o2bfs root\n" +
    "marker. Age-gated: a fresh profile is left alone unless --force.\n",
  sgrep:
    "usage: o2b brain sgrep <query> [path-prefix] [--limit <n>] [--keyword-only] [--vault <path>] [--json]\n" +
    "Grep-shaped semantic Brain search: path:line: output lines, path\n" +
    "scoping, exit 1 on no matches (also in --json mode).\n",
  trigger:
    "usage: o2b brain trigger <scan|list|ack|dismiss|act|history> [id] [--status <s>] [--vault <path>] [--json]\n" +
    "Grounded proactive trigger queue under Brain/triggers/. scan generates\n" +
    "deduped triggers from health/retention data (cooldown via\n" +
    "trigger_cooldown_days, default 7); ack/dismiss/act transition one\n" +
    "trigger; history lists terminal ones.\n",
  "deep-synthesis":
    "usage: o2b brain deep-synthesis <topic> [--limit <n>] [--triggers] [--vault <path>] [--json]\n" +
    "Deterministic topic dossier: matched notes, agreements, contradictions,\n" +
    "stale claims, knowledge gaps. --triggers enqueues contradiction/gap\n" +
    "findings into the trigger queue.\n",
  ideas:
    "usage: o2b brain ideas [--cap <n>] [--triggers] [--vault <path>] [--json]\n" +
    "Ranked next-direction candidates from open questions, orphan notes,\n" +
    "and aging inbox signals. --triggers enqueues the ranked ideas.\n",
  continuity:
    "usage: o2b brain continuity export --format atof|atif [--session <id>] [--month YYYY-MM] [--out <dir>] [--json]\n" +
    "Read-only trajectory export of the continuity store. atof renders one\n" +
    "JSONL event stream; atif renders one trajectory document per session.\n" +
    "Records flagged private are dropped; redacted text stays masked.\n",
  session:
    "usage: o2b brain session <open|submit|approve|abandon|status|list|sweep> [<session-id>] [flags]\n" +
    "open --target <Brain/...md> [--schema-type S] [--intent create|overwrite|merge]\n" +
    "     [--prompt P] [--require-review] [--retry-cap N]  open an artifact write session.\n" +
    "submit <id> [--file F|-]  submit the generated artifact (stdin without --file).\n" +
    "approve <id>   commit a needs-review session.  abandon <id>  terminal abandon.\n" +
    "status <id> | list | sweep  inspect or clean the session store.\n" +
    "Envelopes are JSON with --json: status, step, prompt, errors, attempts_left.",
  panel:
    "usage: o2b brain panel <open <topic...>|submit <id>|status <id>> [flags]\n" +
    "open <topic> [--personas a,b,c] [--target T] [--require-review]  convene a\n" +
    "decision panel; personas come from Brain/personas/ (built-in default set:\n" +
    "technical, strategic, risk, user-experience). Each submit answers the\n" +
    "current persona step; after synthesis the decision note commits under\n" +
    "Brain/decisions/panels/. The calling agent generates every word.",
  architect:
    "usage: o2b brain architect <project-path> [--vault V] [--json]\n" +
    "Scan a project tree deterministically (stdlib-only, no LLM) and\n" +
    "write architecture notes under Brain/projects/arch/<repo-key>/.\n" +
    "Generated content lives in sentinel regions; operator prose\n" +
    "outside regions survives every re-scan byte-for-byte.",
  git:
    "usage: o2b brain git <ingest|status|find|mine> [args] [--vault V] [--json]\n" +
    "ingest <repo-path> [--max-count N]  walk a worktree read-only, store\n" +
    "commit/tag records + digest note under Brain/projects/git/<repo-key>/.\n" +
    "status  per-repo watermarks and record counts.\n" +
    "find [text] [--repo K] [--file F] [--author A] [--since S] [--until U]\n" +
    "[--limit N]  query ingested history newest-first.\n" +
    "mine [--repo K]  surface decision-shaped commits as draft ADR\n" +
    "candidate notes under Brain/decisions/candidates/ (skip-existing).",
  bench:
    "usage: o2b brain bench memory --fixture <name|path> [--resume <run-id>] [--runs-dir <dir>] [--json]\n" +
    "Memory quality benchmark over a disposable fixture vault under the\n" +
    "runs directory (never the configured vault). Reports quality,\n" +
    "latency, and context cost separately; checkpoint/resume by run id;\n" +
    "bench_judge_cmd arms the optional external judge. Exit 1 on any\n" +
    "failed question.\n",
};
