/**
 * The view writer's device-local files survive damage: one broken page
 * stats entry costs only that page, and an intent entry that cannot be
 * read or removed never stops the render.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import {
  VIEW_INTENT_DIR,
  VIEW_PAGE_STATS_FILE,
  VIEW_STATE_DIR,
} from "../../../src/core/view/constants.ts";
import { readPageStats } from "../../../src/core/view/page-stats.ts";
import { pendingIntents } from "../../../src/core/view/view-records.ts";
import { makeMachines, type Machines } from "./fixtures/machines.ts";

let m: Machines;
let a: StoreHandle;
beforeEach(() => {
  m = makeMachines(["dev-a"]);
  a = m.open("dev-a");
});
afterEach(() => m.cleanup());

test("a broken stats entry drops only itself", () => {
  const dir = join(a.deviceStateDir, VIEW_STATE_DIR);
  mkdirSync(dir, { recursive: true });
  const good = { size: 1, mtimeMs: 2, ctimeMs: 3, ino: 4, sum: "s" };
  writeFileSync(join(dir, VIEW_PAGE_STATS_FILE), JSON.stringify({ "a.md": null, "b.md": good }));
  expect([...readPageStats(a).entries()]).toEqual([["b.md", good]]);
});

test("an intent entry that is a folder is skipped, not fatal", () => {
  const dir = join(a.deviceStateDir, VIEW_STATE_DIR, VIEW_INTENT_DIR);
  mkdirSync(join(dir, "stray"), { recursive: true });
  expect(pendingIntents(a)).toEqual([]);
});
