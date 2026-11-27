/**
 * A machine register and the receipt ledger follow the lane rule below
 * local reach (change `lane-reach-residuals`, package 1, design R1): the
 * pinned register held in `private` is neither read back, named nor
 * written over by a caller below local reach, a remote pinned write with
 * no private register goes to `shared` (judged on what the caller may
 * read, so a text naming a private page lands there too) or, when its
 * text carries a private region, is refused before anything is written,
 * and a keyed call that meets a
 * receipt held in `private`, or a `private` ledger that may miss a row,
 * gets the fixed answer.
 *
 * The machine under test is store-only and holds both partitions. A
 * server with no reach minted is a caller below local reach; a server at
 * the local reach is the control.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { lookupKey } from "../../src/core/brain/idempotency-ledger.ts";
import { laneEntryInPrivate, writeLanePage } from "../../src/core/store/lane-pages.ts";
import { DUAL_WRITE_LEDGERS } from "../../src/core/store/dual-write-records.ts";
import {
  LEDGER_ROW_KIND,
  PINNED_CLEAR_KIND,
  PINNED_SET_KIND,
  SIGNAL_KIND,
} from "../../src/core/store/constants.ts";
import { appendRecord } from "../../src/core/store/appender.ts";
import { listShards } from "../../src/core/store/shard-list.ts";
import { openStore } from "../../src/core/store/store-open.ts";
import { readStreamRecords } from "../../src/core/store/read/stream-read.ts";
import { readPartition } from "../../src/core/store/state-digest.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { CHMOD_CANNOT_DENY } from "../helpers/platform.ts";
import {
  REGION,
  call,
  callJson,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

function env(): LaneEnv {
  lane = makeLaneEnv("store", "osb-lane-registers-");
  return lane;
}

/** The fixed answer of a call refused below local reach. */
const WITHHELD = "this entry cannot be written at this reach";

const LOCAL_PIN = "zqpinlocal facts of the local session";
const REMOTE_PIN = "zqpinremote facts of the remote session";

/** Every record of both partitions, by id, as the store holds them. */
function rawRecords(e: LaneEnv): string {
  const ids = (partition: "shared" | "private") =>
    readPartition(join(e.env.storeRoot, partition))
      .flatMap((shard) => shard.all)
      .map((r) => r.id)
      .toSorted();
  return JSON.stringify({ shared: ids("shared"), private: ids("private") });
}

/** The pinned records (set and clear) of one partition. */
function pinnedRecords(e: LaneEnv, partition: "shared" | "private"): Record<string, unknown>[] {
  return readPartition(join(e.env.storeRoot, partition))
    .flatMap((shard) => shard.all)
    .filter((r) => r.kind === PINNED_SET_KIND || r.kind === PINNED_CLEAR_KIND)
    .map((r) => r.body);
}

/** The ids of the signal records of both partitions that carry the checkpoint signal's topic. */
function checkpointSignalIds(e: LaneEnv): string[] {
  const topic = CHECKPOINT.signals[0]!.topic;
  return (["shared", "private"] as const)
    .flatMap((partition) => readPartition(join(e.env.storeRoot, partition)))
    .flatMap((shard) => shard.all)
    .filter((r) => r.kind === SIGNAL_KIND && String(r.body["id"]).includes(topic))
    .map((r) => String(r.body["id"]))
    .toSorted();
}

/** The idempotency receipt rows of one partition. */
function receiptRows(e: LaneEnv, partition: "shared" | "private"): Record<string, unknown>[] {
  return readStreamRecords(e.env.storeRoot, partition, {
    stream: "ledgers",
    ledger: DUAL_WRITE_LEDGERS.idempotency,
  })
    .records.filter((r) => r.kind === LEDGER_ROW_KIND)
    .map((r) => r.body["row"] as Record<string, unknown>);
}

/** A local caller pins `LOCAL_PIN`; it is held in the `private` register. */
async function pinLocally(e: LaneEnv): Promise<void> {
  const written = await call(localServer(e), "brain_pinned_context", {
    operation: "write",
    content: LOCAL_PIN,
  });
  expect(written).not.toContain("error");
  expect(JSON.stringify(pinnedRecords(e, "private"))).toContain(LOCAL_PIN);
  expect(JSON.stringify(pinnedRecords(e, "shared"))).not.toContain(LOCAL_PIN);
}

