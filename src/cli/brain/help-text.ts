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
  query            Read by --preference, --topic, or --since
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
  doctor              Validate Brain invariants (--strict promotes warnings to exit 2)
  backlinks           List inbound references to a Brain artifact id
  migrate-frontmatter Rewrite legacy 'status:' / 'applied_count:' keys to '_status:' / '_applied_count:'
  scan-inline         Capture @osb markers from vault markdown files (Daily/, project notes, etc.)
  import-session      Replay signals from a Claude/Codex/Hermes session .jsonl (or directory)
  import-claude-memory  Import metadata.type:feedback MEMORY entries as confirmed preferences

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
  query:
    "usage: o2b brain query --preference <id> | --topic <slug> | --since <ISO> [--vault <path>] [--json]\n" +
    "Read-only lookup. One of --preference / --topic / --since is required.\n",
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
    "Validate invariants. Warnings exit 0 (or 2 with --strict). Errors always exit 1.\n",
  backlinks:
    "usage: o2b brain backlinks <id> [--vault <path>] [--json]\n" +
    "List inbound references to the given Brain artifact id (preference, retired, signal).\n",
  "migrate-frontmatter":
    "usage: o2b brain migrate-frontmatter [--vault <path>] [--apply] [--yes] [--json]\n" +
    "Rewrite legacy Group C frontmatter keys ('status:', 'applied_count:', ...)\n" +
    "to the '_'-prefixed shape across Brain/preferences/ and Brain/retired/.\n" +
    "Default is --dry-run; --apply takes a pre-run snapshot (rollback via run_id).\n" +
    "--apply requires --yes in non-interactive mode (--json or non-TTY stdin).\n",
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
    "                                [--format auto|claude|codex|hermes]\n" +
    "                                [--since <ISO>] [--dry-run] [--json]\n" +
    "Extract signals from a Claude / Codex / Hermes session .jsonl file (or\n" +
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
    "Migrate the three release-owned files (`Brain/_brain.yaml`,\n" +
    "`Brain/_BRAIN.md`, `AI Wiki/_OPEN_SECOND_BRAIN.md`) forward to the\n" +
    "shape the installed open-second-brain release ships.\n" +
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
    "appended, existing values stay. _BRAIN.md and\n" +
    "_OPEN_SECOND_BRAIN.md are byte-compared against the rendered\n" +
    "template and overwritten when they differ.\n",
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
};
