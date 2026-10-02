/**
 * The remaining readers of Brain log content answer at the caller's reach.
 *
 * The rule is the one tests/mcp/log-readers-reach.test.ts pins for the
 * analytics, brief and trace readers: below local reach an event naming
 * a record the caller cannot read is dropped, a dream shared with such a
 * record keeps its readable transitions, and a retired record is judged
 * under its `pref-` spelling too. The rows here cover the raw log
 * resource, `brain_query`'s log branches, the backlinks resource, the
 * preference readers and the doctor.
 *
 * The vault pair is tests/helpers/reach-log-fixture.ts. A server with no
 * reach minted is a remote caller; each row also carries a local control
 * proving the reserved record is there to hide.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendLogEvent } from "../../src/core/brain/log.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../src/core/brain/types.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  PRIVATE_PATH,
  PRIVATE_SLUG,
  reachServer,
  type ReachLogFixture as Fixture,
  RETIRED_SLUG,
  SHARED_SLUG,
} from "../helpers/reach-log-fixture.ts";

/** Relative ages ("1h ago") and durations, which tick between the two builds. */
const AGE_RE = /\b\d+(?:ms|s|m|h|d)\b/g;
/** A log heading's time of day, which ticks between the two builds. */
const HEADING_TIME_RE = /\b\d{2}:\d{2}:\d{2}Z/g;
/** A tool the product no longer ships, which the doctor reports when a page names it. */
const REMOVED_TOOL = "brain_digest";
/** The evidence artifact of the malformed-range row: a reserved note, by path. */
const HIDDEN_NOTE = "Notes/zzhiddendoc";

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-log-readers-reach-r3-"));
  bases.push(base);
  return buildReachLogFixture(base, withPrivate);
}

/** Append one event to the fixture's calendar day, at a fixed time both vaults share. */
function logOnDay(f: Fixture, eventType: string, body: Record<string, unknown>): void {
  appendLogEvent(
    f.vault,
    { timestamp: `${f.date}T00:00:00Z`, eventType, body } as Parameters<typeof appendLogEvent>[1],
    { deviceId: "" },
  );
}

/**
 * A dream confirming the public preference and, in vault A, the retired
 * reserved record under its `pref-` spelling: only `ret-bygone` is on
 * disk, so the transition names no page unless both spellings are asked.
 */
function retiredOnlyDream(withPrivate: boolean): (f: Fixture) => Promise<void> {
  return async (f) => {
    const confirmed = [`[[pref-${SHARED_SLUG}|rule]]`];
    if (withPrivate) confirmed.push(`[[pref-${RETIRED_SLUG}|rule]]`);
    logOnDay(f, BRAIN_LOG_EVENT_KIND.dream, { run_id: "run-retired-only", confirmed });
  };
}

/**
 * Vault A only: evidence on the public preference whose artifact is the
 * retired reserved record under its `pref-` spelling.
 */
function retiredArtifactEvidence(withPrivate: boolean): (f: Fixture) => Promise<void> {
  return async (f) => {
    if (!withPrivate) return;
    logOnDay(f, BRAIN_LOG_EVENT_KIND.applyEvidence, {
      preference: `[[pref-${SHARED_SLUG}]]`,
      artifact: `[[pref-${RETIRED_SLUG}|rule]]`,
      result: "applied",
    });
  };
}

async function call(
  f: Fixture,
  tool: string,
  args: Record<string, unknown>,
  reach?: TransportReach,
): Promise<unknown> {
  try {
    const result = (await reachServer(f, reach).callTool(tool, args)) as Record<string, unknown>;
    return result["structuredContent"] ?? result;
  } catch (err) {
    // A refusal is an answer too: its message is compared like any other.
    return (err as Error).message;
  }
}

/** A resource read through the server's JSON-RPC surface: the result or the error frame. */
async function read(f: Fixture, uri: string, reach?: TransportReach): Promise<unknown> {
  const response = await reachServer(f, reach).handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "resources/read",
    params: { uri },
  });
  return response === null ? null : (response.result ?? response.error);
}

function normalise(f: Fixture, value: unknown): string {
  return maskVolatile(f, value).replace(AGE_RE, "<AGE>").replace(HEADING_TIME_RE, "<HMS>");
}

type Ask = (f: Fixture, reach?: TransportReach) => Promise<unknown>;
type Prepare = (withPrivate: boolean) => (f: Fixture) => Promise<void>;

/** The remote answers of both vaults, normalised, plus vault A's local answer. */
async function abRow(
  ask: Ask,
  prepare: Prepare = () => async () => {},
): Promise<{ withheld: string; absent: string; local: string }> {
  const a = fixture(true);
  const b = fixture(false);
  await prepare(true)(a);
  await prepare(false)(b);
  return {
    withheld: normalise(a, await ask(a)),
    absent: normalise(b, await ask(b)),
    local: normalise(a, await ask(a, TRANSPORT_REACH.local)),
  };
}

const logResource: Ask = (f, reach) => read(f, `osb://log/${f.date}`, reach);
const querySince: Ask = (f, reach) =>
  call(f, "brain_query", { since: `${f.date}T00:00:00Z` }, reach);
const queryTopic: Ask = (f, reach) => call(f, "brain_query", { topic: SHARED_SLUG }, reach);

