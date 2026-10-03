/**
 * `brain_decision` answers at the caller's reach.
 *
 * Vault A holds a rated public decision and a rated decision page withheld
 * from a remote caller by visibility; vault B holds only the public one.
 * A server with no reach minted is a remote caller: every action must
 * answer over A exactly as over B (the whole masked answer), the writes
 * must refuse the withheld slug with the absent slug's error, and the
 * decision page, the decision-change ledger and the log must keep their
 * bytes. The local control proves the withheld decision is there.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordDecision } from "../../src/core/brain/decisions/record.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  reachServer,
  type ReachLogFixture as Fixture,
} from "../helpers/reach-log-fixture.ts";

const TOOL = "brain_decision";
const PUBLIC_TITLE = "Adopt the bun runtime";
const PUBLIC_SLUG = "adopt-the-bun-runtime";
const PRIVATE_TITLE = "Adopt the nightingale vendor";
const PRIVATE_SLUG = "adopt-the-nightingale-vendor";
const PRIVATE_DECISION = `Brain/decisions/decision-${PRIVATE_SLUG}.md`;
/** The review obligation recording opens; its title names the decision, so it is reserved too. */
const PRIVATE_REVIEW = `Brain/obligations/review-decision-${PRIVATE_SLUG}.md`;
const RECALL_CONFIG = ["decision_recall.max_per_session: 3"];

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

function record(f: Fixture, title: string, rating: number): void {
  recordDecision(f.vault, {
    title,
    chosen: `${title} now`,
    assumption: "It keeps working.",
    reviewDate: "2027-01-01",
    rating,
    rationale: "Worked before.",
    agent: "claude",
    configPath: f.configPath,
  });
}

function reserve(f: Fixture, rel: string): void {
  const abs = join(f.vault, rel);
  const text = readFileSync(abs, "utf8");
  const close = text.indexOf("\n---\n", "---\n".length);
  const line = `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`;
  writeFileSync(abs, `${text.slice(0, close)}\n${line}${text.slice(close)}`);
}

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-decision-reach-"));
  bases.push(base);
  const f = buildReachLogFixture(base, false, RECALL_CONFIG);
  record(f, PUBLIC_TITLE, 4);
  if (withPrivate) {
    record(f, PRIVATE_TITLE, 5);
    reserve(f, PRIVATE_DECISION);
    reserve(f, PRIVATE_REVIEW);
  }
  return f;
}

async function answer(
  f: Fixture,
  args: Record<string, unknown>,
  reach?: TransportReach,
): Promise<string> {
  try {
    const result = await reachServer(f, reach).callTool(TOOL, args);
    return maskVolatile(f, result["structuredContent"] ?? result);
  } catch (error) {
    // A refusal is part of the answer: it must read alike over both vaults.
    return maskVolatile(f, { error: (error as Error).message });
  }
}

/** Every byte a decision write could touch: the page, the ledger shards and the log. */
function writtenBytes(f: Fixture): Record<string, string> {
  const out: Record<string, string> = {};
  out[PRIVATE_DECISION] = readFileSync(join(f.vault, PRIVATE_DECISION), "utf8");
  for (const dir of ["Brain/truth", "Brain/log"]) {
    const abs = join(f.vault, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      out[`${dir}/${name}`] = readFileSync(join(abs, name), "utf8");
    }
  }
  return out;
}

const READS: ReadonlyArray<[string, Record<string, unknown>]> = [
  ["show", { action: "show", slug: PRIVATE_SLUG }],
  ["list", { action: "list" }],
  ["list rated", { action: "list", rated: true }],
  ["compare", { action: "compare", slugs: [PRIVATE_SLUG, PUBLIC_SLUG] }],
  ["similar", { action: "similar", title: "Adopt the vendor runtime" }],
  ["history", { action: "history" }],
  ["recall", { action: "recall", prompt: "adopt the nightingale vendor runtime" }],
];

const WRITES: ReadonlyArray<[string, Record<string, unknown>]> = [
  ["outcome", { action: "outcome", slug: PRIVATE_SLUG, outcome: "It broke." }],
  ["rate", { action: "rate", slug: PRIVATE_SLUG, rating: 1 }],
];

describe("brain_decision answers at the caller's reach", () => {
  for (const [name, args] of READS) {
    test(`remote reach: ${name} answers as in a vault without the withheld decision`, async () => {
      const withheld = await answer(fixture(true), args);
      expect(withheld).toBe(await answer(fixture(false), args));
      // The caller's own slug is echoed by an absent-slug refusal; the
      // withheld page's text never is.
      expect(withheld).not.toContain("nightingale vendor now");
      expect(withheld).not.toContain('"rating":5');
    });
  }

  for (const [name, args] of WRITES) {
    test(`remote reach: ${name} on the withheld decision is refused as an absent slug`, async () => {
      const a = fixture(true);
      const before = writtenBytes(a);
      const withheld = await answer(a, args);
      expect(withheld).toBe(await answer(fixture(false), args));
      expect(withheld).toContain(`no decision: ${PRIVATE_SLUG}`);
      expect(writtenBytes(a)).toEqual(before);
    });
  }

  test("remote reach: brain_design_note grounds on no withheld decision", async () => {
    const args = { topic: "Adopt the nightingale vendor" };
    const call = async (f: Fixture, reach?: TransportReach) => {
      try {
        const result = await reachServer(f, reach).callTool("brain_design_note", args);
        return maskVolatile(f, result["structuredContent"] ?? result);
      } catch (error) {
        return maskVolatile(f, { error: (error as Error).message });
      }
    };
    const withheld = await call(fixture(true));
    expect(withheld).toBe(await call(fixture(false)));
    expect(withheld).not.toContain("nightingale vendor now");
    // Local control: the operator's own plan does ground on it.
    expect(await call(fixture(true), TRANSPORT_REACH.local)).toContain("nightingale vendor now");
  });

  test("remote reach: a readable decision still takes an outcome", async () => {
    const args = { action: "outcome", slug: PUBLIC_SLUG, outcome: "It held." };
    const withheld = await answer(fixture(true), args);
    expect(withheld).toBe(await answer(fixture(false), args));
    expect(withheld).toContain('"outcome":"It held."');
  });

  test("local control: the operator's own shell reads and rates the withheld decision", async () => {
    const a = fixture(true);
    const local = TRANSPORT_REACH.local;
    expect(await answer(a, { action: "show", slug: PRIVATE_SLUG }, local)).toContain(
      "nightingale vendor now",
    );
    expect(await answer(a, { action: "list" }, local)).toContain(PRIVATE_SLUG);
    expect(await answer(a, { action: "history" }, local)).toContain(PRIVATE_SLUG);
    expect(await answer(a, { action: "rate", slug: PRIVATE_SLUG, rating: 1 }, local)).toContain(
      '"rating":1',
    );
    expect(readFileSync(join(a.vault, PRIVATE_DECISION), "utf8")).toContain("rating: 1");
  });
});
