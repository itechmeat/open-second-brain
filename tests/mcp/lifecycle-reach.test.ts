/**
 * `brain_lifecycle` answers at the caller's reach.
 *
 * Both vaults carry the log of tests/helpers/reach-log-fixture.ts and two
 * public notes. Vault A also holds a note and a preference withheld from
 * a remote caller by visibility; vault B never had them. A server with no
 * reach minted is a remote caller: tombstone, supersede and
 * temporal-replace naming a withheld page must be refused exactly as a
 * missing page is, and leave the page's bytes unchanged. The local
 * control proves the withheld pages are there to write.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendContinuityRecord } from "../../src/core/brain/continuity/store.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  PRIVATE_PATH as PRIVATE_PREFERENCE,
  reachServer,
  type ReachLogFixture as Fixture,
} from "../helpers/reach-log-fixture.ts";

const TOOL = "brain_lifecycle";
const PRIVATE_NOTE = "Notes/zz-withheld.md";
const PUBLIC_NOTE = "Notes/public.md";
const OTHER_NOTE = "Notes/other.md";
const RESERVE_LINE = `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`;
const AT = "2026-06-01";

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-lifecycle-reach-"));
  bases.push(base);
  const f = buildReachLogFixture(base, withPrivate);
  mkdirSync(join(f.vault, "Notes"), { recursive: true });
  writeFileSync(join(f.vault, PUBLIC_NOTE), "---\ntitle: public\n---\n# public\n");
  writeFileSync(join(f.vault, OTHER_NOTE), "---\ntitle: other\n---\n# other\n");
  if (withPrivate) {
    writeFileSync(join(f.vault, PRIVATE_NOTE), `---\n${RESERVE_LINE}\n---\n# withheld\n`);
  }
  observedUse(f.vault, withPrivate);
  return f;
}

/**
 * Observed-use verdicts the curator folds: the public note is used three
 * times; in vault A the withheld note and the withheld preference (by id)
 * are injected and ignored, and contradicted.
 */
function observedUse(vault: string, withPrivate: boolean): void {
  const used = { path: PUBLIC_NOTE, verdict: "USED" };
  const entries: Array<Record<string, string>> = [used, used, used];
  if (withPrivate) {
    entries.push(
      { path: PRIVATE_NOTE, verdict: "IGNORED" },
      { id: "pref-withheld", verdict: "IGNORED" },
      { path: PRIVATE_PREFERENCE, verdict: "CONTRADICTED" },
    );
  }
  appendContinuityRecord(vault, {
    kind: "recall_observed_use",
    createdAt: "2026-08-22T10:00:00Z",
    sourceRefs: [{ id: "reuse:session" }],
    payload: { session_id: "sess-reuse", entries },
  });
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

/** Every write the tool offers, each naming a withheld page in one argument. */
const WRITES: ReadonlyArray<Record<string, unknown>> = [
  { action: "tombstone", path: PRIVATE_NOTE, reason: "obsolete" },
  { action: "tombstone", path: PRIVATE_PREFERENCE, reason: "obsolete" },
  { action: "supersede", predecessor: PRIVATE_NOTE, successor: "public" },
  { action: "temporal-replace", predecessor: PRIVATE_NOTE, successor: PUBLIC_NOTE, at: AT },
  { action: "temporal-replace", predecessor: PUBLIC_NOTE, successor: PRIVATE_NOTE, at: AT },
];

function pageBytes(f: Fixture): ReadonlyArray<string> {
  return [PRIVATE_NOTE, PRIVATE_PREFERENCE, PUBLIC_NOTE].map((rel) =>
    readFileSync(join(f.vault, rel), "utf8"),
  );
}

describe("brain_lifecycle answers at the caller's reach", () => {
  for (const args of WRITES) {
    test(`remote reach: ${String(args["action"])} refuses a withheld page as a missing one (${JSON.stringify(args)})`, async () => {
      const a = fixture(true);
      const before = pageBytes(a);
      const withheld = await answer(a, args);
      expect(withheld).toBe(await answer(fixture(false), args));
      expect(withheld).toContain("note does not exist");
      expect(pageBytes(a)).toEqual(before);
    });
  }

  test("remote reach: a write over readable pages still lands", async () => {
    const args = {
      action: "temporal-replace",
      predecessor: PUBLIC_NOTE,
      successor: OTHER_NOTE,
      at: AT,
    };
    const withheld = await answer(fixture(true), args);
    expect(withheld).toBe(await answer(fixture(false), args));
    expect(withheld).toContain(PUBLIC_NOTE);
  });

  test("remote reach: curator leaves out the rows of withheld pages", async () => {
    const args = { action: "curator" };
    const withheld = await answer(fixture(true), args);
    expect(withheld).toBe(await answer(fixture(false), args));
    expect(withheld).toContain(PUBLIC_NOTE);
  });

  test("local control: the operator's curator lists the withheld pages", async () => {
    const local = await answer(fixture(true), { action: "curator" }, TRANSPORT_REACH.local);
    expect(local).toContain(PRIVATE_NOTE);
    // The id-keyed row, apart from the row keyed by the preference's path.
    expect(local).toContain('"key":"pref-withheld"');
  });

  test("local control: the operator's own shell tombstones the withheld page", async () => {
    const a = fixture(true);
    const args = { action: "tombstone", path: PRIVATE_NOTE, reason: "obsolete" };
    expect(await answer(a, args, TRANSPORT_REACH.local)).toContain('"changed":true');
    expect(readFileSync(join(a.vault, PRIVATE_NOTE), "utf8")).toContain("tombstoned");
  });
});

/**
 * `tip` walks the supersede chain over Brain pages. In vault A the public
 * page `chain-head` points at the withheld preference, which points on to
 * the public page `chain-tail`; vault B has the same two public pages and
 * no withheld one. A remote walk must stop at the withheld id exactly as
 * at an unknown one, and a tip asked of the withheld id itself must read
 * as an unknown id.
 */
function chainFixture(withPrivate: boolean): Fixture {
  const f = fixture(withPrivate);
  const dir = join(f.vault, "Brain", "processed");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "chain-head.md"),
    `---\nsuperseded_by: "[[pref-withheld]]"\n---\n# head\n`,
  );
  writeFileSync(join(dir, "chain-tail.md"), "---\ntitle: tail\n---\n# tail\n");
  if (withPrivate) {
    const abs = join(f.vault, PRIVATE_PREFERENCE);
    const text = readFileSync(abs, "utf8");
    writeFileSync(abs, text.replace("\n---\n", '\nsuperseded_by: "[[chain-tail]]"\n---\n'));
  }
  return f;
}

describe("brain_lifecycle tip answers at the caller's reach", () => {
  for (const id of ["chain-head", "pref-withheld"]) {
    test(`remote reach: tip of ${id} reads as in a vault without the withheld page`, async () => {
      const args = { action: "tip", id };
      const withheld = await answer(chainFixture(true), args);
      expect(withheld).toBe(await answer(chainFixture(false), args));
      expect(withheld).not.toContain("chain-tail");
    });
  }

  test("local control: the operator's own walk steps through the withheld page", async () => {
    const local = await answer(
      chainFixture(true),
      { action: "tip", id: "chain-head" },
      TRANSPORT_REACH.local,
    );
    expect(local).toContain('"tip":"chain-tail"');
    expect(local).toContain('"steps":2');
  });
});
