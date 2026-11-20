/**
 * The neighbour-updates hook when a topics shard is replaced under its
 * name (review of the cursor reader): a file-sync tool delivers another
 * device's grown shard by writing a temp file and renaming it over the
 * shard, so the same path holds a new file with the old lines and the new
 * ones. A turn shows exactly the new records, once; a rewrite that adds
 * nothing (a compaction) replays nothing; and a session open across the
 * update from the index reader is told, once, which call lists what it
 * did not read.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  copyFileSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { writeHookStamp } from "../../hooks/lib/session-state.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import {
  injected,
  LOCAL_DEVICE,
  NEIGHBOUR_AGENT,
  neighbourHarness,
  REMOTE_DEVICE,
} from "../helpers/neighbour-hook.ts";
import { appendRecord } from "../../src/core/store/appender.ts";
import { buildRecord } from "../../src/core/store/envelope.ts";
import { newUlid } from "../../src/core/store/ulid.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const h = neighbourHarness("osb-neighbour-replace-");

/** The remote device's one topics shard. */
function remoteShard(): string {
  const dir = join(h.fx().root, "shared", "topics", REMOTE_DEVICE);
  const [name] = readdirSync(dir).filter(
    (n) => /^\d{4}-\d{2}\.jsonl$/.test(n) && n !== "2026-01.jsonl",
  );
  return join(dir, name!);
}