/** The pinned text a local read answers. */
async function localPinned(e: LaneEnv): Promise<unknown> {
  return (await callJson(localServer(e), "brain_pinned_context", { operation: "read" }))["content"];
}

const CHECKPOINT = {
  session_id: "zqsession-registers",
  signals: [
    {
      topic: "zqcheckpoint-topic",
      signal: "positive",
      principle: `Prefer the reviewed path. ${REGION}`,
    },
  ],
  request: "Record the session",
  decisions: ["Keep the reviewed path"],
};

const FEEDBACK = {
  topic: "zqfeedback-topic",
  signal: "positive",
  principle: `Prefer the measured route. ${REGION}`,
  idempotency_key: "zqfeedback-key-registers",
};

/** The string fields of a receipt row that a refused answer must not carry. */
function receiptMarks(row: Record<string, unknown>): string[] {
  const ref = JSON.stringify(row["ref"] ?? {});
  const ids = [...ref.matchAll(/"(?:id|signal_id|path|summaryId)":"([^"]+)"/g)].map((m) => m[1]!);
  return [String(row["key"]), String(row["contentHash"]).slice(0, 12), ...ids];
}

/**
 * The idempotency ledger of `private` may miss a row: after a ledger read
 * has seen them, the `private` partition's `ledgers` shards are gone, the
 * way `dropPrivateEvents` makes the lane fold incomplete.
 */
function dropPrivateLedgers(e: LaneEnv): void {
  lookupKey(e.vault, "zqwarm-read");
  const shards = listShards(join(e.env.storeRoot, "private"), {
    stream: "ledgers",
    ledger: DUAL_WRITE_LEDGERS.idempotency,
  });
  expect(shards.length).toBeGreaterThan(0);
  for (const shard of shards) rmSync(shard.path, { force: true });
}

/** A `private` pinned record whose body is a blob that has not arrived. */
function pendingPrivatePin(e: LaneEnv): void {
  appendRecord(openStore({ root: e.env.storeRoot, device: "dev-a" }), {
    partition: "private",
    stream: "events",
    kind: PINNED_SET_KIND,
    agent: "o2b",
    body: { authority: "human", content: `zqpinpending ${"x".repeat(200_000)}` },
  });
  const blobs = join(e.env.storeRoot, "private", "blobs");
  for (const prefix of readdirSync(blobs)) {
    for (const blob of readdirSync(join(blobs, prefix))) {
      rmSync(join(blobs, prefix, blob), { force: true });
    }
  }
}

