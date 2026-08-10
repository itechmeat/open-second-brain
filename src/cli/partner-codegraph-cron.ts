/**
 * `o2b partner codegraph resync --cron-template` renderer.
 *
 * An external code index goes stale the moment the repository moves ahead
 * of it, and this project deliberately owns no mechanism that would notice:
 * it refuses daemons and filesystem watchers for this purpose, and the
 * partner module's invariant - OSB never installs, initializes, or writes
 * data for codegraph - forbids the obvious alternative of re-indexing from
 * a maintenance lane. The sanctioned mechanism is a cron recipe: text on
 * stdout, in which every write is a shell command the operator's own
 * crontab runs on the operator's own host. Rendering it touches nothing.
 *
 * The emitted script runs four steps, in this order:
 *
 *   1. A health pre-flight through `o2b partner codegraph report --json`
 *      that aborts non-zero when the index was built for a different root.
 *      Re-indexing over a mismatched root would bake the wrong provenance
 *      into the graph, so reconciling it stays an operator decision. The
 *      gate needs a JSON parser and refuses to run without one, rather
 *      than falling back to a text match that would answer "no mismatch"
 *      for output it failed to understand.
 *   2. Change detection: the repository's current commit against a stamp
 *      file on the operator's host. Unchanged means exit quietly, so the
 *      common case costs one `git rev-parse`.
 *   3. The partner's own indexer, quoted from the shared partner CLI
 *      vocabulary so a renamed subcommand cannot drift out of the recipe.
 *   4. A post-state verification through `--fail-on-health`. The stamp is
 *      written only after that passes: a stamp written after a failed or
 *      empty index would suppress every later attempt, which is exactly
 *      the silence this recipe exists to end.
 */

import {
  operatorScriptPath,
  renderCronRecipe,
  type CronRecipeOptions,
  type CronRecipeSpec,
} from "./cron-recipe.ts";
import { CODEGRAPH_CLI } from "../core/partner/codegraph.ts";
import { GRAPH_HEALTH_CODES } from "../core/partner/codegraph-health.ts";

/** Inputs the codegraph recipe needs on top of the shared ones. */
export interface CodegraphResyncOptions extends CronRecipeOptions {
  /** Absolute path of the repository the emitted script keeps indexed. */
  readonly projectPath: string;
}

/** Cron job name, and the stem of the script path derived from it. */
const CODEGRAPH_RESYNC_CRON_NAME = "osb-codegraph-resync";

/**
 * Where the emitted script keeps its stamp: the operator's XDG state
 * directory, never the vault and never the partner's index. State
 * directories are for exactly this - data a program may lose without the
 * operator losing anything they authored.
 */
const STAMP_DIR_EXPRESSION = "${XDG_STATE_HOME:-$HOME/.local/state}/open-second-brain";

/** Extension of the per-repository stamp file. */
const STAMP_EXTENSION = ".stamp";

/** Characters kept verbatim in a stamp file name; everything else folds to a dash. */
const STAMP_NAME_UNSAFE = /[^A-Za-z0-9._-]+/g;

/** The `o2b partner codegraph` verb path the emitted script calls back into. */
const REPORT_COMMAND = "partner codegraph report";

/** Flag that turns the report's health verdict into its exit code. */
const FAIL_ON_HEALTH_FLAG = "--fail-on-health";

/** Flag that makes the report machine-readable. */
const JSON_FLAG = "--json";

/** The JSON parser the health gate requires. */
const JSON_PARSER = "jq";

/**
 * One stamp file per repository, named after the repository's path so two
 * recipes on one host cannot silently share a change detector and starve
 * each other of re-indexes.
 */
function stampFileName(projectPath: string): string {
  const slug = projectPath.replace(STAMP_NAME_UNSAFE, "-").replace(/^-+|-+$/g, "");
  return `${CODEGRAPH_RESYNC_CRON_NAME}-${slug}${STAMP_EXTENSION}`;
}

/**
 * The bash body of the resync script. JS-side strings are plain text: the
 * heredoc that carries them is quoted, so nothing here is interpolated by
 * the shell that installs the script, and every `$name` below is expanded
 * later, when cron runs it.
 */
