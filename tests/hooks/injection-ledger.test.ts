import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LEDGER_KEY_ACTIVE,
  LEDGER_KEY_RECALL,
  LEDGER_KEY_REGROUND,
  LEDGER_TTL_MS,
  beginInjectionEpoch,
  digestNotePaths,
  isRealSessionId,
  readActiveEmittedPaths,
  readRecallInjected,
  recordRecallInjected,
  takeRegroundPart,
} from "../../hooks/lib/injection-ledger.ts";
import * as sessionState from "../../hooks/lib/session-state.ts";
import { hookStateFilePath, readHookStamp, writeHookStamp } from "../../hooks/lib/session-state.ts";
import { _resetHeldLocksForTests } from "../../src/core/brain/sync-lockfile.ts";

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

  test("rejects undefined, null, empty and non-strings", () => {
    for (const value of [undefined, null, "", "   ", "\t", 42, {}, ["s"]]) {
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
  test("maps every pref token and dedupes repeats", () => {
    const paths = digestNotePaths({
      emittedText: "- `pref-alpha` rule\n- `pref-beta-2` rule\n- again `pref-alpha`",
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
      emittedText: "`pref-x`",
      activeBodyEmitted: false,
      lessonsBodyEmitted: true,
    });
    expect(lessonsOnly).toEqual(["Brain/lessons.md", "Brain/preferences/pref-x.md"]);
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
      const update = spyOn(sessionState, "updateHookState");
      try {
        expect(takeRegroundPart(vault, "sess-1", NOW + 1)).toEqual({ status: "busy" });
        // One lock attempt, never the retry loop.
        expect(update).toHaveBeenCalledTimes(1);
        expect(update.mock.calls[0]![3]).toMatchObject({ tryOnce: true });
      } finally {
        update.mockRestore();
      }
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

  test("alternating sequential takers advance one shared cursor", () => {
    seedQueue("sess-1", ["p2", "p3", "p4", "p5", "p6"]);
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const takeA = takeRegroundPart(vault, "sess-1", NOW + i);
      const takeB = takeRegroundPart(vault, "sess-1", NOW + i);
      for (const take of [takeA, takeB]) if (take.status === "part") seen.push(take.index);
    }
    expect(seen).toEqual([2, 3, 4, 5, 6]);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("session isolation", () => {
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
