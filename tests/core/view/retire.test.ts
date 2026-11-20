/**
 * Pages leaving the view (review fixes of task 3.2): a forged render
 * record never makes the view writer read, ingest, move or remove a file
 * outside the view or outside the page shapes it writes (`..`, a
 * backslash); when a folder slot passes from one topic to another, each
 * topic keeps its user's files; and a renamed topic's files follow it
 * even when its old page was already gone.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs";
import type { BigIntStats } from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import { newUlid } from "../../../src/core/store/ulid.ts";
import { capturePage, NotAPageFileError } from "../../../src/core/view/page-io.ts";
import { runViewPass } from "../../../src/core/view/render.ts";
import { sameFileStats } from "../../../src/core/view/retire.ts";
import { bytesSum, writeBase } from "../../../src/core/view/view-records.ts";
import { claimViewWriter } from "../../../src/core/view/writer.ts";
import { makeMachines, type Machines } from "./fixtures/machines.ts";
import { seedLaneEntry, seedLaneRemove, seedTopicRecord } from "./fixtures/seed.ts";

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
let clock = T0;
const now = () => clock;

let m: Machines;
let a: StoreHandle;
beforeEach(() => {
  clock = T0;
  m = makeMachines(["dev-a"]);
  a = m.open("dev-a");
});
afterEach(() => m.cleanup());

function render(passes = 2): void {
  claimViewWriter(a, { agent: "t", now });
  for (let i = 0; i < passes; i++) {
    clock += 1000;
    runViewPass(a, { target: m.view("dev-a"), vault: null, agent: "t", now });
  }
}

function topic(id: string, title: string, kind = "topic-create"): void {
  clock += 60_000;
  const body = kind === "topic-create" ? { title, scope: "project:o2b" } : { title };
  seedTopicRecord(a, clock, kind, id, body, { authority: "human" });
}

/** A render record for `page` with a real merge base, as a peer could write it. */
function forgeRender(page: string, text: string, topicId?: string): void {
  clock += 1000;
  appendRecord(
    a,
    {
      partition: "shared",
      stream: "log",
      kind: "view-render",
      agent: "peer",
      body: {
        page,
        ...(topicId !== undefined ? { topic: topicId } : {}),
        sum: bytesSum(`${text}-other`),
        base: writeBase(a, page, { text: `${text}-base\n`, keys: [null] }),
        bytes: 1,
      },
    },
    { now },
  );
}

const view = (...parts: string[]) => join(m.view("dev-a"), ...parts);

