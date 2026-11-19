/**
 * An import of late legacy writes reads what changed, not the whole tree
 * (change migration-sync-conflict-copies, follow-up 5): a file whose
 * stamp (size, mtime, ctime, inode) is unchanged since the last import is
 * not opened, an appended one is read from where the last read ended, and
 * anything the stamp and the checksum of what was read cannot prove
 * unchanged is read whole, as before.
 */
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  appendFileSync,
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { migrateStore } from "../../../src/core/store-migration/outcome.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { makeMigrationBench, type MigrationBench } from "./fixtures/migration-env.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const FAST = { settleMs: 0 } as const;
const SHARD = "Brain/log/2026-11-05.dev-a.jsonl";

let bench: MigrationBench | null = null;
afterEach(() => {
  bench?.cleanup();
  bench = null;
});

const row = (n: number, text = `row ${n}`): string =>
  JSON.stringify({
    ts: `2026-11-05T10:0${n}:00Z`,
    kind: "note",
    payload: { text },
    prev: null,
    h: "0".repeat(64),
  });

/** A switched bench whose shard holds four rows, imported. */
function switched(): MigrationBench {
  const b = makeMigrationBench("osb-incremental-");
  b.fx.write(SHARD, [1, 2, 3, 4].map((n) => row(n)).join("\n") + "\n");
  expect(runMigration(b.vault, FAST).ok).toBe(true);
  return b;
}

/** Run the late-write import, counting how often the shard is read. */
function importCounting(b: MigrationBench): { imported: number; reads: number } {
  const shard = join(b.vault, ...SHARD.split("/"));
  let reads = 0;
  const real = fs.readFileSync;
  const spy = spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...rest: unknown[]) => {
    if (path === shard) reads += 1;
    return (real as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFileSync);
  try {
    const outcome = migrateStore(b.vault, FAST);
    if (outcome.mode !== "transition") throw new Error(`unexpected mode ${outcome.mode}`);
    return { imported: outcome.imported, reads };
  } finally {
    spy.mockRestore();
  }
}

/** Records per item key of the shard. */
function versions(b: MigrationBench, line: number): string[] {
  return (b.byKey().get(`${SHARD}#${line}`) ?? []).map(
    (r) => (r.body["body"] as { text: string }).text,
  );
}

describe("an import of late legacy writes", () => {
  test("does not open a file whose stamp is unchanged since the last import", () => {
    bench = switched();
    expect(importCounting(bench)).toEqual({ imported: 0, reads: 0 });
  });

  test("imports an appended line once, reading the file once per pass that sees it change", () => {
    bench = switched();
    appendFileSync(join(bench.vault, ...SHARD.split("/")), `${row(5)}\n`);
    const first = importCounting(bench);
    expect(first.imported).toBe(1);
    expect(first.reads).toBe(1);
    expect(versions(bench, 5)).toEqual(["row 5"]);
    for (const n of [1, 2, 3, 4]) expect(versions(bench, n)).toHaveLength(1);
    // The next import finds nothing new and opens nothing.
    expect(importCounting(bench)).toEqual({ imported: 0, reads: 0 });
  });

  test.each([
    [
      "a changed line in the middle",
      (path: string) => {
        const lines = readFileSync(path, "utf8").split("\n");
        lines[1] = row(2, "row 2 edited");
        writeFileSync(path, lines.join("\n"));
      },
    ],
    [
      "a file replaced by a shorter one",
      (path: string) => {
        writeFileSync(`${path}.new`, `${row(1)}\n${row(2, "row 2 edited")}\n`);
        renameSync(`${path}.new`, path);
      },
    ],
    [
      "the same size and mtime, other content",
      (path: string) => {
        const before = statSync(path);
        const text = readFileSync(path, "utf8").replace("row 2", "row 9");
        writeFileSync(path, text.replace(row(9), row(2, "row 9")));
        utimesSync(path, before.atime, before.mtime);
      },
    ],
    [
      "an edited prefix and an appended line, in place",
      (path: string) => {
        const text = readFileSync(path, "utf8");
        const at = text.indexOf("row 2");
        const fd = openSync(path, "r+");
        try {
          writeSync(fd, "row 8", at);
        } finally {
          closeSync(fd);
        }
        appendFileSync(path, `${row(5)}\n`);
      },
    ],
  ])("reads the file whole after %s", (_case, change) => {
    bench = switched();
    const path = join(bench.vault, ...SHARD.split("/"));
    change(path);
    const result = importCounting(bench);
    expect(result.imported).toBeGreaterThan(0);
    // The row on line 2 is read again: its new version is in the store.
    expect(versions(bench, 2).length).toBe(2);
    for (const n of [1, 3, 4]) expect(versions(bench, n).length).toBeLessThanOrEqual(1);
  });
});
