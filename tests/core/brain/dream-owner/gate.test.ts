/**
 * The dream owner gate (design D2): unbound, the owner's device, another
 * device on a live call and on a dry run, and a brain on the legacy tree.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rmSync, symlinkSync } from "node:fs";

import {
  assertDreamOwner,
  DreamNotOwnerError,
  maintainDreamOwner,
} from "../../../../src/core/brain/dream-owner/gate.ts";
import * as ownerModule from "../../../../src/core/brain/dream-owner/owner.ts";
import {
  claimDreamOwner,
  readDreamOwner,
  releaseDreamOwner,
  takeDreamOwner,
} from "../../../../src/core/brain/dream-owner/owner.ts";
import { recheckDreamOwner } from "../../../../src/core/brain/dream-owner/gate.ts";
import { dream } from "../../../../src/core/brain/dream.ts";
import { openStore } from "../../../../src/core/store/store-open.ts";
import { blobPath, partitionDir } from "../../../../src/core/store/store-paths.ts";
import { appendRecord } from "../../../../src/core/store/appender.ts";
import { listShards } from "../../../../src/core/store/shard-list.ts";
import { withDeviceId } from "../../../helpers/device-id.ts";
import { makeTestStore, type TestStore } from "../../../helpers/test-store.ts";
import { makeTestVault } from "../../../helpers/test-vault.ts";

const human = { writer: "o2b", authority: "human" as const };
let s: TestStore;
beforeEach(() => {
  s = makeTestStore("osb-dream-gate-");
});
afterEach(() => s.cleanup());

/** Claim on `device` and settle the claim with one look. */
function own(device: string, agent = "claude"): void {
  claimDreamOwner(openStore({ root: s.root, device }), agent, human);
  withDeviceId(device, () => {
    expect(() => assertDreamOwner(null, { live: true })).toThrow(DreamNotOwnerError);
  });
}

