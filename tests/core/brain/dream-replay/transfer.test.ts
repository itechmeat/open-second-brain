/**
 * The replay across an owner transfer (dream replay task 7.1; spec
 * "Coverage belongs to the brain", the `dream-ownership` delta). Two
 * devices share one store directory; a device's shards held aside stand
 * for records that have not synced yet.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { dream } from "../../../../src/core/brain/dream.ts";
import {
  maintainDreamOwner,
  assertDreamOwner,
} from "../../../../src/core/brain/dream-owner/gate.ts";
import { claimDreamOwner, takeDreamOwner } from "../../../../src/core/brain/dream-owner/owner.ts";
import { foldReplayLedgers } from "../../../../src/core/brain/dream-replay/ledgers.ts";
import { replayStatus } from "../../../../src/core/brain/dream-replay/status-view.ts";
import { setBrainSetting } from "../../../../src/core/brain/policy/settings-write.ts";
import { writePreference } from "../../../../src/core/brain/preference.ts";
import { readStreamRecords } from "../../../../src/core/store/read/stream-read.ts";
import { openStore } from "../../../../src/core/store/store-open.ts";
import {
  makeDreamReplayFixture,
  type DreamReplayFixture,
} from "../../../helpers/dream-replay-fixtures.ts";
import { at, dateOf } from "../../../helpers/dream-replay-scenarios.ts";
import { switchDevice } from "../store-only/fixtures.ts";

let fx: DreamReplayFixture | null = null;
const saved = new Map<string, string | undefined>();
afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  fx?.cleanup();
  fx = null;
});

const human = { writer: "o2b", authority: "human" as const };
const ALPHA = "Always pin exact dependency versions in every manifest file.";

function end(day: number): Date {
  return new Date(`${dateOf(day)}T23:59:59.999Z`);
}

/** Act as `device`, with that machine's own device-local state. */
function asDevice<T>(f: DreamReplayFixture, device: string, fn: () => T): T {
  const keys = ["O2B_DEVICE_ID", "XDG_STATE_HOME", "LOCALAPPDATA"] as const;
  const before = keys.map((key) => process.env[key]);
  process.env["O2B_DEVICE_ID"] = device;
  if (device !== "dev-a") {
    process.env["XDG_STATE_HOME"] = join(f.parent, `state-${device}`);
    process.env["LOCALAPPDATA"] = join(f.parent, `state-${device}`);
  }
  try {
    return fn();
  } finally {
    keys.forEach((key, index) => {
      const value = before[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
}

/** Every `dream-replay` shard folder of `device`, moved between the store and `aside`. */
function moveReplayShards(from: string, to: string): void {
  const folder = join(from, "shared", "dream-replay", "dev-a");
  if (!existsSync(folder)) return;
  const target = join(to, relative(from, folder));
  mkdirSync(dirname(target), { recursive: true });
  renameSync(folder, target);
}

/** dev-a owns the brain, covered days 1 to 5 with a cross-topic promotion; dev-b is switched too. */
function ownedBrain(): DreamReplayFixture {
  const f = makeDreamReplayFixture();
  fx = f;
  for (const key of ["O2B_DEVICE_ID", "XDG_STATE_HOME", "LOCALAPPDATA"]) {
    saved.set(key, process.env[key]);
  }
  setBrainSetting({ vault: f.vault, authority: "human", agent: "t" }, "cross_topic.enabled", true);
  for (const [slug, topic] of [
    ["alpha-one", "deps"],
    ["alpha-two", "packaging"],
  ] as const) {
    writePreference(f.vault, {
      slug,
      topic,
      principle: ALPHA,
      created_at: at(0, 0),
      unconfirmed_until: at(14, 0),
      status: "confirmed",
      confirmed_at: at(0, 0),
      evidenced_by: [],
      scope: "coding",
    });
  }
  f.cover(dateOf(0));
  claimDreamOwner(openStore({ root: f.storeRoot, device: "dev-a" }), "claude", human);
  // The claim settles at the look after the one that first saw it.
  try {
    assertDreamOwner(f.vault, { live: true });
  } catch {
    // first look: unsettled
  }
  dream(f.vault, { now: end(5) });
  asDevice(f, "dev-b", () => switchDevice(f.storeRoot, "dev-b"));
  return f;
}

function releases(f: DreamReplayFixture): Array<Record<string, unknown>> {
  return readStreamRecords(f.storeRoot, "shared", { stream: "settings" })
    .records.filter((r) => r.kind === "dream-owner-released")
    .map((r) => r.body as Record<string, unknown>);
}

function windowsBy(f: DreamReplayFixture, device: string): string[] {
  return f
    .replayRecords()
    .filter((r) => r.kind === "dream-admission" && r.device === device)
    .map((r) => String(r.body["day"]));
}

/** dev-b asks for the role and dev-a's next look releases it. */
function transfer(f: DreamReplayFixture): void {
  asDevice(f, "dev-b", () =>
    takeDreamOwner(openStore({ root: f.storeRoot, device: "dev-b" }), "codex", {
      ...human,
      force: false,
    }),
  );
  expect(maintainDreamOwner(f.vault, f.configPath)).toBe("dev-b");
}

describe("dream replay: an owner transfer", () => {
  test("a release names the last covered window", () => {
    const f = ownedBrain();
    transfer(f);
    const [release] = releases(f);
    expect((release!["covered"] as Record<string, unknown>)["day"]).toBe(dateOf(5));
  });

  test("a new owner that holds the release and not the coverage waits for sync", () => {
    const f = ownedBrain();
    transfer(f);
    const aside = join(f.parent, "unsynced");
    moveReplayShards(f.storeRoot, aside);
    const summary = asDevice(f, "dev-b", () => dream(f.vault, { now: end(7) }));
    expect(summary.windows?.outcome).toBe("waiting-for-sync");
    expect(summary.warnings.map((w) => w.code)).toContain("dream-replay-waiting-sync");
    expect(windowsBy(f, "dev-b")).toEqual([]);
    const status = asDevice(f, "dev-b", () => replayStatus(f.vault, { now: end(7) }));
    expect(status.available && status.waitingForSync).toBeTruthy();
    moveReplayShards(aside, f.storeRoot);
    // Synced: it starts at the next window and spends no allowance twice.
    asDevice(f, "dev-b", () => dream(f.vault, { now: end(7) }));
    expect(windowsBy(f, "dev-b")).toEqual([dateOf(6), dateOf(7)]);
    const ledgers = foldReplayLedgers(f.replayRecords());
    const spent = f.replayRecords().filter((r) => r.kind === "dream-cross-topic-spent");
    expect(spent).toHaveLength(ledgers.effects.size);
    expect([...ledgers.crossTopic.get("")!]).toEqual([dateOf(1)]);
  });

  test("a forced takeover continues from what it holds and says what may be missing", () => {
    const f = ownedBrain();
    asDevice(f, "dev-b", () =>
      takeDreamOwner(openStore({ root: f.storeRoot, device: "dev-b" }), "codex", {
        ...human,
        force: true,
      }),
    );
    const status = asDevice(f, "dev-b", () => replayStatus(f.vault, { now: end(7) }));
    expect(status.available && status.forced).toBe(true);
    asDevice(f, "dev-b", () => {
      try {
        assertDreamOwner(f.vault, { live: true });
      } catch {
        // first look: unsettled
      }
      dream(f.vault, { now: end(7) });
    });
    expect(windowsBy(f, "dev-b")).toEqual([dateOf(6), dateOf(7)]);
  });

  test("coverage from the old owner that arrives later folds to the highest day, one effect each", () => {
    const f = ownedBrain();
    const aside = join(f.parent, "unsynced");
    moveReplayShards(f.storeRoot, aside);
    asDevice(f, "dev-b", () => {
      takeDreamOwner(openStore({ root: f.storeRoot, device: "dev-b" }), "codex", {
        ...human,
        force: true,
      });
      try {
        assertDreamOwner(f.vault, { live: true });
      } catch {
        // first look: unsettled
      }
      dream(f.vault, { now: end(3) });
    });
    moveReplayShards(aside, f.storeRoot);
    expect(f.replayState().lastCovered).toBe(dateOf(5));
    // The allowance both devices spent on day 1 counts once.
    const rules = new Set(
      f
        .replayRecords()
        .filter((r) => r.kind === "dream-cross-topic-spent")
        .map((r) => r.body["day"]),
    );
    expect([...rules]).toEqual([dateOf(1)]);
  });
});
