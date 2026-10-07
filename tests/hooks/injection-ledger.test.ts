import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  LEDGER_KEY_ACTIVE,
  LEDGER_KEY_RECALL,
  LEDGER_KEY_REGROUND,
  LEDGER_TTL_MS,
  RECALL_SET_MAX,
  beginInjectionEpoch,
  digestNotePaths,
  isRealSessionId,
  readActiveEmittedPaths,
  readRecallInjected,
  recordRecallInjected,
  takeRegroundPart,
} from "../../hooks/lib/injection-ledger.ts";
import {
  hookStateFilePath,
  readHookStamp,
  updateHookState,
  writeHookStamp,
} from "../../hooks/lib/session-state.ts";
import { _resetHeldLocksForTests } from "../../src/core/brain/sync-lockfile.ts";
import { IS_WINDOWS } from "../helpers/platform.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-ledger-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const NOW = 10_000_000;

function holdLock(sessionId: string): string {
  const lockPath = hookStateFilePath(vault, sessionId) + ".lock";
  mkdirSync(join(vault, ".open-second-brain", "hook-state"), { recursive: true });
  writeFileSync(lockPath, "held by another process\n");
  return lockPath;
}

/** How many times `run` sleeps through `Atomics.wait` (the lock retry's sleep). */
function countRetrySleeps(run: () => void): number {
  const original = Atomics.wait;
  let calls = 0;
  Atomics.wait = ((...args: Parameters<typeof Atomics.wait>) => {
    calls += 1;
    return original(...args);
  }) as typeof Atomics.wait;
  try {
    run();
  } finally {
    Atomics.wait = original;
  }
  return calls;
}

function seedQueue(sessionId: string, parts: ReadonlyArray<string>, epoch = "ep-1"): void {
  expect(
    beginInjectionEpoch(
      vault,
      sessionId,
      { epoch, emittedPaths: [], regroundParts: parts, partCeilingChars: 9000 },
      NOW,
    ),
  ).toBe(true);
}

describe("isRealSessionId", () => {
  test("accepts a non-empty string", () => {
    expect(isRealSessionId("sess-1")).toBe(true);
  });

  test("rejects undefined, null, empty, separator-only and non-strings", () => {
    for (const value of [undefined, null, "", "   ", "\t", "---", "::", 42, {}, ["s"]]) {
      expect(isRealSessionId(value)).toBe(false);
    }
  });
});

describe("recall injected set", () => {
  test("missing ledger reads as an empty set", () => {
    expect(readRecallInjected(vault, "sess-1", NOW).size).toBe(0);
  });

  test("records merge and read back until the TTL passes", () => {
    expect(recordRecallInjected(vault, "sess-1", ["k1", "k2"], NOW)).toBe(true);
    expect(recordRecallInjected(vault, "sess-1", ["k2", "k3"], NOW + 1000)).toBe(true);
    const live = readRecallInjected(vault, "sess-1", NOW + 2000);
    expect([...live].toSorted()).toEqual(["k1", "k2", "k3"]);
    // The TTL is refreshed on every write.
    expect(readRecallInjected(vault, "sess-1", NOW + 1000 + LEDGER_TTL_MS - 1).size).toBe(3);
    expect(readRecallInjected(vault, "sess-1", NOW + 1000 + LEDGER_TTL_MS).size).toBe(0);
  });

  test("an expired set is not merged into a new record", () => {
    recordRecallInjected(vault, "sess-1", ["old"], NOW);
    recordRecallInjected(vault, "sess-1", ["new"], NOW + LEDGER_TTL_MS + 1);
    expect([...readRecallInjected(vault, "sess-1", NOW + LEDGER_TTL_MS + 2)]).toEqual(["new"]);
  });

  test("the set keeps only the most recent RECALL_SET_MAX keys", () => {
    const keys = Array.from({ length: RECALL_SET_MAX + 5 }, (_, i) => `k${i}`);
    expect(recordRecallInjected(vault, "sess-1", keys.slice(0, 10), NOW)).toBe(true);
    expect(recordRecallInjected(vault, "sess-1", keys.slice(10), NOW + 1)).toBe(true);
    const live = readRecallInjected(vault, "sess-1", NOW + 2);
    expect(live.size).toBe(RECALL_SET_MAX);
    for (const dropped of keys.slice(0, 5)) expect(live.has(dropped)).toBe(false);
    expect(live.has(keys[5]!)).toBe(true);
    expect(live.has(keys.at(-1)!)).toBe(true);
  });

  test("a malformed payload reads as an empty set", () => {
    const path = hookStateFilePath(vault, "sess-1");
    mkdirSync(join(vault, ".open-second-brain", "hook-state"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ [LEDGER_KEY_RECALL]: { expiresAt: NOW + 5000, data: { keys: "nope" } } }),
    );
    expect(readRecallInjected(vault, "sess-1", NOW).size).toBe(0);
  });
});

