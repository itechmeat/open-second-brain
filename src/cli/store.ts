/**
 * `o2b store` - verbs on the brain store, the append-only folder outside
 * the vault that Open Second Brain is moving its machine data into.
 *
 * Only `init` exists today. It is the one way a store is created: writers
 * and the index never create one. Run it once on the first machine; every
 * other machine receives the partitions through sync, and a re-run
 * completes a store whose creation stopped half way. The work itself lives
 * in `core/store/store-init.ts`; this file parses flags and renders.
 */

import { ConfigReadError } from "../core/config.ts";
import { STORE_PARTITIONS, type StorePartition } from "../core/store/constants.ts";
import { initStore, StoreInitRefusal, type InitStoreResult } from "../core/store/store-init.ts";
import { StoreOpenError } from "../core/store/store-open.ts";
import {
  resolveConfiguredStoreRoot,
  StoreRootInsideVaultError,
} from "../core/store/store-paths.ts";
import { CliError, parseFlags } from "./argparse.ts";
import { sortedReplacer } from "./helpers.ts";

const USAGE =
  "usage: o2b store init [--partitions shared|shared,private] [--config <file>] [--json]";

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
    process.stderr.write(`error: ${err.message}\n${USAGE}\n`);
    return STORE_EXIT.usage;
  }

  try {
    const { root } = resolveConfiguredStoreRoot(configPath);
    const result = initStore({ root, partitions });
    process.stdout.write(
      json
        ? `${JSON.stringify({ ok: true, ...result }, sortedReplacer, 2)}\n`
        : renderResult(result),
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
