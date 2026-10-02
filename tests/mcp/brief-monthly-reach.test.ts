/**
 * `brain_brief view=monthly` counts at the caller's reach.
 *
 * The vault pair is tests/helpers/reach-log-fixture.ts: vault A holds a
 * reserved preference with evidence inside both the 24-hour and the
 * 30-day windows and a reserved record a dream confirmed and retired;
 * vault B never had either. A server with no reach minted is a remote
 * caller: its monthly summaries over the two vaults must be identical.
 * The events of the fixture span the last three days, so every month
 * they touch is asked. The local control proves the reserved records
 * are there to count.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import {
  buildReachLogFixture,
  DAY_MS,
  reachServer,
  type ReachLogFixture as Fixture,
} from "../helpers/reach-log-fixture.ts";

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-brief-monthly-reach-"));
  bases.push(base);
  return buildReachLogFixture(base, withPrivate);
}

/** Every month the fixture's events fall in: the recent day and three days back. */
function months(): ReadonlyArray<string> {
  const now = Date.now();
  const touched = [now - DAY_MS / 24, now - 3 * DAY_MS].map((ms) =>
    new Date(ms).toISOString().slice(0, 7),
  );
  return [...new Set(touched)];
}

interface Summary {
  readonly events: number;
  readonly status_transitions: number;
  readonly retired: number;
  readonly contradictions: number;
  readonly neglected_areas: ReadonlyArray<string>;
}

async function summaries(f: Fixture, reach?: TransportReach): Promise<Summary[]> {
  const server = reachServer(f, reach);
  const out: Summary[] = [];
  for (const month of months()) {
    // oxlint-disable-next-line no-await-in-loop -- one server, months in order
    const result = (await server.callTool("brain_brief", { view: "monthly", month })) as Record<
      string,
      unknown
    >;
    const body = (result["structuredContent"] ?? result) as Record<string, unknown>;
    out.push(body["summary"] as Summary);
  }
  return out;
}

function sum(list: ReadonlyArray<Summary>, key: "events" | "retired" | "contradictions"): number {
  return list.reduce((n, s) => n + s[key], 0);
}

describe("brain_brief view=monthly counts at the caller's reach", () => {
  test("remote reach: the reserved records move no count", async () => {
    const b = fixture(false);
    const remoteA = await summaries(fixture(true));
    const remoteB = await summaries(b);
    expect(remoteA).toEqual(remoteB);
    // Vault B holds nothing to withhold: the remote answer is the local one.
    expect(remoteB).toEqual(await summaries(b, TRANSPORT_REACH.local));
  });

  test("local control: the operator's own shell counts the reserved records", async () => {
    const localA = await summaries(fixture(true), TRANSPORT_REACH.local);
    const localB = await summaries(fixture(false), TRANSPORT_REACH.local);
    expect(sum(localA, "events")).toBeGreaterThan(sum(localB, "events"));
    expect(sum(localA, "retired")).toBeGreaterThan(sum(localB, "retired"));
    expect(sum(localA, "contradictions")).toBeGreaterThan(sum(localB, "contradictions"));
  });
});
