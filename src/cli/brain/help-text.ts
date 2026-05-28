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
  health              Semantic-health report: contradictions, concept gaps, stale claims
  history             Render a preference's edit-history timeline
  backlinks           List inbound references to a Brain artifact id
  mcp-landscape       List MCP servers configured across the vault (packages, env names)
  scan-inline         Capture @osb markers from folders listed under notes.read_paths in _brain.yaml
  import-session      Replay signals from a registered agent session .jsonl (or directory)
  import-claude-memory  Import metadata.type:feedback MEMORY entries as confirmed preferences
  page-dedup          Detect (and optionally merge) near-duplicate vault pages
  token-footprint     Report per-category vault token size with a warn threshold
  context-pack        Return a tier-then-recency vault slice under a token budget
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
  health:
    "usage: o2b brain health [--vault <path>] [--json]\n" +
    "Semantic-health report: contradictory confirmed preferences, recurring\n" +
    "concepts with no dedicated preference, and confirmed preferences on stale\n" +
    "evidence, plus a clean/watch/investigate verdict. Read-only.\n",
  history:
    "usage: o2b brain history <slug> [--vault <path>] [--json]\n" +
    "Render a preference's edit-history timeline (one entry per content\n" +
    "mutation: principle/scope/status before -> after). Read-only.\n",
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
  "import-session":
    "usage: o2b brain import-session <path> [--vault <vault>]\n" +
    "                                [--format auto|<registered-adapter>]\n" +
    "                                [--since <ISO>] [--dry-run] [--json]\n" +
    "Extract signals from a registered agent session .jsonl file (or\n" +
    "directory of .jsonl files). Two extraction paths run in parallel:\n" +
    "@osb markers in user/assistant messages, and replay of brain_feedback\n" +
    "tool_use calls. Dedup against the inbox by normalised payload hash.\n" +
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
    "usage: o2b brain context-pack --max-tokens <n> [--query <q>] [--vault <path>] [--json]\n" +
    "Return the highest-tier, most recent vault slice that fits under\n" +
    "<n> tokens. Items ordered core → supporting → peripheral, then\n" +
    "newest first. Stops adding pages when the next page would exceed\n" +
    "the budget. --query <q> filters by NFKC+casefold substring match\n" +
    "on topic + principle.\n",
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
};