describe("pinned register below local reach", () => {
  test("a remote pinned read does not return the private register", async () => {
    const e = env();
    await pinLocally(e);
    const remote = server(e);
    const read = await call(remote, "brain_pinned_context", { operation: "read" });
    const context = await call(remote, "brain_context", {});
    expect({ read: read.includes(LOCAL_PIN), context: context.includes(LOCAL_PIN) }).toEqual({
      read: false,
      context: false,
    });
    expect(await localPinned(e)).toBe(LOCAL_PIN);
  });

  test("local control: a local pinned read returns the private register", async () => {
    const e = env();
    await pinLocally(e);
    expect(await localPinned(e)).toBe(LOCAL_PIN);
    expect(await call(localServer(e), "brain_context", {})).toContain(LOCAL_PIN);
  });

  const writes: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["write", { operation: "write", content: REMOTE_PIN }],
    ["append", { operation: "append", content: REMOTE_PIN }],
    ["clear", { operation: "clear" }],
    [
      "operations batch with write, append and replace",
      {
        operations: [
          { op: "write", content: REMOTE_PIN },
          { op: "append", content: "zqpinmore" },
          { op: "replace", find: "zqpinmore", replace: "zqpinother" },
        ],
      },
    ],
    [
      "operations batch with a replace of the private text",
      { operations: [{ op: "replace", find: "zqpinlocal", replace: "zqpinremote" }] },
    ],
    [
      "operations batch with a replace of an absent segment",
      { operations: [{ op: "replace", find: "zqpinabsent", replace: "zqpinremote" }] },
    ],
  ];

  for (const [name, args] of writes) {
    test(`a remote pinned ${name} leaves the private register unchanged`, async () => {
      const e = env();
      await pinLocally(e);
      const before = rawRecords(e);
      const answer = await call(server(e), "brain_pinned_context", args);
      expect(answer).toContain(WITHHELD);
      expect(answer).not.toContain("zqpinlocal");
      expect(rawRecords(e)).toBe(before);
      expect(await localPinned(e)).toBe(LOCAL_PIN);
    });
  }

  test("local control: a local pinned batch replaces the private register", async () => {
    const e = env();
    await pinLocally(e);
    const answer = await call(localServer(e), "brain_pinned_context", {
      operations: [{ op: "replace", find: "zqpinlocal", replace: "zqpinlocal2" }],
    });
    expect(answer).not.toContain("error");
    expect(await localPinned(e)).toBe(LOCAL_PIN.replace("zqpinlocal", "zqpinlocal2"));
  });

  test("a remote pinned write with no private register goes to shared", async () => {
    const e = env();
    expect(pinnedRecords(e, "private")).toEqual([]);
    const remote = server(e);
    const written = await call(remote, "brain_pinned_context", {
      operation: "write",
      content: REMOTE_PIN,
    });
    expect(written).not.toContain("error");
    expect({
      shared: JSON.stringify(pinnedRecords(e, "shared")).includes(REMOTE_PIN),
      private: JSON.stringify(pinnedRecords(e, "private")).includes(REMOTE_PIN),
    }).toEqual({ shared: true, private: false });
    // A read below local reach is shaped for delivery (wrapped as stored
    // text of unverified provenance); the text itself is answered.
    expect(
      String((await callJson(remote, "brain_pinned_context", { operation: "read" }))["content"]),
    ).toContain(REMOTE_PIN);
    expect(await localPinned(e)).toBe(REMOTE_PIN);
  });

  test("a remote pinned write whose text carries a private region is refused before anything is written", async () => {
    const e = env();
    expect(pinnedRecords(e, "private")).toEqual([]);
    const privateText = `zqpinprivate facts of the remote session ${REGION}`;
    const remote = server(e);
    const before = rawRecords(e);
    const written = await call(remote, "brain_pinned_context", {
      operation: "write",
      content: privateText,
    });
    expect(written).toContain(WITHHELD);
    expect(written).not.toContain("zqpinprivate");
    expect(rawRecords(e)).toBe(before);
    const batch = await call(remote, "brain_pinned_context", {
      operations: [{ op: "write", content: privateText }],
    });
    expect(batch).toContain(WITHHELD);
    expect(rawRecords(e)).toBe(before);
  });

  test("a remote pinned write whose text names a private page goes to shared, as one naming an open page does", async () => {
    const e = env();
    const held = join(e.vault, "Brain", "decisions", "zqpinheld.md");
    writeLanePage(e.vault, held, { kind: "note" }, `# held\n\n${REGION}\n`);
    expect(laneEntryInPrivate(e.vault, held)).toBe(true);
    writeLanePage(
      e.vault,
      join(e.vault, "Brain", "decisions", "zqpinopen.md"),
      { kind: "note" },
      "# open\n",
    );
    expect(pinnedRecords(e, "private")).toEqual([]);
    const remote = server(e);
    const outcome = async (target: string) => {
      const text = `zqpinnames the page [[Brain/decisions/${target}]]`;
      const written = await call(remote, "brain_pinned_context", {
        operation: "write",
        content: text,
      });
      const read = await call(remote, "brain_pinned_context", { operation: "read" });
      const next = await call(remote, "brain_pinned_context", {
        operation: "append",
        content: `zqpinnext ${target}`,
      });
      return {
        written: written.includes("error"),
        shared: JSON.stringify(pinnedRecords(e, "shared")).includes(target),
        private: JSON.stringify(pinnedRecords(e, "private")).includes(target),
        read: read.includes(target),
        next: next.includes("error") || next.includes(WITHHELD),
      };
    };
    const expected = { written: false, shared: true, private: false, read: true, next: false };
    expect(await outcome("zqpinheld")).toEqual(expected);
    expect(await outcome("zqpinopen")).toEqual(expected);
  });

  test("a remote pinned write while the private register holds a record whose blob has not arrived is refused", async () => {
    const e = env();
    pendingPrivatePin(e);
    const before = rawRecords(e);
    const answer = await call(server(e), "brain_pinned_context", {
      operation: "write",
      content: REMOTE_PIN,
    });
    expect(answer).toContain(WITHHELD);
    expect(rawRecords(e)).toBe(before);
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a remote pinned write while a private events shard cannot be read is refused",
    async () => {
      const e = env();
      await pinLocally(e);
      const shards = listShards(join(e.env.storeRoot, "private"), { stream: "events" });
      expect(shards.length).toBeGreaterThan(0);
      for (const shard of shards) chmodSync(shard.path, 0o000);
      try {
        const answer = await call(server(e), "brain_pinned_context", {
          operation: "write",
          content: REMOTE_PIN,
        });
        expect(answer).toContain(WITHHELD);
        expect(JSON.stringify(pinnedRecords(e, "shared"))).not.toContain(REMOTE_PIN);
      } finally {
        for (const shard of shards) chmodSync(shard.path, 0o644);
      }
    },
  );

  test("a local clear after a remote write empties what a local reader sees, and a remote write is then refused", async () => {
    const e = env();
    const remote = server(e);
    expect(
      await call(remote, "brain_pinned_context", { operation: "write", content: REMOTE_PIN }),
    ).not.toContain("error");
    expect(await localPinned(e)).toBe(REMOTE_PIN);
    expect(
      await call(localServer(e), "brain_pinned_context", { operation: "clear" }),
    ).not.toContain("error");
    const local = await callJson(localServer(e), "brain_pinned_context", { operation: "read" });
    const next = await call(remote, "brain_pinned_context", {
      operation: "write",
      content: "zqpinafter",
    });
    expect({
      present: local["present"],
      content: local["content"],
      next: next.includes(WITHHELD),
    }).toEqual({
      present: false,
      content: "",
      next: true,
    });
  });

  test("local control: a local pinned write lands in the private register", async () => {
    const e = env();
    const written = await call(localServer(e), "brain_pinned_context", {
      operation: "write",
      content: REMOTE_PIN,
    });
    expect(written).not.toContain("error");
    expect(JSON.stringify(pinnedRecords(e, "private"))).toContain(REMOTE_PIN);
    expect(await localPinned(e)).toBe(REMOTE_PIN);
  });
});

