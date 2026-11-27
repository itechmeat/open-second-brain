/**
 * A remote write over a key a private removal holds is refused (change
 * `lane-reach-residuals`, package 5, design R5, sequence 19): below local
 * reach a lane key whose winning record is a removal held in `private`
 * refuses an obligation add of that title, a lane text create at that key
 * and a move onto it with the fixed answer, before any record is written.
 * The same call at local reach succeeds and follows the ordinary placement
 * rule, as in 2.0.4: a shared text lands in `shared`. That keeps the
 * operator's way to make a private entry shared (remove it, then write it
 * anew); the persona refusal names that way.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { removePersona, setPersona } from "../../src/core/brain/write-session/personas.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { wholeLaneStoreFold } from "../../src/core/store/lane-fold-cache.ts";
import {
  laneEntryInPrivate,
  lanePageExists,
  moveLanePage,
  removeLanePage,
  writeLanePage,
  writeLaneText,
} from "../../src/core/store/lane-pages.ts";
import { lanePlaceOf } from "../../src/core/store/lane-paths.ts";
import { laneEntryKey } from "../../src/core/store/lane-records.ts";
import { readPartition } from "../../src/core/store/state-digest.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  REGION,
  callJson,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

function env(): LaneEnv {
  lane = makeLaneEnv("store", "osb-lane-private-removal-");
  return lane;
}

const WITHHELD = "this entry cannot be written at this reach";
const TITLE = "Zqremoval duty";
const REMOVED = "Brain/decisions/zqremovaltarget.md";
const SOURCE = "Brain/decisions/zqremovalsource.md";

/** Every record of both partitions, by id, as the store holds them. */
function rawRecords(e: LaneEnv): string {
  const ids = (partition: "shared" | "private") =>
    readPartition(join(e.env.storeRoot, partition))
      .flatMap((shard) => shard.all)
      .map((r) => r.id)
      .toSorted();
  return JSON.stringify({ shared: ids("shared"), private: ids("private") });
}

/** `<name>: <message>` of what `fn` throws, or `none`. */
function thrown(fn: () => unknown): string {
  try {
    fn();
    return "none";
  } catch (err) {
    return `${(err as Error).name}: ${(err as Error).message}`;
  }
}

