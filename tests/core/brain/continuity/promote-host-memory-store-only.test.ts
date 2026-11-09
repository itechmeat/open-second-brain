/**
 * `promoteHostMemory` on a machine switched to the brain store (task 2.10,
 * design D14 items 1 and 9): the promoted preference is a store record and
 * no snapshot is taken.
 *
 * The promotions sidecar lives in the device-local state, so nothing is
 * written under `Brain/`, and the planner asks the fold whether the
 * preference exists, so a second run over unchanged content is
 * SKIP_UNCHANGED.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { promoteHostMemory } from "../../../../src/core/brain/continuity/promote-host-memory.ts";
import { recordHostMemoryWrite } from "../../../../src/core/brain/host-memory-write.ts";
import { preferencePath } from "../../../../src/core/brain/paths.ts";
import { existingPreferencePageText } from "../../../../src/core/brain/preference-page-write.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { brainTreeDigest, switchDevice } from "../store-only/fixtures.ts";

const NOW = new Date("2026-07-01T12:00:00Z");

let env: StoreEnv;
let vault: string;

beforeEach(() => {
  // A vault that still holds a legacy Brain/ tree, switched: the strict case.
  env = makeStoreEnv("osb-promote-store-only-");
  vault = env.vault;
  switchDevice(env.storeRoot);
});

afterEach(() => env.cleanup());

function hostRef(recordId: string): string {
  return `hostmem-${recordId.slice(-12).toLowerCase()}`;
}

function seedHostMemory(): string {
  return recordHostMemoryWrite(vault, {
    action: "add",
    target: "user",
    content: "User prefers dark mode",
    createdAt: "2026-06-20T10:00:00Z",
  }).id;
}

describe("promoteHostMemory on a switched machine", () => {
  test("lands the preference in the store, with no snapshot and no page on disk", () => {
    const id = seedHostMemory();
    const res = promoteHostMemory({ vault, mode: "apply", now: NOW });
    expect(res.plans.map((p) => p.action)).toEqual(["CREATE"]);
    expect(res.snapshotRunId).toBeNull();
    expect(existsSync(preferencePath(vault, hostRef(id)))).toBe(false);
    const stored = existingPreferencePageText(vault, hostRef(id), (path) =>
      readFileSync(path, "utf8"),
    );
    expect(stored).toContain(`id: pref-${hostRef(id)}`);
    expect(stored).toContain("User prefers dark mode");
  });

  test("writes no byte under Brain/ (the promotions sidecar included)", () => {
    seedHostMemory();
    const before = brainTreeDigest(vault);
    promoteHostMemory({ vault, mode: "apply", now: NOW });
    expect(brainTreeDigest(vault)).toBe(before);
  });

  test("a second run over unchanged content is SKIP_UNCHANGED, not a new landing", () => {
    seedHostMemory();
    promoteHostMemory({ vault, mode: "apply", now: NOW });
    const second = promoteHostMemory({
      vault,
      mode: "apply",
      now: new Date("2026-07-02T12:00:00Z"),
    });
    expect(second.plans.map((p) => p.action)).toEqual(["SKIP_UNCHANGED"]);
    expect(second.applied).toHaveLength(0);
  });
});
