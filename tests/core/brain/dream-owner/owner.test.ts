/**
 * The dream owner role on a fixture store (design D1, D3): read, claim,
 * an agent change, a request from a second device, the release under the
 * pass lock, the claim-settle rule and the pass lock itself.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startDreamPassHolder } from "../../../helpers/dream-pass-holder.ts";
import { chmodSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import {
  claimDreamOwner,
  claimSettled,
  readDreamOwner,
  releaseDreamOwner,
  releaseIfRequested,
  requestDreamOwner,
  takeDreamOwner,
  withDreamPassLock,
} from "../../../../src/core/brain/dream-owner/owner.ts";
import { CHMOD_CANNOT_DENY } from "../../../helpers/platform.ts";
import { makeMachines, type Machines } from "../../view/fixtures/machines.ts";
import { blobPath, partitionDir } from "../../../../src/core/store/store-paths.ts";
import { openStore } from "../../../../src/core/store/store-open.ts";
import { listShards } from "../../../../src/core/store/shard-list.ts";
import { appendRecord } from "../../../../src/core/store/appender.ts";
import { readShard } from "../../../../src/core/store/reader.ts";

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
let clock = NOW;
const now = () => (clock += 1000);
const human = { writer: "o2b", authority: "human" as const, now };

let m: Machines;
let savedWait: string | undefined;
beforeEach(() => {
  clock = NOW;
  m = makeMachines(["dev-a", "dev-b", "dev-c"], "osb-dream-owner-");
  savedWait = process.env["OPEN_SECOND_BRAIN_LOCK_WAIT_MS"];
  process.env["OPEN_SECOND_BRAIN_LOCK_WAIT_MS"] = "100";
});
afterEach(() => {
  if (savedWait === undefined) delete process.env["OPEN_SECOND_BRAIN_LOCK_WAIT_MS"];
  else process.env["OPEN_SECOND_BRAIN_LOCK_WAIT_MS"] = savedWait;
  m.cleanup();
});

describe("dream owner role", () => {
  test("an empty store has no owner", () => {
    expect(readDreamOwner(m.open("dev-a"), now).owner).toBeNull();
  });

  test("an unreadable settings shard is not treated as an absent owner", () => {
    const a = m.open("dev-a");
    claimDreamOwner(a, "claude", human);
    const shard = listShards(partitionDir(a.root, "shared"), { stream: "settings" })[0]!;
    rmSync(shard.path);
    symlinkSync(join(a.root, "missing-settings-shard"), shard.path);
    expect(() => readDreamOwner(a, now)).toThrow(/unreadable settings shard/i);
  });

  test("a pending owner body makes ownership unknown and names its record", () => {
    const a = m.open("dev-a");
    const appended = appendRecord(a, {
      partition: "shared",
      stream: "settings",
      kind: "dream-owner-claim",
      agent: "claude",
      body: { device: "dev-a", agent: "claude", force: false, padding: "x".repeat(40_000) },
    });
    expect(appended.spilled).toBe(true);
    const partition = partitionDir(a.root, "shared");
    const shard = listShards(partition, { stream: "settings" })[0]!;
    const read = readShard(shard.path, { partitionRoot: partition });
    expect(read.records[0]?.bodyState).toBe("blob");
    const sha = appended.record.sum;
    rmSync(blobPath(partition, sha));

    expect(() => readDreamOwner(a, now)).toThrow(new RegExp(appended.record.id));
  });

  test("a pending record of another kind stays outside the owner fold", () => {
    const a = m.open("dev-a");
    const appended = appendRecord(a, {
      partition: "shared",
      stream: "settings",
      kind: "unrelated-setting",
      agent: "claude",
      body: { padding: "x".repeat(40_000) },
    });
    const partition = partitionDir(a.root, "shared");
    rmSync(blobPath(partition, appended.record.sum));
    expect(readDreamOwner(a, now).owner).toBeNull();
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a settings shard whose read fails is not treated as an absent owner",
    () => {
      const a = m.open("dev-a");
      claimDreamOwner(a, "claude", human);
      const shard = listShards(partitionDir(a.root, "shared"), { stream: "settings" })[0]!;
      chmodSync(shard.path, 0o000);
      try {
        expect(() => readDreamOwner(a, now)).toThrow(/unreadable settings shard/i);
      } finally {
        chmodSync(shard.path, 0o600);
      }
    },
  );

  test("fully readable shards with no owner record still read as no owner", () => {
    const a = m.open("dev-a");
    takeDreamOwner(m.open("dev-b"), "codex", { ...human, force: false });
    expect(readDreamOwner(a, now).owner).toBeNull();
  });

  test("a claim makes this device and agent the owner; a second claim is a no-op", () => {
    const a = m.open("dev-a");
    expect(claimDreamOwner(a, "claude", human).claimed).toBe(true);
    expect(readDreamOwner(a, now).owner).toMatchObject({ device: "dev-a", agent: "claude" });
    m.sync();
    const b = m.open("dev-b");
    expect(claimDreamOwner(b, "codex", human)).toEqual({
      claimed: false,
      owner: { device: "dev-a", agent: "claude" },
    });
  });

  test("a creation claim waits for a live pass lock before writing", () => {
    const a = m.open("dev-a");
    expect(() => withDreamPassLock(a, () => claimDreamOwner(a, "claude", human))).toThrow(
      /dream pass lock busy/i,
    );
    expect(readDreamOwner(a, now).owner).toBeNull();
  });

  test("a second take on the owner's device changes the agent with a new revision", () => {
    const a = m.open("dev-a");
    claimDreamOwner(a, "claude", human);
    const before = readDreamOwner(a, now).owner!;
    const res = takeDreamOwner(a, "codex", { ...human, authority: "agent", force: false });
    expect(res.status).toBe("agent-changed");
    const after = readDreamOwner(a, now).owner!;
    expect(after).toMatchObject({ device: "dev-a", agent: "codex" });
    expect(after.revision > before.revision).toBe(true);
    expect(takeDreamOwner(a, "codex", { ...human, force: false }).status).toBe("already-owner");
  });

  test("a request from a second device waits for the owner's release", () => {
    const a = m.open("dev-a");
    claimDreamOwner(a, "claude", human);
    m.sync();
    const b = m.open("dev-b");
    expect(takeDreamOwner(b, "codex", { ...human, force: false }).status).toBe("requested");
    expect(readDreamOwner(b, now)).toMatchObject({
      owner: { device: "dev-a" },
      pending: { device: "dev-b", agent: "codex" },
    });
    // The owner has not seen the request yet: nothing to release.
    expect(releaseIfRequested(a, readDreamOwner(a, now), human)).toBeNull();
    m.sync();
    expect(releaseIfRequested(a, readDreamOwner(a, now), human)).toBe("dev-b");
    // The owner's device knows at once; the requester only after its catch-up.
    expect(readDreamOwner(a, now).owner?.device).toBe("dev-b");
    expect(readDreamOwner(b, now).owner?.device).toBe("dev-a");
    m.sync();
    expect(readDreamOwner(b, now).owner).toMatchObject({ device: "dev-b", agent: "codex" });
  });

  test("a request observes the owner's clock before appending", () => {
    const a = m.open("dev-a");
    claimDreamOwner(a, "claude", { ...human, now: () => NOW + 60_000 });
    m.sync();
    const b = m.open("dev-b");
    requestDreamOwner(b, "codex", { ...human, now: () => NOW });

    expect(readDreamOwner(b, now)).toMatchObject({
      owner: { device: "dev-a", agent: "claude" },
      pending: { device: "dev-b", agent: "codex" },
    });
  });

  test("a release waits for a pass in progress on the owner's device", () => {
    const a = m.open("dev-a");
    claimDreamOwner(a, "claude", human);
    m.sync();
    takeDreamOwner(m.open("dev-b"), "codex", { ...human, force: false });
    m.sync();
    withDreamPassLock(a, () => {
      // The lock is held: the release is left to the next look.
      expect(releaseIfRequested(a, readDreamOwner(a, now), human)).toBeNull();
    });
    expect(readDreamOwner(a, now).owner?.device).toBe("dev-a");
    expect(releaseIfRequested(a, readDreamOwner(a, now), human)).toBe("dev-b");
  });

  test("--release gives the role up with no successor; only the owner may", () => {
    const a = m.open("dev-a");
    claimDreamOwner(a, "claude", human);
    m.sync();
    expect(releaseDreamOwner(m.open("dev-b"), human)).toMatchObject({ status: "not-owner" });
    expect(releaseDreamOwner(a, human)).toEqual({ status: "released" });
    expect(readDreamOwner(a, now).owner).toBeNull();
  });

  test("--release rereads ownership after waiting for the lock", async () => {
    const a = m.open("dev-a");
    claimDreamOwner(a, "claude", human);
    const holder = await startDreamPassHolder(a, 250);
    const script = [
      'import { takeDreamOwner } from "./src/core/brain/dream-owner/owner.ts";',
      'import { openStore } from "./src/core/store/store-open.ts";',
      "const raw = JSON.parse(Bun.argv[1]);",
      'setTimeout(() => takeDreamOwner(openStore({ root: raw.root, device: "dev-b" }), "codex", { writer: "o2b", authority: "human", force: true }), 20);',
      'process.stdout.write("ready\\n");',
    ].join("\n");
    const writer = Bun.spawn([process.execPath, "-e", script, JSON.stringify(a)], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const reader = writer.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    try {
      process.env["OPEN_SECOND_BRAIN_LOCK_WAIT_MS"] = "1000";
      expect(releaseDreamOwner(a, { writer: "o2b", now: () => NOW + 6000 })).toMatchObject({
        status: "not-owner",
        owner: { device: "dev-b", agent: "codex" },
      });
    } finally {
      await holder.exited;
      await writer.exited;
    }
    expect(readDreamOwner(a).owner).toMatchObject({ device: "dev-b", agent: "codex" });
  });

  test("a changed pending request is reread and the current requester receives the role", () => {
    const a = m.open("dev-a");
    claimDreamOwner(a, "claude", human);
    m.sync();
    const b = m.open("dev-b");
    requestDreamOwner(b, "codex", human);
    m.sync();
    const stale = readDreamOwner(a, now);
    requestDreamOwner(openStore({ root: a.root, device: "dev-c" }), "sonnet", {
      ...human,
      now: () => NOW + 5000,
    });
    expect(releaseIfRequested(a, stale, { writer: "o2b", now: () => NOW + 6000 })).toBe("dev-c");
    expect(readDreamOwner(a).owner).toMatchObject({ device: "dev-c", agent: "sonnet" });
  });

  test("a forced take moves the role at once and warns", () => {
    const a = m.open("dev-a");
    claimDreamOwner(a, "claude", human);
    m.sync();
    const b = m.open("dev-b");
    const res = takeDreamOwner(b, "codex", { ...human, force: true });
    expect(res.status).toBe("forced");
    expect(res.status === "forced" && res.warning).toContain("until its first catch-up");
    expect(readDreamOwner(b, now).owner?.device).toBe("dev-b");
    // The old owner still sees itself until the forced claim reaches it.
    expect(readDreamOwner(a, now).owner?.device).toBe("dev-a");
    m.sync();
    expect(readDreamOwner(a, now).owner?.device).toBe("dev-b");
  });
});

describe("claim settle rule", () => {
  test("a fresh claim is settled only from the look after the one that first saw it", () => {
    const a = m.open("dev-a");
    claimDreamOwner(a, "claude", human);
    expect(claimSettled(a, readDreamOwner(a, now))).toBe(false);
    expect(claimSettled(a, readDreamOwner(a, now))).toBe(true);
  });

  test("two devices that both claimed before syncing are not both settled", () => {
    const a = m.open("dev-a");
    const b = m.open("dev-b");
    claimDreamOwner(b, "codex", { ...human, now: () => NOW + 5 });
    claimDreamOwner(a, "claude", { ...human, now: () => NOW + 9 });
    // Each device's first look before the claims meet only notes its claim.
    expect(claimSettled(a, readDreamOwner(a))).toBe(false);
    expect(claimSettled(b, readDreamOwner(b))).toBe(false);
    m.sync();
    // After the catch-up both agree on dev-b; dev-a is not the owner.
    const sa = readDreamOwner(a);
    const sb = readDreamOwner(b);
    expect(sa.owner?.device).toBe("dev-b");
    expect(sb.owner?.device).toBe("dev-b");
    expect(claimSettled(b, sb)).toBe(true);
  });

  test("a role taken by request, release or force is settled at once", () => {
    const a = m.open("dev-a");
    takeDreamOwner(a, "claude", { ...human, force: false });
    // An unbound brain adopted by `take` is a claim, and waits.
    expect(claimSettled(a, readDreamOwner(a, now))).toBe(false);
    m.sync();
    const b = m.open("dev-b");
    takeDreamOwner(b, "codex", { ...human, force: true });
    expect(claimSettled(b, readDreamOwner(b, now))).toBe(true);
  });
});

describe("pass lock", () => {
  test("a second holder is refused while a pass holds the lock", () => {
    const a = m.open("dev-a");
    withDreamPassLock(a, () => {
      expect(() => withDreamPassLock(a, () => 1)).toThrow(/lock/i);
    });
    expect(withDreamPassLock(a, () => 2)).toBe(2);
  });
});
