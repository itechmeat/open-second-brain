/**
 * The device-local quarantine of a shard line (change store-hardening,
 * design D4; spec `store-shard-gaps`): a line recorded by its byte offset
 * and the hash of its bytes reads as no gap on this machine, the shard's
 * bytes stay as they are, and any other line, or other bytes at the same
 * offset, stays a gap. A pending blob stops counting as a gap but its
 * record is still left out until the blob arrives, and the migration's
 * refusals still see it.
 */
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

import {
  buildEntityIndex,
  __clearEntityIndexCache,
} from "../../../src/core/brain/entities/index-builder.ts";
import { buildCaptureBoundary } from "../../../src/core/brain/capture-boundary.ts";
import { BrainSettingsUnreadableError } from "../../../src/core/brain/policy/errors.ts";
import { readBrainSettingsFromStore } from "../../../src/core/brain/policy/settings-source.ts";
import { brainSettingKey } from "../../../src/core/store-migration/brain-settings.ts";
import { readHeldRecords } from "../../../src/core/store-migration/journal.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { laneStoreFold } from "../../../src/core/store/lane-fold-cache.ts";
import { laneStoreStamp } from "../../../src/core/store/lane-pages.ts";
import {
  PINNED_SET_KIND,
  SETTING_SET_KIND,
  STORE_LINE_CAP_BYTES,
} from "../../../src/core/store/constants.ts";
import { LANE_ENTRY_KIND } from "../../../src/core/store/lane-records.ts";
import { BRAIN_ENTITY_KIND } from "../../../src/core/brain/entities/types.ts";
import { readEntitiesOf } from "../../../src/core/store/read/store-entities.ts";
import { readStreamRecords } from "../../../src/core/store/read/stream-read.ts";
import { readShard, shardReadGap } from "../../../src/core/store/reader.ts";
import {
  addQuarantine,
  QuarantineLedgerUnreadableError,
  releaseQuarantine,
} from "../../../src/core/store/shard-quarantine-write.ts";
import {
  dropLoadedLedger,
  ledgerPath,
  lineSha256At,
  listQuarantine,
  QUARANTINE_HASH_CAP_BYTES,
  type QuarantineShardReader,
} from "../../../src/core/store/shard-quarantine.ts";
import { inspectStore, openStore } from "../../../src/core/store/store-open.ts";
import { partitionDir } from "../../../src/core/store/store-paths.ts";
import { switchDevice } from "../brain/store-only/fixtures.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import { makeStoreEnv, type StoreEnv } from "./fixtures/store-env.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const NOV = Date.UTC(2026, 10, 6, 9);
const QUARANTINE = join(import.meta.dir, "../../../src/core/store/shard-quarantine.ts");
const QUARANTINE_WRITE = join(import.meta.dir, "../../../src/core/store/shard-quarantine-write.ts");

function note(e: StoreEnv, body: Record<string, unknown>): string {
  return appendRecord(
    openStore({ root: e.storeRoot, device: "dev-b" }),
    { partition: "shared", stream: "events", kind: "note", agent: "t", body },
    { now: () => NOV },
  ).path;
}

const shared = (e: StoreEnv): string => partitionDir(e.storeRoot, "shared");
const relOf = (e: StoreEnv, path: string): string =>
  relative(shared(e), path).split("\\").join("/");
const gapOf = (e: StoreEnv, path: string): string | null =>
  shardReadGap(readShard(path, { partitionRoot: shared(e) }));
const events = (e: StoreEnv) => readStreamRecords(e.storeRoot, "shared", { stream: "events" });

/** The byte offset of line `index` (0-based) of the shard at `path`. */
function offsetOfLine(path: string, index: number): number {
  const lines = readFileSync(path, "utf8").split("\n");
  return lines.slice(0, index).reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
}

/** Rewrite line `index` of the shard at `path` with `edit`. */
function editLine(path: string, index: number, edit: (line: string) => string): void {
  const lines = readFileSync(path, "utf8").split("\n");
  lines[index] = edit(lines[index]!);
  writeFileSync(path, lines.join("\n"));
}

/** `count` notes (default three) in one shard; returns the shard's path. */
function shardOf(e: StoreEnv, count = 3): string {
  let path = "";
  for (let n = 1; n <= count; n += 1) path = note(e, { n });
  return path;
}

function quarantine(
  e: StoreEnv,
  path: string,
  offset: number,
  kind: "corrupt-line" | "blob-pending" = "corrupt-line",
  sha256 = lineSha256At(path, offset, shared(e))!,
): "quarantined" | "already" {
  return addQuarantine(e.storeRoot, {
    partition: "shared",
    shard: relOf(e, path),
    offset,
    sha256,
    kind,
    reason: "test",
  });
}

const breakLine = (line: string): string => line.replace(/"n":(\d+)/, '"n":9$1');

/** A shard whose second record's body is a blob that has not arrived; returns the blob dir mover. */
function pendingBlob(e: StoreEnv): { path: string; restore: () => void } {
  note(e, { n: 1 });
  const path = note(e, { n: 2, text: "x".repeat(20_000) });
  const blobs = join(shared(e), "blobs");
  const kept = join(e.storeRoot, "..", "blobs-aside");
  rmSync(kept, { recursive: true, force: true });
  renameSync(blobs, kept);
  return { path, restore: () => renameSync(kept, blobs) };
}

