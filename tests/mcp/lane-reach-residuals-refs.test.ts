/**
 * A reference below local reach is withheld when it cannot be judged and
 * shown when it can (change `lane-reach-residuals`, package 3, design R3):
 * a bare id with an inner space on a fold that may miss a record, a
 * store-mode question that fails, and a lookup that fails withhold their
 * row only; a shared lane id ending in `.md` and an extensionless
 * reference to a shared entry are shown; a lane path spelled with a
 * redundant separator names its entry.
 *
 * A reach view at the remote reach is the caller below local reach; the
 * same view at the local reach is the control.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { storeLaneEntryAt } from "../../src/core/brain/artifact-ref-resolve.ts";
import { reachView } from "../../src/core/brain/reach-view.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { laneEntryInPrivate, writeLanePage } from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv, type LaneMode } from "../core/lanes/fixtures/lane-env.ts";
import { CHMOD_CANNOT_DENY } from "../helpers/platform.ts";
import { REGION, callJson, localServer } from "./lane-private-partition-reach-writes-fixture.ts";
import { dropPrivateEvents } from "./lane-private-partition-reach-store-fixture.ts";

let lane: LaneEnv | null = null;
let restoreMode: (() => void) | null = null;
afterEach(() => {
  restoreMode?.();
  restoreMode = null;
  lane?.cleanup();
  lane = null;
});

function env(mode: LaneMode = "store"): LaneEnv {
  lane = makeLaneEnv(mode, "osb-lane-residual-refs-");
  return lane;
}

const OPEN = "Notes/zqopen.md";

/** An open note on disk, a row every caller may see. */
function openNote(e: LaneEnv): void {
  mkdirSync(join(e.vault, "Notes"), { recursive: true });
  writeFileSync(join(e.vault, OPEN), "---\nkind: note\n---\n\n# open\n");
}

/** A private lane entry, so the `private` partition holds an `events` shard. */
function privateEntry(e: LaneEnv): void {
  const path = join(e.vault, "Brain", "decisions", "zqheld.md");
  writeLanePage(e.vault, path, { kind: "note" }, `# held\n\n${REGION}\n`);
  expect(laneEntryInPrivate(e.vault, path)).toBe(true);
}

/** The view a caller at `reach` asks, bound as the MCP tools bind it. */
function view(e: LaneEnv, remote: boolean) {
  const vault = e.mode === "no-vault" ? null : e.vault;
  return reachView(vault, remote ? TRANSPORT_REACH.remote : TRANSPORT_REACH.local);
}

/** The refs of the rows a view keeps, or the error it throws. */
function kept(e: LaneEnv, remote: boolean, refs: ReadonlyArray<string>): string[] | string {
  try {
    return view(e, remote)
      .keep(
        refs.map((ref) => ({ ref })),
        (row) => [row.ref],
      )
      .map((row) => row.ref);
  } catch (err) {
    return `${(err as Error).name}: ${(err as Error).message}`;
  }
}

describe("references that cannot be judged below local reach", () => {
  const SPACED = "zq spaced id";

  test("a bare id with an inner space is withheld while the fold may miss a record", () => {
    const e = env();
    privateEntry(e);
    openNote(e);
    dropPrivateEvents(e);
    expect(kept(e, true, [SPACED, OPEN])).toEqual([OPEN]);
  });

  test("local control: a bare id with an inner space is kept while the fold may miss a record", () => {
    const e = env();
    privateEntry(e);
    openNote(e);
    dropPrivateEvents(e);
    expect(kept(e, false, [SPACED, OPEN])).toEqual([SPACED, OPEN]);
  });

  /**
   * The question whether the lane pages live in the store fails: the
   * machine is not switched and its `Brain` is no directory, so the look
   * at the legacy tree cannot answer.
   */
  function storeModeFails(e: LaneEnv): void {
    rmSync(join(e.vault, "Brain"), { recursive: true, force: true });
    writeFileSync(join(e.vault, "Brain"), "not a folder\n");
  }

  test("a failed store-mode question withholds a lane-shaped reference", () => {
    const e = env("legacy");
    openNote(e);
    storeModeFails(e);
    expect({
      path: kept(e, true, ["Brain/decisions/zqlaneref.md", OPEN]),
      id: kept(e, true, ["zqlaneref", OPEN]),
    }).toEqual({ path: [OPEN], id: [OPEN] });
  });

  test("local control: a failed store-mode question keeps the rows as before", () => {
    const e = env("legacy");
    openNote(e);
    storeModeFails(e);
    expect({
      path: kept(e, false, ["Brain/decisions/zqlaneref.md", OPEN]),
      id: kept(e, false, ["zqlaneref", OPEN]),
    }).toEqual({ path: ["Brain/decisions/zqlaneref.md", OPEN], id: ["zqlaneref", OPEN] });
  });

  /** A store directory the lookups read cannot be listed. */
  function eventsUnlistable(e: LaneEnv): void {
    const dir = join(e.env.storeRoot, "private", "events");
    chmodSync(dir, 0o000);
    restoreMode = () => chmodSync(dir, 0o755);
  }

  // The failure is a directory at mode 000, which denies nothing where
  // chmod cannot deny (root, Windows): the case is skipped there.
  test.skipIf(CHMOD_CANNOT_DENY)(
    "a failed lookup withholds its row and the report answers the other rows",
    () => {
      const e = env();
      privateEntry(e);
      openNote(e);
      eventsUnlistable(e);
      expect({
        id: kept(e, true, ["zqmissingid", OPEN]),
        spaced: kept(e, true, [SPACED, OPEN]),
      }).toEqual({ id: [OPEN], spaced: [OPEN] });
    },
  );
});

