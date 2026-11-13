/**
 * `o2b store shard quarantine|list|release` (change store-hardening,
 * design D6; spec `store-shard-gaps`): record on this machine that one bad
 * line of a held shard is skipped, list what is recorded, and release an
 * entry. The ledger lives in `core/store/shard-quarantine.ts`; this file
 * checks the line, parses flags and renders. The store is only inspected
 * (`inspectStore`), and the device id is read without minting
 * (`readDeviceId`).
 *
 * A line is quarantined only when it is a gap of the shard right now: a
 * corrupt line in the middle, or a record whose body blob has not arrived
 * for seven days (`PENDING_BLOB_QUARANTINE_AGE_MS`) in a shard other than
 * `settings`. Never a newer-format
 * line (upgrading reads it), never the last line of a shard of this
 * machine's own device (its writer may still be appending).
 *
 * Exit codes: 0 for an answer (`quarantined`, `already`, a list,
 * `released`, `not-quarantined`), 1 for a refusal (`no-store`,
 * `partition-lost`, `store-open-error`, `store-root-in-vault`, `config`,
 * `not-held`, `unknown-shard`, `no-gap`, `newer-format`, `blob-too-young`,
 * `settings-blob`, `blob-clock-unreadable`, `own-tail`, `line-too-long`,
 * `shard-changed`, `shard-unreadable`, `ledger-unreadable`, `ledger-busy`),
 * 2 for a broken argv.
 * `line-too-long` (the line runs past the hash cap) is permanent until the
 * shard's bytes change; `shard-changed` (the line's bytes differ, or could
 * not be read, between the hashes taken before and after it is judged, or
 * the shard was removed after it was listed) is transient, and running the
 * command again checks it once more. `shard-unreadable` (the shard or its
 * stream folder is there and cannot be read) stays until the operator makes
 * it readable. `ledger-busy` (another process held the
 * ledger's device-local lock past the wait budget) is transient too: run
 * the command again. Under `--json` every refusal and usage error is a
 * `{ ok: false, reason, error }` answer on stdout.
 */

import { ConfigReadError, readDeviceId } from "../core/config.ts";
import {
  LEDGER_STREAM,
  STORE_PARTITIONS,
  STORE_STREAMS,
  type StorePartition,
  type StoreStream,
} from "../core/store/constants.ts";
import { readShard } from "../core/store/reader.ts";
import { listShards, type ShardEntry } from "../core/store/shard-list.ts";
import {
  addQuarantine,
  QuarantineLedgerUnreadableError,
  releaseQuarantine,
} from "../core/store/shard-quarantine-write.ts";
import {
  listQuarantine,
  probeLineHashAt,
  QUARANTINE_HASH_CAP_BYTES,
  PENDING_BLOB_QUARANTINE_AGE_MS,
  PENDING_BLOB_QUARANTINE_AGE_TEXT,
  pendingRecordWrittenMs,
  type QuarantineKind,
} from "../core/store/shard-quarantine.ts";
import {
  HeldPartitionLostError,
  inspectStore,
  NoStoreError,
  StoreOpenError,
  type StoreInspection,
} from "../core/store/store-open.ts";
import {
  partitionDir,
  resolveConfiguredStoreRoot,
  StoreRootInsideVaultError,
} from "../core/store/store-paths.ts";
import { CliError, parseFlags } from "./argparse.ts";
import { sortedReplacer } from "./helpers.ts";

const QUARANTINE_USAGE =
  "usage: o2b store shard quarantine <partition>/<shard> --offset <n> [--config <file>] [--json]";
const LIST_USAGE = "usage: o2b store shard list [--config <file>] [--json]";
const RELEASE_USAGE =
  "usage: o2b store shard release <partition>/<shard> --offset <n> [--config <file>] [--json]";
export const STORE_SHARD_USAGE = `${QUARANTINE_USAGE}\n${LIST_USAGE}\n${RELEASE_USAGE}`;

const EXIT = Object.freeze({ ok: 0, refused: 1, usage: 2 } as const);

type RefusalReason =
  | "not-held"
  | "unknown-shard"
  | "no-gap"
  | "newer-format"
  | "blob-too-young"
  | "settings-blob"
  | "blob-clock-unreadable"
  | "own-tail"
  | "line-too-long"
  | "shard-changed"
  | "shard-unreadable"
  | "ledger-busy";

