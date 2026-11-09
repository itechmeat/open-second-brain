/**
 * Dream readers on a switched machine (task 2.10): the scan, the refresh
 * inputs and the archive scan answer from the store's folds what they
 * answer from the legacy pages on an unswitched twin built by the same
 * writers.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { join } from "node:path";

import { dream } from "../../../../src/core/brain/dream.ts";
import { scanBrain, scanInboxForArchive } from "../../../../src/core/brain/dream-scan.ts";
import { digestVaultTree } from "../../../helpers/vault-digest.ts";
import {
  FIXTURE,
  FIXTURE_ACTIVE_PREFERENCES,
  FIXTURE_IDS,
  FIXTURE_NOW,
  makeMemoryTwins,
  type MemoryTwins,
  normalized,
  onBoth,
  useEnv,
} from "../fixtures/memory-twins.ts";

let twins: MemoryTwins;
beforeAll(() => {
  twins = makeMemoryTwins("osb-wp2a-dream-");
});
afterAll(() => twins.cleanup());

describe("scanBrain", () => {
  test("the switched scan equals the legacy scan", () => {
    const { legacy, switched } = onBoth(twins, (env) => normalized(scanBrain(env.vault), env));
    expect(switched).toEqual(legacy);
    const scan = legacy as ReturnType<typeof scanBrain>;
    expect(scan.signals.map((s) => s.signal.id).toSorted()).toEqual(
      [
        ...FIXTURE.activeSignals,
        FIXTURE.consumedSignal,
        FIXTURE_IDS.tabs,
        FIXTURE_IDS.spaces,
        FIXTURE_IDS.consumed,
        FIXTURE_IDS.archived,
      ].toSorted(),
    );
    expect(scan.preferences.length).toBe(FIXTURE_ACTIVE_PREFERENCES);
    expect(scan.retired.map((r) => r.id)).toContain("ret-oldrule");
  });

  test("the archive scan sees the same inbox", () => {
    const { legacy, switched } = onBoth(twins, (env) =>
      normalized(scanInboxForArchive(env.vault), env),
    );
    expect(switched).toEqual(legacy);
  });
});

describe("a dream pass", () => {
  test("a dry run plans the same moves on both twins", () => {
    const { legacy, switched } = onBoth(twins, (env) => {
      const summary = dream(env.vault, { dryRun: true, now: FIXTURE_NOW });
      return normalized(
        {
          new_unconfirmed: summary.new_unconfirmed,
          confirmed: summary.confirmed,
          retired: summary.retired,
          moved_to_processed: summary.moved_to_processed,
        },
        env,
      );
    });
    expect(switched).toEqual(legacy);
    // The unconfirmed preference is past its window: the plan retires it.
    const retiredIds = (switched as { retired: ReadonlyArray<{ id: string }> }).retired.map(
      (r) => r.id,
    );
    expect(retiredIds.some((id) => id.endsWith("ret-drafty"))).toBe(true);
  });

  // The pass writes the store (and its digest caches), so it gets twins of
  // its own: the shared twins the parity tests read stay as built.
  test("a real pass on the switched twin writes no byte under Brain/", () => {
    const own = makeMemoryTwins("osb-wp2a-dream-pass-");
    try {
      useEnv(own.switched);
      const brain = join(own.switched.vault, "Brain");
      const before = digestVaultTree(brain);
      const summary = dream(own.switched.vault, { now: FIXTURE_NOW });
      // The pass had work to do (the unconfirmed preference is past its
      // window), so an unchanged tree is not an idle pass.
      expect(summary.retired.some((r) => r.id.endsWith("ret-drafty"))).toBe(true);
      expect(digestVaultTree(brain)).toBe(before);
      // The retire went through the store: its folds now hold it as retired.
      const after = scanBrain(own.switched.vault);
      expect(after.retired.some((r) => r.path.includes("ret-drafty"))).toBe(true);
      expect(after.preferences.some((p) => p.path.includes("ret-drafty"))).toBe(false);
    } finally {
      own.cleanup();
    }
  });
});
