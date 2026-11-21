/**
 * A rebuild whose swap fails puts the previous index back. When that
 * put-back fails too, the refusal says so and names where the previous
 * index is, instead of reading as "old index intact".
 */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync } from "node:fs";

import { indexVault, reindexVault } from "../../../src/core/search/indexer.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("swap-rollback"));
  writeMd(vault, "a.md", "# Herons\n\nGrey herons wade in shallow water.\n");
});
afterEach(() => cleanup());

async function reindexWithFailingRename(
  failOn: (from: string, to: string) => boolean,
): Promise<string> {
  const realRename = fs.renameSync;
  const spy = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (failOn(String(from), String(to))) {
      throw Object.assign(new Error(`EIO: simulated, ${String(to)}`), { code: "EIO" });
    }
    realRename(from, to);
  });
  try {
    await reindexVault(makeConfig({ vault, dbPath }));
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    spy.mockRestore();
  }
}

const isSwapIn = (from: string, to: string): boolean => to === dbPath && from !== `${dbPath}.bak`;

test.skipIf(process.platform === "win32")(
  "a failed put-back is reported with the place the previous index stays",
  async () => {
    await indexVault(makeConfig({ vault, dbPath }));
    const message = await reindexWithFailingRename(
      (from, to) => isSwapIn(from, to) || (from === `${dbPath}.bak` && to === dbPath),
    );
    expect(message).toContain("EIO: simulated");
    expect(message).toContain(`the previous index could not be put back`);
    expect(message).toContain(`${dbPath}.bak`);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}.bak`)).toBe(true);
  },
);

test.skipIf(process.platform === "win32")(
  "a put-back that works leaves the previous index live and claims nothing else",
  async () => {
    await indexVault(makeConfig({ vault, dbPath }));
    const message = await reindexWithFailingRename(isSwapIn);
    expect(message).toContain("EIO: simulated");
    expect(message).not.toContain("could not be put back");
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(`${dbPath}.bak`)).toBe(false);
  },
);
