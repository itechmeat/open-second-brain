/**
 * §E.3 -- 'o2b search reindex --cron-template' renderer.
 *
 * Prints a watchdog script body, a native crontab line, and an
 * optional 'hermes cron create' invocation. Pure stdout, writes
 * nothing. The operator (or agent in the user's name) copies what
 * fits their host into the cron infrastructure of choice.
 *
 * The layout, the interval parser and the heredoc mechanics live in
 * `cron-recipe.ts`, shared with every other recipe this CLI prints.
 * What stays here is what is specific to the reindex recipe: its name,
 * its command and its change-detection expression, gathered into
 * {@link SEARCH_REINDEX_RECIPE}. The extraction is required to be
 * output-preserving to the byte - `tests/cli/search-cron-template.test.ts`
 * pins the rendered text against a fixture - because operators already
 * have this script installed and a diff here is a diff in their crontab.
 *
 * Every name this module exported before the extraction is still
 * exported from it, so existing importers are untouched.
 */

import {
  CronTemplateError,
  operatorScriptPath,
  renderCronRecipe,
  parseInterval,
  type CronRecipeOptions,
  type CronRecipeSpec,
  type ParsedInterval,
} from "./cron-recipe.ts";

export { CronTemplateError, parseInterval };
export type { ParsedInterval };

export type RenderCronTemplateOptions = CronRecipeOptions;

/** Cron job name, and the stem of the script path derived from it. */
const SEARCH_REINDEX_CRON_NAME = "osb-reindex";

/** The reindex recipe: the reindex-specific half of the shared layout. */
export const SEARCH_REINDEX_RECIPE: CronRecipeSpec = Object.freeze<CronRecipeSpec>({
  title: "Open Second Brain - periodic reindex template",
  cronName: SEARCH_REINDEX_CRON_NAME,
  scriptPath: operatorScriptPath(SEARCH_REINDEX_CRON_NAME),
  scriptNotes: Object.freeze([
    "(then chmod +x). Sources ~/.hermes/.env if present so the",
    "embedding API key lands in the environment.",
  ]),
  schedulerNote: "(preferred when Hermes is the embedding owner)",
  buildScriptBody: ({ o2bBin }) => renderWatchdogBody(o2bBin),
  buildVerifyCommand: ({ o2bBin }) => o2bBin + " search status",
});

export function renderCronTemplate(interval: string, opts: RenderCronTemplateOptions = {}): string {
  return renderCronRecipe(SEARCH_REINDEX_RECIPE, interval, opts);
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
