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
import {
  applyStateMigration,
  applyStateRollback,
  planStateMigration,
  planStateRollback,
  renderMigrationPlan,
  renderRollbackPlan,
  StateMigrationError,
  type MigrationPlan,
  type RollbackPlan,
} from "../core/state/migrate.ts";
import { inventoryStateSurfaces, renderStateInventory } from "../core/state/surfaces.ts";
import { parseFlags } from "./argparse.ts";
import { readSingleLine } from "./brain/rollback-prompt.ts";
import { requireVault, sortedReplacer } from "./helpers.ts";

const USAGE = [
  "usage: o2b state status [--vault <dir>] [--config <file>] [--json]",
  "       o2b state migrate --to <dir> [--vault <dir>] [--config <file>]",
  "                         [--dry-run | --apply [--yes]] [--json]",
  "       o2b state rollback --from <dir> [--to <vault>] [--apply [--yes]] [--json]",
].join("\n");

/**
 * Exit codes these verbs return.
 *
 * `refused` is separate from a crash on purpose. A migration that will
 * not run, and a rollback that left files behind, are ANSWERS - the
 * command did what it was asked and the answer is no. A supervisor that
 * cannot tell them from a broken invocation retries the wrong one, so
 * `2` stays reserved for a mistake in the argv.
 */
const STATE_EXIT = Object.freeze({ ok: 0, refused: 1, usage: 2 } as const);

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
    case "migrate":
      return cmdStateMigrate(rest);
    case "rollback":
      return cmdStateRollback(rest);
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

/**
 * `o2b state migrate --to <dir>` - move the vault's state, or say why not.
 *
 * The ladder is `brain upgrade`'s, verb for verb: `--dry-run` and
 * `--apply` are mutually exclusive, a bare invocation plans, `--apply`
 * without `--yes` is refused whenever nobody can answer a prompt
 * (`--json`, or a non-TTY stdin), and the TTY prompt accepts only `y` or
 * `yes`. It is copied rather than reinvented because an operator who has
 * learned one destructive verb in this CLI has learned all of them.
 */
