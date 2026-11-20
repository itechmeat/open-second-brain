/**
 * The store checks that read a partition record by record (the digest a
 * device publishes, `partition-view.ts` for the doctor and the digest
 * comparison) answer exactly what the same checks answer over the whole
 * partition held at once: on a mixed partition with preferences, pinned
 * context, settings, retirements, digests of two devices, a record id
 * delivered with two contents, a record stamped ahead of the clock, a
 * pending body and records no check reads.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import type { StorePartition } from "../../../src/core/store/constants.ts";
import type { RecordBody } from "../../../src/core/store/envelope.ts";
import { prepareRecords } from "../../../src/core/store/fold.ts";
import { HLC_MAX_DRIFT_MS, parseHlc } from "../../../src/core/store/hlc.ts";
import { readPartitionView } from "../../../src/core/store/partition-view.ts";
import { removalBacklog } from "../../../src/core/store/removal-backlog.ts";
import { compareDigests, computeRoster } from "../../../src/core/store/state-digest-compare.ts";
import {
  buildDigestBody,
  publishStateDigest,
  readPartition,
} from "../../../src/core/store/state-digest.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import { partitionDir } from "../../../src/core/store/store-paths.ts";
import { makeTempStore, type TempStore } from "./fixtures/temp-store.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const at = (ms: number) => () => ms;

function write(
  store: StoreHandle,
  ms: number,
  kind: string,
  body: RecordBody,
  stream: "events" | "settings" | "log" = "events",
  partition: StorePartition = "shared",
) {
  return appendRecord(store, { partition, stream, kind, agent: "agent-1", body }, { now: at(ms) });
}

describe("partition checks read record by record", () => {
  let tmp: TempStore;
  beforeEach(() => {
    tmp = makeTempStore("osb-streamed-checks-");
  });
  afterEach(() => tmp.cleanup());

  function mixedPartition(): { a: StoreHandle; b: StoreHandle; root: string } {
    const a = tmp.open("dev-a");
    const b = tmp.open("dev-b");
    const old = NOW - 40 * DAY;
    write(a, old, "preference-set", { authority: "agent", preference: "p1", fields: { x: "1" } });
    write(b, old + 1, "preference-set", {
      authority: "human",
      preference: "p1",
      fields: { x: "2" },
    });
    write(b, NOW - 5 * DAY, "preference-evidence", { preference: "p1", result: "applied" });
    write(a, NOW - 4 * DAY, "preference-remove", { authority: "human", preference: "p1" });
    write(a, NOW - 4 * DAY, "pinned-set", { authority: "agent", content: "task" });
    write(a, NOW - 3 * DAY, "setting-set", { authority: "human", key: "k", value: 3 }, "settings");
    write(b, NOW - 3 * DAY, "device-retire", { authority: "human", device: "dev-c" }, "settings");
    write(a, NOW - 2 * DAY, "signal", { authority: "agent", id: "s1", frontmatter: {} });
    write(a, NOW - 2 * DAY, "signal-removed", { authority: "human", signal: "s1" });
    for (let n = 0; n < 20; n++) {
      write(b, NOW - DAY + n, "log-event", { timestamp: "2026-11-05T00:00:00Z", n }, "log");
    }
    // Stamped ahead of the clock.
    write(b, NOW + 3 * DAY, "note", { ahead: true });
    // A pending body: a large note whose blob has not arrived.
    write(a, NOW - DAY, "note", { text: "x".repeat(40_000) });
    const root = partitionDir(tmp.root, "shared");
    renameSync(join(root, "blobs"), join(tmp.root, "blobs-aside"));
    publishStateDigest(a, { partition: "shared", agent: "t", now: at(NOW - 3600_000) });
    publishStateDigest(b, { partition: "shared", agent: "t", now: at(NOW - 1800_000) });
    // One id delivered with another content: a line copied with its
    // agent changed, as a broken peer would (its checksum covers only
    // the body, so it verifies).
    const shard = readPartition(root).find((s) => s.stream === "events" && s.device === "dev-a")!;
    const path = join(root, ...shard.rel.split("/"));
    const line = readFileSync(path, "utf8").split("\n")[0]!;
    appendFileSync(path, `${line.replace('"agent":"agent-1"', '"agent":"agent-2"')}\n`);
    return { a, b, root };
  }

  test("the published digest is the one built from the whole partition", () => {
    const { a, root } = mixedPartition();
    const whole = buildDigestBody("shared", readPartition(root));
    const published = publishStateDigest(a, { partition: "shared", agent: "t", now: at(NOW) });
    expect(published.body).toEqual(whole);
  });

  test("the partition view answers each check as the whole partition does", () => {
    const { root } = mixedPartition();
    const shards = readPartition(root);
    const all = shards.flatMap((s) => s.all);
    const view = readPartitionView(root, {}, NOW);
    const conflicts = prepareRecords(all).conflicts;
    expect(conflicts.length).toBeGreaterThan(0);
    expect(view.conflicts).toEqual(conflicts);
    expect([...view.ids].toSorted()).toEqual([...new Set(all.map((r) => r.id))].toSorted());
    expect(computeRoster(view.digestRecords, view.retireRecords, NOW)).toEqual(
      computeRoster(all, view.retireRecords, NOW),
    );
    expect(
      new Set(view.digestRecords.filter((r) => r.kind === "state-digest").map((r) => r.id)).size,
    ).toBe(2);
    expect(
      compareDigests({
        partition: "shared",
        records: view.digestRecords,
        retireRecords: view.retireRecords,
        nowMs: NOW,
      }),
    ).toEqual(
      compareDigests({
        partition: "shared",
        records: all,
        retireRecords: view.retireRecords,
        nowMs: NOW,
      }),
    );
    expect(removalBacklog(view.voiding)).toEqual(removalBacklog(all));
    expect(removalBacklog(all).total).toBeGreaterThan(0);
    const ahead = all.filter((r) => parseHlc(r.hlc)!.physical - NOW > HLC_MAX_DRIFT_MS);
    expect(ahead.length).toBeGreaterThan(0);
    expect(view.clockAhead.get("dev-b")?.count).toBe(ahead.length);
    expect(view.shards.map((s) => s.rel)).toEqual(shards.map((s) => s.rel));
    expect(view.retireRecords.map((r) => r.id)).toEqual(
      shards
        .filter((s) => s.stream === "settings")
        .flatMap((s) => s.records)
        .filter((r) => r.kind === "device-retire")
        .map((r) => r.id),
    );
  });
});