describe("assertDreamOwner", () => {
  test("a brain with no owner answers unbound", () => {
    expect(assertDreamOwner(null, { live: true })).toMatchObject({ status: "unbound" });
  });

  test("a new owner found under the lock closes the unbound pass", () => {
    const original = ownerModule.withDreamPassLock;
    let claimed = false;
    const spy = spyOn(ownerModule, "withDreamPassLock").mockImplementation((...args) => {
      if (!claimed) {
        claimed = true;
        claimDreamOwner(openStore({ root: s.root, device: "dev-a" }), "claude", human);
      }
      return original(...args);
    });
    let caught: unknown;
    try {
      withDeviceId("dev-a", () => dream(null, {}));
    } catch (err) {
      caught = err;
    } finally {
      spy.mockRestore();
    }
    expect(caught).toMatchObject({ reason: "ownership-changed", code: "dream_not_owner" });
  });

  test("an unreadable owner shard refuses live work while previews still answer", () => {
    const a = openStore({ root: s.root, device: "dev-a" });
    claimDreamOwner(a, "claude", human);
    const shard = listShards(partitionDir(a.root, "shared"), { stream: "settings" })[0]!;
    rmSync(shard.path);
    symlinkSync(`${shard.path}.missing`, shard.path);
    let caught: unknown;
    try {
      withDeviceId("dev-b", () => assertDreamOwner(null, { live: true }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DreamNotOwnerError);
    expect(caught).toMatchObject({ reason: "unreadable", code: "dream_not_owner" });
    expect((caught as Error).message).toContain("is unreadable");
    expect((caught as Error).message).toContain(shard.path);
    expect(withDeviceId("dev-b", () => assertDreamOwner(null, { live: false })).status).toBe(
      "preview",
    );
  });

  test("a pending owner record refuses live work and names the record; previews still answer", () => {
    const a = openStore({ root: s.root, device: "dev-a" });
    const appended = appendRecord(a, {
      partition: "shared",
      stream: "settings",
      kind: "dream-owner-claim",
      agent: "claude",
      body: { device: "dev-a", agent: "claude", force: false, padding: "x".repeat(40_000) },
    });
    rmSync(blobPath(partitionDir(a.root, "shared"), appended.record.sum));

    let caught: unknown;
    try {
      withDeviceId("dev-b", () => assertDreamOwner(null, { live: true }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DreamNotOwnerError);
    expect(caught).toMatchObject({ reason: "unreadable", code: "dream_not_owner" });
    expect((caught as Error).message).toContain(appended.record.id);
    expect(withDeviceId("dev-b", () => assertDreamOwner(null, { live: false })).status).toBe(
      "preview",
    );
  });

  test("the owner's device passes, once its claim has settled", () => {
    own("dev-a");
    const gate = withDeviceId("dev-a", () => assertDreamOwner(null, { live: true }));
    expect(gate).toMatchObject({ status: "owner", device: "dev-a", owner: { agent: "claude" } });
  });

  test("another device on a live call is refused with the owner and the transfer command", () => {
    own("dev-a");
    let caught: unknown;
    try {
      withDeviceId("dev-b", () => assertDreamOwner(null, { live: true }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DreamNotOwnerError);
    const err = caught as DreamNotOwnerError;
    expect(err.code).toBe("dream_not_owner");
    expect(err.reason).toBe("elsewhere");
    expect(err.owner).toEqual({ device: "dev-a", agent: "claude" });
    expect(err.message).toContain("dev-a");
    expect(err.message).toContain("claude");
    expect(err.message).toContain("o2b dream owner --here");
  });

  test("a requesting device is told its request is pending", () => {
    own("dev-a");
    takeDreamOwner(openStore({ root: s.root, device: "dev-b" }), "codex", {
      ...human,
      force: false,
    });
    // dev-b's look reads the request; dev-a has not looked yet.
    expect(() => withDeviceId("dev-b", () => assertDreamOwner(null, { live: true }))).toThrow(
      /request for the role is pending/,
    );
    // The owner's next look hands the role over and refuses its own pass.
    expect(() => withDeviceId("dev-a", () => assertDreamOwner(null, { live: true }))).toThrow(
      /handed the dream owner role over/,
    );
    expect(withDeviceId("dev-b", () => assertDreamOwner(null, { live: true }))).toMatchObject({
      status: "owner",
      owner: { device: "dev-b", agent: "codex" },
    });
  });

  test("a rival owner installed before the release lock is reflected by the gate", () => {
    own("dev-a");
    takeDreamOwner(openStore({ root: s.root, device: "dev-b" }), "codex", {
      ...human,
      force: false,
    });
    const original = ownerModule.withDreamPassLock;
    let changed = false;
    const spy = spyOn(ownerModule, "withDreamPassLock").mockImplementation((...args) => {
      if (!changed) {
        changed = true;
        takeDreamOwner(openStore({ root: s.root, device: "dev-c" }), "sonnet", {
          ...human,
          force: true,
        });
      }
      return original(...args);
    });
    let caught: unknown;
    try {
      withDeviceId("dev-a", () => assertDreamOwner(null, { live: true }));
    } catch (err) {
      caught = err;
    } finally {
      spy.mockRestore();
    }
    expect(caught).toBeInstanceOf(DreamNotOwnerError);
    expect(caught).toMatchObject({ reason: "elsewhere", owner: { device: "dev-c" } });
  });

  test("a dry run on another device passes", () => {
    own("dev-a");
    expect(withDeviceId("dev-b", () => assertDreamOwner(null, { live: false }))).toEqual({
      status: "preview",
    });
  });

  test("a brain on the legacy tree answers unbound", () => {
    own("dev-a");
    const v = makeTestVault("osb-dream-gate-legacy-");
    try {
      const gate = withDeviceId("dev-b", () =>
        assertDreamOwner(v.vault, { live: true, configPath: v.configPath }),
      );
      expect(gate).toMatchObject({ status: "unbound" });
    } finally {
      v.cleanup();
    }
  });
});

describe("a device that does not hold the shared partition", () => {
  test("a live pass is refused as unknown ownership, naming the partition; a preview answers", () => {
    const privateOnly = makeTestStore("osb-dream-gate-private-", { partitions: ["private"] });
    try {
      let caught: unknown;
      try {
        withDeviceId("dev-b", () => assertDreamOwner(null, { live: true }));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DreamNotOwnerError);
      expect(caught).toMatchObject({ reason: "partition-unavailable", code: "dream_not_owner" });
      expect((caught as Error).message).toContain("shared partition");
      expect(withDeviceId("dev-b", () => assertDreamOwner(null, { live: false }))).toEqual({
        status: "preview",
      });
      // The background look writes nothing and reports no fault there.
      expect(withDeviceId("dev-b", () => maintainDreamOwner(null, undefined))).toBeNull();
    } finally {
      privateOnly.cleanup();
    }
  });
});

describe("the live pass under the pass lock", () => {
  test("a release written between the gate and the lock refuses the pass before any write", () => {
    own("dev-a");
    const original = ownerModule.withDreamPassLock;
    let released = false;
    const spy = spyOn(ownerModule, "withDreamPassLock").mockImplementation(((
      ...args: Parameters<typeof original>
    ) => {
      // The release lands after the gate answered and before the lock.
      if (!released) {
        released = true;
        releaseDreamOwner(openStore({ root: s.root, device: "dev-a" }), human);
      }
      return original(...args);
    }) as typeof original);
    let caught: unknown;
    try {
      withDeviceId("dev-a", () => dream(null, {}));
    } catch (err) {
      caught = err;
    } finally {
      spy.mockRestore();
    }
    expect(caught).toBeInstanceOf(DreamNotOwnerError);
    expect(caught).toMatchObject({ reason: "ownership-changed", code: "dream_not_owner" });
    expect(readDreamOwner(openStore({ root: s.root, device: "dev-a" })).owner).toBeNull();
  });

  test("a same-device fresh claim between the gate and the lock waits for its catch-up", () => {
    own("dev-a");
    const original = ownerModule.withDreamPassLock;
    let changed = false;
    const spy = spyOn(ownerModule, "withDreamPassLock").mockImplementation((...args) => {
      if (!changed) {
        changed = true;
        const a = openStore({ root: s.root, device: "dev-a" });
        releaseDreamOwner(a, human);
        claimDreamOwner(a, "claude", human);
      }
      return original(...args);
    });
    let caught: unknown;
    try {
      withDeviceId("dev-a", () => dream(null, {}));
    } catch (err) {
      caught = err;
    } finally {
      spy.mockRestore();
    }
    expect(caught).toBeInstanceOf(DreamNotOwnerError);
    expect(caught).toMatchObject({ reason: "unsettled", code: "dream_not_owner" });
    expect(withDeviceId("dev-a", () => assertDreamOwner(null, { live: true }))).toMatchObject({
      status: "owner",
      owner: { device: "dev-a", agent: "claude" },
    });
  });

  test("an agent change on the same device still passes the locked recheck", () => {
    own("dev-a");
    const gate = withDeviceId("dev-a", () => assertDreamOwner(null, { live: true }));
    if (gate.status !== "owner") throw new Error("expected the device to own the role");
    takeDreamOwner(openStore({ root: s.root, device: "dev-a" }), "codex", {
      ...human,
      force: false,
    });
    expect(ownerModule.withDreamPassLock(gate.store, () => recheckDreamOwner(gate))).toMatchObject({
      device: "dev-a",
      agent: "codex",
    });
  });

  test("a fresh claim after release waits even when its agent changed", () => {
    own("dev-a");
    const gate = withDeviceId("dev-a", () => assertDreamOwner(null, { live: true }));
    if (gate.status !== "owner") throw new Error("expected the device to own the role");
    const a = openStore({ root: s.root, device: "dev-a" });
    releaseDreamOwner(a, human);
    claimDreamOwner(a, "codex", human);

    expect(() => ownerModule.withDreamPassLock(gate.store, () => recheckDreamOwner(gate))).toThrow(
      expect.objectContaining({ reason: "unsettled", code: "dream_not_owner" }),
    );
  });
});