/** Whether two names are one file on disk. */
function oneFile(first: string, second: string): boolean {
  try {
    const sa = statSync(first);
    const sb = statSync(second);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

describe("pages leaving the view", () => {
  test("a forged render record outside the view or outside the page shapes touches no file", () => {
    // A file beside the view folder, reached by `..`.
    const outside = join(m.view("dev-a"), "..", "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "topic.md"), "secret\n");
    writeFileSync(join(outside, "keep.txt"), "mine\n");
    forgeRender("topics/../../outside/topic.md", "a");
    // A Windows separator: one folder on POSIX, an escape on Windows.
    const backslash = view("topics", "..\\..\\outside2");
    mkdirSync(backslash, { recursive: true });
    writeFileSync(join(backslash, "topic.md"), "secret two\n");
    forgeRender("topics/..\\..\\outside2/topic.md", "b");
    // A name the renderer never writes, inside the view.
    mkdirSync(view("topics", "notes"), { recursive: true });
    writeFileSync(view("topics", "notes", "todo.md"), "my list\n");
    forgeRender("topics/notes/todo.md", "c");
    topic(newUlid(T0), "Real");
    render();
    expect(readFileSync(join(outside, "topic.md"), "utf8")).toBe("secret\n");
    expect(readdirSync(outside).toSorted()).toEqual(["keep.txt", "topic.md"]);
    expect(readFileSync(join(backslash, "topic.md"), "utf8")).toBe("secret two\n");
    expect(readFileSync(view("topics", "notes", "todo.md"), "utf8")).toBe("my list\n");
    const stored = (["shared", "private"] as const)
      .flatMap((p) => readPartition(join(m.root("dev-a"), p)))
      .flatMap((s) => s.records)
      .map((r) => JSON.stringify(r.body));
    expect(stored.some((body) => body.includes("secret") || body.includes("my list"))).toBe(false);
  });

  test("when a rename hands a folder slot to another topic, each topic keeps its own files", () => {
    const first = newUlid(T0);
    const second = newUlid(T0 + 1);
    topic(first, "Docs");
    topic(second, "Docs");
    render();
    const base = "2026-11-02-docs";
    const tail = `${base}-${second.slice(-6).toLowerCase()}`;
    expect(readdirSync(view("topics")).toSorted()).toEqual([base, tail]);
    writeFileSync(view("topics", base, "a-notes.md"), "first's\n");
    writeFileSync(view("topics", tail, "b-notes.md"), "second's\n");
    topic(first, "Alpha", "topic-rename");
    render();
    expect(readdirSync(view("topics")).toSorted()).toEqual(["2026-11-02-alpha", base]);
    expect(readdirSync(view("topics", "2026-11-02-alpha")).toSorted()).toEqual([
      "a-notes.md",
      "topic.md",
    ]);
    expect(readdirSync(view("topics", base)).toSorted()).toEqual(["b-notes.md", "topic.md"]);
    expect(readFileSync(view("topics", base, "topic.md"), "utf8")).toContain(`topic=${second}`);
  });

  test("two topics that exchange folders each keep their own files", () => {
    const one = newUlid(T0);
    const two = newUlid(T0 + 1);
    topic(one, "Alpha");
    topic(two, "Beta");
    render();
    writeFileSync(view("topics", "2026-11-02-alpha", "a-notes.md"), "one's\n");
    writeFileSync(view("topics", "2026-11-02-beta", "b-notes.md"), "two's\n");
    topic(one, "Beta", "topic-rename");
    topic(two, "Alpha", "topic-rename");
    render();
    expect(readdirSync(view("topics")).toSorted()).toEqual(["2026-11-02-alpha", "2026-11-02-beta"]);
    expect(readdirSync(view("topics", "2026-11-02-beta")).toSorted()).toEqual([
      "a-notes.md",
      "topic.md",
    ]);
    expect(readdirSync(view("topics", "2026-11-02-alpha")).toSorted()).toEqual([
      "b-notes.md",
      "topic.md",
    ]);
    expect(readFileSync(view("topics", "2026-11-02-beta", "topic.md"), "utf8")).toContain(
      `topic=${one}`,
    );
  });

  test("a conflict copy a sync tool writes again while the page retires is kept and ingested later", () => {
    seedLaneEntry(a, (clock += 1000), "reports", "vector", { title: "vector" }, "Lower.");
    render();
    const copy = view("reports", "vector.sync-conflict-20261106-120000-abcdefg.md");
    writeFileSync(copy, "older copy line\n");
    seedLaneRemove(a, (clock += 1000), "reports", "vector");
    const newer = join(m.view("dev-a"), "..", "newer.tmp");
    writeFileSync(newer, "newer copy line\n");
    const realOpen = fs.openSync;
    const realRename = fs.renameSync;
    let delivered = false;
    // The sync tool writes the copy again right after the writer first
    // touches it: once a read has closed the file (Windows refuses to
    // replace a file that is open), or right after a rename took it.
    const deliver = (): void => {
      if (delivered) return;
      delivered = true;
      realRename(newer, copy);
    };
    const realClose = fs.closeSync;
    let copyFd: number | null = null;
    const open = spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: never[]) => {
      const fd = (realOpen as (...args: unknown[]) => number)(p, ...rest);
      if (String(p) === copy) copyFd = fd;
      return fd;
    }) as typeof fs.openSync);
    const close = spyOn(fs, "closeSync").mockImplementation(((fd: number) => {
      realClose(fd);
      if (fd === copyFd) {
        copyFd = null;
        deliver();
      }
    }) as typeof fs.closeSync);
    const rename = spyOn(fs, "renameSync").mockImplementation(((p: fs.PathLike, q: fs.PathLike) => {
      realRename(p, q);
      if (String(p) === copy) deliver();
    }) as typeof fs.renameSync);
    try {
      render(1);
    } finally {
      open.mockRestore();
      close.mockRestore();
      rename.mockRestore();
    }
    expect(delivered).toBe(true);
    render(1);
    const stored = (["shared", "private"] as const)
      .flatMap((p) => readPartition(join(m.root("dev-a"), p)))
      .flatMap((s) => s.records)
      .map((r) => JSON.stringify(r.body));
    expect(stored.some((body) => body.includes("newer copy line"))).toBe(true);
    expect(existsSync(copy)).toBe(false);
  });

  test("a folder named like a conflict copy of a retiring page stays where it is", () => {
    seedLaneEntry(a, (clock += 1000), "reports", "vector", { title: "vector" }, "Lower.");
    render();
    const copy = view("reports", "vector.sync-conflict-20261106-120000-abcdefg.md");
    mkdirSync(copy);
    writeFileSync(join(copy, "mine.txt"), "mine\n");
    seedLaneRemove(a, (clock += 1000), "reports", "vector");
    render(1);
    expect(readFileSync(join(copy, "mine.txt"), "utf8")).toBe("mine\n");
    expect(readdirSync(view("reports")).filter((n) => n.startsWith("."))).toEqual([]);
  });

  test.skipIf(process.platform === "win32")(
    "a symbolic link named like a conflict copy of a retiring page is never read or moved",
    () => {
      seedLaneEntry(a, (clock += 1000), "reports", "vector", { title: "vector" }, "Lower.");
      render();
      const outside = join(m.view("dev-a"), "..", "outside-secret.md");
      writeFileSync(outside, "outside secret\n");
      const copy = view("reports", "vector.sync-conflict-20261106-120000-abcdefg.md");
      symlinkSync(outside, copy);
      seedLaneRemove(a, (clock += 1000), "reports", "vector");
      render(1);
      expect(fs.lstatSync(copy).isSymbolicLink()).toBe(true);
      expect(readdirSync(view("reports")).filter((n) => n.startsWith("."))).toEqual([]);
      const stored = (["shared", "private"] as const)
        .flatMap((p) => readPartition(join(m.root("dev-a"), p)))
        .flatMap((s) => s.records)
        .map((r) => JSON.stringify(r.body));
      expect(stored.some((body) => body.includes("outside secret"))).toBe(false);
    },
  );

  test("a renamed topic's files follow it when its old page was already gone", () => {
    const id = newUlid(T0);
    topic(id, "Docs");
    render();
    writeFileSync(view("topics", "2026-11-02-docs", "notes.md"), "mine\n");
    // A pass died after the old page left and before its files moved.
    rmSync(view("topics", "2026-11-02-docs", "topic.md"));
    topic(id, "Guide", "topic-rename");
    render();
    expect(existsSync(view("topics", "2026-11-02-docs"))).toBe(false);
    expect(readdirSync(view("topics", "2026-11-02-guide")).toSorted()).toEqual([
      "notes.md",
      "topic.md",
    ]);
  });
});

