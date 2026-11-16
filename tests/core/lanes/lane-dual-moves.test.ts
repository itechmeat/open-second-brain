/**
 * A lane removal or move on an unswitched machine with the dual write on
 * (task 3.12 review): the page's store entry, which the dual write put
 * there, is removed or moved with it, so after the switch the store holds
 * what the legacy tree held. A page that never reached the store is moved
 * or removed as a file alone.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { STORE_DUAL_WRITE_ENV } from "../../../src/core/store/constants.ts";
import {
  moveLanePage,
  moveLaneTree,
  removeLanePage,
  removeLaneTree,
  writeLanePage,
  writeLaneText,
} from "../../../src/core/store/lane-pages.ts";
import { foldIncomplete } from "../../../src/core/store/lane-entry-store.ts";
import { foldLaneEntries } from "../../../src/core/store/lane-records.ts";
import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import { makeLaneEnv, type LaneEnv } from "./fixtures/lane-env.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

/** The live entries of `records` (default: the whole store), by `<lane>/<entry>`, with their trimmed text. */
const liveTexts = (env: LaneEnv, records: StoreRecord[] = env.laneRecords()) =>
  Object.fromEntries(
    [...foldLaneEntries(records).entries]
      .filter(([, state]) => !state.removed)
      .map(([key, state]) => [key, state.value!.text.trim()])
      .toSorted(([a], [b]) => a!.localeCompare(b!)),
  );

/** The live entries of the store, by `<lane>/<entry>`. */
const live = (env: LaneEnv) => Object.keys(liveTexts(env));

/** Run `fn` with the dual write off: a write the store never sees. */
function legacyOnly(fn: () => void): void {
  delete process.env[STORE_DUAL_WRITE_ENV];
  try {
    fn();
  } finally {
    process.env[STORE_DUAL_WRITE_ENV] = "1";
  }
}

describe("an unswitched machine with the dual write on", () => {
  test("removes and moves the stored entries with the pages, one by one and by folder", () => {
    lane = makeLaneEnv("legacy", "osb-lane-dual-moves-");
    const { vault } = lane;
    const deadEnds = join(vault, "Brain", "dead-ends");
    writeLanePage(vault, join(deadEnds, "de-a.md"), { kind: "brain-dead-end" }, "A.\n");
    writeLanePage(vault, join(deadEnds, "de-b.md"), { kind: "brain-dead-end" }, "B.\n");
    const staged = join(vault, "Brain", "dream", "staged");
    writeLaneText(vault, join(staged, "s1", "manifest.json"), '{"schema":"x"}\n');
    writeLaneText(vault, join(staged, "s2", "manifest.json"), '{"schema":"y"}\n');

    removeLanePage(vault, join(deadEnds, "de-a.md"));
    moveLanePage(vault, join(deadEnds, "de-b.md"), join(deadEnds, "archive", "de-b.md"));
    moveLaneTree(vault, join(staged, "s1"), join(vault, "Brain", "dream", "applied", "s1"));
    removeLaneTree(vault, join(staged, "s2"));

    expect(live(lane)).toEqual(["dead-ends/archive/de-b", "dream/applied/s1/manifest.json"]);
  });

  test("leaves the store alone for a page that never reached it", () => {
    lane = makeLaneEnv("legacy", "osb-lane-dual-legacy-only-");
    const { vault } = lane;
    const page = join(vault, "Brain", "dead-ends", "de-old.md");
    delete process.env[STORE_DUAL_WRITE_ENV];
    writeLanePage(vault, page, { kind: "brain-dead-end" }, "Old.\n");
    process.env[STORE_DUAL_WRITE_ENV] = "1";
    expect(removeLanePage(vault, page)).toBe(true);
    expect(lane.laneRecords()).toEqual([]);
  });
});

