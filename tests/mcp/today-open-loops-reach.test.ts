/**
 * `brain_brief view=today` answers its open loops, obligations and
 * pledges at the caller's reach.
 *
 * Vault A holds a note under `notes.read_paths`, an obligation page and
 * a pledge page, all withheld from a remote caller by visibility, each
 * carrying a unique marker; vault B never had either. Both share a
 * public note with its own loop, a public obligation, a public pledge
 * and the log of tests/helpers/reach-log-fixture.ts. A server with no
 * reach minted is a remote caller: its answers over the two vaults must
 * be identical once the volatile parts are masked. The local control
 * proves the withheld items are there to hide.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addObligation } from "../../src/core/brain/obligations.ts";
import { addPledge } from "../../src/core/brain/pledges.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  reachServer,
  type ReachLogFixture as Fixture,
} from "../helpers/reach-log-fixture.ts";

const PRIVATE_PATH = "Notes/PRIVATE_PATH.md";
const PRIVATE_LOOP = "zzreservedloopzz";
const PRIVATE_OBLIGATION = "Zzreservedduty";
const PRIVATE_PLEDGE = "Zzreservedpledge";
const PUBLIC_LOOP = "call the plumber";
const PUBLIC_PLEDGE = "Send the pledge report";
const PLEDGE_SOURCE_REL = "Notes/promises-meeting.md";
// A due date that stays ahead of the clock for the suite's whole life: the
// test pins reach behavior, not overdue arithmetic, so a hardcoded date
// would start failing - and change the rendered lines - once it passed.
const PLEDGE_DUE = `${new Date().getUTCFullYear() + 5}-01-01`;
const RESERVE_LINE = `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`;
const AGENT = "claude";

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

/** Insert the reserve line before the closing frontmatter fence of `abs`. */
function reserve(abs: string): void {
  const text = readFileSync(abs, "utf8");
  const close = text.indexOf("\n---\n", "---\n".length);
  writeFileSync(abs, `${text.slice(0, close)}\n${RESERVE_LINE}${text.slice(close)}`);
}

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-today-loops-reach-"));
  bases.push(base);
  const f = buildReachLogFixture(base, withPrivate);
  appendFileSync(join(f.vault, "Brain", "_brain.yaml"), "\nnotes:\n  read_paths:\n    - Notes\n");
  mkdirSync(join(f.vault, "Notes"), { recursive: true });
  writeFileSync(join(f.vault, "Notes", "open.md"), `# open\n\n@osb loop ${PUBLIC_LOOP}\n`);
  addObligation(f.vault, { title: "Water the plants", cadence: "weekly", agent: AGENT });
  writeFileSync(
    join(f.vault, PLEDGE_SOURCE_REL),
    "# Promises meeting\n\nAlice asked me to send the pledge report to the team.\n",
  );
  addPledge(f.vault, {
    title: PUBLIC_PLEDGE,
    due: PLEDGE_DUE,
    source: PLEDGE_SOURCE_REL,
    evidence: ["send the pledge report"],
    agent: AGENT,
  });
  if (withPrivate) {
    writeFileSync(
      join(f.vault, PRIVATE_PATH),
      `---\n${RESERVE_LINE}\n---\n# p\n\n@osb loop ${PRIVATE_LOOP}\n`,
    );
    const duty = addObligation(f.vault, {
      title: PRIVATE_OBLIGATION,
      cadence: "weekly",
      agent: AGENT,
    });
    reserve(duty.path);
    const pledge = addPledge(f.vault, {
      title: PRIVATE_PLEDGE,
      due: PLEDGE_DUE,
      source: PLEDGE_SOURCE_REL,
      evidence: ["send the pledge report"],
      agent: AGENT,
    });
    reserve(pledge.path);
  }
  return f;
}

async function today(f: Fixture, reach?: TransportReach): Promise<Record<string, unknown>> {
  const result = (await reachServer(f, reach).callTool("brain_brief", {
    view: "today",
  })) as Record<string, unknown>;
  return (result["structuredContent"] ?? result) as Record<string, unknown>;
}

describe("brain_brief view=today answers at the caller's reach", () => {
  test("remote reach: the withheld loop, obligation and pledge change nothing", async () => {
    const a = fixture(true);
    const b = fixture(false);
    const answerA = await today(a);
    const answerB = await today(b);
    const textA = maskVolatile(a, answerA);
    expect(textA).not.toContain(PRIVATE_LOOP);
    expect(textA).not.toContain("PRIVATE_PATH");
    expect(textA.toLowerCase()).not.toContain(PRIVATE_OBLIGATION.toLowerCase());
    expect(textA.toLowerCase()).not.toContain(PRIVATE_PLEDGE.toLowerCase());
    expect(textA).toContain(PUBLIC_LOOP);
    expect(textA).toContain(PUBLIC_PLEDGE);
    expect(textA).toBe(maskVolatile(b, answerB));
    // The withheld pledge moves no count: the remote totals see one pledge
    // (the public one) over both vaults.
    expect(answerA["totals"]).toMatchObject({ pledgesTotal: 1, pledgesOverdue: 0 });
    expect(answerA["totals"]).toEqual(answerB["totals"]);
    expect(answerA["pledges"]).toEqual(answerB["pledges"]);
  });

  test("local control: the operator's own shell still sees both", async () => {
    const a = fixture(true);
    const b = fixture(false);
    const local = maskVolatile(a, await today(a, TRANSPORT_REACH.local));
    expect(local).toContain(PRIVATE_LOOP);
    expect(local).toContain("PRIVATE_PATH");
    expect(local.toLowerCase()).toContain(PRIVATE_OBLIGATION.toLowerCase());
    expect(local.toLowerCase()).toContain(PRIVATE_PLEDGE.toLowerCase());
    const totals = (await today(a, TRANSPORT_REACH.local))["totals"] as Record<string, number>;
    const totalsB = (await today(b, TRANSPORT_REACH.local))["totals"] as Record<string, number>;
    expect(totals["openLoopsCount"]).toBe(2);
    // Three notes sit under the scanned root now: the loop note, the
    // private loop note and the pledge source page.
    expect(totals["scannedFiles"]).toBe(3);
    expect(totals["obligationsTotal"]).toBe(2);
    expect(totals["pledgesTotal"]).toBe(2);
    expect(totalsB["openLoopsCount"]).toBe(1);
    expect(totalsB["pledgesTotal"]).toBe(1);
  });
});
