/**
 * `o2b state` - the verbs that answer "where does this vault keep its
 * state, and can it be moved".
 *
 * Only `status` exists today: an inventory, and nothing more. It is a
 * dispatcher rather than a single verb from the first commit because the
 * sibling that moves state (`state migrate` / `state rollback`) is a
 * separate unit on the established `--dry-run` / `--apply --yes` ladder,
 * and bolting a subcommand onto a flat verb later means reshaping the
 * surface an operator has already learned.
 *
 * The report itself is built and rendered in `core/state/surfaces.ts`, so
 * this file resolves inputs and picks a stream - the human sentence or the
 * same value as JSON. It never composes a second copy of the report; that
 * is the drift `renderDataOwnership` exists to prevent and this verb
 * follows it.
 */

import { defaultConfigPath, discoverConfig } from "../core/config.ts";
import { inventoryStateSurfaces, renderStateInventory } from "../core/state/surfaces.ts";
import { parseFlags } from "./argparse.ts";
import { requireVault, sortedReplacer } from "./helpers.ts";

const USAGE = "usage: o2b state status [--vault <dir>] [--config <file>] [--json]";

/** Exit codes this verb returns. `2` is reserved for a mistake in the argv. */
const STATE_EXIT = Object.freeze({ ok: 0, usage: 2 } as const);

export async function handleStateSubcommand(argv: ReadonlyArray<string>): Promise<number> {
  const verb = argv[0];
  if (verb === undefined || verb === "-h" || verb === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return verb === undefined ? STATE_EXIT.usage : STATE_EXIT.ok;
  }
  const rest = argv.slice(1);
  switch (verb) {
    case "status":
      return cmdStateStatus(rest);
    default:
      process.stderr.write(`error: unknown state verb: ${verb}\n${USAGE}\n`);
      return STATE_EXIT.usage;
  }
}

/**
 * `o2b state status` - one row per declared state surface.
 *
 * Exit 0 whenever the inventory completed, including when a surface could
 * not be probed. An `unchecked` verdict is an answer this command was
 * asked for and it carries its own reason; turning it into a non-zero exit
 * would make a reporting verb into a gate, and the gate already exists
 * (`o2b doctor`).
 */
async function cmdStateStatus(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags([...argv], {
    vault: { type: "string" },
    config: { type: "string" },
    json: { type: "boolean" },
  });
  const configPath = (flags["config"] as string | undefined) ?? defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, configPath);
  const inventory = inventoryStateSurfaces({
    vault,
    env: process.env,
    config: discoverConfig(configPath).data,
  });
  process.stdout.write(
    flags["json"]
      ? `${JSON.stringify(inventory, sortedReplacer, 2)}\n`
      : renderStateInventory(inventory),
  );
  return STATE_EXIT.ok;
}
