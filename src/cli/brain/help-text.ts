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
  dream            Deterministic dreaming pass; stage/validate/apply staged bundles
  apply-evidence   Log a real-work application of a preference
  note             Append a one-line narrative milestone to Brain/log/today
  lifecycle        Tombstone/supersede a memory, resolve chain tips, curator slices
  claims           Claim-graph query: current truth, truth-at-T, replaced-by, contested-by
  decision         Capture/review decisions: record/outcome/show/list/similar
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
  okf-export       Write a portable Open Knowledge Format bundle (--out <dir> [--force])
  okf-import       Import an OKF bundle (<dir>; staged as review candidates, --trusted writes direct)
  explorer         Launch the loopback HTML explorer; --export <path> writes a single offline file
  snapshot diff    Read-only diff between two snapshots, or snapshot vs live
  rollback         Restore Brain/ from a snapshot (--list or <run_id>; --yes;
                   --dry-run previews via the same diff renderer)
  doctor              Validate Brain invariants (--strict; --remediate [--dry-run])
  hygiene             Hygiene pipeline: scan findings; apply by ids (--dry-run)
  refresh             Targeted recompile of stale derived pages (--stale [--dry-run])
  anticipate          Inspect or refresh the anticipatory context cache (--session)
  watchdog            Probe Brain health and plan safe recovery (--remediate, --restore, --force-restore)
  health              Semantic-health report: contradictions, concept gaps, stale claims
  history             Render a preference's edit-history timeline
  activation          Activation event store: status and sweep
  truth               Claim ledger: ingest, slots, conflicts, aggregate, collisions, sweep
  facts               Decompose text into atomic assertions (--ingest to ledger)
  dead-end            Negative-knowledge registry: record and list failed approaches
  foresight           Forward projection: routines coming due, open commitments and questions
  label               Controlled-vocabulary classification: assign, remove, show note labels
  bridges             Embedding-near link proposals: discover, list, accept, dismiss
  clusters            Link-graph communities: detect and materialize cluster notes
  vitals              Aggregate governance scorecard: diversity, connectivity, gap pressure
  co-occurrence       Suggest edges between entities co-referenced from the same notes
  file-context        Surface prior vault work that mentions a file path
  benchmark           Recall quality benchmark: hit@k and MRR over a fixed dataset
  tune                Self-tuning recall: grid-evaluate, persist, inspect, reset
  attr                Typed-page attribute fields: assign, remove, show (schema-pack declared)
  tiers               Frontmatter tier guard: check identity-field drift, restore or accept
  secret              Capability-gated secret custody: set, list, rm, run (use w/o exposure)
  maintenance         Quiet-window, lease-guarded lane (dream, reindex, bridges, clusters)
  audit               Render a preference's full mutation audit trail
  morning-brief       Session-start summary: top prefs, open questions, recent notes
  codec               Compress/expand session prose with the deterministic codec (stdin/--in)
  sources             Read-only dashboard of signals by (agent, source_type)
  schema              Inspect resolved schema vocabulary and artifact token usage
  graph-export        Serialise the vault knowledge graph to graph.json
  graph-import        Reconstruct vault pages from graph.json (--mode skip|overwrite|merge)
  bank-export         Serialise a whole-vault bank bundle (prefs + graph + pages + sources)
  bank-import         Reconstruct the page graph from a bank bundle (--mode skip|overwrite|merge)
  backlinks           List inbound references to a Brain artifact id
  semantics-backfill  Preview deterministic typed preference-edge backfill proposals
  mcp-landscape       List MCP servers configured across the vault (packages, env names)
  scan-inline         Capture @osb markers from folders listed under notes.read_paths in _brain.yaml
  import-session      Replay signals from a registered agent session .jsonl (or directory)
  entity              Canonical entity registry: set, get, list, relate, archive, prune
  session-hook        Capture one runtime hook payload from stdin (internal hook bridge)
  import-claude-memory  Import metadata.type:feedback MEMORY entries as confirmed preferences
  page-dedup          Detect (and optionally merge) near-duplicate vault pages
  token-footprint     Report per-category vault token size with a warn threshold
  context-pack        Return a tier-then-recency vault slice under a token budget
  context-receipts    List/show prompt context receipt records
  event-trace         Show context traces attached to logged events by correlation id
  context-presets     Show/suggest/diff read-only context budget presets
  pre-compact-extract Extract typed continuity records from bounded text
  post-compact-audit  Audit pinned-anchor survival after a compaction; re-assert drifted anchors
  recall-telemetry    List/summarize opt-in recall telemetry records
  knowledge-gaps      Rank recurring queries the vault answers poorly (unmet demand)
  generation-reports  Record/list/summarize opt-in LLM generation traces
  skill-proposals     Learn/list/review deterministic skill proposals
  procedural-memory   Reconcile/list procedural memory index and usage
  procedural-graph    Rebuild/show procedural graph and hint projections
  recurrence          Inspect and update recurrence/support diagnostics
  attention-flows     Declarative attention recipes for open loops and learnings
  obligation          Recurring obligations with cadence-driven next-due dates
  agenda              Synthesize agenda conflicts/focus blocks from provided events
  today               Today dashboard: due obligations, open loops, recent activity, totals
  apply-markers       Apply @osb set frontmatter write-backs (report by default; --apply writes)
  pending             Review the write-approval queue: list | apply <id> | reject <id>
  signal              Fact signal lifecycle: retire <id> --reason <text>
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
  forget-source       Find/delete entries derived from an exact source file (dry-run by default)
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
  "forget-source":
    "usage: o2b brain forget-source <source> [--confirm] [--include-originals] [--vault <path>] [--json]\n" +
    "Find and delete every Brain entry derived from an EXACT source file. Dry-run by\n" +
    "default: reports the blast radius and deletes nothing. --confirm deletes the\n" +
    "single-purpose derived entries + ingest index artifacts (summary page + manifest\n" +
    "entry); shared/aggregate pages are reported, never deleted. --include-originals\n" +
    "also removes the original source file outside Brain/. Confirmed runs write an\n" +
    "auditable source_invalidation continuity record.\n",
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
    "usage: o2b brain dream [run] [--dry-run] | stage | validate <run-id> | apply <run-id> |\n" +
    "  discard <run-id> | list  [--now <ISO-8601>] [--agent <name>] [--vault <path>] [--json]\n" +
    "Runs the deterministic dreaming algorithm (idempotent), or manages the staged\n" +
    "lifecycle: stage persists a reviewable proposal bundle under Brain/dream/staged/,\n" +
    "validate proves the vault has not drifted, apply re-validates then runs the same\n" +
    "engine live, discard drops the bundle.\n",
  "apply-evidence":
    "usage: o2b brain apply-evidence --pref <id> --artifact <wikilink> --result applied|violated|outdated\n" +
    "  [--agent <name>] [--note <text>] [--vault <path>] [--json]\n" +
    "Appends a single event to today's log. Missing preference exits 2.\n",
  note:
    "usage: o2b brain note <text> [--agent <name>] [--vault <path>] [--config <path>] [--json]\n" +
    "Append one narrative-milestone line to Brain/log/<today>.md under the `note`\n" +
    "event kind. CLI mirror of the MCP `brain_note` tool — same on-disk contract.\n" +
    "Use from cron jobs and shell scripts. Multi-line text collapses to one line.\n",
  lifecycle:
    "usage: o2b brain lifecycle <tombstone|supersede|tip|curator> [...] [--vault <path>] [--json]\n" +
    "Cross-type tombstone + supersede lifecycle. tombstone <path> --reason <r>\n" +
    "[--superseded-by <id>] marks a memory _status: tombstoned in place (no delete);\n" +
    "supersede <predecessor> <successor> tombstones the predecessor and records the\n" +
    "replacement pointer; tip <id> walks a supersede chain to its live tip; curator\n" +
    "[--high-use-min <n>] lists injected-never-used, contradicted, and high-used\n" +
    "memories from observed-use verdicts. Tombstoned entries stay on disk for audit\n" +
    "but are excluded from recall, inject, and active.md.\n",
  claims:
    "usage: o2b brain claims [--at <instant>] [--history] [--replaced <id>] [--contests <id>] [--rebuild] [--vault <path>] [--json]\n" +
    "Query the claim-graph projection over existing superseded_by / contradicts /\n" +
    "valid_from / valid_until relations. Default is current truth; --at <ISO|YYYY-MM-DD>\n" +
    "gives truth at that instant; --history lists every claim (tombstoned included);\n" +
    "--replaced <id> follows the supersede chain to the live tip; --contests <id>\n" +
    "lists contesting claims; --rebuild rebuilds and persists Brain/claim-graph.json.\n",
  decision:
    "usage: o2b brain decision <record|outcome|rate|show|list|compare|similar> [...] [--vault <path>] [--json]\n" +
    "Decision-record note family under Brain/decisions/. record --title <t> --chosen <c>\n" +
    "--assumption <a> --review-date <YYYY-MM-DD> [--premortem <p>] [--notes <n>]\n" +
    "[--rating <1-5>] [--rationale <r>] captures a type: decision note and opens one review\n" +
    "obligation idempotently; outcome <slug> --outcome <text> backfills the hindsight\n" +
    "outcome; rate <slug> --rating <1-5> [--rationale <r>] sets a rating (logged); show\n" +
    "<slug> and list [--rated] read stored decisions (--rated sorts by rating); compare\n" +
    "<slug...> reads decisions side by side; similar --title <t> [--chosen <c>] surfaces\n" +
    "historically similar decisions with their recorded outcomes.\n",
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
  hygiene:
    "usage: o2b brain hygiene <scan|apply> [--vault <path>] [--json]\n" +
    "                          [--detectors conflicts,dedup,freshness,usefulness]\n" +
    "                          [--ids <finding-id,...>] [--dry-run]\n" +
    "Scan is read-only: contested truth slots, near-duplicate preferences,\n" +
    "stale/orphaned derived pages, low-usefulness candidates. Apply executes\n" +
    "only explicitly selected finding ids; review findings never execute.\n" +
    "The conflict resolver command comes from _brain.yaml (hygiene.resolver_cmd).\n",
  refresh:
    "usage: o2b brain refresh --stale [--vault <path>] [--dry-run] [--json]\n" +
    "Targeted recompile: re-derive stale pages from their recorded sources\n" +
    "(handoff notes re-derive in place), archive orphans into Brain/.snapshots,\n" +
    "report unknown pipelines as manual. --dry-run previews with zero writes.\n",
  anticipate:
    "usage: o2b brain anticipate --session <id> [--refresh] [--signal <text>]\n" +
    "                             [--vault <path>] [--json]\n" +
    "Read the anticipatory context cache for the session's lineage root\n" +
    "(warm | stale | miss), or force a refresh first (TTL debounce applies).\n",
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
    "events outside the retention window or beyond the newest-N cap and refolds\n" +
    "(--max-events 0 clears every retained event).\n",
  truth:
    "usage: o2b brain truth <ingest|slots|conflicts|aggregate|collisions|sweep> [--vault <path>] [--json]\n" +
    "Operator surface over the entity claim ledger (Brain/truth/). ingest appends one\n" +
    "claim (--entity --aspect --value --source, optional --quantity-value/--quantity-unit/\n" +
    "--quantity-action); slots renders current values with superseded history; conflicts\n" +
    "lists contested slots (two values within the window from independent sources,\n" +
    "resolution always ask_user); aggregate sums exact (entity, action, unit) quantity\n" +
    "matches; collisions reports cross-agent convergence; sweep keeps the newest N events.\n",
  facts:
    "usage: o2b brain facts decompose (--file <path> | --text <text>) [--ingest --entity E] [--vault <path>] [--json]\n" +
    "Deterministically decompose text into atomic assertions via markdown structure\n" +
    "(headings, list items, sentence boundaries with an abbreviation guard), anchored\n" +
    "to canonical entities. --ingest appends structured-family assertions (quantity,\n" +
    "possession, identity, location, email, url) to the claim ledger for --entity.\n",
  "dead-end":
    "usage: o2b brain dead-end <record|list> [--approach T --reason T [--context T]] [--max-active N] [--vault <path>] [--json]\n" +
    "Negative-knowledge registry under Brain/dead-ends/. record persists one\n" +
    "tried-and-failed approach as a markdown note (FTS-indexed, so recall can\n" +
    "surface avoid-X alongside prefer-Y); the active set is bounded and overflow\n" +
    "archives the oldest entries. list renders active entries newest first.\n",
  foresight:
    "usage: o2b brain foresight [--horizon-days N] [--write] [--vault <path>] [--json]\n" +
    "Forward-looking projection over the continuity log and recurrence ladder:\n" +
    "recurring routines coming due within the horizon (cadence arithmetic, soonest\n" +
    "first), recent open commitments, and open questions - every item carries\n" +
    "deterministic sources. --write persists Brain/foresight/<date>.md.\n",
  label:
    "usage: o2b brain label <path> <dimension>=<value> | --remove <dimension> | --show  [--agent N] [--vault <path>] [--json]\n" +
    "Controlled-vocabulary classification against the schema pack's labels\n" +
    "field. Assignments are fail-closed - unknown dimensions and values are\n" +
    "rejected with the declared vocabulary - single-choice per dimension, and\n" +
    "persist as a sorted labels frontmatter array plus a canonical label\n" +
    "entity. Filter recall with: o2b search <q> --property labels=<dim>/<value>.\n",
  bridges:
    "usage: o2b brain bridges discover [--max N] [--min-similarity X] | list | accept <source> <target> | dismiss <source> <target>  [--vault <path>] [--json]\n" +
    "Bridge discovery over the vec index: propose links between embedding-near\n" +
    "notes that share no existing edge, orphan-first. discover regenerates the\n" +
    "reviewable Brain/proposals/bridges.md artifact and records one\n" +
    "bridge_discovery metric; accept writes a single related: wikilink into the\n" +
    "source note (schema-pack link constraints honored); dismiss silences a\n" +
    "pair across future runs. Fail-soft without an index or embeddings.\n",
  clusters:
    "usage: o2b brain clusters run [--min-size N] | list  [--vault <path>] [--json]\n" +
    "Graph-wide community detection: deterministic label propagation over the\n" +
    "index's resolved link graph. run materializes one derived note per\n" +
    "community of size >= min-size (default 4) under Brain/clusters/ - members\n" +
    "by internal degree, shared entities, density, no LLM prose - removes\n" +
    "stale generated notes, and records one communities metric. list reads\n" +
    "the generated notes back. Fail-soft without an index.\n",
  vitals:
    "usage: o2b brain vitals [--orphan-threshold N] [--vault <path>] [--json]\n" +
    "Aggregate governance scorecard over confirmed Brain/preferences/, four\n" +
    "numbers the per-item hygiene lints don't surface: domain_diversity\n" +
    "(normalised Shannon entropy of the scope distribution), connectivity_index\n" +
    "(mean evidenced_by count per preference), orphan_preferences (confirmed\n" +
    "preferences below --orphan-threshold evidence items, default 2), and\n" +
    "gap_pressure (open concept-gap findings, reused from `doctor`, divided by\n" +
    "preference count). Records one vault_vitals metric. Read-only.\n",
  "co-occurrence":
    "usage: o2b brain co-occurrence [--min-co N] [--min-score X] [--limit N] [--write]  [--vault <path>] [--json]\n" +
    "Suggest relationship edges between entities repeatedly co-referenced from\n" +
    "the same notes, scored by a structural PMI / document-frequency metric over\n" +
    "the wikilink graph (no natural-language word list, any script). Read-only\n" +
    "by default; --write persists the Brain/link-graph/co-occurrence.json\n" +
    "artifact. Already directly-linked pairs are never re-suggested; notes are\n" +
    "never mutated.\n",
  "file-context":
    "usage: o2b brain file-context <file-path> [--limit N] [--min-bytes N]  [--vault <path>] [--json]\n" +
    "Surface prior vault work that mentions a file (decisions, bug notes, refactor\n" +
    "history) by querying the existing index with terms derived structurally from\n" +
    "the path (basename + stem, no natural-language processing). A size gate skips\n" +
    "trivial files (default 1500 bytes) with an explicit reason. Read-only; no LLM.\n",
  benchmark:
    "usage: o2b brain benchmark run --dataset <path> [--k N] [--expand]  [--vault <path>] [--json]\n" +
    "Score the vault's live hybrid recall against a fixed query/expected-result\n" +
    "dataset (hit@k + MRR, per query and aggregate) and record one\n" +
    "recall_benchmark metric in Brain/metrics/ so recall quality is chartable\n" +
    "over time. Dataset shape: {queries: [{id, query, expected: [paths]}]}.\n",
  tune:
    "usage: o2b brain tune run --dataset <path> [--k N] | status | reset  [--vault <path>] [--json]\n" +
    "Opt-in self-tuning recall: run grid-evaluates bounded parameters (pool\n" +
    "multiplier, traversal depth, learned weights, expansion) with the recall\n" +
    "benchmark as the objective and persists the winner to\n" +
    "Brain/search/tuning.json. Search honors it only when\n" +
    "search_self_tuning_enabled is on; reset deletes the state.\n",
  attr:
    "usage: o2b brain attr <path> <field>=<value> | --remove <field> | --show  [--vault <path>] [--json]\n" +
    "Per-type attribute fields declared in the schema pack's attributes map.\n" +
    "The note's own frontmatter type selects the descriptor set; assigning an\n" +
    "undeclared field is rejected with the declared fields and their\n" +
    "natural-language descriptions. One value per field, persisted as a sorted\n" +
    "attributes frontmatter array (filterable via --property attributes=<f>=<v>).\n",
  tiers:
    "usage: o2b brain tiers check | restore <path> [--field F] [--apply] | accept <path> [--field F]  [--vault <path>] [--json]\n" +
    "Frontmatter tier guard over framework-kind files. The index post-pass\n" +
    "snapshots identity/system fields and stages a finding when an identity\n" +
    "join key (kind, id, entity_id, category) changes by hand - the snapshot\n" +
    "keeps the expected value, so reindexes never absorb the edit. check\n" +
    "lists open findings; restore writes the expected value back (--apply);\n" +
    "accept adopts the hand-edit as the new baseline. Nothing auto-resolves.\n",
  secret:
    "usage: o2b brain secret set <name> [--env-var V] [--allow PATTERN]... [--from-env SRC] [--agent N] | list | rm <name> | run <name> [--agent N] [--vault <path>] [--json] -- <command...>\n" +
    "Capability-gated secret custody under the vault-local state dir:\n" +
    "per-value AES-256-GCM ciphertext, 0600 keyfile, no surface ever prints\n" +
    "the value. set reads the value from stdin or --from-env (never argv);\n" +
    "run injects it as the declared env var into a subprocess whose command\n" +
    "matches the allowlist declared at set time, and the captured output is\n" +
    "redacted before it reaches the caller. Every operation lands a\n" +
    "no-values record in Brain/log/secret-custody/. Protects against\n" +
    "context leakage and vault sync exposure - not against root.\n",
  maintenance:
    "usage: o2b brain maintenance run [--force] [--window H-H] [--tz ZONE] [--busy-minutes N] [--busy-threshold N] | status [--limit N]  [--vault <path>] [--json]\n" +
    "Quiet-window, lease-guarded lane for heavy passes. run gates on the\n" +
    "local-time window (unset = always open), recent interactive query-rate\n" +
    "from recall telemetry, and an expiring SQLite lease no second worker\n" +
    "can grab, then executes dream, reindex, bridges, and clusters\n" +
    "stale-first. --force bypasses\n" +
    "the soft gates but never the lease. Every attempt - including gate\n" +
    "refusals - lands in a bounded journal; status renders lease + journal.\n",
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
  "bank-export":
    "usage: o2b brain bank-export [--vault <path>] [--out <file>]\n" +
    "Serialise a whole-vault bank bundle (preferences + page graph + page\n" +
    "contracts + sources dashboard) to a schema-versioned JSON. Read-only.\n",
  "bank-import":
    "usage: o2b brain bank-import <file> [--mode skip|overwrite|merge] [--vault <path>] [--json]\n" +
    "Reconstruct the page graph from a bank bundle. Preferences, page\n" +
    "contracts, and the sources dashboard are reported as carried-not-restored;\n" +
    "an unsupported bundle schema fails loudly.\n",
  "okf-export":
    "usage: o2b brain okf-export --out <dir> [--vault <path>] [--force]\n" +
    "Write a portable Open Knowledge Format bundle: concepts/, queries/,\n" +
    "references/ markdown pages, a date-grouped log.md, and an okf.json\n" +
    "manifest. Page class is derived from frontmatter kind:. Read-only on\n" +
    "the vault; refuses a non-empty --out dir without --force.\n",
  "okf-import":
    "usage: o2b brain okf-import <bundle-dir> [--trusted] [--vault <path>]\n" +
    "Import an OKF bundle. By default pages are staged under 'OKF Review/'\n" +
    "with okf_review: pending (review candidates); --trusted writes each\n" +
    "page directly to its recorded path. Foreign-producer bundles get\n" +
    "producer + raw type provenance stamped and x-* frontmatter preserved.\n",
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
    "usage: o2b brain entity <set|get|list|relate|archive|prune> [args]\n" +
    "  set <category> <name> [--alias <a>]... [--body <md>] [--confidence <c>] [--json]\n" +
    "  get <name-or-alias> [--category <c>] [--json]      exit 2 when not found\n" +
    "  list [--category <c>] [--status active|archived] [--json]\n" +
    "  relate <from> <relation> <to> [--from-category <c>] [--to-category <c>] [--json]\n" +
    "  archive <name-or-alias> [--restore] [--category <c>] [--json]\n" +
    "  prune [--confirm] [--json]                         dry-run default; snapshot before removal\n" +
    "One canonical entity per (category, name); aliases resolve to the canonical record.\n" +
    "Labels are decoration-stripped and quality-gated on set; prune removes historical\n" +
    "malformed nodes and their edges. Denylist: entities.label_denylist config key.",
  "import-session":
    "usage: o2b brain import-session <path> [--vault <vault>]\n" +
    "                                [--format auto|<registered-adapter>]\n" +
    "                                [--agent <name>] [--since <ISO>] [--dry-run] [--recall]\n" +
    "                                [--ingest-scope <label>] [--filter-role <role> ...] [--filter-text <substring>]\n" +
    "                                [--preserve-event-time]\n" +
    "                                [--recall-session-id <id>] [--recall-summary-group-size <n>] [--json]\n" +
    "Extract signals from a registered agent session .jsonl file (or\n" +
    "directory of .jsonl files). Two extraction paths run in parallel:\n" +
    "@osb markers in user/assistant messages, and replay of brain_feedback\n" +
    "tool_use calls. Dedup against the inbox by normalised payload hash.\n" +
    "With --recall, also stores normalized turns in the continuity-backed\n" +
    "session recall DAG.\n" +
    "With --preserve-event-time, each signal is stamped with its turn's\n" +
    "original timestamp (created_at/recorded_at/valid_from) instead of the\n" +
    "import wall-clock, so backfilling an old log stays historically\n" +
    "faithful. Turns with an absent/unparseable/future timestamp fall back\n" +
    "to now.\n" +
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
  "event-trace":
    "usage: o2b brain event-trace [--date <YYYY-MM-DD>] [--at <HH:MM:SS>] [--kind <event-kind>] [--session-id <id>] [--limit <n>] [--keep-private] [--vault <path>] [--json]\n" +
    "Join logged Brain events to the continuity records (recall telemetry, context\n" +
    "receipts, generation reports, …) attached to them by shared correlation ids\n" +
    "(session_id, turn_id, artifact refs). Defaults to today's log. Use the per-kind\n" +
    "readers (context-receipts show, recall-telemetry, generation-reports show) to\n" +
    "open a listed record in full. Read-only; private records are dropped unless\n" +
    "--keep-private is set.\n",
  "context-presets":
    "usage: o2b brain context-presets show [preset-id] [--json]\n" +
    "       o2b brain context-presets suggest [--model <name>] [--context-window <tokens>] [--json]\n" +
    "       o2b brain context-presets diff <preset-id> [current-value flags] [--override <path>...] [--json]\n" +
    "Dry-run model-aware context budget preset diagnostics. Never writes config.\n",
  "pre-compact-extract":
    "usage: o2b brain pre-compact-extract --vault <path> --session-id <id> --turn-start <id> --turn-end <id> --text <text> [--host <name>] [--max-chars <n>] [--dry-run] [--json]\n" +
    "Extract Decision/Commitment/Outcome/Rule/Open question lines into idempotent continuity records.\n" +
    "--dry-run previews the candidate records without writing to the vault (predicts the real extraction byte-for-byte).\n",
  "post-compact-audit":
    "usage: o2b brain post-compact-audit [--session-id <id>] [--no-reassert] [--force] [--vault <path>] [--json]\n" +
    "Reads a { session_id, messages } JSON document from stdin. Detects a Hermes compaction, audits which pinned anchors survived in the active (non-summary) region, and re-asserts only the drifted ones. Gated by post_compact_survival_audit (default off); --force overrides the gate.\n",
  "recall-telemetry":
    "usage: o2b brain recall-telemetry list [--mode search|context_pack|pre_compress] [--status ok|empty|error|timeout] [--host <name>] [--since <iso>] [--until <iso>] [--limit <n>] [--vault <path>] [--json]\n" +
    "       o2b brain recall-telemetry summary [same filters] [--vault <path>] [--json]\n" +
    "       o2b brain recall-telemetry cost [--since <iso>] [--until <iso>] [--write-cost <n>] [--read-cost <n>] [--write-heavy-ratio <n>] [--vault <path>] [--json]\n" +
    "Read opt-in recall telemetry continuity records and aggregate coverage gaps. cost folds write volume (feedback/apply-evidence/note/host writes) against reads into a write-vs-read ratio, a write-heavy flag, and a rough weighted cost signal per period.\n",
  "knowledge-gaps":
    "usage: o2b brain knowledge-gaps [--min-occurrences <n>] [--max-satisfaction <0..1>] [--since <iso>] [--until <iso>] [--limit <n>] [--vault <path>] [--json]\n" +
    "Aggregate the persisted cross-query demand log (Brain/log/query-demand.jsonl) into recurring queries the vault answers poorly. Buckets by normalized query terms and ranks by frequency x (1 - satisfaction), where satisfaction is the reused IDF-weighted coverage (or the non-empty-result fraction when coverage was not recorded). Turns repeated recall failures into a prioritized backlog of what to write next. Read-only; the log is written only by opt-in recall telemetry.\n",
  "generation-reports":
    "usage: o2b brain generation-reports record <write_session|context_pack|dream_stage> --ref <id> --agent <name> --prompt <text> [--enable] [--provider <p>] [--model <m>] [--finish-reason <r>] [--latency-ms <n>] [--input-tokens <n>] [--output-tokens <n>] [--cached-tokens <n>] [--total-tokens <n>] [--scope <s>] [--source <id[=path]>...] [--created-at <iso>] [--vault <path>] [--json]\n" +
    "       o2b brain generation-reports list [--handoff <kind>] [--agent <name>] [--since <iso>] [--until <iso>] [--limit <n>] [--vault <path>] [--json]\n" +
    "       o2b brain generation-reports summary [same filters] [--vault <path>] [--json]\n" +
    "       o2b brain generation-reports show <report-id> [--vault <path>] [--json]\n" +
    "Inbound, opt-in LLM generation tracing. record is gated (default off) by --enable or generation_trace_enabled; only prompt_hash + counts are stored, never the prompt.\n",
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
  obligation:
    "usage: o2b brain obligation <add|done|list|show|remove> [args]\n" +
    "Recurring obligations as Brain pages with a deterministic cadence-driven next-due date.\n" +
    "Cadences: daily, weekly, biweekly, monthly, quarterly, yearly, every-<N>-days.\n" +
    "  add --title <t> --cadence <c> [--anchor YYYY-MM-DD] [--notes <n>] [--vault <path>] [--json]\n" +
    "  done --slug <s> [--date YYYY-MM-DD] [--vault <path>] [--json]\n" +
    "  list [--overdue] [--vault <path>] [--json]\n" +
    "  show --slug <s> [--vault <path>] [--json]\n" +
    "  remove --slug <s> [--vault <path>] [--json]\n",
  today:
    "usage: o2b brain today [--vault <path>] [--json] [--lookback-days <n>] [--limit <n>]\n" +
    "Read-only today dashboard: due and overdue obligations, open loops, merged\n" +
    "recent activity, and a totals rollup. Each section derives live and in\n" +
    "isolation, so a section that fails to compute is reported without blanking\n" +
    "the rest. --lookback-days bounds the recent-activity window (default 7);\n" +
    "--limit caps the recent-activity entries (default 20). Never writes.\n",
  "apply-markers":
    "usage: o2b brain apply-markers [--vault <path>] [--path <subdir>...] [--apply]\n" +
    "                                [--agent <name>] [--json]\n" +
    "Apply @osb set markers as schema-validated frontmatter attribute writes.\n" +
    "Report mode by default: lists each pending marker with its resolved target\n" +
    "and validation verdict and writes nothing. --apply performs the mutations\n" +
    "and requires the guardrails.marker_writeback flag in _brain.yaml; with the\n" +
    "flag off, --apply refuses and writes nothing. Applied markers are consumed\n" +
    "(annotated) so a re-run is idempotent. Unresolvable or invalid targets are\n" +
    "reported with an error code and candidates and left unconsumed. Source files\n" +
    "come from --path (repeatable) or notes.read_paths.\n",
  pending:
    "usage: o2b brain pending list [--vault <path>] [--json]\n" +
    "       o2b brain pending apply <id> [--vault <path>] [--json]\n" +
    "       o2b brain pending reject <id> --reason <text> [--vault <path>] [--json]\n" +
    "Review the opt-in write-approval queue (write_approval.enabled). When the\n" +
    "toggle is on, extracted signals are staged into Brain/pending/ instead of\n" +
    "Brain/inbox/. list shows the staged signals; apply moves one into\n" +
    "Brain/inbox/ unchanged (entity anchors and dedup hash preserved); reject\n" +
    "moves it to Brain/retired/ with retire-shaped frontmatter. Applying or\n" +
    "rejecting a missing id exits 2 (never a silent no-op).\n",
  signal:
    "usage: o2b brain signal retire <id> --reason <text> [--superseded-by <id>] [--vault <path>] [--json]\n" +
    "Retire an extracted fact signal: move Brain/inbox/sig-*.md into\n" +
    "Brain/retired/ with retire-shaped frontmatter (_status, retired_at,\n" +
    "retired_reason, optional superseded_by, old-id alias). The directory move\n" +
    "excludes it from the dream pass while it stays readable in Brain/retired/.\n" +
    "Retiring a missing, already-retired, or non-signal id exits 2 (never a\n" +
    "silent no-op).\n",
  agenda:
    "usage: o2b brain agenda --events <file|-> [args]\n" +
    "Deterministic agenda synthesis over caller-provided calendar events (JSON array or {events:[...]}).\n" +
    "Reports overlap conflicts, free focus blocks, and external organizers. No vault writes.\n" +
    "  --events <file|->            event source; '-' reads stdin\n" +
    "  --focus-min <N>              minimum free-gap minutes for a focus block (default 60)\n" +
    "  --owner-domain <D[,D2]>      operator domain(s); organizers outside these are flagged\n" +
    "  --workday-start HH:MM --workday-end HH:MM  clip focus blocks to a daily window\n" +
    "  [--json]\n",
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
