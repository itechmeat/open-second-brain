/**
 * The per-pass cache of store log reads (task 2.10): on a switched machine
 * a reader that walks the log once per preference (the dream pass's
 * evidence collection) reads the store's `log` stream once per read pass,
 * sees an event appended during the pass, and reads again after the pass.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { appendApplyEvidence } from "../../../src/core/brain/apply-evidence.ts";
import { dream } from "../../../src/core/brain/dream.ts";
import { collectEvidenceForSlug } from "../../../src/core/brain/evidence.ts";
import { logDayReader, logReadStats, withLogReadPass } from "../../../src/core/brain/log-days.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { switchDevice } from "./fixtures/memory-twins.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

const SLUGS = ["one", "two", "three", "four"];

function switchedWithEvidence(): StoreEnv {
  const e = makeStoreEnv("osb-wp2b-logdays-", { dualWrite: false });
  switchDevice(e);
  for (const slug of SLUGS) {
    writePreference(
      e.vault,
      {
        slug,
        topic: slug,
        principle: `principle ${slug}`,
        created_at: "2026-11-01T00:00:00Z",
        unconfirmed_until: "2026-11-30T00:00:00Z",
        status: "unconfirmed",
        evidenced_by: [],
      },
      { authority: "agent" },
    );
    appendApplyEvidence(
      e.vault,
      { pref_id: `pref-${slug}`, artifact: "[[notes/a]]", agent: "claude", result: "applied" },
      { now: new Date("2026-11-05T09:00:00Z") },
    );
  }
  return e;
}

const evidenceOf = (vault: string, slug: string) =>
  collectEvidenceForSlug(vault, slug, { sinceIso: "" });

describe("store log reads per pass", () => {
  test("outside a pass every walk reads the log", () => {
    env = switchedWithEvidence();
    const before = logReadStats().storeReads;
    for (const slug of SLUGS) expect(evidenceOf(env.vault, slug).applied).toHaveLength(1);
    expect(logReadStats().storeReads - before).toBe(SLUGS.length);
  });

  test("inside a pass the log is read once and served from the cache", () => {
    env = switchedWithEvidence();
    const before = logReadStats();
    withLogReadPass(() => {
      for (const slug of SLUGS) expect(evidenceOf(env!.vault, slug).applied).toHaveLength(1);
    });
    const after = logReadStats();
    expect(after.storeReads - before.storeReads).toBe(1);
    expect(after.cacheHits - before.cacheHits).toBe(SLUGS.length - 1);
  });

  test("an event appended during the pass is seen, and the cache ends with the pass", () => {
    env = switchedWithEvidence();
    const vault = env.vault;
    const before = logReadStats().storeReads;
    withLogReadPass(() => {
      expect(evidenceOf(vault, "one").applied).toHaveLength(1);
      appendApplyEvidence(
        vault,
        { pref_id: "pref-one", artifact: "[[notes/b]]", agent: "claude", result: "applied" },
        { now: new Date("2026-11-05T10:00:00Z") },
      );
      expect(evidenceOf(vault, "one").applied).toHaveLength(2);
    });
    expect(logReadStats().storeReads - before).toBe(2);
    evidenceOf(vault, "one");
    expect(logReadStats().storeReads - before).toBe(3);
  });

  test("a reader asking for one day reads that day, not the whole log", () => {
    env = switchedWithEvidence();
    const before = logReadStats().storeReads;
    const reader = logDayReader(env.vault);
    expect(reader.stored).toBe(true);
    expect(reader.day("2026-11-05").entries).toHaveLength(SLUGS.length);
    expect(reader.day("2026-11-04").entries).toHaveLength(0);
    expect(logReadStats().storeReads - before).toBe(0);
    expect(reader.dates).toEqual(["2026-11-05"]);
    expect(logReadStats().storeReads - before).toBe(1);
  });

  test("the days a pass shares cannot be changed by one reader", () => {
    env = switchedWithEvidence();
    withLogReadPass(() => {
      const days = logDayReader(env!.vault).day("2026-11-05").entries as unknown[];
      expect(() => days.pop()).toThrow();
      expect(logDayReader(env!.vault).day("2026-11-05").entries).toHaveLength(SLUGS.length);
    });
  });

  test("a dream pass reads the log fewer times than it has preferences", () => {
    env = switchedWithEvidence();
    const before = logReadStats().storeReads;
    dream(env.vault, { now: new Date("2026-11-06T12:00:00Z"), dryRun: true });
    expect(logReadStats().storeReads - before).toBeLessThan(SLUGS.length);
  });
});

describe("a windowed store reader", () => {
  test("answers a day outside its window, as the legacy reader does", () => {
    env = switchedWithEvidence();
    const reader = logDayReader(env.vault, { from: "2026-11-06", to: "2026-11-07" });
    expect(reader.dates).toEqual([]);
    expect(reader.day("2026-11-05").entries).toHaveLength(SLUGS.length);
  });
});