function renderResyncBody(o2bBin: string, projectPath: string): string {
  const report = `${o2bBin} ${REPORT_COMMAND}`;
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "# The repository this recipe keeps indexed, baked in when the recipe",
    "# was rendered. Re-render for a different repository.",
    'project="' + projectPath + '"',
    'stamp_dir="' + STAMP_DIR_EXPRESSION + '"',
    'stamp_file="$stamp_dir/' + stampFileName(projectPath) + '"',
    "",
    "# 1. Health pre-flight. " + JSON_PARSER + " is REQUIRED here, not preferred:",
    "#    this gate decides whether a re-index may run, and a gate that",
    "#    cannot parse its input must not pass. A looser text match would",
    "#    report no mismatch for output it failed to understand, so a",
    "#    missing parser aborts instead of guessing.",
    "if ! command -v " + JSON_PARSER + " >/dev/null 2>&1; then",
    '  printf "%s\\n" "' +
      CODEGRAPH_RESYNC_CRON_NAME +
      ": " +
      JSON_PARSER +
      ' is required to read the health report; aborting" >&2',
    "  exit 1",
    "fi",
    "",
    'health=$(cd "$project" && ' + report + " " + JSON_FLAG + ")",
    "# An index built for another root must be reconciled by a human before",
    "# a re-index writes over it; every other finding is what re-indexing is",
    "# for, so only this one blocks.",
    // The exit status is read explicitly rather than through `if`, because
    // `if` collapses every non-zero status into one answer. This parser
    // exits 0 when the selection is truthy, 1 when it is falsy, and
    // something larger when it could not read its input at all - and a
    // bare `if` reads that last case as "no mismatch" and re-indexes over
    // a root nobody verified. Only a literal 1 is a pass.
    "mismatch_status=0",
    'printf "%s" "$health" | ' +
      JSON_PARSER +
      " -e '[.index.health.warnings[]? | select(.code == \"" +
      GRAPH_HEALTH_CODES.cacheRootMismatch +
      "\")] | length > 0' >/dev/null || mismatch_status=$?",
    'if [ "$mismatch_status" -eq 0 ]; then',
    '  printf "%s\\n" "' +
      CODEGRAPH_RESYNC_CRON_NAME +
      ": index was built for a different root (" +
      GRAPH_HEALTH_CODES.cacheRootMismatch +
      '); reconcile it before re-indexing" >&2',
    "  exit 1",
    'elif [ "$mismatch_status" -ne 1 ]; then',
    '  printf "%s\\n" "' +
      CODEGRAPH_RESYNC_CRON_NAME +
      ": could not read the health report (" +
      JSON_PARSER +
      ' exit $mismatch_status); aborting rather than re-indexing blind" >&2',
    "  exit 1",
    "fi",
    "",
    "# 2. Change detection. The stamp holds the commit the last verified",
    "#    index was built from; an unchanged commit exits quietly so the",
    "#    common case costs one git call and prints nothing.",
    'current=$(git -C "$project" rev-parse HEAD)',
    'previous=""',
    'if [[ -f "$stamp_file" ]]; then',
    '  previous=$(cat "$stamp_file")',
    "fi",
    'if [[ "$current" == "$previous" ]]; then',
    "  exit 0",
    "fi",
    "",
    "# 3. Re-index through the partner's own CLI. This is the operator's",
    "#    command, running on the operator's host; o2b only quotes it.",
    CODEGRAPH_CLI.bin + " " + CODEGRAPH_CLI.initSubcommand + ' "$project"',
    "",
    "# 4. Verify the post-index state before recording the commit. A stamp",
    "#    written after a failed or empty index would suppress every later",
    "#    attempt and leave the graph quietly stale.",
    'if ! (cd "$project" && ' +
      report +
      " " +
      JSON_FLAG +
      " " +
      FAIL_ON_HEALTH_FLAG +
      " >/dev/null); then",
    '  printf "%s\\n" "' +
      CODEGRAPH_RESYNC_CRON_NAME +
      ': re-index finished but the health gate refused the result; stamp not written" >&2',
    "  exit 1",
    "fi",
    "",
    'mkdir -p "$stamp_dir"',
    'printf "%s\\n" "$current" >"$stamp_file"',
  ];
  return lines.join("\n") + "\n";
}

/** The resync recipe: the codegraph-specific half of the shared layout. */
export const CODEGRAPH_RESYNC_RECIPE: CronRecipeSpec<CodegraphResyncOptions> = Object.freeze<
  CronRecipeSpec<CodegraphResyncOptions>
>({
  title: "Open Second Brain - codegraph resync template",
  cronName: CODEGRAPH_RESYNC_CRON_NAME,
  scriptPath: operatorScriptPath(CODEGRAPH_RESYNC_CRON_NAME),
  scriptNotes: Object.freeze([
    "(then chmod +x). The repository is baked into the script, so a",
    "second repository needs its own script path and cron job name.",
  ]),
  schedulerNote: "(preferred when Hermes owns the host's scheduled jobs)",
  buildScriptBody: ({ o2bBin, projectPath }) => renderResyncBody(o2bBin, projectPath),
  buildVerifyCommand: ({ o2bBin }) => `${o2bBin} ${REPORT_COMMAND} ${FAIL_ON_HEALTH_FLAG}`,
});

/**
 * Render the resync recipe for one repository. Pure text: nothing is
 * created, spawned or scheduled here.
 */
export function renderCodegraphResyncTemplate(
  projectPath: string,
  interval: string,
  opts: CronRecipeOptions = {},
): string {
  return renderCronRecipe(CODEGRAPH_RESYNC_RECIPE, interval, { ...opts, projectPath });
}
