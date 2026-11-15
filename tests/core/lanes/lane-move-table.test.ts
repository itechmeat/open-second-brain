/**
 * A lane move over its whole state space (task 3.12 review, design D19
 * item 2). The rule under test: a move is the write of the destination
 * page plus the removal of the source, judged as those two writes would be
 * judged. One oracle ({@link expected}) computes what every cell must
 * leave, so no cell carries a hand-written expectation.
 *
 * The table is the product of:
 *
 *  - the source: tracked in `shared`, tracked in `private`, or untracked
 *    (a legacy page the store never saw);
 *  - what is at the destination after the rename: a page with public
 *    content, a page private by its content (`visibility: private`), or a
 *    symbolic link (no page the store would import);
 *  - the destination before the move: stored in `shared`, stored in
 *    `private`, or not stored;
 *  - the mode: an unswitched machine with the dual write on, or a
 *    store-only machine;
 *  - the shape: a single page (`moveLanePage`) or the same page inside a
 *    moved folder (`moveLaneTree`).
 *
 * Cells that cannot exist, so the table leaves them out:
 *
 *  - a store-only move of an untracked source: a store-only machine holds
 *    no page outside the store, so there is nothing to move;
 *  - a store-only move that carries a symbolic link: the store holds
 *    records, never links;
 *  - a store-only move of a source in `shared` whose content is private:
 *    on a store-only machine the moved content is the stored value, and
 *    every write judges its content, so a value private by its frontmatter
 *    is never stored in `shared`.
 *
 * Cells that carry a symbolic link are skipped where the host cannot create
 * one (Windows without the privilege).
 *
 * Two more dimensions, each crossed with a representative subset of the
 * ones above so the table stays fast:
 *
 *  - the completeness of the fold the move reads: complete (every cell
 *    above), an `events` shard read only in part (a corrupt line in the
 *    middle), or a record of another device in `private` whose body blob
 *    has not arrived (quarantined on this machine, so its shard reads as
 *    whole), for the source entry or for the destination entry. Each
 *    incomplete value is crossed with every cell above that carries a
 *    public page (the cells where the verdict could be `shared`; a private
 *    page or a link already decides it). The oracle: private whenever the
 *    fold is incomplete, since the record it misses may make the entry
 *    private. A record of another device in `shared` whose body blob has
 *    not arrived, quarantined, for the source or the destination entry,
 *    is no such gap: a record in `shared` never carries a value a write
 *    would place in `private`, and the fold's winner of a key changes only
 *    when the missing record is that winner, so the fold without it is at
 *    least as private as the fold with it. These cells cross it with the
 *    cells whose verdict over the visible fold is `shared` (a public page,
 *    a source in `shared` or untracked, a destination in `shared` or not
 *    stored, an untracked source onto an unstored path left out because
 *    the missing record would store the destination there). The oracle:
 *    what the complete fold gives, `shared`. A hidden newer value of an
 *    entry the visible fold holds in `private` is left out: there the
 *    complete fold would read `shared` and the move keeps `private`, the
 *    side that leaks nothing;
 *  - for a folder, the overlap of the source and the destination folders:
 *    disjoint, the destination below the source, the destination an
 *    ancestor of the source, and the same folder, in both modes, over a
 *    folder holding a shared entry and a private one in a nested folder of
 *    the same name. The oracle: refused with nothing written and every
 *    entry still live, or the exact live set after the move; on an
 *    unswitched machine the live set is also what the disk shows.
 *
 * The unswitched folder shape removes the destination folder legacy-only
 * before the move (the store keeps its entries there): a rename refuses a
 * non-empty destination folder, so the stored destination entry is one
 * whose file the tree lost.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import { BLOB_REF_KEY, STORE_DUAL_WRITE_ENV } from "../../../src/core/store/constants.ts";
import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import {
  dualWriteLaneMove,
  dualWriteLaneTreeMove,
} from "../../../src/core/store/lane-dual-moves.ts";
import { laneEntryInPrivate } from "../../../src/core/store/lane-entry-store.ts";
import {
  moveLanePage,
  moveLaneTree,
  readLanePage,
  writeLanePage,
} from "../../../src/core/store/lane-pages.ts";
import { lanePlaceOf } from "../../../src/core/store/lane-paths.ts";
import { foldLaneEntries, laneEntryRecord } from "../../../src/core/store/lane-records.ts";
import { readShard } from "../../../src/core/store/reader.ts";
import { addQuarantine } from "../../../src/core/store/shard-quarantine-write.ts";
import { lineSha256At } from "../../../src/core/store/shard-quarantine.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { partitionDir } from "../../../src/core/store/store-paths.ts";
import type { FrontmatterMap } from "../../../src/core/types.ts";
import { makeLaneEnv, type LaneEnv } from "./fixtures/lane-env.ts";

type Source = "shared" | "private" | "untracked";
type Disk = "public" | "private" | "link";
type Destination = "shared" | "private" | "none";
type Mode = "legacy" | "store";
type Shape = "page" | "folder";
type Fold =
  | "complete"
  | "unreadable"
  | "pending-source"
  | "pending-destination"
  | "pending-shared-source"
  | "pending-shared-destination";

/** The folds that may miss a record: the move fails closed over them. */
const INCOMPLETE: ReadonlySet<Fold> = new Set([
  "unreadable",
  "pending-source",
  "pending-destination",
]);