describe("pages leaving the view: links, case and device names", () => {
  test.skipIf(process.platform === "win32")(
    "a topic folder that is a symbolic link out of the view is never read, emptied or written",
    () => {
      const id = newUlid(T0);
      topic(id, "Live");
      render();
      const outside = join(m.view("dev-a"), "..", "elsewhere");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "id_rsa"), "key\n");
      const withPage = join(m.view("dev-a"), "..", "elsewhere-two");
      mkdirSync(withPage, { recursive: true });
      writeFileSync(join(withPage, "topic.md"), "secret\n");
      symlinkSync(outside, view("topics", "2026-11-02-evil"));
      symlinkSync(withPage, view("topics", "2026-11-02-evil-two"));
      forgeRender("topics/2026-11-02-evil/topic.md", "a", id);
      forgeRender("topics/2026-11-02-evil-two/topic.md", "b", id);
      render();
      expect(readdirSync(outside)).toEqual(["id_rsa"]);
      expect(readFileSync(join(withPage, "topic.md"), "utf8")).toBe("secret\n");
      expect(readdirSync(view("topics", "2026-11-02-live")).toSorted()).toEqual(["topic.md"]);
      const stored = readPartition(join(m.root("dev-a"), "shared"))
        .flatMap((s) => s.records)
        .map((r) => JSON.stringify(r.body));
      expect(stored.some((body) => body.includes("secret"))).toBe(false);
    },
  );

  test("a forged record naming a Windows device name is never retired", () => {
    mkdirSync(view("reports"), { recursive: true });
    writeFileSync(view("reports", "con.md"), "mine\n");
    forgeRender("reports/con.md", "a");
    topic(newUlid(T0), "Real");
    render();
    expect(readFileSync(view("reports", "con.md"), "utf8")).toBe("mine\n");
  });

  test.skipIf(process.platform === "win32")(
    "a page that is a live page's file under another case is not retired",
    () => {
      seedLaneEntry(a, (clock += 1000), "reports", "vector", { title: "vector" }, "Lower.");
      render();
      seedLaneRemove(a, (clock += 1000), "reports", "vector");
      seedLaneEntry(a, (clock += 1000), "reports", "Vector", { title: "Vector" }, "Upper.");
      render();
      // What a case-insensitive file system does: both names are one file.
      // On such a file system (macOS by default) they already are, and
      // removing one name would remove the live page.
      if (!oneFile(view("reports", "vector.md"), view("reports", "Vector.md"))) {
        rmSync(view("reports", "vector.md"), { force: true });
        linkSync(view("reports", "Vector.md"), view("reports", "vector.md"));
      }
      const before = readPartition(join(m.root("dev-a"), "shared")).flatMap(
        (s) => s.records,
      ).length;
      render();
      const after = readPartition(join(m.root("dev-a"), "shared")).flatMap((s) => s.records);
      expect(existsSync(view("reports", "vector.md"))).toBe(true);
      expect(after.slice(before).filter((r) => r.body["page"] === "reports/vector.md")).toEqual([]);
    },
  );

  test("a page whose id line a user edited is not taken for another topic's", () => {
    const one = newUlid(T0);
    const two = newUlid(T0 + 1);
    topic(one, "Alpha");
    topic(two, "Beta");
    render();
    const page = view("topics", "2026-11-02-alpha", "topic.md");
    writeFileSync(view("topics", "2026-11-02-alpha", "notes.md"), "mine\n");
    writeFileSync(page, readFileSync(page, "utf8").replace(`topic=${one}`, `topic=${two}`));
    render();
    expect(readdirSync(view("topics", "2026-11-02-alpha")).toSorted()).toEqual([
      "notes.md",
      "topic.md",
    ]);
    expect(readdirSync(view("topics", "2026-11-02-beta")).toSorted()).toEqual(["topic.md"]);
  });
});

