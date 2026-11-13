/**
 * `o2b store partition leave` (design D7 item 5 of change `store-hardening`):
 * take a partition off this machine on purpose, once its folder no longer
 * carries the store identity file. The work lives in
 * `core/store/partition-leave.ts`; this file parses flags and renders.
 *
 * Exit codes: 0 for an answer (left, or nothing to leave), 1 for a refusal
 * (`shared`, `still-held`, `files-left`, `no-store-id`, `clear-failed`,
 * `store-root-in-vault`, `config`), 2 for a broken argv. Under `--json`
 * every refusal and usage error is a `{ ok: false, reason, error }` answer
 * on stdout.
 */

import { ConfigReadError } from "../core/config.ts";
import { join } from "node:path";
import {
  leavePartition,
  PartitionLeaveRefusal,
  type LeavePartitionResult,
} from "../core/store/partition-leave.ts";
import {
  STORE_IDENTITY_FILE,
  STORE_PARTITIONS,
  type StorePartition,
} from "../core/store/constants.ts";
import {
  partitionDir,
  resolveConfiguredStoreRoot,
  StoreRootInsideVaultError,
} from "../core/store/store-paths.ts";
import { CliError, parseFlags } from "./argparse.ts";
import { sortedReplacer } from "./helpers.ts";

export const STORE_PARTITION_USAGE =
  "usage: o2b store partition leave <partition> [--force] [--config <file>] [--json]";

const EXIT = Object.freeze({ ok: 0, refused: 1, usage: 2 } as const);

export function cmdStorePartition(argv: ReadonlyArray<string>): number {
  const verb = argv[0];
  if (verb === "-h" || verb === "--help") {
    process.stdout.write(`${STORE_PARTITION_USAGE}\n`);
    return EXIT.ok;
  }
  if (verb === "leave") return cmdLeave(argv.slice(1));
  const message =
    verb === undefined ? "missing store partition verb" : `unknown store partition verb: ${verb}`;
  return usage(argv, message);
}

/** A usage error: the usage on stderr, and the JSON failure on stdout under `--json`. */
function usage(argv: ReadonlyArray<string>, message: string): number {
  if (argv.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, reason: "usage", error: message }, sortedReplacer, 2)}\n`,
    );
  }
  process.stderr.write(`error: ${message}\n${STORE_PARTITION_USAGE}\n`);
  return EXIT.usage;
}

/** A refusal: the message on stderr and, under `--json`, the failure on stdout. */
function refuse(err: Error, reason: string, json: boolean): number {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, reason, error: err.message }, sortedReplacer, 2)}\n`,
    );
  }
  process.stderr.write(`error: ${err.message}\n`);
  return EXIT.refused;
}

/** Parse leave's flags; a `CliError` is a usage error with the usage text. */
function parse(
  argv: ReadonlyArray<string>,
): { flags: Record<string, unknown>; positional: string[] } | number {
  try {
    const { flags, positional } = parseFlags(argv, {
      force: { type: "boolean" },
      config: { type: "string" },
      json: { type: "boolean" },
    });
    return { flags, positional };
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    return usage(argv, err.message);
  }
}

/** The text answer of a leave: what was cleared, or that there is nothing to leave. */
function renderText(result: LeavePartitionResult, root: string): string {
  const cleared = result.cleared;
  const identityPath = join(partitionDir(root, result.partition), STORE_IDENTITY_FILE);
  if (result.left) {
    return (
      `Left the ${result.partition} partition of the brain store at ${root} on this machine.\n` +
      `  cleared: held marker, ${cleared.seenShards} seen shard entr` +
      `${cleared.seenShards === 1 ? "y" : "ies"}, ` +
      `${cleared.digestCaches ? "digest caches" : "no digest cache"}\n` +
      `The search index drops the ${result.partition} partition's records on its next catch-up. ` +
      `If ${identityPath} returns, by sync or a restore, this ` +
      `machine holds the ${result.partition} partition again from its next store write.\n`
    );
  }
  return (
    `This machine does not hold the ${result.partition} partition of the brain store at ${root}; ` +
    `nothing to leave. If ${identityPath} arrives, by sync or a ` +
    `restore, this machine holds the ${result.partition} partition again from its next store ` +
    "write.\n"
  );
}

function cmdLeave(argv: ReadonlyArray<string>): number {
  const parsed = parse(argv);
  if (typeof parsed === "number") return parsed;
  const json = parsed.flags["json"] === true;
  if (parsed.positional.length === 0) {
    return usage(argv, "name the partition to leave (shared or private)");
  }
  if (parsed.positional.length > 1) {
    return usage(argv, `unexpected argument: ${parsed.positional[1]}`);
  }
  const partition = parsed.positional[0]!;
  if (!(STORE_PARTITIONS as ReadonlyArray<string>).includes(partition)) {
    return usage(argv, `unknown partition: ${partition}`);
  }
  const configPath = parsed.flags["config"] as string | undefined;
  try {
    const { root } = resolveConfiguredStoreRoot(configPath);
    const result = leavePartition({
      root,
      partition: partition as StorePartition,
      ...(parsed.flags["force"] === true ? { force: true } : {}),
    });
    process.stdout.write(
      json
        ? `${JSON.stringify(
            {
              ok: true,
              left: result.left,
              partition: result.partition,
              root,
              cleared: {
                held_marker: result.cleared.heldMarker,
                seen_shards: result.cleared.seenShards,
                digest_caches: result.cleared.digestCaches,
              },
            },
            sortedReplacer,
            2,
          )}\n`
        : renderText(result, root),
    );
    return EXIT.ok;
  } catch (err) {
    if (err instanceof PartitionLeaveRefusal) return refuse(err, err.reason, json);
    if (err instanceof StoreRootInsideVaultError) return refuse(err, "store-root-in-vault", json);
    if (err instanceof ConfigReadError) return refuse(err, "config", json);
    throw err;
  }
}
