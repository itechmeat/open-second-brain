/**
 * Records of the replay never carry private content into `shared`
 * (FORMAT.md "Partitions"): a window that reads private signals or
 * evidence freezes what it read into its plan, admission and bootstrap
 * records, and those go to `private` the way every other writer's
 * private-derived records do.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dream } from "../../../../src/core/brain/dream.ts";
import type { DreamRunSummary } from "../../../../src/core/brain/dream-types.ts";
import { replayWindows } from "../../../../src/core/brain/dream-replay/loop.ts";
import * as passModule from "../../../../src/core/brain/dream-replay/pass.ts";
import { openReplayPass } from "../../../../src/core/brain/dream-replay/pass.ts";
import type { FrozenWindow } from "../../../../src/core/brain/dream-replay/plan.ts";
import { loadBrainConfig } from "../../../../src/core/brain/policy/load.ts";
import { appendRecord } from "../../../../src/core/store/appender.ts";
import { openStore } from "../../../../src/core/store/store-open.ts";
import {
  DREAM_ADMISSION_KIND,
  DREAM_ADMISSION_PRIVATE_KIND,
  DREAM_BOOTSTRAP_KIND,
  DREAM_COVERAGE_KIND,
  DREAM_REPLAY_RECORD_KINDS,
  DREAM_REPLAY_STREAM,
  DREAM_WINDOW_PLAN_KIND,
} from "../../../../src/core/brain/dream-replay/records.ts";
import { writeSignal } from "../../../../src/core/brain/signal.ts";
import { STORE_ROOT_CONFIG_KEY, STORE_ROOT_ENV } from "../../../../src/core/store/constants.ts";
import {
  makeDreamReplayFixture,
  type DreamReplayFixture,
} from "../../../helpers/dream-replay-fixtures.ts";
import { dumpStore, firstDreamHistoryDifference } from "../../../helpers/dream-history.ts";
import { at, dateOf } from "../../../helpers/dream-replay-scenarios.ts";
import { partitionRecords } from "../store-only/fixtures.ts";

const opened: DreamReplayFixture[] = [];
afterEach(() => {
  for (const f of opened.splice(0).toReversed()) f.cleanup();
});

const SECRET = "Route every request through the clinic proxy.";

function replayRecords(f: DreamReplayFixture, partition: "shared" | "private") {
  const kinds: ReadonlySet<string> = new Set(DREAM_REPLAY_RECORD_KINDS);
  return partitionRecords(f.storeRoot, partition).filter((r) => kinds.has(r.kind));
}

/** Three private signals of one topic from three agents: a promotion candidate. */
function privateBacklog(f: DreamReplayFixture, lateDay?: number): string[] {
  const ids: string[] = [];
  for (const [slug, agent, day] of [
    ["p1", "claude", 1],
    ["p2", "codex", 1],
    ["p3", "hermes", lateDay ?? 2],
  ] as const) {
    const written = writeSignal(f.vault, {
      topic: "proxy",
      signal: "positive",
      agent,
      principle: `${SECRET} <private>clinic</private>`,
      created_at: at(day, 9),
      date: dateOf(day),
      slug,
      scope: "coding",
    });
    ids.push(written.id);
  }
  return ids;
}

function sharedText(f: DreamReplayFixture): string {
  return JSON.stringify(replayRecords(f, "shared").map((r) => r.body));
}

/**
 * A brain covered through day 3 that sees late private signals on day 4,
 * its day-4 pass stopped before the second record of the admission's pair
 * when `stopBetween`, then finished by a new pass.
 */
function passOverLatePrivate(stopBetween: boolean): { f: DreamReplayFixture; ids: string[] } {
  const f = makeDreamReplayFixture();
  opened.push(f);
  f.cover(dateOf(2));
  dream(f.vault, { now: new Date(`${dateOf(3)}T23:00:00.000Z`) });
  const ids = privateBacklog(f, 1);
  const day4 = new Date(`${dateOf(4)}T23:00:00.000Z`);
  if (stopBetween) {
    // Stop right before the second record of the admission's pair,
    // whichever of the two the pass writes first.
    const pair: ReadonlySet<string> = new Set([DREAM_ADMISSION_KIND, DREAM_ADMISSION_PRIVATE_KIND]);
    const original = passModule.writeReplayRecord;
    let previous: string | null = null;
    const spy = spyOn(passModule, "writeReplayRecord").mockImplementation(
      (pass, kind, body, isPrivate) => {
        if (pair.has(kind) && previous !== null && pair.has(previous) && previous !== kind) {
          throw new Error("stopped between the admission records");
        }
        previous = kind;
        return original(pass, kind, body, isPrivate);
      },
    );
    try {
      expect(() => dream(f.vault, { now: day4 })).toThrow("stopped between the admission records");
    } finally {
      spy.mockRestore();
    }
  }
  dream(f.vault, { now: day4 });
  return { f, ids };
}

