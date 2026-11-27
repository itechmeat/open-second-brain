/**
 * The device-local memory of verified shard prefixes
 * (`src/core/store/verified-prefixes.ts`): a process that opts in (the
 * hooks) skips the envelope check of the bytes it verified before and that
 * are unchanged; an append verifies only its tail; a truncation, a changed
 * byte in the verified prefix or an unreadable memory reads the shard whole;
 * a process that does not opt in (`o2b doctor`, every command) checks
 * every line whatever the memory says; two processes writing the memory at
 * once leave a memory that reads.
 */
import { afterEach, describe, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RACY_WINDOW_MS } from "../../../src/core/fs-stamp.ts";
import { appendRecords } from "../../../src/core/store/appender.ts";
import { readShard } from "../../../src/core/store/reader.ts";
import { readStreamRecords } from "../../../src/core/store/read/stream-read.ts";
import { openStore, readStoreId } from "../../../src/core/store/store-open.ts";
import { deviceStateDirFor, partitionDir } from "../../../src/core/store/store-paths.ts";
import {
  flushVerifiedPrefixes,
  resetVerifiedPrefixesForTests,
  trustVerifiedPrefixes,
  verifiedPrefixStats,
} from "../../../src/core/store/verified-prefixes.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { makeStoreEnv, type StoreEnv } from "./fixtures/store-env.ts";

// The concurrency case spawns processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const HERE = dirname(fileURLToPath(import.meta.url));
const READER = resolve(HERE, "fixtures", "verified-prefixes-reader.ts");

let env: StoreEnv | null = null;
afterEach(() => {
  setSystemTime();
  resetVerifiedPrefixesForTests();
  env?.cleanup();
  env = null;
});

function append(e: StoreEnv, from: number, count: number): string {
  const results = appendRecords(
    openStore({ root: e.storeRoot, device: "dev-a" }),
    Array.from({ length: count }, (_, i) => ({
      partition: "shared" as const,
      stream: "log" as const,
      kind: "log-event",
      agent: "t",
      body: {
        timestamp: "2026-11-20T09:00:00Z",
        event_type: "note",
        body: { text: `event ${from + i}` },
      },
    })),
  );
  return results[0]!.path;
}

const readLog = (e: StoreEnv) => readStreamRecords(e.storeRoot, "shared", { stream: "log" });

/**
 * A read in a fresh process that opts in: the memory comes from disk
 * only, and what the read learned is on disk when it returns.
 */
function trustingRead(e: StoreEnv) {
  resetVerifiedPrefixesForTests();
  trustVerifiedPrefixes();
  const read = readLog(e);
  const stats = verifiedPrefixStats();
  flushVerifiedPrefixes();
  resetVerifiedPrefixesForTests();
  return { read, stats };
}

function memoryFiles(e: StoreEnv): string[] {
  const storeId = readStoreId(partitionDir(e.storeRoot, "shared"))!;
  const dir = deviceStateDirFor(storeId);
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.startsWith("verified-prefixes-"))
        .map((name) => join(dir, name))
    : [];
}

/** One byte of the shard turned into another, same length. */
function changeByte(path: string, find: string, replace: string): void {
  const text = readFileSync(path, "utf8");
  expect(text.includes(find)).toBe(true);
  writeFileSync(path, text.replace(find, replace));
}