/** A refusal of this verb itself, with its JSON reason. */
class ShardVerbRefusal extends Error {
  constructor(
    readonly reason: RefusalReason,
    message: string,
  ) {
    super(message);
    this.name = "ShardVerbRefusal";
  }
}

export function cmdStoreShard(argv: ReadonlyArray<string>): number {
  const verb = argv[0];
  if (verb === "-h" || verb === "--help") {
    process.stdout.write(`${STORE_SHARD_USAGE}\n`);
    return EXIT.ok;
  }
  if (verb === "quarantine") return cmdQuarantine(argv.slice(1));
  if (verb === "list") return cmdList(argv.slice(1));
  if (verb === "release") return cmdRelease(argv.slice(1));
  return usage(
    argv,
    verb === undefined ? "missing store shard verb" : `unknown store shard verb: ${verb}`,
    STORE_SHARD_USAGE,
  );
}

function isRefusal(err: unknown): err is Error {
  return (
    err instanceof ShardVerbRefusal ||
    err instanceof QuarantineLedgerUnreadableError ||
    err instanceof StoreOpenError ||
    err instanceof StoreRootInsideVaultError ||
    err instanceof ConfigReadError
  );
}

/** The JSON reason of a refusal: one per error class, so a caller can act on it. */
function reasonOf(err: Error): string {
  if (err instanceof ShardVerbRefusal) return err.reason;
  if (err instanceof QuarantineLedgerUnreadableError) return "ledger-unreadable";
  if (err instanceof NoStoreError) return "no-store";
  if (err instanceof HeldPartitionLostError) return "partition-lost";
  if (err instanceof StoreOpenError) return "store-open-error";
  if (err instanceof StoreRootInsideVaultError) return "store-root-in-vault";
  return "config";
}

function refuse(err: Error, json: boolean): number {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, reason: reasonOf(err), error: err.message }, sortedReplacer, 2)}\n`,
    );
  }
  process.stderr.write(`error: ${err.message}\n`);
  return EXIT.refused;
}

/** A usage error: the usage on stderr, and the JSON failure on stdout under `--json`. */
function usage(argv: ReadonlyArray<string>, message: string, text: string): number {
  if (argv.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, reason: "usage", error: message }, sortedReplacer, 2)}\n`,
    );
  }
  process.stderr.write(`error: ${message}\n${text}\n`);
  return EXIT.usage;
}

function answer(json: boolean, body: Record<string, unknown>, text: string): number {
  process.stdout.write(json ? `${JSON.stringify(body, sortedReplacer, 2)}\n` : text);
  return EXIT.ok;
}

/** The line a verb names: its partition, its partition-relative shard path, its offset. */
interface LineArg {
  readonly partition: StorePartition;
  readonly shard: string;
  readonly offset: number;
  readonly configPath: string | undefined;
  readonly json: boolean;
}

/** Parse `<partition>/<shard> --offset <n>`; a number is the usage error's exit code. */
function parseLine(argv: ReadonlyArray<string>, usageText: string): LineArg | number {
  let flags: Record<string, unknown>;
  let positional: string[];
  try {
    ({ flags, positional } = parseFlags(argv, {
      offset: { type: "string" },
      config: { type: "string" },
      json: { type: "boolean" },
    }));
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    return usage(argv, err.message, usageText);
  }
  if (positional.length === 0) {
    return usage(argv, "name the shard as <partition>/<shard>", usageText);
  }
  if (positional.length > 1) {
    return usage(argv, `unexpected argument: ${positional[1]}`, usageText);
  }
  const target = positional[0]!;
  const slash = target.indexOf("/");
  const partition = slash === -1 ? target : target.slice(0, slash);
  if (!(STORE_PARTITIONS as ReadonlyArray<string>).includes(partition)) {
    return usage(argv, `unknown partition: ${partition}`, usageText);
  }
  const shard = slash === -1 ? "" : target.slice(slash + 1);
  if (shard === "") return usage(argv, "name the shard as <partition>/<shard>", usageText);
  const offsetText = flags["offset"];
  if (typeof offsetText !== "string") return usage(argv, "--offset <n> is required", usageText);
  const offset = /^\d+$/.test(offsetText) ? Number(offsetText) : Number.NaN;
  if (!Number.isSafeInteger(offset)) {
    return usage(argv, `--offset takes a byte offset, got ${offsetText}`, usageText);
  }
  return {
    partition: partition as StorePartition,
    shard,
    offset,
    configPath: flags["config"] as string | undefined,
    json: flags["json"] === true,
  };
}

