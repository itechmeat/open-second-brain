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

import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  CronTemplateError,
  operatorScriptPath,
  parseRecipeFormat,
  renderCronRecipe,
  renderSystemdTimer,
  shellQuote,
  singleLinePath,
  type CronRecipeOptions,
  type CronRecipeSpec,
  type RecipeFormat,
} from "./cron-recipe.ts";

/**
 * Stem of the per-vault job name. The full name appends a vault suffix
 * ({@link maintenanceCronName}), because the script bakes in its vault.
 */
export const MAINTENANCE_CRON_NAME = "osb-maintenance";

/** Hex characters of the vault hash the job name carries. */
const VAULT_SUFFIX_LENGTH = 8;

/**
 * The job name for one vault: the stem plus the first hex characters of
 * `sha256(resolve(vault))`, the same scheme `discipline install` uses for
 * its job id. The script, the Hermes job and the systemd units all take
 * this name, so a second vault's recipe never overwrites the first's, and
 * re-rendering for the same vault yields the same name.
 */
export function maintenanceCronName(vault: string): string {
  const suffix = createHash("sha256")
    .update(resolve(vault))
    .digest("hex")
    .slice(0, VAULT_SUFFIX_LENGTH);
  return MAINTENANCE_CRON_NAME + "-" + suffix;
}

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

/**
 * `H-H` with hours 0..23: the one shape of a quiet window, shared by the
 * lane's own `--window` parser and this recipe so the two cannot drift.
 */
export const MAINTENANCE_WINDOW_PATTERN = /^(\d{1,2})-(\d{1,2})$/u;

/** Highest hour a window bound may name. */
export const MAX_WINDOW_HOUR = 23;

/** The two bounds of a quiet window, in hours. */
export interface WindowBounds {
  readonly startHour: number;
  readonly endHour: number;
}

/**
 * Parse an `H-H` window into its bounds, or null when the value is not
 * that shape or names an hour above {@link MAX_WINDOW_HOUR}. Callers
 * word their own refusal.
 */
export function parseWindowBounds(raw: string): WindowBounds | null {
  const match = MAINTENANCE_WINDOW_PATTERN.exec(raw);
  if (!match) return null;
  const startHour = Number(match[1]);
  const endHour = Number(match[2]);
  if (startHour > MAX_WINDOW_HOUR || endHour > MAX_WINDOW_HOUR) return null;
  return { startHour, endHour };
}

/**
 * Characters an IANA zone name (`Europe/Berlin`, `Etc/GMT+3`, `UTC`) is
 * made of, none of which a shell treats specially. The first character
 * is a letter, so a zone can never look like a flag (`--force`).
 */
const TZ_PATTERN = /^[A-Za-z][A-Za-z0-9_+\-/]*$/u;

/** The window as given, after proving it is a plain `H-H` token. */
function checkedWindow(raw: string): string {
  if (parseWindowBounds(raw) === null) {
    throw new CronTemplateError(
      "--window must be H-H with hours 0.." + MAX_WINDOW_HOUR + ", got: " + JSON.stringify(raw),
    );
  }
  return raw;
}

/** Whether the runtime knows the zone, the same check the lane makes. */
function isKnownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone }).resolvedOptions();
    return true;
  } catch (err) {
    if (err instanceof RangeError) return false;
    throw err;
  }
}

/**
 * The zone as given, after proving it is a plain zone-name token AND a
 * zone the runtime resolves: the lane formats the window through `Intl`
 * on every firing, so a recipe must not bake in a zone it would refuse.
 */
function checkedTz(raw: string): string {
  if (!TZ_PATTERN.test(raw)) {
    throw new CronTemplateError(
      "--tz must be a time zone name such as Europe/Berlin or UTC, got: " + JSON.stringify(raw),
    );
  }
  if (!isKnownTimeZone(raw)) {
    throw new CronTemplateError("--tz names an unknown time zone: " + JSON.stringify(raw));
  }
  return raw;
}

/** Label the line-break refusal names the vault with. */
const VAULT_LABEL = "vault";

/** The lane invocation the script runs, every input already checked. */
function laneCommand(o2bBin: string, opts: MaintenanceCronOptions): string {
  const parts = [
    o2bBin,
    RUN_COMMAND,
    "--vault",
    shellQuote(singleLinePath(VAULT_LABEL, opts.vault)),
  ];
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

/** The maintenance recipe for one vault: the lane-specific half of the shared layout. */
export function maintenanceRecipe(vault: string): CronRecipeSpec<MaintenanceCronOptions> {
  const cronName = maintenanceCronName(vault);
  return Object.freeze<CronRecipeSpec<MaintenanceCronOptions>>({
    title: "Open Second Brain - maintenance lane template",
    cronName,
    scriptPath: operatorScriptPath(cronName),
    scriptNotes: Object.freeze([
      "(then chmod +x). Silent when the lane exits 0, including a gate",
      "skip; any other exit prints the lane's JSON and keeps its code.",
    ]),
    schedulerNote: "(when Hermes owns the schedule)",
    buildScriptBody: (opts) => renderMaintenanceBody(opts.o2bBin, opts),
    buildVerifyCommand: ({ o2bBin, vault: target }) =>
      o2bBin + " " + STATUS_COMMAND + " --vault " + shellQuote(singleLinePath(VAULT_LABEL, target)),
  });
}

/**
 * Render the maintenance lane recipe in the requested format (cron when
 * omitted). Pure text: nothing is created, spawned or scheduled. Throws
 * {@link CronTemplateError} for an interval the scheduler cannot express,
 * a window that is not `H-H` with hours 0..23, a zone that is not a
 * plain zone name the runtime knows, or a vault path with a line break.
 */
export function renderMaintenanceCronTemplate(
  interval: string,
  opts: MaintenanceCronOptions & { readonly format?: RecipeFormat },
): string {
  const { format, ...recipeOpts } = opts;
  const render: RecipeFormat = parseRecipeFormat(format);
  const spec = maintenanceRecipe(recipeOpts.vault);
  return render === "systemd"
    ? renderSystemdTimer(spec, interval, recipeOpts)
    : renderCronRecipe(spec, interval, recipeOpts);
}