describe("verified prefixes", () => {
  test("a second process trusts the lines the first verified and checks none again", () => {
    env = makeStoreEnv("osb-verified-hit-", { legacyTree: false });
    append(env, 0, 20);
    const first = trustingRead(env);
    expect(first.stats).toMatchObject({ trustedLines: 0, verifiedLines: 20, remembered: 1 });
    expect(memoryFiles(env)).toHaveLength(1);
    const second = trustingRead(env);
    expect(second.stats).toMatchObject({ trustedLines: 20, verifiedLines: 0 });
    expect(second.read.records.map((r) => r.id)).toEqual(first.read.records.map((r) => r.id));
    expect(second.read.unreadable).toEqual([]);
  });

  test("a settled stamp vouches for the shard without hashing it", () => {
    env = makeStoreEnv("osb-verified-stamp-", { legacyTree: false });
    append(env, 0, 5);
    setSystemTime(new Date(Date.now() + RACY_WINDOW_MS + 1_000));
    trustingRead(env);
    const again = trustingRead(env);
    expect(again.stats).toMatchObject({ trustedLines: 5, verifiedLines: 0, prefixHashes: 0 });
  });

  test("an append verifies only the new tail", () => {
    env = makeStoreEnv("osb-verified-append-", { legacyTree: false });
    append(env, 0, 20);
    trustingRead(env);
    append(env, 20, 3);
    const after = trustingRead(env);
    expect(after.stats).toMatchObject({
      trustedLines: 20,
      verifiedLines: 3,
      prefixHashes: 1,
      remembered: 1,
    });
    expect(after.read.records).toHaveLength(23);
    // The new length is remembered: the next read trusts all of it.
    expect(trustingRead(env).stats).toMatchObject({ trustedLines: 23, verifiedLines: 0 });
  });

  test("a truncated shard is read whole and verified", () => {
    env = makeStoreEnv("osb-verified-truncate-", { legacyTree: false });
    const path = append(env, 0, 10);
    trustingRead(env);
    const lines = readFileSync(path, "utf8").split("\n");
    truncateSync(path, Buffer.byteLength(lines.slice(0, 4).join("\n") + "\n"));
    const after = trustingRead(env);
    expect(after.stats).toMatchObject({ trustedLines: 0, verifiedLines: 4 });
    expect(after.read.records).toHaveLength(4);
  });

  test("a changed byte in the verified prefix is verified again and found", () => {
    env = makeStoreEnv("osb-verified-byte-", { legacyTree: false });
    const path = append(env, 0, 10);
    trustingRead(env);
    changeByte(path, "event 3", "event X");
    const after = trustingRead(env);
    expect(after.stats.trustedLines).toBe(0);
    expect(after.stats.verifiedLines).toBe(10);
    expect(after.read.records).toHaveLength(9);
    expect(after.read.unreadable).toEqual(["log/dev-a/2026-11.jsonl"]);
    // A read that was not clean is not remembered: the next one checks again.
    expect(trustingRead(env).stats).toMatchObject({ trustedLines: 0, verifiedLines: 10 });
  });

  test("a process that does not opt in checks every line, whatever the memory says", () => {
    env = makeStoreEnv("osb-verified-doctor-", { legacyTree: false });
    const path = append(env, 0, 6);
    trustingRead(env);
    trustingRead(env);
    // A memory entry that vouches for changed bytes, as a planted or a
    // mistaken file could: the stamp and the hash of the shard as it is now.
    changeByte(path, "event 2", "event X");
    const [file] = memoryFiles(env);
    const memory = JSON.parse(readFileSync(file!, "utf8")) as {
      shards: Record<string, Record<string, unknown>>;
    };
    const stat = statSync(path, { bigint: true });
    memory.shards["shared/log/dev-a/2026-11.jsonl"] = {
      ...memory.shards["shared/log/dev-a/2026-11.jsonl"],
      size: Number(stat.size),
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      dev: String(stat.dev),
      ino: String(stat.ino),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
    };
    writeFileSync(file!, JSON.stringify(memory));
    // A hook trusts it ...
    expect(trustingRead(env).stats).toMatchObject({ trustedLines: 6, verifiedLines: 0 });
    // ... the reads of a command that checks the store do not.
    resetVerifiedPrefixesForTests();
    const read = readShard(path, { partitionRoot: partitionDir(env.storeRoot, "shared") });
    expect(read.records).toHaveLength(5);
    expect(read.diagnostics.map((d) => d.kind)).toEqual(["corrupt-line"]);
    expect(readLog(env).unreadable).toEqual(["log/dev-a/2026-11.jsonl"]);
  });

  test("an unreadable memory costs a full read and is written anew", () => {
    env = makeStoreEnv("osb-verified-corrupt-", { legacyTree: false });
    append(env, 0, 8);
    trustingRead(env);
    trustingRead(env);
    const [file] = memoryFiles(env);
    writeFileSync(file!, "{ not json");
    const after = trustingRead(env);
    expect(after.stats).toMatchObject({ trustedLines: 0, verifiedLines: 8, remembered: 1 });
    expect(trustingRead(env).stats).toMatchObject({ trustedLines: 8, verifiedLines: 0 });
  });

  test("two processes reading and writing the memory at once leave one that reads", async () => {
    env = makeStoreEnv("osb-verified-race-", { legacyTree: false });
    append(env, 0, 30);
    const run = () =>
      Bun.spawn(["bun", READER, env!.storeRoot, "40"], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });
    const procs = [run(), run()];
    // A third writer appends meanwhile, so the two see the shard change.
    for (let i = 0; i < 5; i++) append(env, 30 + i, 1);
    const outs = await Promise.all(
      procs.map(async (p) => ({
        exit: await p.exited,
        stdout: await new Response(p.stdout).text(),
        stderr: await new Response(p.stderr).text(),
      })),
    );
    for (const out of outs) {
      expect({ exit: out.exit, stderr: out.stderr }).toEqual({ exit: 0, stderr: "" });
      // Every read of the reader saw every record that was there.
      expect(
        out.stdout
          .trim()
          .split("\n")
          .every((line) => /^ok \d+$/.test(line)),
      ).toBe(true);
    }
    const files = memoryFiles(env);
    expect(files).toHaveLength(1);
    const parsed = JSON.parse(readFileSync(files[0]!, "utf8")) as { shards: object };
    expect(Object.keys(parsed.shards)).toEqual(["shared/log/dev-a/2026-11.jsonl"]);
    // No temporary file of an atomic write is left beside it.
    expect(readdirSync(dirname(files[0]!)).filter((n) => n.includes("verified-prefixes"))).toEqual([
      files[0]!.slice(dirname(files[0]!).length + 1),
    ]);
    const after = trustingRead(env);
    expect(after.read.records).toHaveLength(35);
    expect(after.stats.trustedLines).toBe(35);
  });
});

test("an append to the end of the shard is not taken for a change of its prefix", () => {
  env = makeStoreEnv("osb-verified-raw-append-", { legacyTree: false });
  const path = append(env, 0, 4);
  trustingRead(env);
  // A blank line after the verified bytes: no record, the prefix stands.
  appendFileSync(path, "\n");
  const after = trustingRead(env);
  expect(after.stats).toMatchObject({ trustedLines: 4, prefixHashes: 1 });
  expect(after.read.records).toHaveLength(4);
});