/** The store this machine reads, inspected only. */
function storeHere(configPath: string | undefined): StoreInspection {
  const { root } = resolveConfiguredStoreRoot(configPath);
  const store = inspectStore(root);
  if (store === null) throw new NoStoreError(root);
  return store;
}

/** The listed shard `rel` of `partition`, matched against the store's own listing. */
function findShard(store: StoreInspection, partition: StorePartition, rel: string): ShardEntry {
  const unknown = new ShardVerbRefusal(
    "unknown-shard",
    `the ${partition} partition of the brain store at ${store.root} holds no shard ${rel}`,
  );
  const segments = rel.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) throw unknown;
  const stream = segments[0]!;
  if (!(STORE_STREAMS as ReadonlyArray<string>).includes(stream)) throw unknown;
  if (segments.length !== (stream === LEDGER_STREAM ? 4 : 3)) throw unknown;
  const ref =
    segments.length === 3
      ? { stream: stream as StoreStream }
      : { stream: stream as StoreStream, ledger: segments[1]! };
  let shards: ShardEntry[];
  try {
    shards = listShards(partitionDir(store.root, partition), ref);
  } catch (err) {
    // A stream folder that is not there lists no shard; one that is there
    // and cannot be listed is not a proof that the shard is absent.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw unknown;
    throw unreadableShard(`${partition}/${rel}`, err);
  }
  const found = shards.find((s) => s.rel === rel);
  if (found === undefined) throw unknown;
  return found;
}

/** The refusal for a shard, or its stream folder, that is there and cannot be read. */
function unreadableShard(named: string, err: unknown): ShardVerbRefusal {
  return new ShardVerbRefusal(
    "shard-unreadable",
    `the shard ${named} cannot be read (${err instanceof Error ? err.message : String(err)}); ` +
      "nothing was changed. Make it readable for this account, then run the command again",
  );
}

/**
 * Read the shard the listing named. A sync tool may remove or replace it
 * between the listing and this read; the reader then throws `ENOENT`,
 * which is the same transient change the two line hashes guard against,
 * so it answers `shard-changed` rather than an unnamed error. Any other
 * read failure answers `shard-unreadable`.
 */
export function readListedShard(
  path: string,
  partitionRoot: string,
  named: string,
): ReturnType<typeof readShard> {
  try {
    return readShard(path, { partitionRoot });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw unreadableShard(named, err);
    throw new ShardVerbRefusal(
      "shard-changed",
      `the shard ${named} was removed after it was listed (a sync tool may be replacing it); ` +
        "run the command again",
    );
  }
}

/**
 * Run a change of the quarantine ledger. Its device-local lock is held
 * while another `o2b` process changes the ledger; when it stays held past
 * the wait budget, the lock answers `ELOCKED`, which is transient and
 * answers `ledger-busy` so a `--json` caller gets a named refusal.
 */
function underLedgerLock<T>(change: () => T): T {
  try {
    return change();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ELOCKED") throw err;
    throw new ShardVerbRefusal(
      "ledger-busy",
      "another o2b process on this machine holds the quarantine ledger's lock and did not " +
        `release it in time (${(err as Error).message}); run the command again`,
    );
  }
}