describe("a dream shared with a reserved preference is kept for its public transition", () => {
  for (const [label, ask] of [
    ["osb://log/{date}", logResource],
    ["brain_query since", querySince],
  ] as const) {
    test(`${label} shows the shared dream remotely as the vault that never had the record`, async () => {
      const row = await abRow(ask);
      expect(row.withheld).toBe(row.absent);
      expect(row.withheld).toContain(`pref-${SHARED_SLUG}`);
      expect(row.withheld).not.toContain(PRIVATE_SLUG);
      // Control: a local caller sees the dream naming the reserved record.
      expect(row.local).toContain(`pref-${PRIVATE_SLUG}`);
    });
  }
});

describe("a retired reserved record is judged under its pref- spelling", () => {
  for (const [label, ask, prepare] of [
    ["osb://log/{date}", logResource, retiredOnlyDream],
    ["brain_query since", querySince, retiredOnlyDream],
    ["brain_query topic", queryTopic, retiredArtifactEvidence],
  ] as const) {
    test(`${label} names no retired reserved record remotely`, async () => {
      const row = await abRow(ask, prepare);
      expect(row.withheld).toBe(row.absent);
      expect(row.withheld).not.toContain(RETIRED_SLUG);
      expect(row.local).toContain(`pref-${RETIRED_SLUG}|rule`);
    });
  }

  test("osb://backlinks/pref-bygone answers as an absent page", async () => {
    const row = await abRow((f, reach) => read(f, `osb://backlinks/pref-${RETIRED_SLUG}`, reach));
    expect(row.withheld).toBe(row.absent);
    expect(row.local).toContain("log-dream");
  });
});

// The fixture's retired page carries no `retired_by`, so the preference
// parser refuses it and names the page in its error.
describe("a reserved preference page that fails to parse answers as an absent one", () => {
  for (const [label, ask] of [
    [
      "brain_query preference",
      (f: Fixture, reach?: TransportReach) =>
        call(f, "brain_query", { preference: `pref-${RETIRED_SLUG}` }, reach),
    ],
    [
      "osb://preference/{id}",
      (f: Fixture, reach?: TransportReach) =>
        read(f, `osb://preference/pref-${RETIRED_SLUG}`, reach),
    ],
  ] as const) {
    test(`${label} on the retired reserved record`, async () => {
      const row = await abRow(ask);
      expect(row.withheld).toBe(row.absent);
      expect(row.withheld).not.toContain(`ret-${RETIRED_SLUG}`);
      // Control: a local caller reaches the parser, which names the page.
      expect(row.local).toContain(`ret-${RETIRED_SLUG}`);
    });
  }
});

/**
 * Vault A's reserved preference names a removed tool and carries evidence
 * whose artifact range is malformed, and the retired reserved record
 * carries evidence logged under its `pref-` spelling; vault B carries none
 * of them.
 */
function doctorFindings(withPrivate: boolean): (f: Fixture) => Promise<void> {
  return async (f) => {
    if (!withPrivate) return;
    const abs = join(f.vault, PRIVATE_PATH);
    writeFileSync(abs, `${readFileSync(abs, "utf8")}\nSee \`${REMOVED_TOOL}\`.\n`);
    logOnDay(f, BRAIN_LOG_EVENT_KIND.applyEvidence, {
      preference: `[[pref-${PRIVATE_SLUG}]]`,
      artifact: `[[${HIDDEN_NOTE}:9-x]]`,
      result: "applied",
    });
    // Evidence on the retired reserved record, logged under `pref-`.
    logOnDay(f, BRAIN_LOG_EVENT_KIND.applyEvidence, {
      preference: `[[pref-${RETIRED_SLUG}]]`,
      artifact: `[[Notes/${RETIRED_SLUG}-applied]]`,
      result: "applied",
    });
  };
}

/** The doctor's warnings and errors, sorted (their order follows the checks). */
function findings(normalised: string): ReadonlyArray<string> {
  const report = JSON.parse(normalised) as { warnings?: unknown[]; errors?: unknown[] };
  return [...(report.warnings ?? []), ...(report.errors ?? [])]
    .map((w) => JSON.stringify(w))
    .toSorted();
}

describe("brain_doctor names no reserved record below local reach", () => {
  test("every finding agrees with the vault that never had the record", async () => {
    const row = await abRow((f, reach) => call(f, "brain_doctor", {}, reach), doctorFindings);
    expect(findings(row.withheld)).toEqual(findings(row.absent));
    expect(row.withheld).not.toContain(PRIVATE_SLUG);
    expect(row.withheld).not.toContain(RETIRED_SLUG);
    expect(row.withheld).not.toContain(HIDDEN_NOTE);
    // Control: locally the orphan evidence, the malformed range and the
    // removed-tool mention of the reserved preference are all reported.
    const local = findings(row.local).join("\n");
    for (const code of ["orphan-evidence", "malformed-evidence-range", "removed-tool-reference"]) {
      expect(local).toContain(code);
    }
    expect(local).toContain(`${PRIVATE_SLUG}-applied`);
    expect(local).toContain(`${RETIRED_SLUG}-applied`);
    expect(local).toContain(HIDDEN_NOTE);
    expect(local).toContain(`pref-${PRIVATE_SLUG}.md`);
  });
});
