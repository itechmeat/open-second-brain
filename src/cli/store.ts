/**
 * `o2b store` - verbs on the brain store, the append-only folder outside
 * the vault that Open Second Brain is moving its machine data into.
 *
 * `init` is the one way a store is created: writers
 * and the index never create one. The machine that creates a store also
 * takes the view writer role (`core/view/writer.ts`). Run it once on the first machine; every
 * other machine receives the partitions through sync, and a re-run
 * completes a store whose creation stopped half way. The work itself lives
 * in `core/store/store-init.ts`; this file parses flags and renders.
 * `path` reports where the store and its device-local state are
 * (`store-path.ts`); `device` lists the devices the store knows and
 * retires one that is gone (`store-device.ts`); `partition leave` takes a
 * partition off this machine (`store-partition.ts`). `shard` quarantines one bad
 * line of a held shard on this machine, lists and releases it (`store-shard.ts`).
 */

import {
  ConfigReadError,
  resolveAgentName,
  resolveDeviceId,
  resolveVault,
} from "../core/config.ts";
import { STORE_PARTITIONS, type StorePartition } from "../core/store/constants.ts";
import { recordFreshInstallSwitch, type FreshSwitchOutcome } from "../core/store/fresh-switch.ts";
import { PartitionUnavailableError } from "../core/store/appender.ts";
import { initStore, StoreInitRefusal, type InitStoreResult } from "../core/store/store-init.ts";
import { openStore, StoreOpenError } from "../core/store/store-open.ts";
import {
  resolveConfiguredStoreRoot,
  StoreRootInsideVaultError,
} from "../core/store/store-paths.ts";
import { claimViewWriter } from "../core/view/writer.ts";
import { CliError, parseFlags } from "./argparse.ts";
import { sortedReplacer } from "./helpers.ts";
import { cmdStoreDevice, STORE_DEVICE_USAGE } from "./store-device.ts";
import { cmdStorePartition, STORE_PARTITION_USAGE } from "./store-partition.ts";
import { cmdStorePath, STORE_PATH_USAGE } from "./store-path.ts";
import { cmdStoreShard, STORE_SHARD_USAGE } from "./store-shard.ts";

const INIT_USAGE =
  "usage: o2b store init [--partitions shared|shared,private] [--config <file>] [--json]";
const USAGE = `${INIT_USAGE}\n${STORE_PATH_USAGE}\n${STORE_DEVICE_USAGE}\n${STORE_PARTITION_USAGE}\n${STORE_SHARD_USAGE}`;

/** `refused` is an answer (the store exists, or is partial), not a broken argv. */
const STORE_EXIT = Object.freeze({ ok: 0, refused: 1, usage: 2 } as const);

export async function handleStoreSubcommand(argv: ReadonlyArray<string>): Promise<number> {
  const verb = argv[0];
  if (verb === undefined || verb === "-h" || verb === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return verb === undefined ? STORE_EXIT.usage : STORE_EXIT.ok;
  }
  const rest = argv.slice(1);
  switch (verb) {
    case "init":
      return cmdStoreInit(rest);
    case "path":
      return cmdStorePath(rest);
    case "device":
      return cmdStoreDevice(rest);
    case "partition":
      return cmdStorePartition(rest);
    case "shard":
      return cmdStoreShard(rest);
    default:
      process.stderr.write(`error: unknown store verb: ${verb}\n${USAGE}\n`);
      return STORE_EXIT.usage;
  }
}

function parsePartitions(value: string | undefined): StorePartition[] {
  if (value === undefined) return [...STORE_PARTITIONS];
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const known = new Set<string>(STORE_PARTITIONS);
  const unknown = names.filter((name) => !known.has(name));
  if (names.length === 0 || unknown.length > 0) {
    throw new CliError(
      `--partitions takes a comma-separated list of ${STORE_PARTITIONS.join(", ")}` +
        (unknown.length > 0 ? `; unknown: ${unknown.join(", ")}` : ""),
    );
  }
  return names as StorePartition[];
}

function renderResult(result: InitStoreResult): string {
  const verb = result.status === "created" ? "Created" : "Completed";
  return (
    `${verb} the brain store at ${result.root}\n` +
    `  store id:   ${result.storeId}\n` +
    `  partitions: ${result.partitions.join(", ")}` +
    (result.status === "completed" ? ` (added: ${result.created.join(", ") || "none"})` : "") +
    "\nSync each partition folder as its own sync folder; never sync the store root.\n"
  );
}

