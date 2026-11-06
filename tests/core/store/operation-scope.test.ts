/**
 * The ambient operation scope (`operation-scope.ts`): a store record
 * written while a writer operation runs follows that operation's verdict,
 * whoever writes it, on the synchronous path and across awaits and timers.
 * Nested operations can only raise; two operations running at once never
 * see each other's verdict.
 *
 * The record under test is a plain Brain log event, which on its own lands
 * in `shared`. Every test runs against its own temp HOME, state base,
 * vault and store root under one named parent, removed in teardown.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { STORE_DUAL_WRITE_ENV, STORE_ROOT_ENV } from "../../../src/core/store/constants.ts";
import { withOperationPrivacy } from "../../../src/core/store/operation-scope.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { initStore } from "../../../src/core/store/store-init.ts";

const ENV_KEYS = [
  STORE_DUAL_WRITE_ENV,
  STORE_ROOT_ENV,
  "O2B_DEVICE_ID",
  "HOME",
  "XDG_STATE_HOME",
  "LOCALAPPDATA",
] as const;

let parent: string;
let vault: string;
let storeRoot: string;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  parent = mkdtempSync(join(tmpdir(), "osb-operation-scope-"));
  vault = join(parent, "vault");
  storeRoot = join(parent, "store");
  mkdirSync(vault, { recursive: true });
  bootstrapBrain(vault);
  process.env["HOME"] = join(parent, "home");
  process.env["XDG_STATE_HOME"] = join(parent, "state");
  process.env["LOCALAPPDATA"] = join(parent, "state");
  process.env[STORE_ROOT_ENV] = storeRoot;
  process.env["O2B_DEVICE_ID"] = "dev-a";
  process.env[STORE_DUAL_WRITE_ENV] = "1";
  initStore({ root: storeRoot });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Append a plain log event whose text is `marker`. */
function writePlain(marker: string): void {
  appendLogEvent(vault, {
    timestamp: "2026-11-06T10:00:00Z",
    eventType: "note",
    body: { text: marker, agent: "@claude-devbox-agent" },
  });
}

/** The partition the event carrying `marker` landed in. */
function partitionOf(marker: string): "shared" | "private" | "missing" {
  for (const partition of ["shared", "private"] as const) {
    for (const shard of readPartition(join(storeRoot, partition))) {
      if (shard.records.some((r) => JSON.stringify(r.body).includes(marker))) return partition;
    }
  }
  return "missing";
}

/** Three records under one verdict, each after a timer, so two runs interleave. */
function runInterleaved(verdict: boolean, marker: string): Promise<void> {
  const step = async (i: number): Promise<void> => {
    await sleep(1);
    writePlain(`${marker}-${i}`);
  };
  return withOperationPrivacy(verdict, async () => {
    await step(0);
    await step(1);
    await step(2);
  });
}

describe("the operation scope", () => {
  test("outside any operation a plain record lands in shared", () => {
    writePlain("outside");
    expect(partitionOf("outside")).toBe("shared");
  });

  test("a private operation sends a record written on its synchronous path to private", () => {
    withOperationPrivacy(true, () => writePlain("sync"));
    expect(partitionOf("sync")).toBe("private");
  });

  test("a shared operation leaves a plain record in shared", () => {
    withOperationPrivacy(
      () => false,
      () => writePlain("open"),
    );
    expect(partitionOf("open")).toBe("shared");
  });

  test("the scope follows the operation across awaits and timers", async () => {
    await withOperationPrivacy(true, async () => {
      await Promise.resolve();
      writePlain("after-microtask");
      await sleep(5);
      writePlain("after-timer");
      await new Promise<void>((done) => {
        setImmediate(() => {
          writePlain("in-callback");
          done();
        });
      });
    });
    expect(partitionOf("after-microtask")).toBe("private");
    expect(partitionOf("after-timer")).toBe("private");
    expect(partitionOf("in-callback")).toBe("private");
  });

  test("an inner operation can raise, never lower, and the outer verdict holds again after it", () => {
    withOperationPrivacy(true, () => {
      withOperationPrivacy(false, () => writePlain("inner-open-in-private"));
    });
    withOperationPrivacy(false, () => {
      withOperationPrivacy(true, () => writePlain("inner-private-in-open"));
      writePlain("outer-open-after-inner");
    });
    expect(partitionOf("inner-open-in-private")).toBe("private");
    expect(partitionOf("inner-private-in-open")).toBe("private");
    expect(partitionOf("outer-open-after-inner")).toBe("shared");
  });

  test("two operations running at once keep their own verdicts", async () => {
    await Promise.all([runInterleaved(true, "busy-private"), runInterleaved(false, "busy-open")]);
    for (const i of [0, 1, 2]) {
      expect(partitionOf(`busy-private-${i}`)).toBe("private");
      expect(partitionOf(`busy-open-${i}`)).toBe("shared");
    }
  });

  test("a verdict that throws counts as private", () => {
    withOperationPrivacy(
      () => {
        throw new Error("cannot judge");
      },
      () => writePlain("throwing"),
    );
    expect(partitionOf("throwing")).toBe("private");
  });

  test("the verdict is judged once, and not at all with dual writes off", () => {
    let calls = 0;
    const verdict = (): boolean => {
      calls += 1;
      return false;
    };
    delete process.env[STORE_DUAL_WRITE_ENV];
    withOperationPrivacy(verdict, () => writePlain("off"));
    expect(calls).toBe(0);
    process.env[STORE_DUAL_WRITE_ENV] = "1";
    withOperationPrivacy(verdict, () => {
      writePlain("first");
      writePlain("second");
    });
    expect(calls).toBe(1);
  });
});
