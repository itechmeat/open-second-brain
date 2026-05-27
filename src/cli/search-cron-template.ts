/**
 * §E.3 -- 'o2b search reindex --cron-template' renderer.
 *
 * Prints a watchdog script body, a native crontab line, and an
 * optional 'hermes cron create' invocation. Pure stdout, writes
 * nothing. The operator (or agent in the user's name) copies what
 * fits their host into the cron infrastructure of choice.
 *
 * Duration parser accepts <N>s|m|h|d. Mapping to a cron expression
 * covers the common cadences:
 *   - minutes:  every N (N less than 60)   maps to N-step minutes
 *   - hours:    every N hours              maps to N-step hours
 *   - days:     every N days               maps to N-step days
 *   - seconds:  rejected (cron's finest grain is one minute)
 *
 * Inputs outside those bounds raise a CronTemplateError with a
 * concrete suggestion (use the next unit up).
 */

export class CronTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronTemplateError";
  }
}

interface ParsedInterval {
  /** Cron expression for the chosen interval. */
  readonly cron: string;
  /** Human-readable label (e.g. "30 minutes"). */
  readonly human: string;
  /** Schedule string for 'hermes cron create --schedule ...'. */
  readonly hermesSchedule: string;
}

export function parseInterval(raw: string): ParsedInterval {
  const trimmed = raw.trim();
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(trimmed);
  if (!m) {
    throw new CronTemplateError(
      "cannot parse interval " + JSON.stringify(raw) + ": expected <N>s|m|h|d (e.g. 30m, 6h, 1d)",
    );
  }
  const n = parseInt(m[1]!, 10);
  const unit = m[2]!;
  if (n <= 0) {
    throw new CronTemplateError("interval must be positive; got " + JSON.stringify(raw));
  }
  if (unit === "s") {
    throw new CronTemplateError(
      "cron grain is one minute -- second-level intervals are not supported",
    );
  }
  if (unit === "m") {
    if (n >= 60) {
      const hours = Math.round(n / 60);
      throw new CronTemplateError(
        "intervals of 60 minutes or more must use the h unit (e.g. " + hours + "h)",
      );
    }
    const cron = "*/" + n + " * * * *";
    return { cron, human: n + " minutes", hermesSchedule: cron };
  }
  if (unit === "h") {
    if (n >= 24) {
      const days = Math.round(n / 24);
      throw new CronTemplateError(
        "intervals of 24 hours or more must use the d unit (e.g. " + days + "d)",
      );
    }
    const cron = "0 */" + n + " * * *";
    return { cron, human: n + " hours", hermesSchedule: cron };
  }
  // unit === "d"
  const cron = "0 0 */" + n + " * *";
  return { cron, human: n + " days", hermesSchedule: cron };
}

export interface RenderCronTemplateOptions {
  /** Override the resolved o2b binary path (test seam). */
  readonly o2bBin?: string;
}

export function renderCronTemplate(interval: string, opts: RenderCronTemplateOptions = {}): string {
  const parsed = parseInterval(interval);
  const o2bBin = opts.o2bBin ?? "o2b";
  const watchdogBody = renderWatchdogBody(o2bBin);
  const header =
    "# ----------------------------------------------------------------------\n" +
    "# Open Second Brain - periodic reindex template\n" +
    "# interval: " +
    parsed.human +
    "\n" +
    "#\n" +
    "# Pick ONE of the three paths below. The watchdog script is the\n" +
    "# common piece; both crontab and Hermes-cron rely on it.\n" +
    "# ----------------------------------------------------------------------\n";
  const watchdog =
    "## 1. Watchdog script - save to ~/.local/bin/osb-reindex.sh\n" +
    "##    (then chmod +x). Sources ~/.hermes/.env if present so the\n" +
    "##    embedding API key lands in the environment.\n" +
    "\n" +
    "cat >~/.local/bin/osb-reindex.sh <<'OSBEOF'\n" +
    watchdogBody +
    "OSBEOF\n" +
    "chmod +x ~/.local/bin/osb-reindex.sh\n";
  const nativeCron =
    "## 2. Native crontab - open 'crontab -e' and append:\n" +
    "\n" +
    parsed.cron +
    "    ~/.local/bin/osb-reindex.sh\n";
  const hermesCron =
    "## 3. Hermes cron (preferred when Hermes is the embedding owner):\n" +
    "\n" +
    "hermes cron create \\\n" +
    "  --name osb-reindex \\\n" +
    "  --schedule '" +
    parsed.hermesSchedule +
    "' \\\n" +
    '  --command "$HOME/.local/bin/osb-reindex.sh" \\\n' +
    "  --no-agent\n";
  const footer =
    "# ----------------------------------------------------------------------\n" +
    "# After install, verify with: " +
    o2bBin +
    " search status\n" +
    "# ----------------------------------------------------------------------\n";
  return [header, "", watchdog, "", nativeCron, "", hermesCron, "", footer].join("\n");
}

function renderWatchdogBody(o2bBin: string): string {
  // The bash body lives in a heredoc on the operator's host. JS-side
  // strings are plain text -- no JS-level interpolation of shell
  // variables. The watchdog prints the JSON line verbatim when
  // something changed; the operator pipes it through jq, Slack, or
  // keeps the raw line.
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "# Pick up OPEN_SECOND_BRAIN_EMBEDDING_* from the Hermes env file",
    "# if it exists. Other env files can be appended below.",
    'if [[ -f "$HOME/.hermes/.env" ]]; then',
    '  set -a; . "$HOME/.hermes/.env"; set +a',
    "fi",
    "",
    "out=$(" + o2bBin + " search reindex --embeddings --json)",
    "# Emit the JSON line only when the reindex actually changed",
    "# something. jq is preferred; fall back to grep when missing.",
    "if command -v jq >/dev/null 2>&1; then",
    '  changed=$(printf "%s" "$out" | jq -r ".stats.added + .stats.updated + .stats.deleted")',
    '  if [ "$changed" != "0" ] && [ -n "$changed" ]; then',
    '    printf "%s\\n" "$out"',
    "  fi",
    "else",
    '  if printf "%s" "$out" | grep -Eq \'"(added|updated|deleted)"[[:space:]]*:[[:space:]]*[1-9]\'; then',
    '    printf "%s\\n" "$out"',
    "  fi",
    "fi",
  ];
  return lines.join("\n") + "\n";
}