describe("references to shared lane entries below local reach", () => {
  const MD_ID = "zqsharedmd.md";

  function sharedMdEntry(e: LaneEnv): void {
    const path = join(e.vault, "Brain", "procedures", `${MD_ID}.md`);
    writeLanePage(e.vault, path, { kind: "note" }, "# shared\n\nOpen text.\n");
    expect(laneEntryInPrivate(e.vault, path)).toBe(false);
  }

  test("a shared lane id ending in .md is shown, with a vault", () => {
    const e = env("store");
    sharedMdEntry(e);
    expect(kept(e, true, [MD_ID])).toEqual([MD_ID]);
  });

  test("a shared lane id ending in .md is shown, with no vault", () => {
    const e = env("no-vault");
    sharedMdEntry(e);
    expect(kept(e, true, [MD_ID])).toEqual([MD_ID]);
  });

  test("local control: a shared lane id ending in .md is shown at local reach", () => {
    const e = env("store");
    sharedMdEntry(e);
    expect(kept(e, false, [MD_ID])).toEqual([MD_ID]);
  });

  test("an extensionless reference to a shared entry is shown with no vault", () => {
    const e = env("no-vault");
    writeLanePage(
      e.vault,
      join(e.vault, "Brain", "decisions", "zqsharedext.md"),
      { kind: "note" },
      "# shared\n\nOpen text.\n",
    );
    expect(kept(e, true, ["Brain/decisions/zqsharedext"])).toEqual(["Brain/decisions/zqsharedext"]);
  });
});

describe("a lane path with a redundant separator", () => {
  function entries(e: LaneEnv) {
    writeLanePage(
      e.vault,
      join(e.vault, "Brain", "decisions", "zqsepopen.md"),
      { kind: "note" },
      "# open\n\nOpen text.\n",
    );
    writeLanePage(
      e.vault,
      join(e.vault, "Brain", "decisions", "zqsepheld.md"),
      { kind: "note" },
      `# held\n\n${REGION}\n`,
    );
  }

  test("a doubled separator names the entry with its privacy", () => {
    const e = env();
    entries(e);
    const at = (rel: string) => {
      const found = storeLaneEntryAt(e.vault, rel);
      return found === null ? null : { rel: found.rel, private: found.private };
    };
    expect({
      open: at("Brain//decisions/zqsepopen.md"),
      held: at("Brain//decisions/zqsepheld.md"),
    }).toEqual({
      open: { rel: "Brain/decisions/zqsepopen.md", private: false },
      held: { rel: "Brain/decisions/zqsepheld.md", private: true },
    });
  });

  test("a trailing slash names the entry with its privacy", () => {
    const e = env();
    entries(e);
    const at = (rel: string) => {
      const found = storeLaneEntryAt(e.vault, rel);
      return found === null ? null : { rel: found.rel, private: found.private };
    };
    expect({
      open: at("Brain/decisions/zqsepopen.md/"),
      held: at("Brain/decisions/zqsepheld.md/"),
    }).toEqual({
      open: { rel: "Brain/decisions/zqsepopen.md", private: false },
      held: { rel: "Brain/decisions/zqsepheld.md", private: true },
    });
  });

  test("control: the canonical spelling names the entry with its privacy", () => {
    const e = env();
    entries(e);
    expect({
      open: storeLaneEntryAt(e.vault, "Brain/decisions/zqsepopen.md")?.private,
      held: storeLaneEntryAt(e.vault, "Brain/decisions/zqsepheld.md")?.private,
    }).toEqual({ open: false, held: true });
  });
});

describe("a bare id that is a private memory record and a shared lane entry", () => {
  /** A private signal, and a shared lane entry whose id is the signal's id; that id. */
  async function twinned(e: LaneEnv): Promise<string> {
    const answer = await callJson(localServer(e), "brain_feedback", {
      topic: "zqtwin-topic",
      signal: "positive",
      principle: `Prefer the twin. ${REGION}`,
    });
    const id = String(answer["id"]);
    expect(id.startsWith("sig-")).toBe(true);
    const path = join(e.vault, "Brain", "decisions", `${id}.md`);
    writeLanePage(e.vault, path, { kind: "note" }, "# shared twin\n");
    expect(laneEntryInPrivate(e.vault, path)).toBe(false);
    return id;
  }

  test("below local reach the memory record is judged first, so the row is withheld", async () => {
    const e = env();
    const id = await twinned(e);
    expect(kept(e, true, [id])).toEqual([]);
  });

  test("local control: a local view keeps the row", async () => {
    const e = env();
    const id = await twinned(e);
    expect(kept(e, false, [id])).toEqual([id]);
  });
});
