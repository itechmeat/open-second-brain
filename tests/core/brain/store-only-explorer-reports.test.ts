/**
 * The explorer console's report-snapshot listing on a switched vault with
 * no `Brain/` tree: the snapshots are entries of the store's `reports`
 * lane (`report-snapshot.ts` writes them through the lane page store), so
 * the surfaces are listed from there, not from a `Brain/reports/` folder.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { collectExplorerConsole } from "../../../src/core/brain/explorer-console.ts";
import { writeReportSnapshot } from "../../../src/core/brain/report-snapshot.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";

const ENV_KEY = "OPEN_SECOND_BRAIN_REPORT_SNAPSHOTS";
let env: StoreEnv | undefined;
const saved = process.env[ENV_KEY];
afterEach(() => {
  env?.cleanup();
  env = undefined;
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

test("report snapshot surfaces are listed from the store on a vault with no Brain/", () => {
  env = makeStoreEnv("osb-explorer-reports-", { legacyTree: false });
  process.env[ENV_KEY] = "1";
  writeReportSnapshot(env.vault, "digest", "2026-11-18", { counts: { events: 1 } });
  writeReportSnapshot(env.vault, "morning-brief", "2026-11-19", { items: [] });
  expect(existsSync(join(env.vault, "Brain"))).toBe(false);

  const payload = collectExplorerConsole(env.vault, { now: new Date("2026-11-20T00:00:00Z") });
  expect(payload.report_snapshots).toEqual({
    status: "ok",
    surfaces: [
      { surface: "digest", latest_date: "2026-11-18" },
      { surface: "morning-brief", latest_date: "2026-11-19" },
    ],
  });
});
