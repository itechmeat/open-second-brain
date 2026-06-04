/**
 * Time-Aware Recall & Activation Suite - end-to-end integration over
 * one vault: access-reinforced activation with co-access companions
 * (t_2bc79017 + t_c5ef25a3), freshness-trend ranking bias
 * (t_ee09a6ce), event-time recall discipline with temporal bridging
 * (t_b7191486 + t_c3871f0c), and the self-correcting two-pass retry
 * (t_ef92dfdc).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { utimesSync } from "node:fs";

import { loadAccessEvents } from "../../src/core/search/activation/store.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { search } from "../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../helpers/search-fixtures.ts";

const DAY = 24 * 60 * 60 * 1000;

let vault: string;
let dbPath: string;
let cleanup: () => void;

function prefBody(trend: string | null): string {
  return (
    `---\nkind: brain-preference\n${trend ? `freshness_trend: ${trend}\n` : ""}---\n\n` +
    "# Rule\n\nGlacier deploy approvals are mandatory.\n"
  );
}

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("time-aware-e2e"));
});

afterEach(() => {
  cleanup();
});

test("the suite composes end to end on one vault", async () => {
  const now = Date.now();

  // -- Fixtures -------------------------------------------------------
  // A recurring working set: two notes habitually recalled together.
  writeMd(vault, "Brain/notes/runbook.md", "# Runbook\n\nGlacier deploy runbook steps.\n");
  writeMd(vault, "Brain/notes/checklist.md", "# Checklist\n\nGlacier deploy checklist items.\n");
  // Preferences: one weakening, one unstamped twin.
  writeMd(vault, "Brain/preferences/pref-fresh.md", prefBody(null));
  writeMd(vault, "Brain/preferences/pref-fading.md", prefBody("weakening"));
  // Event-time discipline: an old file describing a recent event.
  const oldFileRecentEvent = writeMd(
    vault,
    "Brain/notes/migration-window.md",
    `---\nvalid_from: ${new Date(now - 1 * DAY).toISOString()}\n---\n\n# Window\n\nGlacier migration window agreed.\n`,
  );
  // Temporal bridge: in-window incident linking to near-past prep work.
  writeMd(
    vault,
    "Brain/notes/incident.md",
    "# Incident\n\nGlacier migration window incident.\n\n[[Brain/notes/prep.md|prep]]\n",
  );
  const prep = writeMd(vault, "Brain/notes/prep.md", "# Prep\n\nPre-freeze valve work.\n");
  // Two-pass: terms split across documents (implicit AND finds nothing).
  writeMd(vault, "Brain/notes/permafrost.md", "# Permafrost\n\nPermafrost sensor archive.\n");
  writeMd(vault, "Brain/notes/turbine.md", "# Turbine\n\nTurbine maintenance ledger.\n");

  const config = makeConfig({ vault, dbPath, maxHops: 1, mmrLambda: 1 });
  await indexVault(config);
  // Age the event-time and bridge fixtures AFTER content indexing.
  const ancient = new Date(now - 200 * DAY);
  utimesSync(oldFileRecentEvent, ancient, ancient);
  const prepDate = new Date(now - 10 * DAY);
  utimesSync(prep, prepDate, prepDate);
  await indexVault(config);

  // -- Activation + co-access (t_2bc79017 + t_c5ef25a3) ---------------
  // Recall the working set repeatedly with recording on. Sequential on
  // purpose: each recording must land before the next query so the
  // event files carry distinct timestamps.
  await search(config, { query: "glacier deploy", recordAccess: true, limit: 5 });
  await search(config, { query: "glacier deploy", recordAccess: true, limit: 5 });
  await search(config, { query: "glacier deploy", recordAccess: true, limit: 5 });
  await search(config, { query: "glacier deploy", recordAccess: true, limit: 5 });
  expect(loadAccessEvents(vault).length).toBeGreaterThanOrEqual(1);
  const activated = await search(config, { query: "glacier deploy", limit: 10 });
  const runbook = activated.results.find((r) => r.path === "Brain/notes/runbook.md");
  expect(runbook).toBeDefined();
  expect(runbook!.reasons.some((x) => x.startsWith("activation: "))).toBe(true);
  expect(runbook!.reasons.some((x) => x.startsWith("co_access: "))).toBe(true);

  // -- Freshness-trend bias (t_ee09a6ce) ------------------------------
  const prefs = await search(config, { query: "glacier deploy approvals", limit: 10 });
  const fresh = prefs.results.find((r) => r.path === "Brain/preferences/pref-fresh.md");
  const fading = prefs.results.find((r) => r.path === "Brain/preferences/pref-fading.md");
  expect(fading!.score).toBeLessThan(fresh!.score);
  expect(fading!.reasons.some((x) => x.includes("weakening"))).toBe(true);

  // -- Event-time discipline + temporal bridge (t_b7191486 + t_c3871f0c)
  const windowed = await search(config, { query: "glacier migration window", since: "7d" });
  const windowedPaths = windowed.results.map((r) => r.path);
  // The 200-day-old FILE is found because its EVENT time is yesterday.
  expect(windowedPaths).toContain("Brain/notes/migration-window.md");
  // The linked prep work (10d out, within the 7d pad) bridges in.
  expect(windowedPaths).toContain("Brain/notes/prep.md");
  const bridged = windowed.results.find((r) => r.path === "Brain/notes/prep.md");
  expect(bridged!.reasons.some((x) => x.startsWith("temporal_bridge: "))).toBe(true);

  // -- Two-pass recovery (t_ef92dfdc) ---------------------------------
  const strict = await search(config, { query: "permafrost turbine" });
  expect(strict.results).toHaveLength(0);
  const recovered = await search(config, { query: "permafrost turbine", evidencePack: true });
  expect(recovered.secondPass?.triggered).toBe(true);
  const recoveredPaths = recovered.results.map((r) => r.path);
  expect(recoveredPaths).toContain("Brain/notes/permafrost.md");
  expect(recoveredPaths).toContain("Brain/notes/turbine.md");
});