describe("receipt ledger below local reach", () => {
  /** A local checkpoint whose receipt row lands in `private`; its row. */
  async function checkpointLocally(e: LaneEnv): Promise<Record<string, unknown>> {
    const first = await callJson(localServer(e), "brain_session_checkpoint", CHECKPOINT);
    expect(first["status"]).toBe("ok");
    const row = receiptRows(e, "private").find((r) =>
      String(r["key"]).includes(CHECKPOINT.session_id),
    );
    expect(row).toBeDefined();
    expect(JSON.stringify(receiptRows(e, "shared"))).not.toContain(CHECKPOINT.session_id);
    return row!;
  }

  test("a remote checkpoint retry with the same payload that meets a private receipt is refused", async () => {
    const e = env();
    const row = await checkpointLocally(e);
    const before = rawRecords(e);
    const answer = await call(server(e), "brain_session_checkpoint", CHECKPOINT);
    expect(answer).toContain(WITHHELD);
    expect(receiptMarks(row).filter((mark) => answer.includes(mark))).toEqual([]);
    expect(rawRecords(e)).toBe(before);
  });

  test("a remote checkpoint retry with another payload that meets a private receipt is refused", async () => {
    const e = env();
    const row = await checkpointLocally(e);
    const before = rawRecords(e);
    const answer = await call(server(e), "brain_session_checkpoint", {
      ...CHECKPOINT,
      decisions: ["Take the other path"],
    });
    expect(answer).toContain(WITHHELD);
    expect(receiptMarks(row).filter((mark) => answer.includes(mark))).toEqual([]);
    expect(rawRecords(e)).toBe(before);
  });

  test("local control: a local checkpoint retry dedupes against the private receipt", async () => {
    const e = env();
    await checkpointLocally(e);
    const retry = await callJson(localServer(e), "brain_session_checkpoint", CHECKPOINT);
    expect(retry["deduped"]).toBe(true);
  });

  test("local control: a remote checkpoint retry dedupes against a shared receipt", async () => {
    const e = env();
    const plain = {
      ...CHECKPOINT,
      signals: [{ ...CHECKPOINT.signals[0]!, principle: "Prefer the reviewed path." }],
    };
    expect((await callJson(localServer(e), "brain_session_checkpoint", plain))["status"]).toBe(
      "ok",
    );
    expect(JSON.stringify(receiptRows(e, "shared"))).toContain(CHECKPOINT.session_id);
    const retry = await callJson(server(e), "brain_session_checkpoint", plain);
    expect(retry["deduped"]).toBe(true);
  });

  test("a remote feedback retry that meets a private receipt is refused", async () => {
    const e = env();
    const first = await call(localServer(e), "brain_feedback", FEEDBACK);
    expect(first).not.toContain("error");
    const row = receiptRows(e, "private").find((r) => r["key"] === FEEDBACK.idempotency_key);
    expect(row).toBeDefined();
    const before = rawRecords(e);
    const answer = await call(server(e), "brain_feedback", FEEDBACK);
    expect(answer).toContain(WITHHELD);
    expect(receiptMarks(row!).filter((mark) => answer.includes(mark))).toEqual([]);
    expect(rawRecords(e)).toBe(before);
  });

  test("local control: a local feedback retry dedupes against the private receipt", async () => {
    const e = env();
    expect(await call(localServer(e), "brain_feedback", FEEDBACK)).not.toContain("error");
    const retry = await call(localServer(e), "brain_feedback", FEEDBACK);
    expect(retry).not.toContain("error");
    expect(retry).toContain("deduped");
  });

  // Code review of packages 1 to 5, finding 3, and its ruling: the receipt
  // a remote checkpoint inserts follows the operation's verdict, so with a
  // private region it lands in `private` beside the signal, and the
  // caller's own retry with the same key gets the fixed answer. Moving the
  // receipt to `shared` was rejected: it would place the private signal's
  // id and path, the summary id and the hash of the private payload in
  // `shared`. The first case pins what the row carries; the second pins
  // the retry: refused, the first call's records in place, nothing written
  // twice.
  test("a remote checkpoint whose signal is held in private keeps its receipt, which names that signal, in private", async () => {
    const e = env();
    const first = await callJson(server(e), "brain_session_checkpoint", CHECKPOINT);
    expect(first["status"]).toBe("ok");
    const row = receiptRows(e, "private").find(
      (r) => r["key"] === `checkpoint:${CHECKPOINT.session_id}`,
    );
    expect(row).toBeDefined();
    const signal = (first["signals"] as Array<Record<string, unknown>>)[0]!;
    const ref = JSON.stringify(row!["ref"]);
    expect({
      id: ref.includes(String(signal["id"])),
      path: ref.includes(String(signal["path"])),
      sharedRow: JSON.stringify(receiptRows(e, "shared")).includes(CHECKPOINT.session_id),
    }).toEqual({ id: true, path: true, sharedRow: false });
  });

  test("a remote checkpoint retry against its own receipt held in private gets the fixed answer and writes nothing twice", async () => {
    const e = env();
    const first = await callJson(server(e), "brain_session_checkpoint", CHECKPOINT);
    expect(first["status"]).toBe("ok");
    const signal = (first["signals"] as Array<Record<string, unknown>>)[0]!;
    const before = rawRecords(e);
    const retry = await call(server(e), "brain_session_checkpoint", CHECKPOINT);
    expect(retry).toContain(WITHHELD);
    expect(rawRecords(e)).toBe(before);
    // One signal record of the checkpoint's topic in either partition: the
    // first call's, in place, and no second one from the retry.
    expect(checkpointSignalIds(e)).toEqual([String(signal["id"])]);
  });

  test("a keyed call while the private ledger cannot be read in full is refused, and the local call answers as before", async () => {
    const e = env();
    await checkpointLocally(e);
    dropPrivateLedgers(e);
    const next = { ...CHECKPOINT, session_id: "zqsession-registers-next" };
    const before = rawRecords(e);
    const remote = await call(server(e), "brain_session_checkpoint", next);
    const remoteRefused = remote.includes(WITHHELD);
    const unchanged = rawRecords(e) === before;
    const local = await callJson(localServer(e), "brain_session_checkpoint", next);
    expect({
      local: local["status"],
      localDeduped: local["deduped"],
      remoteRefused,
      unchanged,
    }).toEqual({
      local: "ok",
      localDeduped: false,
      remoteRefused: true,
      unchanged: true,
    });
  });
});