describe("a quarantined corrupt line", () => {
  test("reads as no gap, and the shard's bytes are unchanged", () => {
    env = makeStoreEnv("osb-quarantine-corrupt-", { legacyTree: false });
    const path = shardOf(env);
    editLine(path, 1, breakLine);
    expect(gapOf(env, path)).not.toBeNull();
    const before = readFileSync(path);
    expect(quarantine(env, path, offsetOfLine(path, 1))).toBe("quarantined");
    expect(quarantine(env, path, offsetOfLine(path, 1))).toBe("already");
    expect(gapOf(env, path)).toBeNull();
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  test("other bytes at the same offset are a gap again", () => {
    env = makeStoreEnv("osb-quarantine-replaced-", { legacyTree: false });
    const path = shardOf(env);
    editLine(path, 1, breakLine);
    quarantine(env, path, offsetOfLine(path, 1));
    editLine(path, 1, (line) => line.replace('"n":92', '"n":93'));
    expect(gapOf(env, path)).not.toBeNull();
  });

  test("a second corrupt line in the same shard is still a gap", () => {
    env = makeStoreEnv("osb-quarantine-second-", { legacyTree: false });
    const path = shardOf(env, 4);
    editLine(path, 1, breakLine);
    quarantine(env, path, offsetOfLine(path, 1));
    expect(gapOf(env, path)).toBeNull();
    editLine(path, 2, breakLine);
    const gap = gapOf(env, path);
    expect(gap).toContain(`at byte ${offsetOfLine(path, 2)}`);
    expect(gap).not.toContain(`at byte ${offsetOfLine(path, 1)}:`);
  });

  test("a newer-format line is never marked", () => {
    env = makeStoreEnv("osb-quarantine-newer-", { legacyTree: false });
    const path = shardOf(env);
    editLine(path, 1, (line) => line.replace('"v":1', '"v":99'));
    expect(gapOf(env, path)).toContain("unknown-version");
    quarantine(env, path, offsetOfLine(path, 1));
    expect(gapOf(env, path)).toContain("unknown-version");
  });

  test("a release brings the gap back", () => {
    env = makeStoreEnv("osb-quarantine-release-", { legacyTree: false });
    const path = shardOf(env);
    editLine(path, 1, breakLine);
    const offset = offsetOfLine(path, 1);
    quarantine(env, path, offset);
    expect(releaseQuarantine(env.storeRoot, "shared", relOf(env, path), offset)).toBe("released");
    expect(gapOf(env, path)).not.toBeNull();
    expect(releaseQuarantine(env.storeRoot, "shared", relOf(env, path), offset)).toBe(
      "not-quarantined",
    );
  });

  test("two processes quarantining at once both land", async () => {
    env = makeStoreEnv("osb-quarantine-race-", { legacyTree: false });
    const path = shardOf(env, 4);
    editLine(path, 1, breakLine);
    editLine(path, 2, breakLine);
    const dir = join(env.storeRoot, "..");
    const go = join(dir, "go");
    const script = join(dir, "quarantine.ts");
    // Each child hashes its line, says it is ready, and waits for the
    // parent's go: both writes then start together, inside the lock's reach.
    writeFileSync(
      script,
      `import { existsSync, writeFileSync } from "node:fs";
import { addQuarantine } from ${JSON.stringify(QUARANTINE_WRITE)};
import { lineSha256At } from ${JSON.stringify(QUARANTINE)};
const [root, shard, path, partitionRoot, offset, ready, go] = process.argv.slice(2);
const sha256 = lineSha256At(path, Number(offset), partitionRoot);
writeFileSync(ready, "");
while (!existsSync(go)) Bun.sleepSync(1);
addQuarantine(root, { partition: "shared", shard, offset: Number(offset),
  sha256, kind: "corrupt-line", reason: "race" });
`,
    );
    const ready = [1, 2].map((line) => join(dir, `ready-${line}`));
    const procs = [1, 2].map((line, i) =>
      Bun.spawn(
        [
          process.execPath,
          script,
          env!.storeRoot,
          relOf(env!, path),
          path,
          shared(env!),
          String(offsetOfLine(path, line)),
          ready[i]!,
          go,
        ],
        { env: process.env, stdout: "ignore", stderr: "inherit" },
      ),
    );
    const deadline = Date.now() + 20_000;
    while (!ready.every((r) => existsSync(r)) && Date.now() < deadline) Bun.sleepSync(5);
    writeFileSync(go, "");
    for (const p of procs) expect(await p.exited).toBe(0);
    expect(gapOf(env, path)).toBeNull();
  }, 30_000);

  test("an oversized line is quarantinable up to the hash cap", () => {
    env = makeStoreEnv("osb-quarantine-oversized-", { legacyTree: false });
    const path = shardOf(env);
    editLine(path, 1, () => "x".repeat(2 * STORE_LINE_CAP_BYTES));
    expect(gapOf(env, path)).toContain("line-size cap");
    quarantine(env, path, offsetOfLine(path, 1));
    expect(gapOf(env, path)).toBeNull();
  });
});

describe("lineSha256At", () => {
  test("a shard name that is a symbolic link gives null", () => {
    env = makeStoreEnv("osb-quarantine-hash-link-", { legacyTree: false });
    const path = shardOf(env);
    const link = join(dirname(path), "2020-01.jsonl");
    symlinkSync(path, link);
    expect(lineSha256At(path, 0, shared(env))).not.toBeNull();
    expect(lineSha256At(link, 0, shared(env))).toBeNull();
  });

  test("a line past the hash cap gives null; one at the cap is hashed", () => {
    env = makeStoreEnv("osb-quarantine-hash-cap-", { legacyTree: false });
    const dir = join(shared(env), "events", "dev-c");
    mkdirSync(dir, { recursive: true });
    const atCap = join(dir, "2026-01.jsonl");
    writeFileSync(atCap, `${"x".repeat(QUARANTINE_HASH_CAP_BYTES - 1)}\n`);
    expect(lineSha256At(atCap, 0, shared(env))).not.toBeNull();
    const past = join(dir, "2026-02.jsonl");
    writeFileSync(past, `${"x".repeat(QUARANTINE_HASH_CAP_BYTES)}\n`);
    expect(lineSha256At(past, 0, shared(env))).toBeNull();
    const noNewline = join(dir, "2026-03.jsonl");
    writeFileSync(noNewline, "x".repeat(QUARANTINE_HASH_CAP_BYTES + 1));
    expect(lineSha256At(noNewline, 0, shared(env))).toBeNull();
  });
});

const ledgerOf = (e: StoreEnv): string => ledgerPath(e.storeRoot);

function brokenLine(e: StoreEnv): { path: string; offset: number } {
  const path = shardOf(e);
  editLine(path, 1, breakLine);
  return { path, offset: offsetOfLine(path, 1) };
}

describe("the ledger write", () => {
  for (const [name, text] of [
    ["does not parse", "{not json"],
    ["has another version", JSON.stringify({ version: 2, lines: [] })],
    [
      "holds an entry this release does not read",
      JSON.stringify({
        version: 1,
        lines: [
          {
            partition: "shared",
            shard: "events/dev-z/2026-01.jsonl",
            offset: 0,
            sha256: "0".repeat(64),
            kind: "future-kind",
            reason: "newer build",
            quarantined_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    ],
  ] as const) {
    test(`a ledger that ${name} is refused, not rewritten`, () => {
      env = makeStoreEnv("osb-quarantine-ledger-strict-", { legacyTree: false });
      const { path, offset } = brokenLine(env);
      mkdirSync(dirname(ledgerOf(env)), { recursive: true });
      writeFileSync(ledgerOf(env), text);
      expect(() => quarantine(env!, path, offset)).toThrow(QuarantineLedgerUnreadableError);
      expect(() => releaseQuarantine(env!.storeRoot, "shared", relOf(env!, path), offset)).toThrow(
        QuarantineLedgerUnreadableError,
      );
      expect(readFileSync(ledgerOf(env), "utf8")).toBe(text);
    });
  }

  test("a ledger that cannot be read is refused with its own detail, not as JSON", () => {
    env = makeStoreEnv("osb-quarantine-ledger-unreadable-", { legacyTree: false });
    const { path, offset } = brokenLine(env);
    // A folder where the file belongs: it exists, and reading it fails.
    mkdirSync(ledgerOf(env), { recursive: true });
    let thrown: unknown = null;
    try {
      quarantine(env, path, offset);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(QuarantineLedgerUnreadableError);
    const message = (thrown as Error).message;
    expect(message).toContain("could not be read (");
    expect(message).toContain("EISDIR");
    expect(message).not.toContain("JSON");
    expect(message).toContain("Check that this account can read it");
    expect(statSync(ledgerOf(env)).isDirectory()).toBe(true);
  });

  test("a ledger that does not parse names the parse, not the read", () => {
    env = makeStoreEnv("osb-quarantine-ledger-parse-", { legacyTree: false });
    const { path, offset } = brokenLine(env);
    mkdirSync(dirname(ledgerOf(env)), { recursive: true });
    writeFileSync(ledgerOf(env), "{not json");
    expect(() => quarantine(env!, path, offset)).toThrow("does not parse as JSON");
  });

  test("a no-op leaves the ledger file untouched", () => {
    env = makeStoreEnv("osb-quarantine-ledger-noop-", { legacyTree: false });
    const { path, offset } = brokenLine(env);
    quarantine(env, path, offset);
    const stamp = (): string => {
      const stat = statSync(ledgerOf(env!));
      return `${stat.ino}:${stat.mtimeMs}`;
    };
    const before = stamp();
    expect(quarantine(env, path, offset)).toBe("already");
    expect(releaseQuarantine(env.storeRoot, "shared", relOf(env, path), offset + 1)).toBe(
      "not-quarantined",
    );
    expect(stamp()).toBe(before);
  });
});

describe("the ledger read", () => {
  /** A quarantined corrupt line whose ledger is then rewritten by `rewrite`. */
  function rewritten(rewrite: (ledger: Record<string, unknown>) => unknown): string {
    env = makeStoreEnv("osb-quarantine-ledger-read-", { legacyTree: false });
    const { path, offset } = brokenLine(env);
    quarantine(env, path, offset);
    expect(gapOf(env, path)).toBeNull();
    const ledger = JSON.parse(readFileSync(ledgerOf(env), "utf8")) as Record<string, unknown>;
    writeFileSync(ledgerOf(env), JSON.stringify(rewrite(ledger)));
    // The rewrite may keep the size and land within the cached mtime.
    dropLoadedLedger(ledgerOf(env));
    return path;
  }

  for (const [name, rewrite] of [
    ["another version", (l: Record<string, unknown>) => ({ ...l, version: 2 })],
    ["no version", (l: Record<string, unknown>) => ({ root: l["root"], lines: l["lines"] })],
    ["no list of lines", (l: Record<string, unknown>) => ({ ...l, lines: { 0: l["lines"] } })],
    ["no object", (l: Record<string, unknown>) => l["lines"]],
  ] as const) {
    test(`a ledger with ${name} applies no entry, so the gap stays`, () => {
      const path = rewritten(rewrite);
      expect(gapOf(env!, path)).not.toBeNull();
      expect(listQuarantine(env!.storeRoot, readShard)).toEqual([]);
    });
  }

  test("an entry this release does not read applies nothing; the others still apply", () => {
    const path = rewritten((l) => ({
      ...l,
      lines: [
        ...(l["lines"] as unknown[]),
        { ...(l["lines"] as Record<string, unknown>[])[0]!, offset: 0, kind: "future-kind" },
      ],
    }));
    expect(gapOf(env!, path)).toBeNull();
    expect(listQuarantine(env!.storeRoot, readShard)).toHaveLength(1);
  });
});

describe("a quarantined pending blob", () => {
  test("stops counting, stays out of the read, and reads with its body once it arrives", () => {
    env = makeStoreEnv("osb-quarantine-blob-", { legacyTree: false });
    const { path, restore } = pendingBlob(env);
    expect(gapOf(env, path)).toContain("has not arrived");
    quarantine(env, path, offsetOfLine(path, 1), "blob-pending");
    expect(gapOf(env, path)).toBeNull();
    expect(events(env).unreadable).toEqual([]);
    expect(events(env).records.map((r) => r.body["n"])).toEqual([1]);
    restore();
    const read = events(env);
    expect(read.records.map((r) => r.body["n"])).toEqual([1, 2]);
    expect(read.records[1]!.body["text"]).toBe("x".repeat(20_000));
  });

  test("an entry with another line hash at the same offset does not mark it", () => {
    env = makeStoreEnv("osb-quarantine-blob-hash-", { legacyTree: false });
    const { path } = pendingBlob(env);
    quarantine(env, path, offsetOfLine(path, 1), "blob-pending", "0".repeat(64));
    expect(gapOf(env, path)).toContain("has not arrived");
  });

  test("a corrupt-line entry at the same offset and bytes does not mark it", () => {
    env = makeStoreEnv("osb-quarantine-blob-kind-", { legacyTree: false });
    const { path } = pendingBlob(env);
    quarantine(env, path, offsetOfLine(path, 1), "corrupt-line");
    expect(gapOf(env, path)).toContain("has not arrived");
  });

  test("quarantining the same bytes as the other kind replaces the entry and marks the record", () => {
    env = makeStoreEnv("osb-quarantine-blob-rekind-", { legacyTree: false });
    const { path } = pendingBlob(env);
    const offset = offsetOfLine(path, 1);
    expect(quarantine(env, path, offset, "corrupt-line")).toBe("quarantined");
    expect(gapOf(env, path)).toContain("has not arrived");
    expect(quarantine(env, path, offset, "blob-pending")).toBe("quarantined");
    expect(gapOf(env, path)).toBeNull();
    expect(listQuarantine(env.storeRoot, readShard).map((e) => e.kind)).toEqual(["blob-pending"]);
    expect(quarantine(env, path, offset, "blob-pending")).toBe("already");
  });

  test("a blob-pending entry over a corrupt line is replaced by a corrupt-line entry", () => {
    env = makeStoreEnv("osb-quarantine-line-rekind-", { legacyTree: false });
    const { path, offset } = brokenLine(env);
    expect(quarantine(env, path, offset, "blob-pending")).toBe("quarantined");
    expect(gapOf(env, path)).not.toBeNull();
    expect(quarantine(env, path, offset, "corrupt-line")).toBe("quarantined");
    expect(gapOf(env, path)).toBeNull();
    expect(listQuarantine(env.storeRoot, readShard).map((e) => e.kind)).toEqual(["corrupt-line"]);
  });

  test("a blob-pending entry never marks a record of a settings shard", () => {
    env = makeStoreEnv("osb-quarantine-blob-settings-", { legacyTree: false });
    const path = appendRecord(
      openStore({ root: env.storeRoot, device: "dev-b" }),
      {
        partition: "shared",
        stream: "settings",
        kind: SETTING_SET_KIND,
        agent: "t",
        body: { authority: "human", key: "brain.x.y", value: "x".repeat(20_000) },
      },
      { now: () => NOV },
    ).path;
    rmSync(join(shared(env), "blobs"), { recursive: true, force: true });
    quarantine(env, path, 0, "blob-pending");
    expect(gapOf(env, path)).toContain("has not arrived");
  });

  test("the migration still counts its shard as read only in part", () => {
    env = makeStoreEnv("osb-quarantine-blob-migration-", { legacyTree: false });
    const { path } = pendingBlob(env);
    quarantine(env, path, offsetOfLine(path, 1), "blob-pending");
    const store = inspectStore(env.storeRoot)!;
    expect(readHeldRecords(store).unseen.partial).toEqual([`shared/${relOf(env, path)}`]);
  });
});

describe("listQuarantine", () => {
  test("reads each shard once; a read that throws makes only its own entries held", () => {
    env = makeStoreEnv("osb-quarantine-list-once-", { legacyTree: false });
    const path = shardOf(env, 4);
    editLine(path, 1, breakLine);
    editLine(path, 2, breakLine);
    quarantine(env, path, offsetOfLine(path, 1));
    quarantine(env, path, offsetOfLine(path, 2));
    const { path: blobShard, restore } = pendingBlob(env);
    expect(blobShard).toBe(path); // same device, same month
    restore();
    const devC = appendRecord(
      openStore({ root: env.storeRoot, device: "dev-c" }),
      { partition: "shared", stream: "events", kind: "note", agent: "t", body: { n: 1 } },
      { now: () => NOV },
    ).path;
    appendRecord(
      openStore({ root: env.storeRoot, device: "dev-c" }),
      { partition: "shared", stream: "events", kind: "note", agent: "t", body: { n: 2 } },
      { now: () => NOV },
    );
    // dev-c's first line, read as a record, quarantined as if it were one.
    quarantine(env, devC, 0, "blob-pending");
    const calls: string[] = [];
    const reader: QuarantineShardReader = (shard, options) => {
      calls.push(shard);
      if (shard === devC) throw new Error("locked");
      return readShard(shard, options);
    };
    const states = listQuarantine(env.storeRoot, reader).map((l) => [l.shard, l.state]);
    expect(calls.toSorted()).toEqual([path, devC].toSorted());
    expect(states).toEqual([
      [relOf(env, path), "held"],
      [relOf(env, path), "held"],
      [relOf(env, devC), "held"],
    ]);
    expect(listQuarantine(env.storeRoot, readShard).map((l) => l.state)).toEqual([
      "held",
      "held",
      "resolved",
    ]);
  });

  test("reports held, resolved and stale", () => {
    env = makeStoreEnv("osb-quarantine-list-", { legacyTree: false });
    const { path: blobShard, restore } = pendingBlob(env);
    quarantine(env, blobShard, offsetOfLine(blobShard, 1), "blob-pending");
    restore();
    const other = note(env, { n: 3 }); // same shard: one month, one device
    expect(other).toBe(blobShard);
    // A second shard of another device, with two corrupt lines.
    const devC = (n: number): string =>
      appendRecord(
        openStore({ root: env!.storeRoot, device: "dev-c" }),
        { partition: "shared", stream: "events", kind: "note", agent: "t", body: { n } },
        { now: () => NOV },
      ).path;
    devC(1);
    devC(2);
    const held = devC(3);
    devC(4);
    editLine(held, 1, breakLine);
    editLine(held, 2, breakLine);
    quarantine(env, held, offsetOfLine(held, 1));
    quarantine(env, held, offsetOfLine(held, 2));
    editLine(held, 2, (line) => line.replace('"n":93', '"n":94'));
    const states = listQuarantine(env.storeRoot, readShard).map((l) => [
      l.shard,
      l.offset,
      l.state,
    ]);
    expect(states).toEqual([
      [relOf(env, blobShard), offsetOfLine(blobShard, 1), "resolved"],
      [relOf(env, held), offsetOfLine(held, 1), "held"],
      [relOf(env, held), offsetOfLine(held, 2), "stale"],
    ]);
  });
});

describe("capture", () => {
  test("a corrupt line in a shared settings shard closes capture; the quarantine opens it", () => {
    env = makeStoreEnv("osb-quarantine-capture-", { legacyTree: false });
    switchDevice(env.storeRoot);
    const store = openStore({ root: env.storeRoot, device: "dev-b" });
    const setting = (value: number): string =>
      appendRecord(store, {
        partition: "shared",
        stream: "settings",
        kind: SETTING_SET_KIND,
        agent: "test",
        body: {
          authority: "human",
          key: brainSettingKey("dream", "candidate_threshold"),
          value,
        },
      }).path;
    setting(4);
    setting(5);
    const path = setting(6);
    expect(buildCaptureBoundary(env.vault).sessionDecision("any-1")).toBe("capture");
    editLine(path, 1, (line) => line.replace('"value":5', '"value":7'));
    expect(buildCaptureBoundary(env.vault).sessionDecision("any-1")).toBe("ignore");
    quarantine(env, path, offsetOfLine(path, 1));
    expect(buildCaptureBoundary(env.vault).sessionDecision("any-1")).toBe("capture");
  });
});

describe("the cached settings read", () => {
  test("a release after a whole read fails closed again; a quarantine after a failed read passes", () => {
    env = makeStoreEnv("osb-quarantine-settings-cache-", { legacyTree: false });
    switchDevice(env.storeRoot);
    const store = openStore({ root: env.storeRoot, device: "dev-b" });
    const setting = (value: number): string =>
      appendRecord(store, {
        partition: "shared",
        stream: "settings",
        kind: SETTING_SET_KIND,
        agent: "test",
        body: {
          authority: "human",
          key: brainSettingKey("dream", "candidate_threshold"),
          value,
        },
      }).path;
    setting(4);
    setting(5);
    const path = setting(6);
    editLine(path, 1, (line) => line.replace('"value":5', '"value":7'));
    const read = () => readBrainSettingsFromStore({ configPath: env!.configPath });
    expect(read).toThrow(BrainSettingsUnreadableError);
    const offset = offsetOfLine(path, 1);
    quarantine(env, path, offset);
    expect(read().config.dream.candidate_threshold).toBe(6);
    expect(releaseQuarantine(env.storeRoot, "shared", relOf(env, path), offset)).toBe("released");
    expect(read).toThrow(BrainSettingsUnreadableError);
    quarantine(env, path, offset);
    expect(read().config.dream.candidate_threshold).toBe(6);
  });
});

describe("the cached lane fold", () => {
  test("a release after a whole fold lists the shard again; a quarantine after a failed fold clears it", () => {
    env = makeStoreEnv("osb-quarantine-lane-cache-", { legacyTree: false });
    switchDevice(env.storeRoot);
    const path = shardOf(env);
    expect(laneStoreFold().unreadable).toEqual([]);
    editLine(path, 1, breakLine);
    const listed = [`shared/${relOf(env, path)}`];
    expect(laneStoreFold().unreadable).toEqual(listed);
    const offset = offsetOfLine(path, 1);
    quarantine(env, path, offset);
    expect(laneStoreFold().unreadable).toEqual([]);
    expect(releaseQuarantine(env.storeRoot, "shared", relOf(env, path), offset)).toBe("released");
    expect(laneStoreFold().unreadable).toEqual(listed);
    quarantine(env, path, offset);
    expect(laneStoreFold().unreadable).toEqual([]);
  });
});

describe("the cached entity read", () => {
  test("a release after a whole read lists the shard again; a quarantine after a failed read clears it", () => {
    env = makeStoreEnv("osb-quarantine-entities-cache-", { legacyTree: false });
    const path = shardOf(env);
    const unreadable = () => readEntitiesOf(inspectStore(env!.storeRoot)!).unreadable;
    expect(unreadable()).toEqual([]);
    editLine(path, 1, breakLine);
    const listed = [`shared/${relOf(env, path)}`];
    expect(unreadable()).toEqual(listed);
    const offset = offsetOfLine(path, 1);
    quarantine(env, path, offset);
    expect(unreadable()).toEqual([]);
    expect(releaseQuarantine(env.storeRoot, "shared", relOf(env, path), offset)).toBe("released");
    expect(unreadable()).toEqual(listed);
    quarantine(env, path, offset);
    expect(unreadable()).toEqual([]);
  });
});

/**
 * An `events` record of `kind` whose body is a blob that has not arrived,
 * quarantined on this machine (so its shard reads as no gap); returns the
 * mover that delivers the blob.
 */
function quarantinedPending(e: StoreEnv, kind: string, body: Record<string, unknown>): () => void {
  note(e, { n: 1 });
  const path = appendRecord(
    openStore({ root: e.storeRoot, device: "dev-b" }),
    { partition: "shared", stream: "events", kind, agent: "t", body },
    { now: () => NOV },
  ).path;
  const blobs = join(shared(e), "blobs");
  const kept = join(e.storeRoot, "..", "blobs-aside");
  rmSync(kept, { recursive: true, force: true });
  renameSync(blobs, kept);
  quarantine(e, path, offsetOfLine(path, 1), "blob-pending");
  expect(gapOf(e, path)).toBeNull();
  return () => renameSync(kept, blobs);
}

const BIG = "x".repeat(20_000);

describe("a cached read that skipped a quarantined pending record", () => {
  test("the entity read is served from the cache while the blob is absent, and shows the record once it arrives", () => {
    env = makeStoreEnv("osb-quarantine-entities-blob-", { legacyTree: false });
    const deliver = quarantinedPending(env, PINNED_SET_KIND, {
      authority: "human",
      content: BIG,
    });
    const pinned = () =>
      readEntitiesOf(inspectStore(env!.storeRoot)!).pinned.get("shared")?.content ?? null;
    // The first read builds and stores its fingerprint with the skipped
    // blob's absence stamp, so the next read is already a cache hit.
    expect(pinned()).toBeNull();
    const open = spyOn(fs, "openSync");
    const readFile = spyOn(fs, "readFileSync");
    const shardReads = (): string[] =>
      [...open.mock.calls, ...readFile.mock.calls]
        .map((call) => String(call[0]))
        .filter((p) => p.startsWith(env!.storeRoot) && p.endsWith(".jsonl"));
    try {
      expect(pinned()).toBeNull();
      expect(shardReads()).toEqual([]);
      deliver();
      // The blob's arrival moves the fingerprint's blob stamp, so the
      // next read rebuilds - and a rebuild is seen by the same spies,
      // which proves the empty list above is the cache and not a blind
      // spy.
      expect(pinned()).toBe(BIG);
      expect(shardReads().length).toBeGreaterThan(0);
    } finally {
      open.mockRestore();
      readFile.mockRestore();
    }
  });

  test("the lane fold is served from the cache while the blob is absent, and folds the entry once it arrives", () => {
    env = makeStoreEnv("osb-quarantine-lane-blob-", { legacyTree: false });
    switchDevice(env.storeRoot);
    const deliver = quarantinedPending(env, LANE_ENTRY_KIND, {
      authority: "human",
      lane: "standing-rule",
      entry: "pending-entry",
      fields: {},
      text: BIG,
    });
    const text = () =>
      [...laneStoreFold().entries.values()].find((v) => v.text === BIG)?.text ?? null;
    expect(laneStoreFold().unreadable).toEqual([]);
    expect(text()).toBeNull();
    // The fold is stored with the skipped blob's absence stamp, so the
    // next fold is already a cache hit.
    const open = spyOn(fs, "openSync");
    const readFile = spyOn(fs, "readFileSync");
    const shardReads = (): string[] =>
      [...open.mock.calls, ...readFile.mock.calls]
        .map((call) => String(call[0]))
        .filter((p) => p.startsWith(env!.storeRoot) && p.endsWith(".jsonl"));
    try {
      expect(text()).toBeNull();
      expect(shardReads()).toEqual([]);
      deliver();
      // The blob's arrival moves the fingerprint's blob stamp, so the
      // next fold rebuilds - seen by the same spies, which proves the
      // empty list above is the cache and not a blind spy.
      expect(text()).toBe(BIG);
      expect(shardReads().length).toBeGreaterThan(0);
    } finally {
      open.mockRestore();
      readFile.mockRestore();
    }
  });

  test("a same-size blob repaired in place with its mtime kept is picked up", () => {
    env = makeStoreEnv("osb-quarantine-entities-repair-", { legacyTree: false });
    const deliver = quarantinedPending(env, PINNED_SET_KIND, {
      authority: "human",
      content: BIG,
    });
    deliver();
    const blobsDir = join(shared(env), "blobs");
    const [ab] = readdirSync(blobsDir);
    const [name] = readdirSync(join(blobsDir, ab!));
    const blobFile = join(blobsDir, ab!, name!);
    const good = readFileSync(blobFile);
    const stat = statSync(blobFile);
    const pinned = () =>
      readEntitiesOf(inspectStore(env!.storeRoot)!).pinned.get("shared")?.content ?? null;
    // Corrupt the blob in place at the same size and put the mtime back:
    // only the reader's own hash check refuses it now.
    writeFileSync(
      blobFile,
      Buffer.concat([good.subarray(0, -1), Buffer.from([good[good.length - 1]! ^ 0xff])]),
    );
    utimesSync(blobFile, stat.atime, stat.mtime);
    expect(pinned()).toBeNull();
    // The repair also keeps size and mtime; only the content and the
    // blob's ctime move, so the refused-blob state was never cached and
    // the next read picks the repaired blob up.
    writeFileSync(blobFile, good);
    utimesSync(blobFile, stat.atime, stat.mtime);
    expect(pinned()).toBe(BIG);
  });
});

describe("the entity index on a store-only machine", () => {
  const ENTITY_FIELDS = {
    kind: BRAIN_ENTITY_KIND,
    entity_id: "e1",
    category: "org",
    name: "Acme",
    status: "active",
    created_at: "2026-11-06T09:00:00Z",
  };

  function laneEntry(e: StoreEnv, entry: string, text: string): string {
    return appendRecord(
      openStore({ root: e.storeRoot, device: "dev-b" }),
      {
        partition: "shared",
        stream: "events",
        kind: LANE_ENTRY_KIND,
        agent: "t",
        body: {
          authority: "agent",
          lane: "entities",
          entry,
          fields: ENTITY_FIELDS,
          text,
        },
      },
      // An October shard: the quarantined update below lands alone in its
      // own November shard, at the line offset the helper expects.
      { now: () => Date.UTC(2026, 9, 6, 9) },
    ).path;
  }

  /** A lane entry whose record lands in the month `ms` falls in. */
  function laneEntryIn(e: StoreEnv, entry: string, text: string, ms: number): string {
    return appendRecord(
      openStore({ root: e.storeRoot, device: "dev-b" }),
      {
        partition: "shared",
        stream: "events",
        kind: LANE_ENTRY_KIND,
        agent: "t",
        body: {
          authority: "agent",
          lane: "entities",
          entry,
          fields: { ...ENTITY_FIELDS, entity_id: entry.split("/")[1] },
          text,
        },
      },
      { now: () => ms },
    ).path;
  }

  test("a lane update's pending blob arriving moves the index stamp", () => {
    env = makeStoreEnv("osb-quarantine-index-blob-", { legacyTree: false });
    switchDevice(env.storeRoot);
    laneEntry(env, "org/e1", "v1 body");
    __clearEntityIndexCache();
    const body = (): string =>
      buildEntityIndex(env!.vault).entities.find((entity) => entity.id === "e1")?.body ?? "missing";
    // The first build warms the index memo on the page as it is.
    expect(body()).toBe("v1 body");
    // An update of the same page lands with its body as a quarantined
    // pending blob: the page list and every shard stamp stay the same.
    const deliver = quarantinedPending(env, LANE_ENTRY_KIND, {
      authority: "agent",
      lane: "entities",
      entry: "org/e1",
      fields: ENTITY_FIELDS,
      text: BIG,
    });
    expect(body()).toBe("v1 body");
    deliver();
    // The blob's arrival moves the lane stamp, so the memo no longer
    // serves the old build.
    expect(body()).toBe(BIG);
  });

  test("an unreadable shard leaves a deterministic stamp, so the index memo keeps hitting", () => {
    env = makeStoreEnv("osb-quarantine-index-incomplete-", { legacyTree: false });
    switchDevice(env.storeRoot);
    const october = laneEntry(env, "org/e1", "v1 body");
    // A second entity whose winning record survives on the November
    // shard, so the degraded index still has a page to serve.
    laneEntryIn(env, "org/e2", "e2 body", NOV);
    __clearEntityIndexCache();
    const body = (): string =>
      buildEntityIndex(env!.vault).entities.find((entity) => entity.id === "e2")?.body ?? "missing";
    // The first build warms the memo and the seen-shard tracking.
    expect(body()).toBe("e2 body");
    // A shard this machine read and that is gone now leaves the fold
    // uncached - but its stamp is deterministic and carries the
    // `incomplete` prefix: no healthy stamp can match it.
    const octoberBytes = readFileSync(october);
    rmSync(october);
    const degraded = laneStoreStamp(env!.vault);
    expect(degraded).toContain("incomplete");
    const open = spyOn(fs, "openSync");
    const readFile = spyOn(fs, "readFileSync");
    const shardReads = (): string[] =>
      [...open.mock.calls, ...readFile.mock.calls]
        .map((call) => String(call[0]))
        .filter((p) => p.startsWith(env!.storeRoot) && p.endsWith(".jsonl"));
    try {
      // The degraded build is stable: the same stamp, the same answer.
      // The signature's stamp still costs one fold rebuild (the fold
      // itself stays uncached), but the memo absorbs the rest: a cold
      // build parses every entity page, one fold per page, a warm one
      // pays only the signature. Before the deterministic stamp the
      // memo never hit, so every build paid the cold price.
      expect(laneStoreStamp(env!.vault)).toBe(degraded);
      __clearEntityIndexCache();
      expect(body()).toBe("e2 body");
      const cold = shardReads().length;
      expect(cold).toBeGreaterThan(0);
      expect(body()).toBe("e2 body");
      const warm = shardReads().length - cold;
      expect(warm).toBeGreaterThan(0);
      expect(warm).toBeLessThan(cold);
      // Once the shard reads again (sync delivers it back), the stamp
      // moves, the incomplete prefix is gone, and the next build is a
      // fresh, healthy one.
      writeFileSync(october, octoberBytes);
      expect(laneStoreStamp(env!.vault)).not.toBe(degraded);
      expect(laneStoreStamp(env!.vault)).not.toContain("incomplete");
      expect(body()).toBe("e2 body");
      expect(shardReads().length).toBeGreaterThan(cold + warm);
    } finally {
      open.mockRestore();
      readFile.mockRestore();
    }
  });

  // The transient-unreadable state is a permission denial, which chmod
  // cannot produce everywhere (root reads through any mode, Windows maps
  // it to read-only), so the pair-of-states fixture skips there.
  test.skipIf(CHMOD_CANNOT_DENY)(
    "an unreadable shard's stamp moves when the records the fold saw change",
    () => {
      env = makeStoreEnv("osb-quarantine-stamp-records-", { legacyTree: false });
      switchDevice(env.storeRoot);
      // Three lane entries in ONE shard: the two degraded states below share
      // that shard's stamp, its `unreadable` name and its pending blobs -
      // only the records the fold managed to read differ.
      const shard = laneEntry(env, "org/e1", "v1 body");
      laneEntry(env, "org/e2", "v2 body");
      laneEntry(env, "org/e3", "v3 body");
      // A corrupt middle line, rewritten at an equal length and stamped back
      // to the shard's original mtime, so the shard's size and mtime are
      // frozen across both states.
      const identity = statSync(shard);
      editLine(shard, 1, (line) => "x".repeat(line.length));
      utimesSync(shard, identity.atime, identity.mtime);

      // State A: a transient open failure - the shard is unreadable and the
      // fold saw NONE of its records.
      chmodSync(shard, 0o000);
      let unseen: string;
      try {
        unseen = laneStoreStamp(env!.vault);
        expect(unseen).toContain("incomplete");
        // The same degraded state stamps the same way twice.
        expect(laneStoreStamp(env!.vault)).toBe(unseen);
      } finally {
        chmodSync(shard, 0o644);
      }
      // State B: the same bytes, now read in part - the corrupt line is a
      // read gap and the fold carries the two records around it. Without the
      // contributing records in the fingerprint this stamp equals state A's,
      // and a memo keyed by it would serve the record-less build.
      const gapped = laneStoreStamp(env!.vault);
      expect(gapped).toContain("incomplete");
      expect(gapped).not.toBe(unseen);
      expect(laneStoreStamp(env!.vault)).toBe(gapped);
    },
  );
});
