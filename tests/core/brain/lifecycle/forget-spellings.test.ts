/**
 * No spelling of a target makes a lifecycle verb write the legacy tree of
 * a switched machine (review round 1, R1). A case-insensitive file system
 * (macOS, Windows) answers `brain/inbox/x.md` with the frozen page; a
 * macOS path may arrive in Unicode NFD; a Windows caller writes `\\`. Here
 * a case-insensitive lookup is reproduced on Linux with links in the
 * vault root (`brain` and `BRAIN` pointing at `Brain`), and a vault note
 * that links into `Brain/` stands for every other route to the frozen tree.
 * The links are made only where the file system does not already answer
 * the case-varied name: on macOS and Windows the same table runs natively.
 * Every verb x layout x spelling must resolve the store record, change it,
 * and leave the legacy tree byte for byte as it was; the last guard at the
 * write refuses a legacy-tree write on a switched machine whatever led to it.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as memoryPages from "../../../../src/core/brain/memory-pages.ts";
import { correct } from "../../../../src/core/brain/lifecycle/correction.ts";
import {
  MemoryTargetError,
  writeMemoryPatches,
  type MemoryTarget,
} from "../../../../src/core/brain/lifecycle/memory-target.ts";
import { temporalReplace } from "../../../../src/core/brain/lifecycle/temporal-replace.ts";
import { supersede, tombstone } from "../../../../src/core/brain/lifecycle/tombstone.ts";
import { setExpiration } from "../../../../src/core/brain/expiration-set.ts";
import { retireSignal } from "../../../../src/core/brain/signal-retire.ts";
import { writeSignal } from "../../../../src/core/brain/signal.ts";
import { STORE_DUAL_WRITE_ENV } from "../../../../src/core/store/constants.ts";
import { readLanePage, writeLanePage } from "../../../../src/core/store/lane-pages.ts";
import { readSignals } from "../../../../src/core/store/read/signals.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { brainOutsideLog, switchDevice } from "../store-only/fixtures.ts";

/**
 * Whether this machine may create a link to a file: Windows refuses it
 * without the symbolic-link right (or developer mode), and the row that
 * reaches the frozen tree through a linking note cannot be set up then.
 */
