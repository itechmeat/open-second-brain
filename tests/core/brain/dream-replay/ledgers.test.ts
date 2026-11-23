/**
 * The ledgers the pass keeps between windows, in the brain store (dream
 * replay task 4.1; spec "Coverage belongs to the brain").
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { dream } from "../../../../src/core/brain/dream.ts";
import {
  crossTopicLedgerOn,
  effectId,
  foldReplayLedgers,
  LEDGER_IMPORT_WINDOW,
  rollupLedgerOf,
} from "../../../../src/core/brain/dream-replay/ledgers.ts";
import {
  DREAM_CROSS_TOPIC_SPENT_KIND,
  DREAM_ROLLUP_BASELINE_KIND,
} from "../../../../src/core/brain/dream-replay/records.ts";
import { crossTopicLedgerPath, rollupLedgerPath } from "../../../../src/core/brain/paths.ts";
import { setBrainSetting } from "../../../../src/core/brain/policy/settings-write.ts";
import { writePreference } from "../../../../src/core/brain/preference.ts";
import {
  makeDreamReplayFixture,
  type DreamReplayFixture,
} from "../../../helpers/dream-replay-fixtures.ts";
import { at, dateOf } from "../../../helpers/dream-replay-scenarios.ts";

let fx: DreamReplayFixture | null = null;
afterEach(() => {
  fx?.cleanup();
  fx = null;
});

function end(day: number): Date {
  return new Date(`${dateOf(day)}T23:59:59.999Z`);
}

function cluster(vault: string, slug: string, topic: string, principle: string): void {
  writePreference(vault, {
    slug,
    topic,
    principle,
    created_at: at(0, 0),
    unconfirmed_until: at(14, 0),
    status: "confirmed",
    confirmed_at: at(0, 0),
    evidenced_by: [],
    scope: "coding",
  });
}

function baseline(value: number, window: string) {
  return {
    rung: "fact",
    baseline: value,
    produced: 1,
    window,
    effect: effectId(window, DREAM_ROLLUP_BASELINE_KIND, "fact"),
  };
}

const ALPHA = "Always pin exact dependency versions in every manifest file.";

describe("dream replay: ledgers in the store", () => {
  test("the folds keep one record per effect id", () => {
    fx = makeDreamReplayFixture();
    const spent = {
      day: dateOf(3),
      owner_token: "",
      window: dateOf(3),
      effect: effectId(dateOf(3), DREAM_CROSS_TOPIC_SPENT_KIND, ""),
    };
    fx.append(DREAM_CROSS_TOPIC_SPENT_KIND, spent);
    fx.append(DREAM_CROSS_TOPIC_SPENT_KIND, spent);

    fx.append(DREAM_ROLLUP_BASELINE_KIND, baseline(20, dateOf(2)));
    // A second record of the same effect (a window finished twice) changes nothing.
    fx.append(DREAM_ROLLUP_BASELINE_KIND, { ...baseline(99, dateOf(2)) });
    fx.append(DREAM_ROLLUP_BASELINE_KIND, baseline(40, dateOf(4)));
    const ledgers = foldReplayLedgers(fx.replayRecords());
    expect([...ledgers.crossTopic.get("")!]).toEqual([dateOf(3)]);
    expect(rollupLedgerOf(ledgers)?.baselines).toEqual({ fact: 40 });
  });

  test("the allowance is judged against the window's day", () => {
    fx = makeDreamReplayFixture();
    fx.append(DREAM_CROSS_TOPIC_SPENT_KIND, {
      day: dateOf(3),
      owner_token: "",
      window: dateOf(3),
      effect: effectId(dateOf(3), DREAM_CROSS_TOPIC_SPENT_KIND, ""),
    });
    const ledgers = foldReplayLedgers(fx.replayRecords());
    expect(crossTopicLedgerOn(ledgers, dateOf(3))?.last_promoted[""]).toBe(dateOf(3));
    expect(crossTopicLedgerOn(ledgers, dateOf(4))?.last_promoted[""]).not.toBe(dateOf(4));
  });

  test("the first replay imports this device's ledger files once, and reads only the store after", () => {
    fx = makeDreamReplayFixture();
    setBrainSetting(
      { vault: fx.vault, authority: "human", agent: "test" },
      "cross_topic.enabled",
      true,
    );
    cluster(fx.vault, "alpha-one", "deps", ALPHA);
    cluster(fx.vault, "alpha-two", "packaging", ALPHA);
    // The device's files say the allowance was spent today.
    const crossPath = crossTopicLedgerPath(fx.vault);
    mkdirSync(dirname(crossPath), { recursive: true });
    writeFileSync(crossPath, JSON.stringify({ version: 1, last_promoted: { "": dateOf(1) } }));
    const rollupPath = rollupLedgerPath(fx.vault);
    writeFileSync(
      rollupPath,
      JSON.stringify({ version: 1, baselines: { fact: 7 }, produced: { fact: 2 } }),
    );
    const first = dream(fx.vault, { now: end(1) });
    expect(first.new_unconfirmed).toEqual([]);
    const imported = fx.replayRecords().filter((r) => r.body["window"] === LEDGER_IMPORT_WINDOW);
    expect(imported.map((r) => r.kind).toSorted()).toEqual([
      DREAM_CROSS_TOPIC_SPENT_KIND,
      DREAM_ROLLUP_BASELINE_KIND,
    ]);
    // The next day spends the allowance; the store records it, the file is left alone.
    dream(fx.vault, { now: end(2) });
    const spent = foldReplayLedgers(fx.replayRecords()).crossTopic.get("");
    expect([...spent!].toSorted()).toEqual([dateOf(1), dateOf(2)]);
    expect(
      fx.replayRecords().filter((r) => r.body["window"] === LEDGER_IMPORT_WINDOW),
    ).toHaveLength(2);
    expect(JSON.parse(readFileSync(crossPath, "utf8")).last_promoted[""]).toBe(dateOf(1));
  });

  test("a replayed pass writes no ledger file", () => {
    fx = makeDreamReplayFixture();
    setBrainSetting(
      { vault: fx.vault, authority: "human", agent: "test" },
      "cross_topic.enabled",
      true,
    );
    cluster(fx.vault, "alpha-one", "deps", ALPHA);
    cluster(fx.vault, "alpha-two", "packaging", ALPHA);
    dream(fx.vault, { now: end(1) });
    expect(existsSync(crossTopicLedgerPath(fx.vault))).toBe(false);
    expect(existsSync(rollupLedgerPath(fx.vault))).toBe(false);
    expect(foldReplayLedgers(fx.replayRecords()).crossTopic.get("")?.has(dateOf(1))).toBe(true);
  });
});
