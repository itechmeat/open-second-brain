/**
 * `brain_brief view=today` answers its open loops and obligations at the
 * caller's reach.
 *
 * Vault A holds a note under `notes.read_paths` and an obligation page,
 * both withheld from a remote caller by visibility, each carrying a
 * unique marker; vault B never had either. Both share a public note with
 * its own loop, a public obligation and the log of
 * tests/helpers/reach-log-fixture.ts. A server with no reach minted is a
 * remote caller: its answers over the two vaults must be identical once
 * the volatile parts are masked. The local control proves the withheld
 * items are there to hide.
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
const PUBLIC_LOOP = "call the plumber";
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
  test("remote reach: the withheld loop and obligation change nothing", async () => {
    const a = fixture(true);
    const b = fixture(false);
    const answerA = await today(a);
    const answerB = await today(b);
    const textA = maskVolatile(a, answerA);
    expect(textA).not.toContain(PRIVATE_LOOP);
    expect(textA).not.toContain("PRIVATE_PATH");
    expect(textA.toLowerCase()).not.toContain(PRIVATE_OBLIGATION.toLowerCase());
    expect(textA).toContain(PUBLIC_LOOP);
    expect(textA).toBe(maskVolatile(b, answerB));
  });

  test("local control: the operator's own shell still sees both", async () => {
    const a = fixture(true);
    const b = fixture(false);
    const local = maskVolatile(a, await today(a, TRANSPORT_REACH.local));
    expect(local).toContain(PRIVATE_LOOP);
    expect(local).toContain("PRIVATE_PATH");
    expect(local.toLowerCase()).toContain(PRIVATE_OBLIGATION.toLowerCase());
    const totals = (await today(a, TRANSPORT_REACH.local))["totals"] as Record<string, number>;
    const totalsB = (await today(b, TRANSPORT_REACH.local))["totals"] as Record<string, number>;
    expect(totals["openLoopsCount"]).toBe(2);
    expect(totals["scannedFiles"]).toBe(2);
    expect(totals["obligationsTotal"]).toBe(2);
    expect(totalsB["openLoopsCount"]).toBe(1);
  });
});
