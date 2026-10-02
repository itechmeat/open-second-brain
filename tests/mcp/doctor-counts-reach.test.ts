/**
 * `brain_doctor` caps its removed-tool warnings and counts the states
 * behind its stale-dependency note at the caller's reach.
 *
 * Both are computed inside the doctor's checks, before the handler's
 * own filter runs: a withheld page that spent a slot of the removed-tool
 * cap, or a withheld retired record counted in `states_changed`, would
 * change the answer even though no finding names it.
 *
 * The vault pair is tests/helpers/reach-log-fixture.ts, plus 50 readable
 * pages naming a removed tool in both and, in vault A only, a withheld
 * Brain page whose validity closed (a state that stopped being current)
 * and 50 withheld pages naming the removed tool: the walk lists them in directory order, so withheld
 * pages are among the first 50 whatever that order is. A server with no
 * reach minted is a remote caller; the local control proves the withheld
 * items are there to count.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  reachServer,
  type ReachLogFixture as Fixture,
} from "../helpers/reach-log-fixture.ts";

/** A tool the product no longer ships, which the doctor reports when a page names it. */
const REMOVED_TOOL = "brain_digest";
const PAGE_COUNT = 50;
const PAGE_DIR = "Brain/memos";
const PRIVATE_PATH = "PRIVATE_PATH";
const REMOVED_TOOL_CODE = "removed-tool-reference";
const STALE_DEPENDENCY_CODE = "stale-dependency";

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

function page(index: number, reserved: boolean): string {
  const front = reserved ? `---\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]\n---\n` : "";
  return `${front}# memo ${index}\n\nCall ${REMOVED_TOOL} for the summary.\n`;
}

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-doctor-counts-reach-"));
  bases.push(base);
  const f = buildReachLogFixture(base, withPrivate);
  const dir = join(f.vault, ...PAGE_DIR.split("/"));
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < PAGE_COUNT; i++) {
    const n = String(i).padStart(2, "0");
    writeFileSync(join(dir, `memo-${n}.md`), page(i, false));
    if (withPrivate) writeFileSync(join(dir, `${PRIVATE_PATH}-${n}.md`), page(i, true));
  }
  if (withPrivate) {
    writeFileSync(
      join(f.vault, "Brain", `${PRIVATE_PATH}-closed.md`),
      `---\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]\nvalid_until: 2026-01-01T00:00:00Z\n---\n# closed\n`,
    );
  }
  return f;
}

interface Entry {
  readonly code: string;
  readonly message: string;
}

interface Report {
  readonly warnings: ReadonlyArray<Entry>;
  readonly uncertain?: ReadonlyArray<Entry>;
}

/** The doctor's answer with the fixture's paths and instants masked. */
async function doctor(f: Fixture, reach?: TransportReach): Promise<Report> {
  const result = (await reachServer(f, reach).callTool("brain_doctor", {})) as Record<
    string,
    unknown
  >;
  return JSON.parse(maskVolatile(f, result["structuredContent"] ?? result)) as Report;
}

function removedToolWarnings(report: Report): ReadonlyArray<string> {
  return report.warnings
    .filter((w) => w.code === REMOVED_TOOL_CODE)
    .map((w) => w.message)
    .toSorted();
}

function staleNotes(report: Report): ReadonlyArray<string> {
  return (report.uncertain ?? [])
    .filter((u) => u.code === STALE_DEPENDENCY_CODE)
    .map((u) => u.message);
}

describe("brain_doctor counts at the caller's reach", () => {
  test("remote reach: withheld pages spend no slot of the removed-tool cap", async () => {
    const withheld = removedToolWarnings(await doctor(fixture(true)));
    const absent = removedToolWarnings(await doctor(fixture(false)));
    expect(absent).toHaveLength(PAGE_COUNT);
    expect(withheld).toEqual(absent);
    expect(withheld.join("\n")).not.toContain(PRIVATE_PATH);
  });

  test("remote reach: a withheld closed state moves no stale-dependency count", async () => {
    const withheld = staleNotes(await doctor(fixture(true)));
    const absent = staleNotes(await doctor(fixture(false)));
    expect(withheld).toEqual(absent);
    expect(withheld).toEqual([]);
  });

  test("local control: the operator's own shell counts the withheld items", async () => {
    const a = await doctor(fixture(true), TRANSPORT_REACH.local);
    const b = await doctor(fixture(false), TRANSPORT_REACH.local);
    const local = removedToolWarnings(a);
    expect(local).toHaveLength(PAGE_COUNT);
    expect(local.join("\n")).toContain(PRIVATE_PATH);
    expect(staleNotes(b)).toEqual([]);
    expect(staleNotes(a).join("\n")).toContain("1 state stopped being current");
  });
});