describe("an unswitched machine's dual-written move", () => {
  test("onto its own path writes nothing that removes the entry, page or folder", () => {
    lane = makeLaneEnv("legacy", "osb-lane-dual-self-");
    const { vault } = lane;
    const page = join(vault, "Brain", "dead-ends", "de-a.md");
    writeLanePage(vault, page, { kind: "brain-dead-end" }, "A.\n");
    const staged = join(vault, "Brain", "dream", "staged", "s1");
    writeLaneText(vault, join(staged, "manifest.json"), '{"schema":"x"}\n');
    const before = lane.laneRecords().length;

    moveLanePage(vault, page, page);
    moveLanePage(vault, page, join(vault, "Brain", "dead-ends", ".", "de-a.md"));
    moveLaneTree(vault, staged, staged);

    expect(live(lane)).toEqual(["dead-ends/de-a", "dream/staged/s1/manifest.json"]);
    expect(lane.laneRecords()).toHaveLength(before);
  });

  test("builds the moved entry from the page as it is on disk after the move", () => {
    lane = makeLaneEnv("legacy", "osb-lane-dual-moved-content-");
    const { vault } = lane;
    const deadEnds = join(vault, "Brain", "dead-ends");
    const page = join(deadEnds, "de-a.md");
    writeLanePage(vault, page, { kind: "brain-dead-end" }, "Old.\n");
    // A legacy-only edit the store never saw.
    legacyOnly(() =>
      writeLanePage(vault, page, { kind: "brain-dead-end" }, "New.\n", { overwrite: true }),
    );
    moveLanePage(vault, page, join(deadEnds, "archive", "de-a.md"));
    expect(liveTexts(lane)).toEqual({ "dead-ends/archive/de-a": "New." });

    // A stored entry whose page was removed legacy-only moves nowhere: its
    // tombstone alone, so the store does not keep a page the tree lost.
    const staged = join(vault, "Brain", "dream", "staged", "s1");
    writeLaneText(vault, join(staged, "a.json"), '{"a":1}\n');
    writeLaneText(vault, join(staged, "b.json"), '{"b":1}\n');
    legacyOnly(() => rmSync(join(staged, "b.json")));
    moveLaneTree(vault, staged, join(vault, "Brain", "dream", "applied", "s1"));
    expect(live(lane)).toEqual(["dead-ends/archive/de-a", "dream/applied/s1/a.json"]);
  });

  test("a private page moved over a shared one leaves no shared copy behind", () => {
    lane = makeLaneEnv("legacy", "osb-lane-dual-over-shared-");
    const { vault } = lane;
    const deadEnds = join(vault, "Brain", "dead-ends");
    const target = join(deadEnds, "de-target.md");
    writeLanePage(vault, target, { kind: "brain-dead-end" }, "Public.\n");
    const secret = join(deadEnds, "de-secret.md");
    writeLanePage(vault, secret, { kind: "brain-dead-end", visibility: "private" }, "Secret.\n");

    moveLanePage(vault, secret, target);

    // A device that holds only `shared` no longer reads the replaced page.
    expect(liveTexts(lane, lane.laneRecords("shared"))).toEqual({});
    expect(liveTexts(lane)).toEqual({ "dead-ends/de-target": "Secret." });
    expect(JSON.stringify(lane.laneRecords("shared").map((r) => r.body))).not.toContain("Secret");
  });

  test("a shared page moved over a private one stays private, as a write over it does", () => {
    lane = makeLaneEnv("legacy", "osb-lane-dual-over-private-");
    const { vault } = lane;
    const deadEnds = join(vault, "Brain", "dead-ends");
    const target = join(deadEnds, "de-target.md");
    writeLanePage(vault, target, { kind: "brain-dead-end", visibility: "private" }, "Secret.\n");
    const open = join(deadEnds, "de-open.md");
    writeLanePage(vault, open, { kind: "brain-dead-end" }, "Open.\n");
    // A private legacy page the store never saw keeps its path private too.
    const legacyTarget = join(deadEnds, "de-legacy.md");
    legacyOnly(() =>
      writeLanePage(vault, legacyTarget, { kind: "brain-dead-end", visibility: "private" }, "L.\n"),
    );
    const other = join(deadEnds, "de-other.md");
    writeLanePage(vault, other, { kind: "brain-dead-end" }, "Other.\n");

    moveLanePage(vault, open, target);
    moveLanePage(vault, other, legacyTarget);

    expect(liveTexts(lane)).toEqual({
      "dead-ends/de-legacy": "Other.",
      "dead-ends/de-target": "Open.",
    });
    expect(liveTexts(lane, lane.laneRecords("shared"))).toEqual({});
    expect(JSON.stringify(lane.laneRecords("shared").map((r) => r.body))).not.toContain("Secret");
  });

  test("a page the store never saw, moved over one it holds, replaces the stored entry", () => {
    lane = makeLaneEnv("legacy", "osb-lane-dual-untracked-over-");
    const { vault } = lane;
    const deadEnds = join(vault, "Brain", "dead-ends");
    const target = join(deadEnds, "de-target.md");
    writeLanePage(vault, target, { kind: "brain-dead-end" }, "Stale.\n");
    const fresh = join(deadEnds, "de-fresh.md");
    legacyOnly(() => writeLanePage(vault, fresh, { kind: "brain-dead-end" }, "Fresh.\n"));
    moveLanePage(vault, fresh, target);
    expect(liveTexts(lane)).toEqual({ "dead-ends/de-target": "Fresh." });

    // A private one is judged as a write of the page is: out of shared.
    const shared = join(deadEnds, "de-shared.md");
    writeLanePage(vault, shared, { kind: "brain-dead-end" }, "Shared.\n");
    const secret = join(deadEnds, "de-secret.md");
    legacyOnly(() =>
      writeLanePage(vault, secret, { kind: "brain-dead-end", visibility: "private" }, "Secret.\n"),
    );
    moveLanePage(vault, secret, shared);
    expect(liveTexts(lane)).toEqual({
      "dead-ends/de-shared": "Secret.",
      "dead-ends/de-target": "Fresh.",
    });
    expect(liveTexts(lane, lane.laneRecords("shared"))).toEqual({
      "dead-ends/de-target": "Fresh.",
    });
    expect(JSON.stringify(lane.laneRecords("shared").map((r) => r.body))).not.toContain("Secret");

    // In a folder: a file the store never saw lands where the store holds a stale entry.
    const applied = join(vault, "Brain", "dream", "applied", "s1");
    writeLaneText(vault, join(applied, "m.json"), '{"stale":1}\n');
    legacyOnly(() => rmSync(applied, { recursive: true }));
    const staged = join(vault, "Brain", "dream", "staged", "s1");
    legacyOnly(() => writeLaneText(vault, join(staged, "m.json"), '{"fresh":1}\n'));
    moveLaneTree(vault, staged, applied);
    expect(liveTexts(lane)["dream/applied/s1/m.json"]).toBe("");
    const fields = foldLaneEntries(lane.laneRecords()).entries.get("dream/applied/s1/m.json");
    expect(fields?.value?.fields).toEqual({ fresh: 1 });
  });

  test("while the fold misses a shard, the moved entry stays out of shared", () => {
    lane = makeLaneEnv("legacy", "osb-lane-dual-incomplete-");
    const { vault } = lane;
    const deadEnds = join(vault, "Brain", "dead-ends");
    const page = join(deadEnds, "de-a.md");
    writeLanePage(vault, page, { kind: "brain-dead-end" }, "Open.\n");
    writeLanePage(
      vault,
      join(deadEnds, "de-p.md"),
      { kind: "brain-dead-end", visibility: "private" },
      "Private.\n",
    );
    // The entry may have been raised in a shard this machine saw and has
    // lost since.
    expect(foldIncomplete()).toBe(false);
    const dir = join(lane.env.storeRoot, "private", "events");
    for (const device of readdirSync(dir)) rmSync(join(dir, device), { recursive: true });
    legacyOnly(() => writeFileSync(page, "---\nkind: brain-dead-end\n---\nRaised.\n"));
    expect(foldIncomplete()).toBe(true);
    const shared = lane.laneRecords("shared").length;

    moveLanePage(vault, page, join(deadEnds, "archive", "de-a.md"));

    // Only the old entry's tombstone reaches shared; the moved text does not.
    const added = lane.laneRecords("shared").slice(shared);
    expect(added.map((r) => r.kind)).toEqual(["lane-entry-remove"]);
    expect(JSON.stringify(lane.laneRecords("private").map((r) => r.body))).toContain("Raised.");
  });
});