describe("digestNotePaths", () => {
  test("maps every rendered preference bullet and dedupes repeats", () => {
    const paths = digestNotePaths({
      emittedText:
        "- `pref-alpha` (confidence: high) — rule\n- `pref-beta-2` — rule\n- `pref-alpha` (applied_in_window: 3)",
      activeBodyEmitted: false,
      lessonsBodyEmitted: false,
    });
    expect(paths).toEqual(["Brain/preferences/pref-alpha.md", "Brain/preferences/pref-beta-2.md"]);
  });

  test("adds active.md and lessons.md only when flagged", () => {
    const both = digestNotePaths({
      emittedText: "",
      activeBodyEmitted: true,
      lessonsBodyEmitted: true,
    });
    expect(both).toEqual(["Brain/active.md", "Brain/lessons.md"]);
    const lessonsOnly = digestNotePaths({
      emittedText: "- `pref-x` — rule",
      activeBodyEmitted: false,
      lessonsBodyEmitted: true,
    });
    expect(lessonsOnly).toEqual(["Brain/lessons.md", "Brain/preferences/pref-x.md"]);
  });

  test("a backticked pref token quoted in prose is not a delivered preference", () => {
    expect(
      digestNotePaths({
        emittedText: [
          "- `lesson-1` (tags: x) — remember `pref-x` when editing",
          "Quoted in active.md: see `pref-y` for details.",
          "  - `pref-z` nested quote",
          "- `pref-real` (confidence: high) — a rendered rule",
        ].join("\n"),
        activeBodyEmitted: false,
        lessonsBodyEmitted: false,
      }),
    ).toEqual(["Brain/preferences/pref-real.md"]);
  });

  test("ignores a pref word outside backticks", () => {
    expect(
      digestNotePaths({
        emittedText: "see pref-alpha in prose",
        activeBodyEmitted: false,
        lessonsBodyEmitted: false,
      }),
    ).toEqual([]);
  });
});