interface Cell {
  readonly source: Source;
  readonly disk: Disk;
  readonly destination: Destination;
  readonly mode: Mode;
  readonly shape: Shape;
  readonly fold: Fold;
}

/** Why a cell cannot exist (see the module docblock), or `null` when it can. */
function impossible(cell: Cell): string | null {
  if (cell.mode !== "store") return null;
  if (cell.source === "untracked") return "a store-only machine has no untracked page";
  if (cell.disk === "link") return "the store holds no links";
  if (cell.source === "shared" && cell.disk === "private") return "no write stores it in shared";
  return null;
}

const KIND = { kind: "brain-dead-end" };
const PRIVATE = { kind: "brain-dead-end", visibility: "private" };

/** The page that moves: its fields and text (every private text says "secret"). */
const MOVED: Record<Exclude<Disk, "link">, { fields: FrontmatterMap; text: string }> = {
  public: { fields: KIND, text: "Moved public.\n" },
  private: { fields: PRIVATE, text: "Moved secret.\n" },
};

/** What one cell must leave at the destination, computed from the cell alone. */
interface Expected {
  /** The live destination entry, or `null` when none may be live. */
  readonly entry: {
    readonly fields: FrontmatterMap;
    readonly text: string;
    readonly partition: "shared" | "private";
  } | null;
  /** The move must append no record at all. */
  readonly untouched: boolean;
}

/**
 * The oracle. The destination entry is what a fresh write of the page now
 * there would leave: its content, private when the source entry, the
 * destination entry or the content is private (nothing lowers an entry's
 * partition, and the source's privacy moves with it, and a fold that misses
 * a record in `private` may miss the one that makes it private); no live entry when
 * nothing importable is there. A move that involves no stored entry at all
 * (an untracked page onto an unstored path, unswitched) writes nothing:
 * the dual write mirrors what the store holds, and the migration imports
 * the rest.
 */
function expected(cell: Cell): Expected {
  if (cell.source === "untracked" && cell.destination === "none") {
    return { entry: null, untouched: true };
  }
  if (cell.disk === "link") return { entry: null, untouched: false };
  const moved = MOVED[cell.disk];
  const isPrivate =
    cell.source === "private" ||
    cell.destination === "private" ||
    cell.disk === "private" ||
    INCOMPLETE.has(cell.fold);
  return {
    entry: { ...moved, partition: isPrivate ? "private" : "shared" },
    untouched: false,
  };
}