/** What the line at `offset` is: the kind to record and its reason, or a refusal. */
function gapAt(
  line: LineArg,
  entry: ShardEntry,
  store: StoreInspection,
): { kind: QuarantineKind; reason: string } {
  const partitionRoot = partitionDir(store.root, line.partition);
  const named = `${line.partition}/${line.shard}`;
  const read = readListedShard(entry.path, partitionRoot, named);
  const diagnostic = read.diagnostics.find(
    (d) =>
      d.offset === line.offset &&
      d.torn !== true &&
      (d.kind === "corrupt-line" || d.kind === "unknown-version"),
  );
  // A shard that is no regular file (a link, a folder) was not read at
  // all, so no line of it can be judged.
  const notRead = read.diagnostics.find((d) => d.kind === "not-a-file");
  if (notRead !== undefined) throw unreadableShard(named, new Error(notRead.reason));
  const pending = read.records.find((r) => r.offset === line.offset && r.bodyState === "pending");
  const ownTail = (): ShardVerbRefusal | null =>
    entry.device === readDeviceId(line.configPath ?? null)
      ? new ShardVerbRefusal(
          "own-tail",
          `the line at byte ${line.offset} is the last line of the shard ${named}, which this ` +
            "machine writes; its writer may still be appending, so it is not quarantined",
        )
      : null;
  // The reader holds back an unverified last line for a retry: it is no
  // diagnostic yet, but in this machine's own shard it is the tail its
  // writer may still be appending.
  if (
    diagnostic === undefined &&
    pending === undefined &&
    read.pendingTailBytes > 0 &&
    line.offset === read.nextOffset
  ) {
    const refusal = ownTail();
    if (refusal !== null) throw refusal;
  }
  if (diagnostic === undefined && pending === undefined) {
    throw new ShardVerbRefusal(
      "no-gap",
      `nothing at byte ${line.offset} of the shard ${named} is a gap; the doctor names each gap ` +
        "with its offset",
    );
  }
  if (diagnostic?.kind === "unknown-version") {
    throw new ShardVerbRefusal(
      "newer-format",
      `the record at byte ${line.offset} of the shard ${named} is of a newer format ` +
        `(${diagnostic.reason}); upgrade Open Second Brain on this machine to read it`,
    );
  }
  const last =
    read.pendingTailBytes === 0 &&
    !read.records.some((r) => r.offset > line.offset) &&
    !read.diagnostics.some((d) => d.offset > line.offset);
  if (last) {
    const refusal = ownTail();
    if (refusal !== null) throw refusal;
  }
  if (diagnostic !== undefined) return { kind: "corrupt-line", reason: diagnostic.reason };
  if (line.shard.split("/")[0] === "settings") {
    throw new ShardVerbRefusal(
      "settings-blob",
      `the settings record at byte ${line.offset} of the shard ${named} waits for its body ` +
        "blob; a settings record is never quarantined: deliver the blob from the machine that " +
        "wrote it",
    );
  }
  const written = pendingRecordWrittenMs(pending!.record.hlc);
  if (written === null) {
    throw new ShardVerbRefusal(
      "blob-clock-unreadable",
      `the record at byte ${line.offset} of the shard ${named} waits for a body blob, and its ` +
        "clock stamp does not parse as a time, so its age is unknown; it is never quarantined " +
        "by age: deliver the blob, or repair the record, from the machine that wrote it",
    );
  }
  if (Date.now() - written < PENDING_BLOB_QUARANTINE_AGE_MS) {
    throw new ShardVerbRefusal(
      "blob-too-young",
      `the record at byte ${line.offset} of the shard ${named} waits for a body blob written ` +
        `${new Date(written).toISOString()}; a sync tool may still deliver it, so it is not ` +
        `quarantined before it is ${PENDING_BLOB_QUARANTINE_AGE_TEXT} old`,
    );
  }
  return { kind: "blob-pending", reason: "its body blob has not arrived" };
}