describe("beginInjectionEpoch", () => {
  test.skipIf(IS_WINDOWS)("writes the state file private (mode 0o600)", () => {
    seedQueue("sess-1", ["part-2"]);
    expect(statSync(hookStateFilePath(vault, "sess-1")).mode & 0o777).toBe(0o600);
  });

  test("sets the active set, clears the recall set and replaces the queue in one write", () => {
    recordRecallInjected(vault, "sess-1", ["k1"], NOW);
    seedQueue("sess-1", ["old-2", "old-3"], "ep-old");
    expect(
      beginInjectionEpoch(
        vault,
        "sess-1",
        {
          epoch: "ep-new",
          emittedPaths: ["Brain/active.md", "Brain/preferences/pref-a.md"],
          regroundParts: ["new-2"],
          partCeilingChars: 4000,
        },
        NOW + 10,
      ),
    ).toBe(true);
    expect([...readActiveEmittedPaths(vault, "sess-1", NOW + 20)]).toEqual([
      "Brain/active.md",
      "Brain/preferences/pref-a.md",
    ]);
    expect(readRecallInjected(vault, "sess-1", NOW + 20).size).toBe(0);
    expect(readHookStamp(vault, "sess-1", LEDGER_KEY_RECALL, NOW + 20)).toBeNull();
    const take = takeRegroundPart(vault, "sess-1", NOW + 30);
    expect(take).toEqual({
      status: "part",
      part: "new-2",
      index: 2,
      total: 2,
      epoch: "ep-new",
      partCeilingChars: 4000,
    });
  });

  test("an empty part list deletes the queue", () => {
    seedQueue("sess-1", ["p2"]);
    beginInjectionEpoch(
      vault,
      "sess-1",
      { epoch: "ep-2", emittedPaths: [], regroundParts: [], partCeilingChars: 9000 },
      NOW + 5,
    );
    expect(readHookStamp(vault, "sess-1", LEDGER_KEY_REGROUND, NOW + 6)).toBeNull();
    expect(takeRegroundPart(vault, "sess-1", NOW + 6)).toEqual({ status: "empty" });
  });

  test("repeated emitted paths are stored once", () => {
    beginInjectionEpoch(
      vault,
      "sess-1",
      {
        epoch: "e",
        emittedPaths: ["Brain/active.md", "Brain/active.md", "Brain/preferences/pref-a.md"],
        regroundParts: [],
        partCeilingChars: 9000,
      },
      NOW,
    );
    expect(readHookStamp(vault, "sess-1", LEDGER_KEY_ACTIVE, NOW)!.data!["paths"]).toEqual([
      "Brain/active.md",
      "Brain/preferences/pref-a.md",
    ]);
  });

  test("the active set expires after the TTL", () => {
    beginInjectionEpoch(
      vault,
      "sess-1",
      { epoch: "e", emittedPaths: ["Brain/active.md"], regroundParts: [], partCeilingChars: 9000 },
      NOW,
    );
    expect(readHookStamp(vault, "sess-1", LEDGER_KEY_ACTIVE, NOW)).not.toBeNull();
    expect(readActiveEmittedPaths(vault, "sess-1", NOW + LEDGER_TTL_MS).size).toBe(0);
  });
});

describe("takeRegroundPart", () => {
  test("returns parts 2..n in order, then empty", () => {
    seedQueue("sess-1", ["p2", "p3", "p4"]);
    const got = [1, 2, 3].map(() => takeRegroundPart(vault, "sess-1", NOW + 1));
    expect(got.map((t) => (t.status === "part" ? [t.part, t.index, t.total] : t.status))).toEqual([
      ["p2", 2, 4],
      ["p3", 3, 4],
      ["p4", 4, 4],
    ]);
    expect(takeRegroundPart(vault, "sess-1", NOW + 1)).toEqual({ status: "empty" });
    expect(takeRegroundPart(vault, "sess-1", NOW + 1)).toEqual({ status: "empty" });
  });

  test("taking the last part deletes the queue key", () => {
    seedQueue("sess-1", ["p2", "p3"]);
    takeRegroundPart(vault, "sess-1", NOW + 1);
    expect(readHookStamp(vault, "sess-1", LEDGER_KEY_REGROUND, NOW + 1)).not.toBeNull();
    expect(takeRegroundPart(vault, "sess-1", NOW + 2)).toMatchObject({ status: "part", index: 3 });
    expect(readStateKeys("sess-1")).not.toContain(LEDGER_KEY_REGROUND);
  });

  test("no queue reads as empty without creating a state file", () => {
    expect(takeRegroundPart(vault, "sess-1", NOW)).toEqual({ status: "empty" });
    expect(existsSync(hookStateFilePath(vault, "sess-1"))).toBe(false);
  });

  test("a queue whose cursor is not a non-negative integer reads as empty and is deleted", () => {
    for (const next of [-1, 1.5]) {
      seedQueue("sess-1", ["p2", "p3"]);
      const queue = readHookStamp(vault, "sess-1", LEDGER_KEY_REGROUND, NOW)!;
      writeHookStamp(vault, "sess-1", LEDGER_KEY_REGROUND, {
        expiresAt: queue.expiresAt,
        data: { ...queue.data, next },
      });
      expect(takeRegroundPart(vault, "sess-1", NOW + 1)).toEqual({ status: "empty" });
      expect(readStateKeys("sess-1")).not.toContain(LEDGER_KEY_REGROUND);
    }
  });

  test("a queue from an older epoch than the active one reads as empty and is deleted", () => {
    seedQueue("sess-1", ["p2", "p3"], "ep-a");
    writeHookStamp(vault, "sess-1", LEDGER_KEY_ACTIVE, {
      expiresAt: NOW + LEDGER_TTL_MS,
      data: { epoch: "ep-b", paths: [] },
    });
    expect(takeRegroundPart(vault, "sess-1", NOW + 1)).toEqual({ status: "empty" });
    expect(readStateKeys("sess-1")).not.toContain(LEDGER_KEY_REGROUND);
  });

  test("an expired queue reads as empty", () => {
    seedQueue("sess-1", ["p2"]);
    expect(takeRegroundPart(vault, "sess-1", NOW + LEDGER_TTL_MS)).toEqual({ status: "empty" });
  });

  test("busy while the lock is held, and the undelivered part survives", () => {
    seedQueue("sess-1", ["p2", "p3"]);
    const lockPath = holdLock("sess-1");
    try {
      // Count the retry sleeps instead of timing them: the bounded retry
      // sleeps between attempts through Atomics.wait, a try-once take never
      // sleeps. A count does not drift on a loaded runner the way latency does.
      const sleeps = countRetrySleeps(() => {
        expect(updateHookState(vault, "sess-1", (state) => ({ state, result: null }))).toEqual({
          status: "busy",
        });
      });
      expect(sleeps).toBeGreaterThan(0);
      expect(
        countRetrySleeps(() => {
          expect(takeRegroundPart(vault, "sess-1", NOW + 1)).toEqual({ status: "busy" });
        }),
      ).toBe(0);
    } finally {
      unlinkSync(lockPath);
      _resetHeldLocksForTests();
    }
    const next = takeRegroundPart(vault, "sess-1", NOW + 2);
    expect(next.status === "part" && next.index).toBe(2);
    const after = takeRegroundPart(vault, "sess-1", NOW + 3);
    expect(after.status === "part" && after.index).toBe(3);
    expect(takeRegroundPart(vault, "sess-1", NOW + 4)).toEqual({ status: "empty" });
  });
});

