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
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

// An older release wrote "Проект nightingale vendor" as
// decision-nightingale-vendor.md (its non-Latin word dropped) and its
// review obligation as review-decision-nightingale-vendor.md. Both are
// withheld from a remote caller, who must get the answers a vault without
// them gives: the refusals name the title's own slug, and recording the
// title writes a new page instead of refusing it as a duplicate.
const OLD_TITLE = "Проект nightingale vendor";
const OLD_SLUG = "nightingale-vendor";

function legacyFixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-decision-reach-old-"));
  bases.push(base);
  const f = buildReachLogFixture(base, false, RECALL_CONFIG);
  record(f, PUBLIC_TITLE, 4);
  if (withPrivate) {
    const res = recordDecision(f.vault, {
      title: OLD_TITLE,
      chosen: "nightingale vendor now",
      assumption: "It keeps working.",
      reviewDate: "2027-01-01",
      agent: "claude",
      configPath: f.configPath,
    });
    const decisions = join(f.vault, "Brain", "decisions");
    const oldPage = join(decisions, `decision-${OLD_SLUG}.md`);
    renameSync(join(decisions, `${res.record.id}.md`), oldPage);
    reserve(f, `Brain/decisions/decision-${OLD_SLUG}.md`);
    const obligations = join(f.vault, "Brain", "obligations");
    const oldReview = join(obligations, `review-decision-${OLD_SLUG}.md`);
    renameSync(join(obligations, `${res.reviewObligationSlug}.md`), oldReview);
    reserve(f, `Brain/obligations/review-decision-${OLD_SLUG}.md`);
  }
  return f;
}

/** Park a question titled with the old title, then resolve it. */
async function resolveOld(f: Fixture): Promise<string> {
  const opened = await reachServer(f).callTool(TOOL, {
    action: "open",
    title: OLD_TITLE,
    question: "Which vendor?",
    options: ["nightingale", "lark"],
  });
  const id = (opened["structuredContent"] as { id: string }).id;
  return answer(f, { action: "resolve", id, choice: "lark" });
}

describe("brain_decision: a title whose withheld page sits under an older slug", () => {
  const CALLS: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["show", { action: "show", slug: OLD_TITLE }],
    ["compare", { action: "compare", slugs: [OLD_TITLE, PUBLIC_SLUG] }],
    ["outcome", { action: "outcome", slug: OLD_TITLE, outcome: "It broke." }],
    ["rate", { action: "rate", slug: OLD_TITLE, rating: 1 }],
    [
      "record",
      {
        action: "record",
        title: OLD_TITLE,
        chosen: "again",
        assumption: "It holds.",
        review_date: "2027-02-01",
      },
    ],
  ];

  for (const [name, args] of CALLS) {
    test(`remote reach: ${name} by the title answers as in a vault without the page`, async () => {
      const a = legacyFixture(true);
      const oldPage = join(a.vault, "Brain", "decisions", `decision-${OLD_SLUG}.md`);
      const before = readFileSync(oldPage, "utf8");
      const withheld = await answer(a, args);
      expect(withheld).toBe(await answer(legacyFixture(false), args));
      expect(withheld).not.toContain(`decision-${OLD_SLUG}`);
      expect(withheld).not.toContain(`"${OLD_SLUG}"`);
      expect(withheld).not.toContain("nightingale vendor now");
      expect(readFileSync(oldPage, "utf8")).toBe(before);
    });
  }

  test("remote reach: resolving a question with the title mints the page an absent one gets", async () => {
    const withheld = await resolveOld(legacyFixture(true));
    expect(withheld).toBe(await resolveOld(legacyFixture(false)));
    expect(withheld).toContain("decision-проект-nightingale-vendor");
  });

  test("local control: the operator's own shell reaches the old page by its title", async () => {
    const a = legacyFixture(true);
    expect(await answer(a, { action: "show", slug: OLD_TITLE }, TRANSPORT_REACH.local)).toContain(
      "nightingale vendor now",
    );
  });
});