/** Whether this host lets the test create a symlink (Windows needs a privilege). */
const CAN_SYMLINK = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), "osb-lane-symlink-probe-"));
  try {
    symlinkSync(probe, join(probe, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

describe("an unswitched machine's dual-written move of a symbolic link", () => {
  test.skipIf(!CAN_SYMLINK)(
    "never reads the link's target into the store, as a page or through a folder",
    () => {
      lane = makeLaneEnv("legacy", "osb-lane-dual-symlink-");
      const { vault } = lane;
      const outside = join(dirname(vault), "outside");
      mkdirSync(join(outside, "s1"), { recursive: true });
      writeFileSync(join(outside, "note.md"), "---\nkind: brain-dead-end\n---\nOutside text.\n");
      writeFileSync(join(outside, "s1", "a.json"), '{"outside":"text"}\n');

      const deadEnds = join(vault, "Brain", "dead-ends");
      const page = join(deadEnds, "de-a.md");
      writeLanePage(vault, page, { kind: "brain-dead-end" }, "A.\n");
      const staged = join(vault, "Brain", "dream", "staged", "s1");
      writeLaneText(vault, join(staged, "a.json"), '{"a":1}\n');
      // Legacy-only, the page and the folder become links to files outside the vault.
      legacyOnly(() => {
        rmSync(page);
        symlinkSync(join(outside, "note.md"), page, "file");
        rmSync(staged, { recursive: true });
        symlinkSync(join(outside, "s1"), staged, "dir");
      });

      moveLanePage(vault, page, join(deadEnds, "archive", "de-a.md"));
      moveLaneTree(vault, staged, join(vault, "Brain", "dream", "applied", "s1"));

      // Neither link is a page the store would import: the old entries go, nothing arrives.
      expect(live(lane)).toEqual([]);
      const bodies = JSON.stringify(lane.laneRecords().map((r) => r.body));
      expect(bodies).not.toContain("Outside text");
      expect(bodies).not.toContain("outside");
    },
  );
});

describe("a store-only machine's move", () => {
  test("of a folder onto itself keeps its entries", () => {
    lane = makeLaneEnv("store", "osb-lane-store-self-");
    const { vault } = lane;
    const staged = join(vault, "Brain", "dream", "staged", "s1");
    writeLaneText(vault, join(staged, "manifest.json"), '{"schema":"x"}\n');
    moveLaneTree(vault, staged, staged);
    expect(live(lane)).toEqual(["dream/staged/s1/manifest.json"]);
  });

  test("of a folder into its own subfolder is refused, as a rename is, and keeps its entries", () => {
    lane = makeLaneEnv("store", "osb-lane-store-into-self-");
    const { vault } = lane;
    const staged = join(vault, "Brain", "dream", "staged", "s1");
    writeLaneText(vault, join(staged, "a.json"), '{"a":1}\n');
    writeLaneText(vault, join(staged, "sub", "a.json"), '{"b":1}\n');
    const before = lane.laneRecords().length;
    expect(() => moveLaneTree(vault, staged, join(staged, "sub"))).toThrow(/into itself/);
    expect(lane.laneRecords()).toHaveLength(before);
    expect(live(lane)).toEqual(["dream/staged/s1/a.json", "dream/staged/s1/sub/a.json"]);
  });

  test("of a private page over a shared one leaves no shared copy behind", () => {
    lane = makeLaneEnv("store", "osb-lane-store-over-shared-");
    const { vault } = lane;
    const deadEnds = join(vault, "Brain", "dead-ends");
    const target = join(deadEnds, "de-target.md");
    writeLanePage(vault, target, { kind: "brain-dead-end" }, "Public.\n");
    writeLanePage(
      vault,
      join(deadEnds, "de-secret.md"),
      { kind: "brain-dead-end", visibility: "private" },
      "Secret.\n",
    );
    moveLanePage(vault, join(deadEnds, "de-secret.md"), target);
    expect(liveTexts(lane, lane.laneRecords("shared"))).toEqual({});

    const applied = join(vault, "Brain", "dream", "applied", "s1");
    writeLaneText(vault, join(applied, "m.json"), '{"public":1}\n');
    const staged = join(vault, "Brain", "dream", "staged", "s1");
    writeLaneText(vault, join(staged, "m.json"), '{"visibility":"private","s":1}\n');
    moveLaneTree(vault, staged, applied);
    expect(liveTexts(lane, lane.laneRecords("shared"))).toEqual({});
    expect(Object.keys(liveTexts(lane))).toEqual([
      "dead-ends/de-target",
      "dream/applied/s1/m.json",
    ]);
  });

  test("of a shared page or folder over a private entry keeps the entry private", () => {
    lane = makeLaneEnv("store", "osb-lane-store-over-private-");
    const { vault } = lane;
    const deadEnds = join(vault, "Brain", "dead-ends");
    const target = join(deadEnds, "de-target.md");
    writeLanePage(vault, target, { kind: "brain-dead-end", visibility: "private" }, "Secret.\n");
    writeLanePage(vault, join(deadEnds, "de-open.md"), { kind: "brain-dead-end" }, "Open.\n");
    moveLanePage(vault, join(deadEnds, "de-open.md"), target);

    const applied = join(vault, "Brain", "dream", "applied", "s1");
    writeLaneText(vault, join(applied, "m.json"), '{"visibility":"private","s":1}\n');
    const staged = join(vault, "Brain", "dream", "staged", "s1");
    writeLaneText(vault, join(staged, "m.json"), '{"public":1}\n');
    moveLaneTree(vault, staged, applied);

    expect(live(lane)).toEqual(["dead-ends/de-target", "dream/applied/s1/m.json"]);
    expect(liveTexts(lane, lane.laneRecords("shared"))).toEqual({});
  });

  test("onto its own page writes nothing, a trailing slash included", () => {
    lane = makeLaneEnv("store", "osb-lane-store-self-page-");
    const { vault } = lane;
    const page = join(vault, "Brain", "dead-ends", "de-a.md");
    writeLanePage(vault, page, { kind: "brain-dead-end" }, "A.\n");
    const before = lane.laneRecords().length;
    moveLanePage(vault, page, page);
    moveLanePage(vault, page, `${page}/`);
    expect(lane.laneRecords()).toHaveLength(before);
    expect(live(lane)).toEqual(["dead-ends/de-a"]);
  });
});

describe("a lane move out of Brain/", () => {
  for (const mode of ["legacy", "store"] as const) {
    test(`is refused before anything moves (${mode})`, () => {
      lane = makeLaneEnv(mode, `osb-lane-out-${mode}-`);
      const { vault } = lane;
      const staged = join(vault, "Brain", "dream", "staged", "s1");
      writeLaneText(vault, join(staged, "a.json"), '{"a":1}\n');
      const page = join(vault, "Brain", "dead-ends", "de-a.md");
      writeLanePage(vault, page, { kind: "brain-dead-end" }, "A.\n");
      const before = lane.laneRecords().length;

      expect(() => moveLaneTree(vault, staged, join(vault, "outside", "s1"))).toThrow(
        /out of the Brain lanes/,
      );
      expect(() => moveLanePage(vault, page, join(vault, "outside", "de-a.md"))).toThrow(
        /out of the Brain lanes/,
      );

      expect(lane.laneRecords()).toHaveLength(before);
      expect(live(lane)).toEqual(["dead-ends/de-a", "dream/staged/s1/a.json"]);
      expect(existsSync(join(vault, "outside"))).toBe(false);
    });
  }
});