describe("session isolation", () => {
  test("a session id with separators, dots or NUL keeps its ledger inside hook-state", () => {
    const stateDir = join(vault, ".open-second-brain", "hook-state");
    for (const id of ["../../outside", "a/b\\c", "sess.1", "x\u0000y", ".hidden"]) {
      expect(isRealSessionId(id)).toBe(true);
      expect(recordRecallInjected(vault, id, [`k-${id.length}`], NOW)).toBe(true);
      const path = hookStateFilePath(vault, id);
      expect(dirname(path)).toBe(stateDir);
      // A lossy id gets the hashed scope name, still inside the scope-file shape.
      expect(basename(path)).toMatch(/^[a-z0-9-]{1,64}\.json$/);
      expect(readRecallInjected(vault, id, NOW).has(`k-${id.length}`)).toBe(true);
    }
    expect(readdirSync(vault).toSorted()).toEqual([".open-second-brain"]);
    expect(readdirSync(stateDir).filter((name) => name.endsWith(".json"))).toHaveLength(5);
  });

  test("every key is scoped per session id", () => {
    recordRecallInjected(vault, "sess-a", ["k1"], NOW);
    beginInjectionEpoch(
      vault,
      "sess-a",
      {
        epoch: "e",
        emittedPaths: ["Brain/active.md"],
        regroundParts: ["p2"],
        partCeilingChars: 9000,
      },
      NOW,
    );
    recordRecallInjected(vault, "sess-a", ["k2"], NOW);
    expect(readRecallInjected(vault, "sess-b", NOW).size).toBe(0);
    expect(readActiveEmittedPaths(vault, "sess-b", NOW).size).toBe(0);
    expect(takeRegroundPart(vault, "sess-b", NOW)).toEqual({ status: "empty" });
    expect([...readRecallInjected(vault, "sess-a", NOW)]).toEqual(["k2"]);
    expect(readActiveEmittedPaths(vault, "sess-a", NOW).size).toBe(1);
    expect(takeRegroundPart(vault, "sess-a", NOW)).toMatchObject({ status: "part", index: 2 });
  });
});

function readStateKeys(sessionId: string): string[] {
  return Object.keys(
    JSON.parse(readFileSync(hookStateFilePath(vault, sessionId), "utf8")) as Record<
      string,
      unknown
    >,
  );
}
