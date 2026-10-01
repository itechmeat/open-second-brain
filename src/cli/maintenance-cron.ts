/**
 * `o2b brain maintenance run --cron-template` renderer.
 *
 * The maintenance lane is the cron entry point for the heavy passes: it
 * gates itself on the quiet window, recent interactive load, memory
 * pressure, its lease and each task's failure streak, and a gate skip
 * exits 0. So the intended schedule is a frequent, dumb trigger - hourly
 * by default - and the lane decides whether any work happens. This module
 * is that trigger's recipe, a third consumer of the shared kernel in
 * `cron-recipe.ts`: text on stdout in either the cron or the systemd
 * format, never a file, a unit or a scheduler entry written by this CLI.
 *
 * A scheduler runs the script without the operator's shell environment,
 * so the recipe bakes in what the lane cannot discover on its own: the
 * vault, and the window and zone when the operator gave them. The vault
 * is single-quoted; the window and the zone must be plain tokens, because
 * they are pasted into a shell line and a value that needs quoting is
 * almost certainly not a window or a zone.
 *
 * The script keeps the lane's exit code. Exit 0 (ran, or skipped by a
 * gate) prints nothing, so cron mails nothing; any other exit prints the
 * lane's JSON verdict and exits with the same code, so cron mail or a
 * Hermes job surfaces it.
 */

import {
  CronTemplateError,
  operatorScriptPath,
  parseRecipeFormat,
  renderCronRecipe,
  renderSystemdTimer,
  type CronRecipeOptions,
  type CronRecipeSpec,
  type RecipeFormat,
} from "./cron-recipe.ts";

/** Cron job name, and the stem of the script path derived from it. */
export const MAINTENANCE_CRON_NAME = "osb-maintenance";

/**
 * Cadence when the caller names none. Hourly is cheap because the lane's
 * own gates make most firings a quiet exit 0; `--window` narrows when the
 * work actually happens.
 */
export const DEFAULT_MAINTENANCE_INTERVAL = "1h";

/** Inputs the maintenance recipe needs on top of the shared ones. */
export interface MaintenanceCronOptions extends CronRecipeOptions {
  /** Absolute vault path the scheduled run targets. */
  readonly vault: string;
  /** Quiet window as `H-H`, forwarded to `--window`. */
  readonly window?: string;
  /** Time zone of the window, forwarded to `--tz`. */
  readonly tz?: string;
}

/** The lane verb the emitted script runs, and the one the footer checks. */
const RUN_COMMAND = "brain maintenance run";
const STATUS_COMMAND = "brain maintenance status";

/** `H-H` with hours 0..23: the same shape the lane's `--window` accepts. */
const WINDOW_PATTERN = /^(\d{1,2})-(\d{1,2})$/u;

/** Highest hour a window bound may name. */
const MAX_WINDOW_HOUR = 23;

/**
 * Characters an IANA zone name (`Europe/Berlin`, `Etc/GMT+3`, `UTC`) is
 * made of, none of which a shell treats specially.
 */
const TZ_PATTERN = /^[A-Za-z0-9_+\-/]+$/u;

/**
 * Single-quote a value for bash, the way `discipline-install.ts` quotes
 * the vault it bakes into its job: a quote inside the value closes the
 * string, emits an escaped quote and reopens it. Inside single quotes a
 * backslash is literal, so nothing else needs escaping.
 */
function shellQuote(value: string): string {
  return "'" + value.replace(/'/gu, "'\\''") + "'";
}

/** The window as given, after proving it is a plain `H-H` token. */
function checkedWindow(raw: string): string {
  const match = WINDOW_PATTERN.exec(raw);
  const start = match ? Number(match[1]) : Number.NaN;
  const end = match ? Number(match[2]) : Number.NaN;
  if (!match || start > MAX_WINDOW_HOUR || end > MAX_WINDOW_HOUR) {
    throw new CronTemplateError(
      "--window must be H-H with hours 0.." + MAX_WINDOW_HOUR + ", got: " + JSON.stringify(raw),
    );
  }
  return raw;
}

/** The zone as given, after proving it is a plain zone-name token. */
function checkedTz(raw: string): string {
  if (!TZ_PATTERN.test(raw)) {
    throw new CronTemplateError(
      "--tz must be a time zone name such as Europe/Berlin or UTC, got: " + JSON.stringify(raw),
    );
  }
  return raw;
}

/** The lane invocation the script runs, every input already checked. */
function laneCommand(o2bBin: string, opts: MaintenanceCronOptions): string {
  const parts = [o2bBin, RUN_COMMAND, "--vault", shellQuote(opts.vault)];
  if (opts.window !== undefined) parts.push("--window", checkedWindow(opts.window));
  if (opts.tz !== undefined) parts.push("--tz", checkedTz(opts.tz));
  parts.push("--json");
  return parts.join(" ");
}

/**
 * The bash body of the trigger script. JS-side strings are plain text:
 * the heredoc that carries them is quoted, so every `$name` is expanded
 * later, when the scheduler runs the script.
 */
function renderMaintenanceBody(o2bBin: string, opts: MaintenanceCronOptions): string {
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "# Pick up OPEN_SECOND_BRAIN_EMBEDDING_* from the Hermes env file if it",
    "# exists: the lane's reindex task embeds when maintenance_embeddings is on.",
    'if [[ -f "$HOME/.hermes/.env" ]]; then',
    '  set -a; . "$HOME/.hermes/.env"; set +a',
    "fi",
    "",
    "# The lane decides whether work happens; a gate skip exits 0. Keep its",
    "# exit code: `|| status=$?` stops set -e from ending the script before",
    "# a failure can be reported.",
    "status=0",
    "out=$(" + laneCommand(o2bBin, opts) + ") || status=$?",
    'if [ "$status" -ne 0 ]; then',
    '  printf "%s\\n" "$out"',
    '  exit "$status"',
    "fi",
  ];
  return lines.join("\n") + "\n";
}

/** The maintenance recipe: the lane-specific half of the shared layout. */
export const MAINTENANCE_RECIPE: CronRecipeSpec<MaintenanceCronOptions> = Object.freeze<
  CronRecipeSpec<MaintenanceCronOptions>
>({
  title: "Open Second Brain - maintenance lane template",
  cronName: MAINTENANCE_CRON_NAME,
  scriptPath: operatorScriptPath(MAINTENANCE_CRON_NAME),
  scriptNotes: Object.freeze([
    "(then chmod +x). Silent when the lane exits 0, including a gate",
    "skip; any other exit prints the lane's JSON and keeps its code.",
  ]),
  schedulerNote: "(when Hermes owns the schedule)",
  buildScriptBody: (opts) => renderMaintenanceBody(opts.o2bBin, opts),
  buildVerifyCommand: ({ o2bBin }) => o2bBin + " " + STATUS_COMMAND,
});

/**
 * Render the maintenance lane recipe in the requested format (cron when
 * omitted). Pure text: nothing is created, spawned or scheduled. Throws
 * {@link CronTemplateError} for an interval the scheduler cannot express,
 * a window that is not `H-H` with hours 0..23, or a zone that is not a
 * plain zone name.
 */
export function renderMaintenanceCronTemplate(
  interval: string,
  opts: MaintenanceCronOptions & { readonly format?: RecipeFormat },
): string {
  const { format, ...recipeOpts } = opts;
  const render: RecipeFormat = parseRecipeFormat(format);
  return render === "systemd"
    ? renderSystemdTimer(MAINTENANCE_RECIPE, interval, recipeOpts)
    : renderCronRecipe(MAINTENANCE_RECIPE, interval, recipeOpts);
}
