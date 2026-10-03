/**
 * `brain_expire` answers at the caller's reach.
 *
 * Vault A of tests/helpers/reach-log-fixture.ts holds a preference and a
 * retired preference withheld from a remote caller by visibility; vault B
 * never had them. Both hold the same public preference. A server with no
 * reach minted is a remote caller: setting an expiration on a withheld
 * record must be refused exactly as an unknown id is, and leave the page's
 * bytes unchanged. The local control proves the withheld records are
 * there to write.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  PRIVATE_PATH,
  PRIVATE_SLUG,
  reachServer,
  RETIRED_SLUG,
  SHARED_SLUG,
  type ReachLogFixture as Fixture,
} from "../helpers/reach-log-fixture.ts";

const TOOL = "brain_expire";
const EXPIRES = "2027-01-01";
const RETIRED_PATH = `Brain/retired/ret-${RETIRED_SLUG}.md`;

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-expire-reach-"));
  bases.push(base);
  return buildReachLogFixture(base, withPrivate);
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

function pageBytes(f: Fixture): ReadonlyArray<string> {
  return [PRIVATE_PATH, RETIRED_PATH].map((rel) => readFileSync(join(f.vault, rel), "utf8"));
}

describe("brain_expire answers at the caller's reach", () => {
  for (const id of [`pref-${PRIVATE_SLUG}`, `ret-${RETIRED_SLUG}`]) {
    test(`remote reach: a withheld ${id} is refused as an unknown id`, async () => {
      const a = fixture(true);
      const before = pageBytes(a);
      const withheld = await answer(a, { id, expires: EXPIRES });
      expect(withheld).toBe(await answer(fixture(false), { id, expires: EXPIRES }));
      expect(withheld).toContain("no signal or preference with id");
      expect(pageBytes(a)).toEqual(before);
    });
  }

  test("remote reach: a readable preference still takes the expiration", async () => {
    const args = { id: `pref-${SHARED_SLUG}`, expires: EXPIRES };
    const withheld = await answer(fixture(true), args);
    expect(withheld).toBe(await answer(fixture(false), args));
    expect(withheld).toContain('"changed":true');
  });

  test("local control: the operator's own shell sets the withheld expiration", async () => {
    const a = fixture(true);
    const local = await answer(
      a,
      { id: `pref-${PRIVATE_SLUG}`, expires: EXPIRES },
      TRANSPORT_REACH.local,
    );
    expect(local).toContain('"changed":true');
    expect(readFileSync(join(a.vault, PRIVATE_PATH), "utf8")).toContain(EXPIRES);
  });
});