const FILE_LINKS: boolean = (() => {
  const dir = mkdtempSync(join(tmpdir(), "osb-link-probe-"));
  try {
    writeFileSync(join(dir, "target.md"), "");
    symlinkSync(join(dir, "target.md"), join(dir, "link.md"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

const NOW = new Date("2026-11-21T12:00:00Z");

const signalInput = (slug: string) => ({
  topic: `topic ${slug}`,
  signal: "positive" as const,
  agent: "claude",
  principle: `Principle of ${slug}`,
  created_at: "2026-11-20T10:00:00Z",
  date: "2026-11-20",
  slug,
});

type Layout = "tree" | "no-tree";

interface Fixture {
  readonly env: StoreEnv;
  readonly id: string;
  readonly other: string;
}

/**
 * Two signals captured before the switch (page plus record), then the
 * switch with dual writes off, the state a switched machine runs in.
 * `tree`: the frozen tree stays, and the vault root answers the folder in
 * any case, as a case-insensitive file system does. `no-tree`: it left.
 */
function fixture(layout: Layout): Fixture {
  const e = makeStoreEnv(`osb-forget-spell-${layout}-`, { dualWrite: true });
  env = e;
  const a = writeSignal(e.vault, signalInput("spelled"));
  const b = writeSignal(e.vault, signalInput("successor"));
  switchDevice(e.storeRoot);
  delete process.env[STORE_DUAL_WRITE_ENV];
  if (layout === "tree") {
    // A case-insensitive file system (macOS, Windows) already answers the
    // case-varied name with `Brain`; only a case-sensitive one needs the
    // link that makes it answer so.
    for (const alias of ["brain", "BRAIN"]) {
      if (!existsSync(join(e.vault, alias))) {
        symlinkSync(join(e.vault, "Brain"), join(e.vault, alias), "junction");
      }
    }
    mkdirSync(join(e.vault, "Notes"), { recursive: true });
    if (FILE_LINKS) {
      symlinkSync(
        join(e.vault, "Brain", "inbox", `${a.id}.md`),
        join(e.vault, "Notes", "alias.md"),
        "file",
      );
    }
  } else {
    rmSync(join(e.vault, "Brain"), { recursive: true, force: true });
  }
  return { env: e, id: a.id, other: b.id };
}

function frontmatter(f: Fixture, id: string): Record<string, unknown> | undefined {
  return readSignals({ vault: f.env.vault }, { states: "all" }).find((s) => s.id === id)
    ?.frontmatter;
}

const SPELLINGS: ReadonlyArray<{
  name: string;
  ref: (id: string) => string;
  layouts: Layout[];
  /** Needs a link to a file (see {@link FILE_LINKS}). */
  fileLink?: boolean;
}> = [
  { name: "lower-case root", ref: (id) => `brain/inbox/${id}.md`, layouts: ["tree", "no-tree"] },
  {
    name: "upper-case root and folder",
    ref: (id) => `BRAIN/Inbox/${id}.md`,
    layouts: ["tree", "no-tree"],
  },
  {
    name: "Windows separators",
    ref: (id) => `Brain\\inbox\\${id}.md`,
    layouts: ["tree", "no-tree"],
  },
  {
    name: "Windows separators, case-varied",
    ref: (id) => `brain\\INBOX\\${id}.md`,
    layouts: ["tree", "no-tree"],
  },
  {
    name: "a vault note linking into Brain/",
    ref: () => "Notes/alias.md",
    layouts: ["tree"],
    fileLink: true,
  },
];

const VERBS: ReadonlyArray<{
  name: string;
  run: (f: Fixture, ref: string) => void;
  applied: (f: Fixture) => boolean;
  /** Addressed by id: a link named otherwise names no record, so it is refused. */
  byId?: boolean;
}> = [
  {
    name: "tombstone",
    run: (f, ref) => void tombstone({ vault: f.env.vault, path: ref, reason: "r", now: NOW }),
    applied: (f) => frontmatter(f, f.id)?.["_status"] === "tombstoned",
  },
  {
    name: "supersede",
    run: (f, ref) => void supersede({ vault: f.env.vault, predecessor: ref, successor: f.other }),
    applied: (f) => frontmatter(f, f.id)?.["superseded_by"] === `[[${f.other}]]`,
  },
  {
    name: "temporal-replace",
    run: (f, ref) =>
      void temporalReplace({
        vault: f.env.vault,
        predecessor: ref,
        successor: f.other,
        at: "2026-11-21",
      }),
    applied: (f) => frontmatter(f, f.id)?.["valid_until"] === "2026-11-21",
  },
  {
    name: "correct --apply",
    run: (f, ref) =>
      void correct({
        vault: f.env.vault,
        target: ref,
        windowEnd: "2026-11-21",
        dryRun: false,
        now: NOW,
      }),
    applied: (f) => frontmatter(f, f.id)?.["valid_until"] === "2026-11-21",
  },
  {
    name: "signal retire",
    byId: true,
    run: (f, ref) => void retireSignal(f.env.vault, ref, { reason: "old", now: NOW }),
    applied: (f) =>
      readSignals({ vault: f.env.vault }, { states: "all" }).find((s) => s.id === f.id)?.state ===
      "retired",
  },
  {
    name: "expire",
    byId: true,
    run: (f, ref) => void setExpiration(f.env.vault, ref, "2026-12-01"),
    applied: (f) => frontmatter(f, f.id)?.["expiration_date"] === "2026-12-01",
  },
];

describe("verb x layout x spelling: the store record changes, the legacy tree never does", () => {
  for (const verb of VERBS) {
    for (const spelling of SPELLINGS) {
      for (const layout of spelling.layouts) {
        test.skipIf(spelling.fileLink === true && !FILE_LINKS)(
          `${verb.name}, ${layout}, ${spelling.name}`,
          () => {
            const f = fixture(layout);
            const before = layout === "tree" ? brainOutsideLog(f.env.vault) : null;
            const ref = spelling.ref(f.id);
            if (verb.byId === true && !ref.includes(f.id)) {
              expect(() => verb.run(f, ref)).toThrow();
            } else {
              verb.run(f, ref);
              expect(verb.applied(f)).toBe(true);
            }
            if (before !== null) expect(brainOutsideLog(f.env.vault)).toEqual(before);
            else expect(existsSync(join(f.env.vault, "Brain"))).toBe(false);
          },
        );
      }
    }
  }
});

describe("Unicode normal forms", () => {
  for (const layout of ["tree", "no-tree"] as const) {
    test(`an NFD spelling of a lane page resolves its NFC store entry (${layout})`, () => {
      const e = makeStoreEnv(`osb-forget-nfd-${layout}-`, { dualWrite: true });
      env = e;
      const nfc = "café".normalize("NFC");
      const page = join(e.vault, "Brain", "dead-ends", `${nfc}.md`);
      writeLanePage(e.vault, page, { kind: "brain-dead-end", id: nfc }, "Body.\n");
      switchDevice(e.storeRoot);
      delete process.env[STORE_DUAL_WRITE_ENV];
      if (layout === "no-tree") rmSync(join(e.vault, "Brain"), { recursive: true, force: true });
      const frozen = layout === "tree" ? readFileSync(page, "utf8") : null;
      const nfd = `Brain/dead-ends/${"café".normalize("NFD")}.md`;
      tombstone({ vault: e.vault, path: nfd, reason: "solved" });
      expect(readLanePage(e.vault, page)?.frontmatter["_status"]).toBe("tombstoned");
      if (frozen !== null) expect(readFileSync(page, "utf8")).toBe(frozen);
    });
  }
});

describe("the last guard at the write", () => {
  test("a page under the legacy tree is refused on a switched machine, whatever resolved it", () => {
    const f = fixture("tree");
    const rel = `Brain/inbox/${f.id}.md`;
    const abs = join(f.env.vault, "brain", "inbox", `${f.id}.md`);
    const page = readFileSync(abs, "utf8");
    const target: MemoryTarget = {
      kind: "file",
      rel,
      abs,
      id: f.id,
      inStore: false,
      meta: {},
      body: "",
      storeId: f.id,
    };
    let wrote = false;
    expect(() =>
      writeMemoryPatches(f.env.vault, [{ target, patch: { _status: "tombstoned" } }], () => {
        wrote = true;
      }),
    ).toThrow(MemoryTargetError);
    expect(wrote).toBe(false);
    expect(readFileSync(abs, "utf8")).toBe(page);
  });
});

describe("reach is applied before the record is read", () => {
  test("a record the caller may not read is refused without reading it", () => {
    const f = fixture("no-tree");
    const real = memoryPages.storeMemoryPage;
    let reads = 0;
    const spy = spyOn(memoryPages, "storeMemoryPage").mockImplementation((vault, id, ctx) => {
      const page = real(vault, id, ctx);
      if (page === undefined) return page;
      return {
        ...page,
        read: () => {
          reads += 1;
          return page.read();
        },
      };
    });
    try {
      for (const ref of [f.id, `Brain/inbox/${f.id}.md`, `store:${f.id}`]) {
        expect(() =>
          tombstone({ vault: f.env.vault, path: ref, reason: "r", readable: () => false }),
        ).toThrow(/note does not exist/);
      }
      expect(reads).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(frontmatter(f, f.id)?.["_status"]).toBeUndefined();
  });
});
