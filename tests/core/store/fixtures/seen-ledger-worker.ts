/**
 * Child process for the two-process seen-shards ledger test. Both roles
 * run on one machine (the environment the parent passes) against one store.
 *
 * `track`: for every round i, appends a record of device `track-<i>` to
 * `shared`, reads the stream (recording the new shard as seen) and removes
 * the shard again, as a sync tool taking it away would. A later read
 * names it only if the ledger kept it. Prints each removed shard's
 * partition-relative path on its own line, after `kept` when the ledger
 * held it right after the read, `skipped` when the best-effort update gave
 * way to a busy lock, then the round's milliseconds. The leaver prints its
 * round count and run time at the end, for a failure message.
 * `leave`: reads the `private` shard of device `leave-0` (recording it) and
 * clears the partition's entries again, round after round, until the stop
 * file appears; then it clears them one last time. It gives up only when
 * the tracker's round count (`<stop file>.progress`) has not moved for two
 * minutes, so a slow runner never ends it early.
 *
 * Each worker writes `<ready dir>/<role>` once it is up and then waits for
 * the go file, so the two run at the same time. A go or stop file that
 * never comes ends the worker after 30 s.
 *
 * argv: <root> <role> <rounds> <ready dir> <go file> <stop file>
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { appendRecord } from "../../../../src/core/store/appender.ts";
import { readStreamRecords } from "../../../../src/core/store/read/stream-read.ts";
import {
  forgetSeenPartition,
  withoutSeenRecording,
} from "../../../../src/core/store/seen-shards.ts";
import { openStore, readStoreId } from "../../../../src/core/store/store-open.ts";
import { partitionDir } from "../../../../src/core/store/store-paths.ts";

const [root, role, roundsText, readyDir, goFile, stopFile] = process.argv.slice(2) as [
  string,
  "track" | "leave",
  string,
  string,
  string,
  string,
];
writeFileSync(join(readyDir, role), "ready\n");
const deadline = Date.now() + 30_000;
function giveUpLate(what: string): void {
  if (Date.now() <= deadline) return;
  process.stderr.write(`the ${what} file never came\n`);
  process.exit(2);
}
while (!existsSync(goFile)) {
  giveUpLate("go");
  Bun.sleepSync(1);
}
const storeId = readStoreId(partitionDir(root, "shared")) as string;
const progressFile = `${stopFile}.progress`;
const STALL_MS = 120_000;
function readProgress(): string {
  try {
    return readFileSync(progressFile, "utf8");
  } catch {
    return "";
  }
}
if (role === "track") {
  for (let i = 0; i < Number(roundsText); i++) {
    const started = Date.now();
    const { path } = appendRecord(openStore({ root, device: `track-${i}` }), {
      partition: "shared",
      stream: "events",
      kind: "note",
      agent: role,
      body: { i },
    });
    readStreamRecords(root, "shared", { stream: "events" });
    rmSync(path);
    // Whether the ledger kept the shard: a read that records nothing names
    // it gone only if it is in the ledger. A tracking update is best
    // effort (it skips on a busy lock), so only a kept shard is a claim.
    const rel = `events/track-${i}/${basename(path)}`;
    const kept = withoutSeenRecording(
      () =>
        readStreamRecords(root, "shared", { stream: "events" }, { device: `track-${i}` })
          .unreadable,
    ).includes(rel);
    process.stdout.write(`${kept ? "kept" : "skipped"} ${rel} ${Date.now() - started}\n`);
    // The round count, which keeps the other process going: it stops when
    // the parent writes the stop file and gives up only when this count
    // stops moving, never after a fixed time.
    writeFileSync(progressFile, `${i + 1}\n`);
  }
} else {
  let rounds = 0;
  const began = Date.now();
  let progress = "";
  let movedAt = Date.now();
  while (!existsSync(stopFile)) {
    rounds += 1;
    // Bounded by the tracker's progress, not by a clock: a slow runner only
    // makes the rounds longer. Given up after two minutes without one.
    const now = readProgress();
    if (now !== progress) {
      progress = now;
      movedAt = Date.now();
    } else if (Date.now() - movedAt > STALL_MS) {
      process.stderr.write(`the tracker made no progress for ${STALL_MS} ms (at round ${now})\n`);
      process.exit(2);
    }
    readStreamRecords(root, "private", { stream: "events" }, { device: "leave-0" });
    forgetSeenPartition(root, storeId, "private");
    // A short yield between rounds, so the tracker's lock retries find a
    // free window; the rounds still overlap the tracker's on every pass.
    Bun.sleepSync(1);
  }
  forgetSeenPartition(root, storeId, "private");
  process.stdout.write(`leaver rounds=${rounds} ms=${Date.now() - began}\n`);
}