describe("pages leaving the view: review follow-ups", () => {
  test.skipIf(process.platform === "win32")(
    "a page name that became a symbolic link is never read through when captured",
    () => {
      const outside = join(m.parent, "secret.txt");
      writeFileSync(outside, "secret\n");
      mkdirSync(view("topics"), { recursive: true });
      const page = view("topics", "page.md");
      symlinkSync(outside, page);
      expect(() => capturePage(page)).toThrow(NotAPageFileError);
      expect(readFileSync(outside, "utf8")).toBe("secret\n");
      expect(existsSync(page)).toBe(true);
    },
  );

  test("a folder at a live topic page's name is refused and the rest of the pass renders", () => {
    const docs = newUlid(T0);
    const store = newUlid(T0 + 1);
    topic(docs, "Docs");
    topic(store, "Store");
    const blocked = view("topics", "2026-11-02-docs", "topic.md");
    mkdirSync(blocked, { recursive: true });
    claimViewWriter(a, { agent: "t", now });
    let report = runViewPass(a, { target: m.view("dev-a"), vault: null, agent: "t", now });
    for (let i = 0; i < 2 && report.status !== "rendered"; i++) {
      clock += 1000;
      report = runViewPass(a, { target: m.view("dev-a"), vault: null, agent: "t", now });
    }
    if (report.status !== "rendered") throw new Error(report.status);
    const byPage = new Map(report.pages.map((p) => [p.page, p.status]));
    expect(byPage.get("topics/2026-11-02-docs/topic.md")).toBe("refused");
    expect(byPage.get("topics/2026-11-02-store/topic.md")).toBe("written");
    expect(existsSync(view("topics", "2026-11-02-store", "topic.md"))).toBe(true);
    expect(readdirSync(blocked)).toEqual([]);
  });

  test("a pass whose time budget ran out retires nothing and defers the pages", () => {
    const id = newUlid(T0);
    topic(id, "Docs");
    render();
    topic(id, "Guide", "topic-rename");
    claimViewWriter(a, { agent: "t", now });
    clock += 1000;
    const report = runViewPass(a, {
      target: m.view("dev-a"),
      vault: null,
      agent: "t",
      now,
      shouldStop: () => true,
    });
    expect(existsSync(view("topics", "2026-11-02-docs", "topic.md"))).toBe(true);
    if (report.status !== "rendered") throw new Error(report.status);
    expect(report.pages.every((p) => p.status === "deferred")).toBe(true);
  });

  test("a retired page whose id line names another topic still takes its files to its own topic", () => {
    const one = newUlid(T0);
    const two = newUlid(T0 + 1);
    topic(one, "Alpha");
    topic(two, "Beta");
    render();
    const page = view("topics", "2026-11-02-alpha", "topic.md");
    writeFileSync(view("topics", "2026-11-02-alpha", "notes.md"), "mine\n");
    writeFileSync(page, readFileSync(page, "utf8").replace(`topic=${one}`, `topic=${two}`));
    topic(one, "Gamma", "topic-rename");
    render();
    expect(readdirSync(view("topics", "2026-11-02-gamma")).toSorted()).toEqual([
      "notes.md",
      "topic.md",
    ]);
    expect(readdirSync(view("topics", "2026-11-02-beta")).toSorted()).toEqual(["topic.md"]);
  });

  test("a slot handed to another topic while the old page was gone still moves the old topic's files", () => {
    const first = newUlid(T0);
    const second = newUlid(T0 + 1);
    topic(first, "Docs");
    topic(second, "Docs");
    render();
    const base = "2026-11-02-docs";
    writeFileSync(view("topics", base, "a-notes.md"), "first's\n");
    rmSync(view("topics", base, "topic.md"));
    topic(first, "Alpha", "topic-rename");
    render();
    expect(readdirSync(view("topics", "2026-11-02-alpha")).toSorted()).toEqual([
      "a-notes.md",
      "topic.md",
    ]);
    expect(readdirSync(view("topics", base))).not.toContain("a-notes.md");
  });
});