/** Whether this host lets the test create a symlink (Windows needs a privilege). */
const CAN_SYMLINK = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), "osb-lane-table-symlink-probe-"));
  try {
    symlinkSync(probe, join(probe, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

/** Run `fn` with the dual write off: a write the store never sees. */
function legacyOnly(fn: () => void): void {
  delete process.env[STORE_DUAL_WRITE_ENV];
  try {
    fn();
  } finally {
    process.env[STORE_DUAL_WRITE_ENV] = "1";
  }
}

/** The live entries of `records`, by key, with fields and text. */
function liveOf(records: StoreRecord[]): Map<string, { fields: unknown; text: string }> {
  const out = new Map<string, { fields: unknown; text: string }>();
  // A record whose body blob has not arrived is left out, as every fold leaves it out.
  const known = records.filter((r) => r.body[BLOB_REF_KEY] === undefined);
  for (const [key, state] of foldLaneEntries(known).entries) {
    // Trimmed: a page read back from disk loses the newline that ends its body.
    if (!state.removed) {
      out.set(key, { fields: state.value!.fields, text: state.value!.text.trim() });
    }
  }
  return out;
}

/** Every live entry with the partition it is live in, as one comparable value. */
function liveState(env: LaneEnv): Record<string, unknown> {
  const all = liveOf(env.laneRecords());
  const inShared = liveOf(env.laneRecords("shared"));
  const inPrivate = liveOf(env.laneRecords("private"));
  return Object.fromEntries(
    [...all.keys()]
      .toSorted()
      .map((key) => [
        key,
        { ...all.get(key), shared: inShared.has(key), private: inPrivate.has(key) },
      ]),
  );
}

/** The paths of one cell: the source and destination pages, and the moved folders. */
function pathsOf(vault: string, shape: Shape) {
  if (shape === "page") {
    const dir = join(vault, "Brain", "dead-ends");
    return {
      from: join(dir, "de-src.md"),
      to: join(dir, "de-dst.md"),
      fromKey: "dead-ends/de-src",
      toKey: "dead-ends/de-dst",
    };
  }
  const fromDir = join(vault, "Brain", "dream", "staged", "s1");
  const toDir = join(vault, "Brain", "dream", "applied", "s1");
  return {
    fromDir,
    toDir,
    from: join(fromDir, "page.md"),
    to: join(toDir, "page.md"),
    fromKey: "dream/staged/s1/page",
    toKey: "dream/applied/s1/page",
  };
}

/** Build the state of `cell` before the move. */
function arrange(env: LaneEnv, cell: Cell): void {
  const { vault } = env;
  const paths = pathsOf(vault, cell.shape);
  if (cell.destination !== "none") {
    const own = cell.destination === "private" ? PRIVATE : KIND;
    const text = cell.destination === "private" ? "Dest secret.\n" : "Dest public.\n";
    writeLanePage(vault, paths.to, own, text);
    if (cell.mode === "legacy" && paths.toDir !== undefined) {
      legacyOnly(() => rmSync(paths.toDir!, { recursive: true }));
    }
  }
  if (cell.mode === "store") {
    // The stored value is what moves; a private entry keeps its partition
    // when overwritten with public content.
    const moved = MOVED[cell.disk as Exclude<Disk, "link">];
    if (cell.source === "private") writeLanePage(vault, paths.from, PRIVATE, "Source secret.\n");
    writeLanePage(vault, paths.from, moved.fields, moved.text, { overwrite: true });
    return;
  }
  if (cell.source !== "untracked") {
    const own = cell.source === "private" ? PRIVATE : KIND;
    const text = cell.source === "private" ? "Source secret.\n" : "Source public.\n";
    writeLanePage(vault, paths.from, own, text);
  }
  // Legacy-only, the source becomes what the move carries.
  legacyOnly(() => {
    rmSync(paths.from, { force: true });
    if (cell.disk === "link") {
      const outside = join(dirname(vault), "outside.md");
      writeFileSync(outside, "---\nkind: brain-dead-end\n---\nOutside secret.\n");
      mkdirSync(dirname(paths.from), { recursive: true });
      symlinkSync(outside, paths.from, "file");
      return;
    }
    const moved = MOVED[cell.disk];
    writeLanePage(vault, paths.from, moved.fields, moved.text);
  });
}

/** Every file below `dir`, recursively, partition-relative paths. */
function filesBelow(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name));
}

/**
 * Append `record` as another device's record in `partition` whose body
 * blob never arrived, quarantined here so its shard reads as whole.
 */
function appendPendingQuarantined(
  env: LaneEnv,
  partition: "shared" | "private",
  record: { readonly kind: string; readonly body: Record<string, unknown> },
): void {
  const root = env.env.storeRoot;
  const partitionRoot = partitionDir(root, partition);
  const other = openStore({ root, device: "dev-b" });
  const blobsBefore = new Set(filesBelow(join(partitionRoot, "blobs")));
  const path = appendRecord(other, {
    partition,
    stream: "events",
    kind: record.kind,
    agent: "t",
    body: record.body,
  }).path;
  const blobs = filesBelow(join(partitionRoot, "blobs")).filter((f) => !blobsBefore.has(f));
  expect(blobs).toHaveLength(1);
  rmSync(blobs[0]!);
  const offset = readShard(path, { partitionRoot }).records.find(
    (r) => r.bodyState === "pending",
  )!.offset;
  addQuarantine(root, {
    partition,
    shard: relative(partitionRoot, path).split("\\").join("/"),
    offset,
    sha256: lineSha256At(path, offset, partitionRoot)!,
    kind: "blob-pending",
    reason: "test",
  });
}

/**
 * Make the fold the move reads lack a record, as `cell.fold` says, with
 * records of another device: in `private`, a shard with a corrupt line in
 * its middle, or a newer value of the source or destination entry whose
 * body blob never arrived; in `shared`, a newer public value of the source
 * or destination entry whose body blob never arrived. A pending blob is
 * quarantined here, so its shard reads as whole.
 */
function makeIncomplete(env: LaneEnv, cell: Cell): void {
  if (cell.fold === "complete") return;
  if (cell.fold === "unreadable") {
    const other = openStore({ root: env.env.storeRoot, device: "dev-b" });
    const note = { partition: "private", stream: "events", kind: "note", agent: "t" } as const;
    const path = appendRecord(other, { ...note, body: { text: "one" } }).path;
    appendRecord(other, { ...note, body: { text: "two" } });
    const [first, ...rest] = readFileSync(path, "utf8").split("\n");
    writeFileSync(path, [first, "not a record", ...rest].join("\n"));
    return;
  }
  const paths = pathsOf(env.vault, cell.shape);
  const onSource = cell.fold === "pending-source" || cell.fold === "pending-shared-source";
  const inShared =
    cell.fold === "pending-shared-source" || cell.fold === "pending-shared-destination";
  const at = onSource ? paths.from : paths.to;
  const place = lanePlaceOf(relative(join(env.vault, "Brain"), at).split("\\").join("/"))!;
  const record = laneEntryRecord({
    ...place,
    fields: KIND,
    text: (inShared ? "Written elsewhere. " : "Raised elsewhere. ").repeat(2_000),
    authority: "human",
    private: !inShared,
  });
  appendPendingQuarantined(env, inShared ? "shared" : "private", record);
}

/** The cell's move, through the lane API. */
function act(env: LaneEnv, cell: Cell): void {
  const paths = pathsOf(env.vault, cell.shape);
  if (paths.fromDir !== undefined) moveLaneTree(env.vault, paths.fromDir, paths.toDir!);
  else moveLanePage(env.vault, paths.from, paths.to);
}

/** Assert the invariants of `cell` after its move. */
function assertCell(env: LaneEnv, cell: Cell, recordsBefore: number, sharedBefore: number): void {
  const want = expected(cell);
  const { fromKey, toKey } = pathsOf(env.vault, cell.shape);
  const all = liveOf(env.laneRecords());
  const inShared = liveOf(env.laneRecords("shared"));
  const inPrivate = liveOf(env.laneRecords("private"));

  if (want.untouched) expect(env.laneRecords()).toHaveLength(recordsBefore);
  // (b) nothing live at the source; (a) the destination as a fresh write leaves it.
  expect(all.has(fromKey)).toBe(false);
  expect([...all.keys()]).toEqual(want.entry === null ? [] : [toKey]);
  if (want.entry !== null) {
    expect(all.get(toKey)).toEqual({ fields: want.entry.fields, text: want.entry.text.trim() });
    // (c) live in exactly the partition the rule gives.
    expect({ shared: inShared.has(toKey), private: inPrivate.has(toKey) }).toEqual({
      shared: want.entry.partition === "shared",
      private: want.entry.partition === "private",
    });
  }
  // (c) nothing private reaches a shared record the move wrote, and no link is followed.
  const added = JSON.stringify(env.laneRecords("shared").slice(sharedBefore));
  expect(added.toLowerCase()).not.toContain("secret");
  expect(JSON.stringify(env.laneRecords())).not.toContain("Outside");
}

const CELLS: Cell[] = [];
const FOLDS = [
  "complete",
  "unreadable",
  "pending-source",
  "pending-destination",
  "pending-shared-source",
  "pending-shared-destination",
] as const;

/** Whether `cell` belongs to the table for its fold (see the module docblock). */
function crossed(cell: Cell): boolean {
  if (cell.fold === "complete") return true;
  // An incomplete fold is crossed with the public-page cells only.
  if (cell.disk !== "public") return false;
  if (INCOMPLETE.has(cell.fold)) return true;
  // A pending blob in shared: the cells whose verdict over the visible fold is shared.
  if (cell.source === "private" || cell.destination === "private") return false;
  if (cell.fold === "pending-shared-source") return cell.source === "shared";
  return !(cell.source === "untracked" && cell.destination === "none");
}

for (const fold of FOLDS)
  for (const mode of ["legacy", "store"] as const)
    for (const shape of ["page", "folder"] as const)
      for (const source of ["shared", "private", "untracked"] as const)
        for (const disk of ["public", "private", "link"] as const)
          for (const destination of ["shared", "private", "none"] as const) {
            const cell = { source, disk, destination, mode, shape, fold };
            if (crossed(cell) && impossible(cell) === null) CELLS.push(cell);
          }

describe("a lane move over its state space", () => {
  for (const cell of CELLS) {
    const name = `${cell.mode} ${cell.shape}: source ${cell.source}, ${cell.disk} on disk, destination ${cell.destination}, fold ${cell.fold}`;
    test.skipIf(cell.disk === "link" && !CAN_SYMLINK)(name, () => {
      lane = makeLaneEnv(cell.mode, "osb-lane-table-");
      arrange(lane, cell);
      makeIncomplete(lane, cell);
      const before = lane.laneRecords().length;
      const sharedBefore = lane.laneRecords("shared").length;

      act(lane, cell);
      assertCell(lane, cell, before, sharedBefore);

      // (d) The dual write again, over the same move, changes nothing live
      // and still writes nothing private to shared.
      if (cell.mode === "legacy") {
        const state = liveState(lane);
        const sharedAfter = lane.laneRecords("shared").length;
        const paths = pathsOf(lane.vault, cell.shape);
        const context = { vault: lane.vault };
        if (paths.fromDir !== undefined) {
          dualWriteLaneTreeMove(lane.vault, paths.fromDir, paths.toDir!, context);
        } else {
          const destinationPrivate = cell.destination === "private";
          dualWriteLaneMove(
            lane.vault,
            { from: paths.from, to: paths.to, destinationPrivate },
            context,
          );
        }
        expect(liveState(lane)).toEqual(state);
        assertCell(lane, cell, before, sharedAfter);
      }
    });
  }

  test("covers every cell that can exist", () => {
    // Complete fold: 108 cells in the product; 36 store-only cells cannot
    // exist (see above). Each of the three incomplete folds: the 30 of
    // those 72 that carry a public page. A pending blob in shared: for the
    // source, the 8 cells with a source in shared and a destination in
    // shared or not stored; for the destination, those 8 and the 2
    // unswitched cells of an untracked source onto a destination in shared.
    expect(CELLS).toHaveLength(72 + 3 * 30 + 8 + 10);
  });
});

type Overlap = "disjoint" | "below" | "ancestor" | "same";

/** The folder each overlap moves `dream/staged/s1` to, `Brain/`-relative. */
const OVERLAP_TO: Record<Overlap, string> = {
  disjoint: "dream/applied/s1",
  below: "dream/staged/s1/s1",
  ancestor: "dream/staged",
  same: "dream/staged/s1",
};

/**
 * The entries before every overlap move: two below the moved folder, one
 * of them in a nested folder of the same name (so the destination of one
 * is the source of the other when the folders overlap), and a sibling
 * folder's entry no move may touch.
 */
const OVERLAP_BEFORE: Record<string, { text: string; partition: "shared" | "private" }> = {
  "dream/staged/s1/z": { text: "Outer.", partition: "shared" },
  "dream/staged/s1/s1/z": { text: "Inner secret.", partition: "private" },
  "dream/staged/s2/y": { text: "Sibling.", partition: "shared" },
};

/**
 * The overlap oracle: a move whose folders overlap (one inside the other)
 * is refused before anything moves, as a rename refuses it; a folder moved
 * onto itself changes nothing; a disjoint move carries each entry to the
 * same path below the destination, in the partition it lived in.
 */
function overlapExpected(overlap: Overlap): {
  readonly refused: boolean;
  readonly live: Record<string, { text: string; partition: "shared" | "private" }>;
} {
  if (overlap === "below" || overlap === "ancestor") return { refused: true, live: OVERLAP_BEFORE };
  if (overlap === "same") return { refused: false, live: OVERLAP_BEFORE };
  const from = "dream/staged/s1/";
  return {
    refused: false,
    live: Object.fromEntries(
      Object.entries(OVERLAP_BEFORE).map(([key, value]) => [
        key.startsWith(from) ? `${OVERLAP_TO.disjoint}/${key.slice(from.length)}` : key,
        value,
      ]),
    ),
  };
}

/** The live entries with their text and partition, keyed by entry. */
function liveWithPartition(
  env: LaneEnv,
): Record<string, { text: string; partition: "shared" | "private" }> {
  const inPrivate = liveOf(env.laneRecords("private"));
  const all = liveOf(env.laneRecords());
  return Object.fromEntries(
    [...all.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [
        key,
        { text: value.text, partition: inPrivate.has(key) ? "private" : "shared" },
      ]),
  );
}

/** The lane pages on disk below `Brain/dream`, as entry keys. */
function diskEntries(vault: string): string[] {
  const brain = join(vault, "Brain");
  return filesBelow(join(brain, "dream"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => relative(brain, f).split("\\").join("/").slice(0, -".md".length))
    .toSorted();
}

describe("a lane folder move over the overlap of its folders", () => {
  for (const mode of ["legacy", "store"] as const)
    for (const overlap of ["disjoint", "below", "ancestor", "same"] as const) {
      test(`${mode}: destination ${overlap}`, () => {
        lane = makeLaneEnv(mode, "osb-lane-overlap-");
        const brain = join(lane.vault, "Brain");
        const at = (rel: string): string => join(brain, ...rel.split("/"));
        for (const [key, { text, partition }] of Object.entries(OVERLAP_BEFORE)) {
          writeLanePage(
            lane.vault,
            at(`${key}.md`),
            partition === "private" ? PRIVATE : KIND,
            `${text}\n`,
          );
        }
        const want = overlapExpected(overlap);
        const before = lane.laneRecords().length;
        const sharedBefore = lane.laneRecords("shared").length;

        const move = (): void =>
          moveLaneTree(lane!.vault, at("dream/staged/s1"), at(OVERLAP_TO[overlap]));
        if (want.refused) expect(move).toThrow();
        else move();

        if (want.refused || overlap === "same") expect(lane.laneRecords()).toHaveLength(before);
        expect(liveWithPartition(lane)).toEqual(want.live);
        // No private text reaches a shared record the move wrote.
        const added = JSON.stringify(lane.laneRecords("shared").slice(sharedBefore));
        expect(added.toLowerCase()).not.toContain("secret");
        // Unswitched: the store ends where the rename left the disk.
        if (mode === "legacy")
          expect(diskEntries(lane.vault)).toEqual(Object.keys(want.live).toSorted());
      });
    }

  test("covers every overlap in both modes", () => {
    expect(Object.keys(OVERLAP_TO)).toHaveLength(4);
  });
});

describe("a store-only machine that holds only shared, with a quarantined pending blob in shared", () => {
  test("still writes a lane page to shared", () => {
    lane = makeLaneEnv("store", "osb-lane-shared-only-", { partitions: ["shared"] });
    // A record of another kind, unrelated to the page, whose blob was lost.
    appendPendingQuarantined(lane, "shared", {
      kind: "note",
      body: { authority: "agent", text: "Lost elsewhere. ".repeat(2_000) },
    });
    const page = join(lane.vault, "Brain", "obligations", "obl-q.md");
    writeLanePage(lane.vault, page, { kind: "brain-obligation" }, "Open.\n");

    expect(readLanePage(lane.vault, page)?.body.trim()).toBe("Open.");
    expect(laneEntryInPrivate(lane.vault, page)).toBe(false);
    expect(lane.laneRecords("shared").map((r) => r.body["text"])).toEqual(["Open.\n"]);
  });
});