describe("dream replay: private inputs stay out of shared", () => {
  test("a plan and a bootstrap derived from private signals go to private", () => {
    const f = makeDreamReplayFixture();
    opened.push(f);
    const ids = privateBacklog(f);
    expect(partitionRecords(f.storeRoot, "private").some((r) => r.kind === "signal")).toBe(true);
    dream(f.vault, { now: new Date(`${dateOf(3)}T23:00:00.000Z`) });
    const text = sharedText(f);
    expect(text).not.toContain("clinic proxy");
    for (const id of ids) expect(text).not.toContain(id);
    const shared = replayRecords(f, "shared");
    const kinds = (rs: typeof shared) => new Set(rs.map((r) => r.kind));
    // Coverage is about the brain, not about any record: it stays shared.
    expect(kinds(shared).has(DREAM_COVERAGE_KIND)).toBe(true);
    expect(shared.some((r) => r.kind === DREAM_BOOTSTRAP_KIND)).toBe(false);
    const privateKinds = kinds(replayRecords(f, "private"));
    expect(privateKinds.has(DREAM_WINDOW_PLAN_KIND)).toBe(true);
    expect(privateKinds.has(DREAM_BOOTSTRAP_KIND)).toBe(true);
    // The fold of this device sees both partitions: nothing is behind.
    expect(f.replayState().lastCovered).toBe(dateOf(3));
  });

  test("a late private record is admitted in private; the shared admission keeps the positions", () => {
    const f = makeDreamReplayFixture();
    opened.push(f);
    f.cover(dateOf(2));
    dream(f.vault, { now: new Date(`${dateOf(3)}T23:00:00.000Z`) });
    const ids = privateBacklog(f, 1);
    dream(f.vault, { now: new Date(`${dateOf(4)}T23:00:00.000Z`) });
    const text = sharedText(f);
    for (const id of ids) expect(text).not.toContain(id);
    const sharedAdmission = replayRecords(f, "shared").filter(
      (r) => r.kind === DREAM_ADMISSION_KIND && r.body["day"] === dateOf(4),
    );
    expect(sharedAdmission).toHaveLength(1);
    expect((sharedAdmission[0]!.body["positions"] as unknown[]).length).toBeGreaterThan(0);
    // This device still judges the late records by the window that admitted them.
    const state = f.replayState();
    expect(state.privateAdmitted.size).toBe(ids.length);
    for (const id of state.privateAdmitted) {
      expect(state.effective.get(id)).toBe(`${dateOf(4)}T00:00:00.000Z`);
    }
    // The shared admission names none of them; the late records' private part does.
    const late = sharedAdmission[0]!.body["late"] as unknown[];
    expect(late).toHaveLength(0);
  });

  test("an admission whose private part has not synced here waits instead of losing its late times", () => {
    const f = makeDreamReplayFixture();
    opened.push(f);
    f.cover(dateOf(2));
    dream(f.vault, { now: new Date(`${dateOf(3)}T23:00:00.000Z`) });
    // Another device admitted and covered day 4 with a late private record;
    // its private part is still on its way here.
    const other = openStore({ root: f.storeRoot, device: "dev-b" });
    const late = [{ id: "sig-late-private", at: `${dateOf(4)}T00:00:00.000Z` }];
    const part = appendRecord(other, {
      partition: "private",
      stream: DREAM_REPLAY_STREAM,
      kind: DREAM_ADMISSION_PRIVATE_KIND,
      agent: "o2b",
      body: { day: dateOf(4), window: dateOf(4), late, clamped: [], run: "other" },
    }).record.id;
    const dir = join(f.storeRoot, "private", DREAM_REPLAY_STREAM, "dev-b");
    const [shard] = readdirSync(dir);
    const aside = join(f.parent, "replay-private-aside");
    renameSync(join(dir, shard!), aside);
    const admission = appendRecord(other, {
      partition: "shared",
      stream: DREAM_REPLAY_STREAM,
      kind: DREAM_ADMISSION_KIND,
      agent: "o2b",
      body: {
        day: dateOf(4),
        window: dateOf(4),
        from: `${dateOf(4)}T00:00:00.000Z`,
        to: `${dateOf(4)}T23:59:59.999Z`,
        positions: [...(f.replayState().positions ?? [])],
        gaps: [],
        late: [],
        clamped: [],
        left_out: [],
        rebased: null,
        admitted_at: `${dateOf(4)}T23:00:00.000Z`,
        run: "other",
        private_part: part,
      },
    }).record.id;
    appendRecord(other, {
      partition: "shared",
      stream: DREAM_REPLAY_STREAM,
      kind: DREAM_COVERAGE_KIND,
      agent: "o2b",
      body: {
        day: dateOf(4),
        window: dateOf(4),
        admission,
        plan: null,
        owner: null,
        run: "other",
        behind: 0,
      },
    });
    const day5 = new Date(`${dateOf(5)}T23:00:00.000Z`);
    const days = () =>
      replayRecords(f, "shared")
        .filter((r) => r.kind === DREAM_ADMISSION_KIND)
        .map((r) => r.body["day"]);
    const waiting = dream(f.vault, { now: day5 });
    expect(waiting.warnings.map((w) => w.code)).toContain("dream-replay-waiting-sync");
    expect(days()).not.toContain(dateOf(5));
    renameSync(aside, join(dir, shard!));
    dream(f.vault, { now: day5 });
    expect(days()).toContain(dateOf(5));
    expect(f.replayState().effective.get("sig-late-private")).toBe(late[0]!.at);
  });

  test("a pass given a config path judges privacy from that config's store, not the default one", () => {
    const f = makeDreamReplayFixture();
    opened.push(f);
    f.cover(dateOf(2));
    const ids = privateBacklog(f, 1);
    const now = new Date(`${dateOf(3)}T23:00:00.000Z`);
    const cfg = loadBrainConfig(f.vault);
    // The pass's store is named only by the config it is given; the
    // default config names a store root that holds nothing.
    const passConfig = join(f.parent, "pass-config.yaml");
    writeFileSync(passConfig, `vault: ${f.vault}\n${STORE_ROOT_CONFIG_KEY}: ${f.storeRoot}\n`);
    writeFileSync(
      f.configPath,
      `vault: ${f.vault}\n${STORE_ROOT_CONFIG_KEY}: ${join(f.parent, "no-store")}\n`,
    );
    delete process.env[STORE_ROOT_ENV];
    const opts = { now, configPath: passConfig };
    const pass = openReplayPass(
      f.vault,
      openStore({ root: f.storeRoot, device: "dev-a" }),
      opts,
      now,
      "run-config",
    );
    expect(pass).not.toBeNull();
    // A window body that plans to consume the private signals: its plan names them.
    const frozen = {
      plan: {
        newUnconfirmed: [],
        crossTopicRules: [],
        retires: [],
        signalsToMove: new Map(ids.map((id) => [id, "moved"])),
        signalsToArchive: new Map(),
      },
      refresh: { updated: new Map() },
      reconciliations: [],
      admittedIds: ids,
    } as unknown as FrozenWindow;
    const summary = { changed: true, warnings: [] } as unknown as DreamRunSummary;
    replayWindows({
      vault: f.vault,
      pass: pass!,
      opts,
      cfg,
      evaluate: (window) => {
        window.beforeEffects(frozen);
        return summary;
      },
      noWindow: () => summary,
    });
    const text = sharedText(f);
    for (const id of ids) expect(text).not.toContain(id);
    expect(replayRecords(f, "private").some((r) => r.kind === DREAM_WINDOW_PLAN_KIND)).toBe(true);
    expect(f.replayState().lastCovered).toBe(dateOf(3));
  });

  test("a stop between an admission's private and shared records, then a new pass, ends in the uninterrupted records", () => {
    const reference = passOverLatePrivate(false);
    const expected = dumpStore(reference.f.storeRoot);
    const expectedState = reference.f.replayState();
    expect(expectedState.privateAdmitted.size).toBe(reference.ids.length);
    const interrupted = passOverLatePrivate(true);
    const state = interrupted.f.replayState();
    expect(state.lastCovered).toBe(dateOf(4));
    expect([...state.privateAdmitted].length).toBe(expectedState.privateAdmitted.size);
    for (const id of state.privateAdmitted) {
      expect(state.effective.get(id)).toBe(`${dateOf(4)}T00:00:00.000Z`);
    }
    expect(firstDreamHistoryDifference(expected, dumpStore(interrupted.f.storeRoot))).toBeNull();
  });
});