/** `bigint` stats as a filesystem reports them; only the compared fields matter. */
function stats(fields: { dev: bigint; ino: bigint; size?: bigint; t?: bigint }): BigIntStats {
  return {
    dev: fields.dev,
    ino: fields.ino,
    size: fields.size ?? 12n,
    mtimeNs: fields.t ?? 1_700_000_000_000_000_000n,
    ctimeNs: fields.t ?? 1_700_000_000_000_000_000n,
  } as unknown as BigIntStats;
}

describe("whether a retiring page is the live page's file (constructed stats)", () => {
  test("a volume with no inode: one file under two spellings is the same, so it is spared", () => {
    // A network share or a FAT-family volume answers ino 0 for every file.
    const one = stats({ dev: 7n, ino: 0n });
    expect(sameFileStats(one, stats({ dev: 7n, ino: 0n }))).toBe(true);
  });

  test("a volume with no inode: files of another size or time are not taken for one", () => {
    const one = stats({ dev: 7n, ino: 0n });
    expect(sameFileStats(one, stats({ dev: 7n, ino: 0n, size: 13n }))).toBe(false);
    expect(sameFileStats(one, stats({ dev: 7n, ino: 0n, t: 1n }))).toBe(false);
    expect(sameFileStats(one, stats({ dev: 8n, ino: 0n }))).toBe(false);
  });

  test("with inodes the exact identity decides, above 2^53 too", () => {
    const base = (0x2bn << 48n) | 0x1_2345_6788n;
    expect(sameFileStats(stats({ dev: 7n, ino: base }), stats({ dev: 7n, ino: base }))).toBe(true);
    expect(sameFileStats(stats({ dev: 7n, ino: base }), stats({ dev: 7n, ino: base + 1n }))).toBe(
      false,
    );
    expect(sameFileStats(null, stats({ dev: 7n, ino: base }))).toBe(false);
  });
});