/** Replace `path` as a sync tool does: a temp file with `text`, renamed over it. */
function replaceBySync(path: string, text: string): void {
  const temp = `${path}.syncthing-tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

/** Append a neighbour decision, then deliver the shard by replacement. */
function deliverBySync(topic: string, text: string): void {
  const path = remoteShard();
  const before = readFileSync(path, "utf8");
  // Write the new line the way the other machine did, then put the old
  // file back and deliver old + new as one replaced file.
  const saved = `${path}.before`;
  copyFileSync(path, saved);
  h.decision(REMOTE_DEVICE, topic, text, { agent: NEIGHBOUR_AGENT });
  const grown = readFileSync(path, "utf8");
  expect(grown.startsWith(before)).toBe(true);
  renameSync(saved, path);
  replaceBySync(path, grown);
}

async function startSession(): Promise<string> {
  const topic = newUlid(h.clock());
  h.decision(LOCAL_DEVICE, topic, "the session's own decision");
  // The remote shard exists before the session starts.
  h.decision(REMOTE_DEVICE, topic, "an old neighbour decision", { agent: NEIGHBOUR_AGENT });
  await h.reindex();
  const first = await h.runHook(h.payload("Shared work.", "s1"));
  expect(first.stdout).toBe("");
  return topic;
}

describe("a topics shard replaced under its name", () => {
  test("a replacement holding the old lines and a new one shows the new decision once", async () => {
    const topic = await startSession();
    h.decision(REMOTE_DEVICE, topic, "appended in place", { agent: NEIGHBOUR_AGENT });
    const second = injected((await h.runHook(h.payload("Shared work.", "s1"))).stdout) ?? "";
    expect(second).toContain("appended in place");
    deliverBySync(topic, "delivered by a sync rename");
    const third = injected((await h.runHook(h.payload("Shared work.", "s1"))).stdout) ?? "";
    expect(third).toContain("delivered by a sync rename");
    expect(third).not.toContain("appended in place");
    expect(third).not.toContain("an old neighbour decision");
    const fourth = await h.runHook(h.payload("Shared work.", "s1"));
    expect(fourth.stdout).toBe("");
  });

  test("a replacement that adds nothing (a rewrite of the old lines) replays nothing", async () => {
    const topic = await startSession();
    const path = remoteShard();
    // The same records, rewritten: only the lines that are already there.
    replaceBySync(path, readFileSync(path, "utf8"));
    const turn = await h.runHook(h.payload("Shared work.", "s1"));
    expect(turn.stdout).toBe("");
    // The lane keeps working on the new file.
    h.decision(REMOTE_DEVICE, topic, "after the rewrite", { agent: NEIGHBOUR_AGENT });
    const next = injected((await h.runHook(h.payload("Shared work.", "s1"))).stdout) ?? "";
    expect(next).toContain("after the rewrite");
    expect(next).not.toContain("an old neighbour decision");
  });

  test("two replacements in a row each show only what they added", async () => {
    const topic = await startSession();
    deliverBySync(topic, "first delivery");
    const a = injected((await h.runHook(h.payload("Shared work.", "s1"))).stdout) ?? "";
    expect(a).toContain("first delivery");
    deliverBySync(topic, "second delivery");
    const b = injected((await h.runHook(h.payload("Shared work.", "s1"))).stdout) ?? "";
    expect(b).toContain("second delivery");
    expect(b).not.toContain("first delivery");
    expect(b).not.toContain("an old neighbour decision");
  });
});

describe("a shard the cursor has not seen", () => {
  test("a compaction's output, announced by its compacted record, replays nothing", async () => {
    const topic = await startSession();
    const path = remoteShard();
    const name = basename(path);
    const into = name.replace(/\.jsonl$/, ".c1.jsonl");
    // The owning device announces the compaction, writes the same records
    // under the new name and removes the old shard.
    appendRecord(
      h.fx().open(REMOTE_DEVICE),
      {
        partition: "shared",
        stream: "topics",
        kind: "compacted",
        agent: NEIGHBOUR_AGENT,
        body: {
          // Partition-relative and `/`-separated on every platform (FORMAT.md).
          replaces: [`topics/${REMOTE_DEVICE}/${name}`],
          into: [`topics/${REMOTE_DEVICE}/${into}`],
        },
      },
      { now: h.now },
    );
    writeFileSync(join(dirname(path), into), readFileSync(path, "utf8"));
    rmSync(path);
    const turn = await h.runHook(h.payload("Shared work.", "s1"));
    expect(turn.stdout).toBe("");
    // The lane keeps working on the new shard.
    h.decision(REMOTE_DEVICE, topic, "after the compaction", { agent: NEIGHBOUR_AGENT });
    const next = injected((await h.runHook(h.payload("Shared work.", "s1"))).stdout) ?? "";
    expect(next).not.toContain("an old neighbour decision");
  });

  test("a decision in both a compaction's output and the shard it replaces is shown once", async () => {
    const topic = await startSession();
    const path = remoteShard();
    const name = basename(path);
    const into = name.replace(/\.jsonl$/, ".c1.jsonl");
    h.decision(REMOTE_DEVICE, topic, "in both shards", { agent: NEIGHBOUR_AGENT });
    appendRecord(
      h.fx().open(REMOTE_DEVICE),
      {
        partition: "shared",
        stream: "topics",
        kind: "compacted",
        agent: NEIGHBOUR_AGENT,
        body: {
          // Partition-relative and `/`-separated on every platform (FORMAT.md).
          replaces: [`topics/${REMOTE_DEVICE}/${name}`],
          into: [`topics/${REMOTE_DEVICE}/${into}`],
        },
      },
      { now: h.now },
    );
    // The output is written; the replaced shard is not removed yet.
    writeFileSync(join(dirname(path), into), readFileSync(path, "utf8"));
    const turn = injected((await h.runHook(h.payload("Shared work.", "s1"))).stdout) ?? "";
    expect(turn.split("in both shards")).toHaveLength(2);
  });

  test("a shard of a known device that sync delivers late shows its records, older stamps included", async () => {
    const topic = await startSession();
    const record = buildRecord({
      hlc: { physical: Date.UTC(2026, 0, 5), counter: 0 },
      device: REMOTE_DEVICE,
      agent: NEIGHBOUR_AGENT,
      kind: "decision",
      topic,
      body: { authority: "agent", text: "written offline in January" },
    });
    writeFileSync(join(dirname(remoteShard()), "2026-01.jsonl"), `${JSON.stringify(record)}\n`);
    const turn = injected((await h.runHook(h.payload("Shared work.", "s1"))).stdout) ?? "";
    expect(turn).toContain("written offline in January");
  });
});

describe("a session open across the update from the index reader", () => {
  test("its old watermark is named once in a line with the brain_changes call", async () => {
    const topic = newUlid(h.clock());
    h.decision(LOCAL_DEVICE, topic, "the session's own decision");
    await h.reindex();
    writeHookStamp(h.fx().vault, "s1", "neighbour_watermark", {
      expiresAt: Date.now() + 3_600_000,
      data: { watermark: "01M7W0NEBDJ0XYAP5C9X6S0R72.41" },
    });
    const first = injected((await h.runHook(h.payload("Shared work.", "s1"))).stdout) ?? "";
    expect(first).toContain("`brain_changes` since 01M7W0NEBDJ0XYAP5C9X6S0R72.41");
    const second = await h.runHook(h.payload("Shared work.", "s1"));
    expect(second.stdout).toBe("");
  });
});
