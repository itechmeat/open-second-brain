/**
 * The device-local memory of verified shard prefixes: for a process that
 * opts in ({@link trustVerifiedPrefixes}), a shard read from its start
 * skips the envelope check (the checksum over the canonical JSON of every
 * record, most of the cost of a read) for the lines it verified before,
 * as long as those bytes are unchanged.
 *
 * What is remembered, per shard: the length of a prefix whose every line
 * verified (a read with no diagnostic), the sha256 of those bytes, and the
 * file's stamp (device, inode, size, times) when they were read. A later
 * read trusts the prefix when
 *
 *  - the stamp still vouches for the file (same inode, size and times,
 *    observed outside the racy window, `fs-stamp.ts`), or
 *  - the file is at least as long and its first bytes hash to the
 *    remembered sha256 (an append: only the new tail is verified).
 *
 * Anything else (a shorter file, a changed byte in the prefix, a newer
 * build) reads the shard whole and verifies every line, as without the
 * memory. A trusted line is still parsed, its device still checked
 * against the shard's, and a blob body still read and checked: only the
 * envelope check of unchanged bytes is skipped.
 *
 * Only the hooks opt in (`active-inject`, `view-render`): they must answer
 * inside the host's time limit on a large store. No command does, so
 * `o2b doctor` and every other command find a record that fails
 * verification exactly as before.
 *
 * The memory is device-local state (the store's directory under the
 * state base, keyed by the store root as the seen-shards ledger is),
 * never in the synced store. It is written by atomic rename, merged with
 * what is on disk at the time, so two sessions writing at once lose at
 * most each other's newest entries; a lost, stale or unreadable file only
 * costs a full read.
 */

