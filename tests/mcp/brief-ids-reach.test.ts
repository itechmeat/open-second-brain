/**
 * The daily and weekly brief views answer at the caller's reach.
 *
 * Both views name preference ids from log events: status transitions
 * from dream summaries, the weekly retired and contradiction lists, and
 * the evidence artifacts behind `source_pointers`. Below local reach a
 * row naming a record the caller cannot read is dropped, a source
 * pointer is kept only when it is cited by evidence the caller may see,
 * and no report snapshot is taken.
 *
 * The vault pair is tests/helpers/reach-log-fixture.ts. The counts (`events_by_kind`, `vault_delta`)
 * are recomputed from the events the caller may see, so they are
 * compared unmasked. A server with no reach minted is a remote caller.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BRAIN_LOG_EVENT_KIND } from "../../src/core/brain/types.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import {
  buildReachLogFixture,
  DAY_MS,
  maskVolatile,
  PRIVATE_SLUG,
  reachServer as server,
  type ReachLogFixture as Fixture,
  RETIRED_SLUG,
  SHARED_SLUG,
} from "../helpers/reach-log-fixture.ts";

const SNAPSHOTS_ON = "report_snapshots_enabled: true";

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-brief-ids-reach-"));
  bases.push(base);
  return buildReachLogFixture(base, withPrivate, [SNAPSHOTS_ON]);
}

type View = "daily" | "weekly";

function dayBefore(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

async function brief(f: Fixture, view: View, reach?: TransportReach) {
  const args = view === "daily" ? { view, date: f.date } : { view, week_end: f.weekEnd };
  const result = await server(f, reach).callTool("brain_brief", args);
  return result.structuredContent as Record<string, unknown>;
}

describe("brain_brief daily and weekly at the caller's reach", () => {
  for (const view of ["daily", "weekly"] as const) {
    test(`view=${view} answers remotely as if the reserved records never existed`, async () => {
      const withheld = fixture(true);
      const absent = fixture(false);
      const remoteWithheld = await brief(withheld, view);
      const remoteAbsent = await brief(absent, view);
      expect(maskVolatile(withheld, remoteWithheld)).toBe(maskVolatile(absent, remoteAbsent));
      // Not vacuous: the public preference, its evidence and its counts are named.
      expect(remoteWithheld["events_by_kind"]).toMatchObject({
        [BRAIN_LOG_EVENT_KIND.applyEvidence]: view === "daily" ? 1 : 2,
        [BRAIN_LOG_EVENT_KIND.dream]: 1,
      });
      const text = JSON.stringify(remoteWithheld);
      expect(text).toContain(`pref-${SHARED_SLUG}`);
      expect(text).toContain(`Notes/${SHARED_SLUG}-applied`);
      expect(text).not.toContain(PRIVATE_SLUG);
      expect(text).not.toContain(RETIRED_SLUG);
      expect(remoteWithheld["delta"]).toBeUndefined();
    });

    test(`view=${view} still names the reserved records locally and captures the delta`, async () => {
      const f = fixture(true);
      const local = await brief(f, view, TRANSPORT_REACH.local);
      const text = JSON.stringify(local);
      expect(text).toContain(`pref-${RETIRED_SLUG}`);
      expect(text).toContain(`ret-${RETIRED_SLUG}`);
      expect(text).toContain(`Notes/${PRIVATE_SLUG}-applied`);
      expect(local["delta"]).toMatchObject({ prior_date: null });
    });
  }

  test("view=weekly names the reserved preference's own transition and contradiction locally", async () => {
    const local = await brief(fixture(true), "weekly", TRANSPORT_REACH.local);
    const contradictions = local["contradictions"] as ReadonlyArray<Record<string, unknown>>;
    expect(contradictions.map((row) => row["prefId"])).toContain(`pref-${PRIVATE_SLUG}`);
    expect(JSON.stringify(local["status_transitions"])).toContain(`pref-${PRIVATE_SLUG}`);
  });

  test("a remote run takes no report snapshot, so a later local run is the first", async () => {
    // The remote runs are dated a day earlier: a snapshot they took would
    // be the prior the later local run diffs against.
    const f = fixture(true);
    await server(f).callTool("brain_brief", { view: "daily", date: dayBefore(f.date) });
    await server(f).callTool("brain_brief", { view: "weekly", week_end: dayBefore(f.weekEnd) });
    expect((await brief(f, "daily", TRANSPORT_REACH.local))["delta"]).toMatchObject({
      prior_date: null,
    });
    expect((await brief(f, "weekly", TRANSPORT_REACH.local))["delta"]).toMatchObject({
      prior_date: null,
    });
  });
});