async function cmdStateMigrate(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags([...argv], {
    to: { type: "string" },
    vault: { type: "string" },
    config: { type: "string" },
    "dry-run": { type: "boolean" },
    apply: { type: "boolean" },
    yes: { type: "boolean" },
    json: { type: "boolean" },
  });
  const asJson = Boolean(flags["json"]);
  const destination = flags["to"] as string | undefined;
  if (destination === undefined || destination.trim() === "") {
    process.stderr.write(`error: state migrate requires --to <dir>\n${USAGE}\n`);
    return STATE_EXIT.usage;
  }
  if (flags["dry-run"] && flags["apply"]) {
    process.stderr.write("error: state migrate: --dry-run and --apply are mutually exclusive\n");
    return STATE_EXIT.usage;
  }

  const configPath = (flags["config"] as string | undefined) ?? defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, configPath);

  let plan: MigrationPlan;
  try {
    plan = planStateMigration({
      vault,
      destination,
      env: process.env,
      config: discoverConfig(configPath).data,
    });
  } catch (exc) {
    process.stderr.write(`error: state migrate could not plan: ${(exc as Error).message}\n`);
    return STATE_EXIT.refused;
  }

  if (!flags["apply"]) {
    writePlan(plan, asJson);
    return plan.refusals.length > 0 ? STATE_EXIT.refused : STATE_EXIT.ok;
  }
  if (plan.refusals.length > 0) {
    writePlan(plan, asJson);
    return STATE_EXIT.refused;
  }
  if (plan.manifest.entries.length === 0) {
    writePlan(plan, asJson);
    if (!asJson) process.stdout.write("state migrate: nothing to move.\n");
    return STATE_EXIT.ok;
  }
  if (!flags["yes"]) {
    if (asJson || !process.stdin.isTTY) {
      process.stderr.write(
        "error: state migrate --apply requires --yes in non-interactive mode " +
          "(--json or non-TTY stdin)\n",
      );
      return STATE_EXIT.usage;
    }
    process.stderr.write(
      `${renderMigrationPlan(plan)}About to MOVE ${plan.manifest.entries.length} file(s) ` +
        `(${plan.manifest.total_bytes} bytes) out of ${plan.source}.\n` +
        `A manifest is written to ${plan.destination} so \`o2b state rollback --from ` +
        `${plan.destination}\` can put them back.\nProceed? [y/N] `,
    );
    const answer = (await readSingleLine()).toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      process.stdout.write("state migrate cancelled\n");
      return STATE_EXIT.ok;
    }
  }

  try {
    const result = applyStateMigration(plan);
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ plan, result }, sortedReplacer, 2)}\n`);
    } else {
      process.stdout.write(
        `state migrate: moved ${result.moved.length} file(s), ${result.bytes} byte(s).\n` +
          `manifest: ${result.manifest_path}\n` +
          `roll back with: o2b state rollback --from ${plan.destination} --apply --yes\n`,
      );
    }
    return STATE_EXIT.ok;
  } catch (exc) {
    if (exc instanceof StateMigrationError) {
      process.stderr.write(`error: ${exc.message}\n`);
      return STATE_EXIT.refused;
    }
    throw exc;
  }
}

/**
 * `o2b state rollback --from <dir>` - put back what still matches.
 *
 * The refusal list is part of the exit contract rather than a warning
 * nobody reads: a rollback that left files behind exits `1` even when
 * everything it DID do succeeded, because "restored 4 of 5" is not a
 * success and a supervisor reading only the exit code has to be told so.
 */
async function cmdStateRollback(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags([...argv], {
    from: { type: "string" },
    to: { type: "string" },
    "dry-run": { type: "boolean" },
    apply: { type: "boolean" },
    yes: { type: "boolean" },
    json: { type: "boolean" },
  });
  const asJson = Boolean(flags["json"]);
  const from = flags["from"] as string | undefined;
  // `--to` is the answer to a vault that has MOVED since the migration.
  // The manifest records an absolute source root, and without an override
  // a renamed vault leaves the rollback with nowhere honest to put the
  // files; the plan refuses that case by name and points here.
  const to = flags["to"] as string | undefined;
  if (from === undefined || from.trim() === "") {
    process.stderr.write(
      "error: state rollback requires --from <dir>: the directory a migration was moved TO, " +
        `which is where its manifest was written\n${USAGE}\n`,
    );
    return STATE_EXIT.usage;
  }
  if (flags["dry-run"] && flags["apply"]) {
    process.stderr.write("error: state rollback: --dry-run and --apply are mutually exclusive\n");
    return STATE_EXIT.usage;
  }

  let plan: RollbackPlan;
  try {
    plan = planStateRollback({
      destination: from,
      ...(to === undefined || to.trim() === "" ? {} : { vault: to }),
    });
  } catch (exc) {
    process.stderr.write(`error: state rollback could not plan: ${(exc as Error).message}\n`);
    return STATE_EXIT.refused;
  }

  if (!flags["apply"]) {
    process.stdout.write(
      asJson ? `${JSON.stringify(plan, sortedReplacer, 2)}\n` : renderRollbackPlan(plan),
    );
    return plan.refusals.length > 0 ? STATE_EXIT.refused : STATE_EXIT.ok;
  }
  if (!flags["yes"]) {
    if (asJson || !process.stdin.isTTY) {
      process.stderr.write(
        "error: state rollback --apply requires --yes in non-interactive mode " +
          "(--json or non-TTY stdin)\n",
      );
      return STATE_EXIT.usage;
    }
    process.stderr.write(
      `${renderRollbackPlan(plan)}About to restore ${plan.restore.length} file(s) to ` +
        `${plan.source}.\nProceed? [y/N] `,
    );
    const answer = (await readSingleLine()).toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      process.stdout.write("state rollback cancelled\n");
      return STATE_EXIT.ok;
    }
  }

  try {
    const result = applyStateRollback(plan);
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ plan, result }, sortedReplacer, 2)}\n`);
    } else {
      process.stdout.write(
        `state rollback: restored ${result.restored.length} file(s) to ${plan.source}.\n`,
      );
      if (result.refused.length > 0) {
        process.stdout.write(
          `${result.refused.length} file(s) were left at ${plan.destination}; the manifest is ` +
            "kept so they stay traceable:\n" +
            result.refused
              .map((refusal) => `  - ${refusal.relative_path} (${refusal.code})\n`)
              .join(""),
        );
      }
    }
    return result.refused.length > 0 ? STATE_EXIT.refused : STATE_EXIT.ok;
  } catch (exc) {
    if (exc instanceof StateMigrationError) {
      process.stderr.write(`error: ${exc.message}\n`);
      return STATE_EXIT.refused;
    }
    throw exc;
  }
}

/** One plan, one place it reaches a stream. */
function writePlan(plan: MigrationPlan, asJson: boolean): void {
  const stream = plan.refusals.length > 0 ? process.stderr : process.stdout;
  if (asJson) process.stdout.write(`${JSON.stringify(plan, sortedReplacer, 2)}\n`);
  else stream.write(renderMigrationPlan(plan));
}