function cmdStoreInit(argv: ReadonlyArray<string>): number {
  let partitions: StorePartition[];
  let configPath: string | undefined;
  let json: boolean;
  try {
    const { flags, positional } = parseFlags(argv, {
      partitions: { type: "string" },
      config: { type: "string" },
      json: { type: "boolean" },
    });
    if (positional.length > 0) throw new CliError(`unexpected argument: ${positional[0]}`);
    partitions = parsePartitions(flags["partitions"] as string | undefined);
    configPath = flags["config"] as string | undefined;
    json = flags["json"] === true;
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    // A flag parse can fail before `--json` is read: look for it in argv.
    if (argv.includes("--json")) writeJsonFailure("usage", err.message);
    process.stderr.write(`error: ${err.message}\n${INIT_USAGE}\n`);
    return STORE_EXIT.usage;
  }

  try {
    const { root } = resolveConfiguredStoreRoot(configPath);
    const result = initStore({ root, partitions });
    // The role is taken by the run that brings the shared partition here:
    // the first run, or a re-run that completes a half-made store. The
    // claim is a no-op once a writer is known.
    const viewWriter =
      result.status === "created" || result.created.includes("shared")
        ? claimOnCreate(root, result.partitions, configPath)
        : null;
    const freshSwitch = recordFreshSwitch(configPath);
    const lines = [renderResult(result)];
    if (viewWriter !== null) lines.push(`${viewWriter.message}\n`);
    if (freshSwitch.warning !== null) process.stderr.write(`warning: ${freshSwitch.warning}\n`);
    process.stdout.write(
      json
        ? `${JSON.stringify(
            { ok: true, ...result, viewWriter, fresh_switch: freshSwitch.outcome },
            sortedReplacer,
            2,
          )}\n`
        : lines.join(""),
    );
    return STORE_EXIT.ok;
  } catch (err) {
    if (!(err instanceof Error) || !isInitFailure(err)) throw err;
    if (json) writeJsonFailure(err instanceof StoreInitRefusal ? err.reason : "error", err.message);
    process.stderr.write(`error: ${err.message}\n`);
    return STORE_EXIT.refused;
  }
}

/**
 * A fresh install (no legacy `Brain/` tree) records this device's switch
 * once its store exists (design D14 item 1); a machine with a legacy tree
 * switches through the migration instead. Never fails the init.
 */
function recordFreshSwitch(configPath: string | undefined): {
  outcome: FreshSwitchOutcome | "error";
  warning: string | null;
} {
  let outcome: FreshSwitchOutcome;
  try {
    outcome = recordFreshInstallSwitch({
      vault: resolveVault(configPath),
      ...(configPath !== undefined ? { configPath } : {}),
    });
  } catch (err) {
    // An unreadable config or store, or a failed append: the init stands,
    // and the operator is told the machine is not durably switched.
    // Anything else is a defect and propagates.
    // A shared partition that went away after it was inspected is one of
    // them too, as for the view writer claim.
    if (
      !(err instanceof Error) ||
      !(isInitFailure(err) || err instanceof PartitionUnavailableError)
    ) {
      throw err;
    }
    return {
      outcome: "error",
      warning: `this device's switch to the store was not recorded: ${err.message}`,
    };
  }
  let warning: string | null = null;
  if (outcome === "no-device") {
    warning =
      "this machine has no device id, so its switch to the store was not recorded; " +
      "set device_id in the machine config and run `o2b store init` again";
  } else if (outcome === "no-store") {
    warning =
      "this machine holds no shared partition, so its switch to the store was not recorded; " +
      "run `o2b store init` again once it holds one";
  }
  return { outcome, warning };
}

/**
 * The machine that creates the store becomes the view writer (design D7).
 * A machine without a usable device id cannot write records; it says how
 * to take the role later instead of failing the init that succeeded.
 */
function claimOnCreate(
  root: string,
  partitions: ReadonlyArray<StorePartition>,
  configPath: string | undefined,
): { claimed: boolean; device: string | null; message: string } {
  // The claim is a settings record, and settings live in `shared`.
  if (!partitions.includes("shared")) {
    return {
      claimed: false,
      device: null,
      message:
        "This machine does not hold the shared partition, so it did not take the view writer " +
        "role; run `o2b view writer --here` on a machine that holds it.",
    };
  }
  let device: string | null = null;
  try {
    device = resolveDeviceId(configPath);
    const store = openStore({ root, device });
    const claim = claimViewWriter(store, { agent: resolveAgentName(configPath) });
    return claim.claimed
      ? { claimed: true, device, message: `This machine (${device}) renders the human view.` }
      : { claimed: false, device, message: `The human view is rendered by ${claim.writer}.` };
  } catch (err) {
    if (err instanceof StoreOpenError) {
      return {
        claimed: false,
        device: null,
        message:
          "This machine has no device id, so it did not take the view writer role; set device_id " +
          "and run `o2b view writer --here` on the machine that should render the human view.",
      };
    }
    // The store was created; a failed claim never turns that into a refusal.
    if (
      !(err instanceof Error) ||
      !(isInitFailure(err) || err instanceof PartitionUnavailableError)
    ) {
      throw err;
    }
    return {
      claimed: false,
      device,
      message: `The view writer role was not taken (${err.message}); run \`o2b view writer --here\`.`,
    };
  }
}

/**
 * Failures init reports as an answer rather than a crash: its refusals, a
 * store root it cannot use, an unreadable machine config, and a filesystem
 * error (`EACCES`, `EROFS`, `ENOSPC`, ...) on the store root.
 */
function isInitFailure(err: Error): boolean {
  return (
    err instanceof StoreInitRefusal ||
    err instanceof StoreOpenError ||
    err instanceof StoreRootInsideVaultError ||
    err instanceof ConfigReadError ||
    isFilesystemError(err)
  );
}

/**
 * A system call's error code. Node's own argument errors (`ERR_INVALID_ARG_TYPE`
 * and the rest of the `ERR_` family) carry a string code too, but they are
 * programming errors, and they crash with their stack instead.
 */
function isFilesystemError(err: Error): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "string" && !code.startsWith("ERR_");
}

function writeJsonFailure(reason: string, message: string): void {
  process.stdout.write(
    `${JSON.stringify({ ok: false, reason, error: message }, sortedReplacer, 2)}\n`,
  );
}
