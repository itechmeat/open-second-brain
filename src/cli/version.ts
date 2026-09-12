/**
 * `o2b version` - what this install is.
 *
 * The MCP handshake has always carried `serverInfo.version`; the shell
 * had no way to ask. This verb closes that half, and the root
 * `--version` flag in `main.ts` routes here rather than rendering a
 * second line of its own: two spellings of one question that answer
 * differently are worse than one spelling, because the difference is
 * invisible until someone pastes the wrong one into a bug report.
 *
 * The version itself is not computed here. `src/core/version.ts` holds
 * the tree's only read of the manifest, and this verb reports it.
 */

import { OPEN_SECOND_BRAIN_VERSION } from "../core/version.ts";
import { CliError, parseFlags } from "./argparse.ts";
import { ROOT_VERSION_FLAG } from "./command-manifest.ts";
import { sortedReplacer } from "./helpers.ts";

/**
 * The root synonym `main.ts` matches on, spelled from the manifest
 * declaration so the dispatcher and the completion scripts cannot come
 * to disagree about what the flag is called.
 */
export const ROOT_VERSION_FLAG_TOKEN = `--${ROOT_VERSION_FLAG.name}`;

/** JSON member name, shared by the renderer and the tests that parse it. */
const VERSION_FIELD = "version";

const USAGE = "usage: o2b version [--json]";

/**
 * Render the version to stdout.
 *
 * `argv` is everything after the verb (or after the root flag). It takes
 * no positional argument: `o2b version latest` is a request this verb
 * cannot honour - nothing in this tree learns what any other version is
 * - so it is a usage error rather than a silent print of the local one.
 */
export function cmdVersion(argv: ReadonlyArray<string>): number {
  const { flags, positional } = parseFlags(argv, { json: { type: "boolean" } });
  if (positional.length > 0) {
    throw new CliError(`version takes no positional arguments: ${positional.join(" ")}\n${USAGE}`);
  }
  if (flags["json"] === true) {
    process.stdout.write(
      JSON.stringify({ [VERSION_FIELD]: OPEN_SECOND_BRAIN_VERSION }, sortedReplacer) + "\n",
    );
    return 0;
  }
  process.stdout.write(`${OPEN_SECOND_BRAIN_VERSION}\n`);
  return 0;
}