import { createHash, type Hash } from "node:crypto";
import { type BigIntStats, fstatSync, mkdirSync, readFileSync, readSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import { atomicWriteText } from "../fs-atomic.ts";
import { sameDevIno } from "../fs-identity.ts";
import { stampVouches } from "../fs-stamp.ts";
import { processDirsEnv } from "../platform-dirs.ts";
import { OPEN_SECOND_BRAIN_VERSION } from "../version.ts";
import { STORE_FORMAT_VERSION, STORE_PARTITIONS, type StorePartition } from "./constants.ts";
import { readStoreId } from "./store-open.ts";
import { deviceStateDirFor } from "./store-paths.ts";

/** File name of the memory, before the store-root key. */
const MEMORY_FILE = "verified-prefixes";

/**
 * What the remembered checks were made by: a build that verifies by other
 * rules (a new release, a new format) checks every line again.
 */
const VERIFIER = `${OPEN_SECOND_BRAIN_VERSION}/${STORE_FORMAT_VERSION}`;

const HASH_CHUNK_BYTES = 1 << 20;

interface PrefixEntry {
  /** Bytes from the shard's start whose every line verified. */
  readonly size: number;
  /** sha256 of those bytes. */
  readonly sha256: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  /** Wall-clock time (ms) taken before the read that verified the bytes. */
  readonly readAtMs: number;
}

interface Memory {
  readonly path: string;
  readonly entries: Map<string, PrefixEntry>;
  /** Keys this process changed (set or dropped) since its last flush. */
  readonly touched: Set<string>;
}

let trusting = false;
let exitHook = false;
const memories = new Map<string, Memory>();
/** Memory file of each partition root, `null` for one outside a store. */
const memoryFileOf = new Map<string, { file: string; partition: StorePartition } | null>();

const stats = { trustedLines: 0, verifiedLines: 0, prefixHashes: 0, remembered: 0 };

/**
 * Counters since the process started: lines whose envelope check was
 * skipped, lines checked in a trusting read, prefix hashes taken to prove
 * an unchanged prefix, entries remembered.
 */
export function verifiedPrefixStats(): {
  readonly trustedLines: number;
  readonly verifiedLines: number;
  readonly prefixHashes: number;
  readonly remembered: number;
} {
  return { ...stats };
}

/**
 * Let the shard reads of this process trust remembered verifications
 * (the hooks). The memory is written when the process exits, and by
 * {@link flushVerifiedPrefixes}.
 */
export function trustVerifiedPrefixes(): void {
  trusting = true;
  if (!exitHook) {
    exitHook = true;
    process.on("exit", () => flushVerifiedPrefixes());
  }
}

/** Whether this process trusts remembered verifications. */
export function trustsVerifiedPrefixes(): boolean {
  return trusting;
}

function isPartition(value: string): value is StorePartition {
  return (STORE_PARTITIONS as ReadonlyArray<string>).includes(value);
}

function locate(partitionRoot: string): { file: string; partition: StorePartition } | null {
  const known = memoryFileOf.get(partitionRoot);
  if (known !== undefined) return known;
  let found: { file: string; partition: StorePartition } | null = null;
  const partition = basename(partitionRoot);
  if (isPartition(partition)) {
    try {
      const storeId = readStoreId(partitionRoot);
      if (storeId !== null) {
        const storeRoot = resolve(dirname(partitionRoot));
        const rootKey = createHash("sha256").update(storeRoot).digest("hex").slice(0, 16);
        const dir = deviceStateDirFor(storeId, processDirsEnv());
        found = { file: join(dir, `${MEMORY_FILE}-${rootKey}.json`), partition };
      }
    } catch {
      found = null;
    }
  }
  memoryFileOf.set(partitionRoot, found);
  return found;
}

function parseEntries(text: string): Map<string, PrefixEntry> {
  const out = new Map<string, PrefixEntry>();
  const parsed = JSON.parse(text) as { verifier?: unknown; shards?: Record<string, unknown> };
  if (parsed.verifier !== VERIFIER || typeof parsed.shards !== "object" || parsed.shards === null) {
    return out;
  }
  for (const [key, raw] of Object.entries(parsed.shards)) {
    const e = raw as Record<string, unknown>;
    if (
      typeof e["size"] !== "number" ||
      !Number.isSafeInteger(e["size"]) ||
      e["size"] < 0 ||
      typeof e["sha256"] !== "string" ||
      !/^[0-9a-f]{64}$/.test(e["sha256"]) ||
      typeof e["readAtMs"] !== "number"
    ) {
      continue;
    }
    try {
      out.set(key, {
        size: e["size"],
        sha256: e["sha256"],
        dev: BigInt(e["dev"] as string),
        ino: BigInt(e["ino"] as string),
        mtimeNs: BigInt(e["mtimeNs"] as string),
        ctimeNs: BigInt(e["ctimeNs"] as string),
        readAtMs: e["readAtMs"],
      });
    } catch {
      // An entry that does not parse is not trusted; the shard is read whole.
    }
  }
  return out;
}

function readEntries(file: string): Map<string, PrefixEntry> {
  try {
    return parseEntries(readFileSync(file, "utf8"));
  } catch {
    return new Map();
  }
}

function memoryFor(file: string): Memory {
  let memory = memories.get(file);
  if (memory === undefined) {
    memory = { path: file, entries: readEntries(file), touched: new Set() };
    memories.set(file, memory);
  }
  return memory;
}

function serialise(entries: ReadonlyMap<string, PrefixEntry>): string {
  const shards: Record<string, unknown> = {};
  for (const key of [...entries.keys()].toSorted()) {
    const e = entries.get(key)!;
    shards[key] = {
      size: e.size,
      sha256: e.sha256,
      dev: String(e.dev),
      ino: String(e.ino),
      mtimeNs: String(e.mtimeNs),
      ctimeNs: String(e.ctimeNs),
      readAtMs: e.readAtMs,
    };
  }
  return `${JSON.stringify({ version: 1, verifier: VERIFIER, shards })}\n`;
}

/**
 * Write what this process learned: its changed entries over what the file
 * holds now (another session may have written since this one read it),
 * by atomic rename. Never throws; a write that fails only costs time.
 */
export function flushVerifiedPrefixes(): void {
  for (const memory of memories.values()) {
    if (memory.touched.size === 0) continue;
    try {
      const merged = readEntries(memory.path);
      for (const key of memory.touched) {
        const mine = memory.entries.get(key);
        if (mine === undefined) merged.delete(key);
        else merged.set(key, mine);
      }
      mkdirSync(dirname(memory.path), { recursive: true });
      atomicWriteText(memory.path, serialise(merged));
      memory.touched.clear();
    } catch {
      // Best-effort: a memory that cannot be written is rebuilt by a later read.
    }
  }
}

/** Forget the loaded memories and the counters (tests that stand for a new process). */
export function resetVerifiedPrefixesForTests(): void {
  trusting = false;
  memories.clear();
  memoryFileOf.clear();
  stats.trustedLines = 0;
  stats.verifiedLines = 0;
  stats.prefixHashes = 0;
  stats.remembered = 0;
}

function hashOfPrefix(fd: number, size: number): string | null {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(Math.min(HASH_CHUNK_BYTES, Math.max(size, 1)));
  let position = 0;
  while (position < size) {
    const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
    if (n === 0) return null;
    hash.update(chunk.subarray(0, n));
    position += n;
  }
  return hash.digest("hex");
}

/** A trusting read of one shard: what it may skip and what it must hash to remember. */
export interface PrefixTrust {
  /** A line that ends at or before this byte skips the envelope check. */
  readonly trustedUntil: number;
  /**
   * The hash the read feeds every byte it reads, from the start, to
   * remember the shard's new prefix; `null` when the remembered entry
   * still stands as it is.
   */
  readonly hash: Hash | null;
  /** Counts one line: skipped (trusted) or checked. */
  count(trusted: boolean): void;
  /**
   * After the read: remember the shard as verified up to `nextOffset`
   * when the read was clean (no diagnostic, nothing held back) and the
   * file did not change while it was read; forget it when the read was
   * not clean.
   */
  finish(read: {
    readonly clean: boolean;
    readonly nextOffset: number;
    readonly size: number;
  }): void;
}

/**
 * The trust a read of the shard open at `fd` from its start may place in
 * the memory; `null` when this process does not trust (or the shard is
 * outside a store). Never throws.
 */
export function prefixTrustFor(
  fd: number,
  path: string,
  partitionRoot: string,
): PrefixTrust | null {
  if (!trusting) return null;
  let located: { file: string; partition: StorePartition } | null;
  let before: BigIntStats;
  // Before the stat and the read, as the racy-window rule asks (`fs-stamp.ts`).
  const readAtMs = Date.now();
  try {
    located = locate(partitionRoot);
    if (located === null) return null;
    before = fstatSync(fd, { bigint: true });
  } catch {
    return null;
  }
  const memory = memoryFor(located.file);
  const key = `${located.partition}/${relative(partitionRoot, path).split("\\").join("/")}`;
  const entry = memory.entries.get(key);
  const size = Number(before.size);
  let trustedUntil = 0;
  let stands = false;
  if (entry !== undefined && size >= entry.size) {
    if (
      size === entry.size &&
      stampVouches(
        {
          dev: entry.dev,
          ino: entry.ino,
          size: BigInt(entry.size),
          mtimeNs: entry.mtimeNs,
          ctimeNs: entry.ctimeNs,
          readAtMs: entry.readAtMs,
        },
        before,
      )
    ) {
      trustedUntil = entry.size;
      stands = true;
    } else {
      stats.prefixHashes += 1;
      let sum: string | null = null;
      try {
        sum = hashOfPrefix(fd, entry.size);
      } catch {
        sum = null;
      }
      if (sum === entry.sha256) trustedUntil = entry.size;
    }
  }
  const hash = stands ? null : createHash("sha256");
  return {
    trustedUntil,
    hash,
    count(trusted) {
      if (trusted) stats.trustedLines += 1;
      else stats.verifiedLines += 1;
    },
    finish(read) {
      if (!read.clean) {
        if (entry !== undefined) {
          memory.entries.delete(key);
          memory.touched.add(key);
        }
        return;
      }
      if (hash === null || read.nextOffset !== read.size) return;
      let after: BigIntStats;
      try {
        after = fstatSync(fd, { bigint: true });
      } catch {
        return;
      }
      if (
        !sameDevIno(before, after) ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        Number(after.size) !== read.size
      ) {
        return;
      }
      memory.entries.set(key, {
        size: read.size,
        sha256: hash.digest("hex"),
        dev: after.dev,
        ino: after.ino,
        mtimeNs: after.mtimeNs,
        ctimeNs: after.ctimeNs,
        readAtMs,
      });
      memory.touched.add(key);
      stats.remembered += 1;
    },
  };
}