function cmdQuarantine(argv: ReadonlyArray<string>): number {
  const line = parseLine(argv, QUARANTINE_USAGE);
  if (typeof line === "number") return line;
  const named = `${line.partition}/${line.shard}`;
  try {
    const store = storeHere(line.configPath);
    if (!store.partitions.has(line.partition)) {
      throw new ShardVerbRefusal(
        "not-held",
        `this machine does not hold the ${line.partition} partition of the brain store at ${store.root}`,
      );
    }
    const entry = findShard(store, line.partition, line.shard);
    const partitionRoot = partitionDir(store.root, line.partition);
    // Hashed before and after the line is judged: a sync tool may rewrite
    // the shard between the two, and the ledger must name the bytes judged.
    const before = probeLineHashAt(entry.path, line.offset, partitionRoot);
    const { kind, reason } = gapAt(line, entry, store);
    const after = probeLineHashAt(entry.path, line.offset, partitionRoot);
    if (
      "failure" in before &&
      "failure" in after &&
      before.failure === "too-long" &&
      after.failure === "too-long"
    ) {
      throw new ShardVerbRefusal(
        "line-too-long",
        `the line at byte ${line.offset} of the shard ${named} runs past ` +
          `${QUARANTINE_HASH_CAP_BYTES} bytes with no newline, the longest line a quarantine ` +
          "can name, so it cannot be quarantined and stays a gap. Repair the shard at its " +
          "source, or deliver a whole copy from the machine that wrote it",
      );
    }
    if (!("sha256" in before) || !("sha256" in after) || after.sha256 !== before.sha256) {
      throw new ShardVerbRefusal(
        "shard-changed",
        `the bytes at byte ${line.offset} of the shard ${named} changed, or could not be read ` +
          "through to their end, while they were checked (a sync tool may be writing the " +
          "shard); run the command again",
      );
    }
    const sha256 = after.sha256;
    const status = underLedgerLock(() =>
      addQuarantine(store.root, {
        partition: line.partition,
        shard: line.shard,
        offset: line.offset,
        sha256,
        kind,
        reason,
      }),
    );
    return answer(
      line.json,
      { ok: true, status, partition: line.partition, shard: line.shard, offset: line.offset, kind },
      status === "already"
        ? `The line at byte ${line.offset} of ${named} is already quarantined on this machine; nothing changed.\n`
        : `Quarantined the line at byte ${line.offset} of ${named} on this machine (${kind}). ` +
            "It is skipped here and stays in the file; no other machine is affected. If other " +
            "bytes come to stand at that offset, they are read again.\n",
    );
  } catch (err) {
    if (!isRefusal(err)) throw err;
    return refuse(err, line.json);
  }
}

function cmdList(argv: ReadonlyArray<string>): number {
  let flags: Record<string, unknown>;
  let positional: string[];
  try {
    ({ flags, positional } = parseFlags(argv, {
      config: { type: "string" },
      json: { type: "boolean" },
    }));
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    return usage(argv, err.message, LIST_USAGE);
  }
  if (positional.length > 0)
    return usage(argv, `unexpected argument: ${positional[0]}`, LIST_USAGE);
  const json = flags["json"] === true;
  try {
    const store = storeHere(flags["config"] as string | undefined);
    const lines = listQuarantine(store.root, readShard).map((l) => ({
      partition: l.partition,
      shard: l.shard,
      offset: l.offset,
      kind: l.kind,
      state: l.state,
      quarantined_at: l.quarantined_at,
    }));
    const text =
      lines.length === 0
        ? "No shard line is quarantined on this machine.\n"
        : lines
            .map(
              (l) =>
                `${l.partition}/${l.shard} at byte ${l.offset}: ${l.kind}, ${l.state}, ` +
                `since ${l.quarantined_at}\n`,
            )
            .join("");
    return answer(json, { ok: true, lines }, text);
  } catch (err) {
    if (!isRefusal(err)) throw err;
    return refuse(err, json);
  }
}

function cmdRelease(argv: ReadonlyArray<string>): number {
  const line = parseLine(argv, RELEASE_USAGE);
  if (typeof line === "number") return line;
  const named = `${line.partition}/${line.shard}`;
  try {
    const store = storeHere(line.configPath);
    const status = underLedgerLock(() =>
      releaseQuarantine(store.root, line.partition, line.shard, line.offset),
    );
    return answer(
      line.json,
      { ok: true, status, partition: line.partition, shard: line.shard, offset: line.offset },
      status === "released"
        ? `Released the line at byte ${line.offset} of ${named} on this machine: its mark is ` +
            "removed, and the line is a gap again only if it still is one (a body blob that " +
            "has arrived since leaves none).\n"
        : `Nothing was quarantined at byte ${line.offset} of ${named} on this machine; nothing changed.\n`,
    );
  } catch (err) {
    if (!isRefusal(err)) throw err;
    return refuse(err, line.json);
  }
}