/** The removal at the lane path `rel` is the winning record and is held in `private`. */
function expectPrivateRemoval(rel: string): void {
  const place = lanePlaceOf(rel.replace(/^Brain\//, ""));
  expect(place).not.toBeNull();
  const key = laneEntryKey(place!.lane, place!.entry);
  const fold = wholeLaneStoreFold();
  expect({ live: fold.entries.has(key), privateRemoval: fold.privateRemovals.has(key) }).toEqual({
    live: false,
    privateRemoval: true,
  });
}

/** A private obligation titled `TITLE`, removed by a local caller. */
async function removedPrivateObligation(e: LaneEnv): Promise<void> {
  const local = localServer(e);
  const added = await callJson(local, "brain_obligation", {
    operation: "add",
    title: TITLE,
    cadence: "weekly",
    notes: `zqremoval notes ${REGION}`,
  });
  const obligation = added["obligation"] as Record<string, unknown>;
  const slug = String(obligation["slug"]);
  const path = join(e.vault, "Brain", "obligations", `${slug}.md`);
  expect(laneEntryInPrivate(e.vault, path)).toBe(true);
  const removed = await callJson(local, "brain_obligation", { operation: "remove", slug });
  expect(removed["error"]).toBeUndefined();
  expectPrivateRemoval(`Brain/obligations/${slug}.md`);
}

/** A private entry at `REMOVED`, removed by a local caller, and a shared entry at `SOURCE`. */
function removedPrivateEntry(e: LaneEnv): void {
  const path = join(e.vault, REMOVED);
  writeLanePage(e.vault, path, { kind: "note" }, `# held\n\n${REGION}\n`);
  expect(laneEntryInPrivate(e.vault, path)).toBe(true);
  removeLanePage(e.vault, path);
  expect(lanePageExists(e.vault, path)).toBe(false);
  expectPrivateRemoval(REMOVED);
  writeLanePage(e.vault, join(e.vault, SOURCE), { kind: "note" }, "# source\n\nOpen text.\n");
  expect(laneEntryInPrivate(e.vault, join(e.vault, SOURCE))).toBe(false);
}

describe("a key whose winning record is a removal held in private", () => {
  test("a remote obligation add of that title is refused and writes nothing", async () => {
    const e = env();
    await removedPrivateObligation(e);
    const before = rawRecords(e);
    const answer = await callJson(server(e), "brain_obligation", {
      operation: "add",
      title: TITLE,
      cadence: "weekly",
    });
    expect({
      answer: JSON.stringify(answer).includes(WITHHELD),
      unchanged: rawRecords(e) === before,
    }).toEqual({
      answer: true,
      unchanged: true,
    });
  });

  test("local control: a local obligation add of that title succeeds and lands in shared", async () => {
    const e = env();
    await removedPrivateObligation(e);
    const answer = await callJson(localServer(e), "brain_obligation", {
      operation: "add",
      title: TITLE,
      cadence: "weekly",
    });
    expect(answer["error"]).toBeUndefined();
    const obligation = answer["obligation"] as Record<string, unknown>;
    const path = join(e.vault, "Brain", "obligations", `${String(obligation["slug"])}.md`);
    expect({
      exists: lanePageExists(e.vault, path),
      private: laneEntryInPrivate(e.vault, path),
    }).toEqual({
      exists: true,
      private: false,
    });
  });

  test("a remote lane text create at that key is refused and writes nothing", () => {
    const e = env();
    removedPrivateEntry(e);
    const before = rawRecords(e);
    const outcome = thrown(() =>
      withPrivateWithheld(true, () =>
        writeLaneText(e.vault, join(e.vault, REMOVED), "---\nkind: note\n---\n\n# remote\n"),
      ),
    );
    expect({ outcome, unchanged: rawRecords(e) === before }).toEqual({
      outcome: `LaneEntryWithheldError: ${WITHHELD}`,
      unchanged: true,
    });
  });

  test("local control: a local lane text create at that key succeeds and lands in shared", () => {
    const e = env();
    removedPrivateEntry(e);
    const outcome = thrown(() =>
      writeLaneText(e.vault, join(e.vault, REMOVED), "---\nkind: note\n---\n\n# local\n"),
    );
    expect(outcome).toBe("none");
    expect(lanePageExists(e.vault, join(e.vault, REMOVED))).toBe(true);
    // The ordinary placement rule, as in 2.0.4: a removal holds no entry,
    // and the shared text lands in `shared`.
    expect(laneEntryInPrivate(e.vault, join(e.vault, REMOVED))).toBe(false);
  });

  test("a remote move onto that key is refused and writes nothing", () => {
    const e = env();
    removedPrivateEntry(e);
    const before = rawRecords(e);
    const outcome = thrown(() =>
      withPrivateWithheld(true, () =>
        moveLanePage(e.vault, join(e.vault, SOURCE), join(e.vault, REMOVED)),
      ),
    );
    expect({ outcome, unchanged: rawRecords(e) === before }).toEqual({
      outcome: `LaneEntryWithheldError: ${WITHHELD}`,
      unchanged: true,
    });
  });

  test("local control: a local move onto that key succeeds and lands in shared", () => {
    const e = env();
    removedPrivateEntry(e);
    const outcome = thrown(() =>
      moveLanePage(e.vault, join(e.vault, SOURCE), join(e.vault, REMOVED)),
    );
    expect(outcome).toBe("none");
    expect(lanePageExists(e.vault, join(e.vault, REMOVED))).toBe(true);
    expect(laneEntryInPrivate(e.vault, join(e.vault, REMOVED))).toBe(false);
  });

  test("local: a private persona removed, then set again as shared, is shared", () => {
    const e = env();
    const persona = {
      slug: "zqremovallegal",
      lens: "legal exposure",
      prompt: "Assess the topic through legal exposure.",
    };
    const rel = `Brain/personas/${persona.slug}.md`;
    const path = join(e.vault, rel);
    writeLanePage(
      e.vault,
      path,
      { kind: "persona", lens: persona.lens, visibility: "private" },
      `${persona.prompt}\n`,
    );
    expect(laneEntryInPrivate(e.vault, path)).toBe(true);
    // The persona refusal names the operator's way: remove it, then set it
    // again as a shared persona.
    expect(() => setPersona(e.vault, persona)).toThrow(/lives in private.*persona-remove/);
    expect(removePersona(e.vault, persona.slug)).toBe(true);
    expectPrivateRemoval(rel);
    setPersona(e.vault, persona);
    expect({
      exists: lanePageExists(e.vault, path),
      private: laneEntryInPrivate(e.vault, path),
    }).toEqual({
      exists: true,
      private: false,
    });
  });
});
