/**
 * `brain_anticipatory_context` answers at the caller's reach.
 *
 * Vault A of tests/helpers/reach-log-fixture.ts holds a preference
 * withheld from a remote caller by visibility; vault B never had it. A
 * server with no reach minted is a remote caller: a refresh, and a read
 * of a session whose bundle a local caller already cached, must read
 * alike over both vaults. The local control proves the withheld
 * preference is there to pack.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  reachServer,
  type ReachLogFixture as Fixture,
} from "../helpers/reach-log-fixture.ts";

const TOOL = "brain_anticipatory_context";
const SESSION = "session-reach";
const REFRESH = { session_id: SESSION, refresh: true, signal_text: "plan the week" };
const PRIVATE_PRINCIPLE = "Rule withheld.";

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-anticipatory-reach-"));
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
    return maskVolatile(f, { error: (error as Error).message });
  }
}

describe("brain_anticipatory_context answers at the caller's reach", () => {
  test("remote reach: a refresh reads as in a vault without the withheld preference", async () => {
    const withheld = await answer(fixture(true), REFRESH);
    expect(withheld).toBe(await answer(fixture(false), REFRESH));
    expect(withheld).toContain("cache_state");
    expect(withheld).not.toContain(PRIVATE_PRINCIPLE);
  });

  test("remote reach: a bundle a local caller cached is not served", async () => {
    const remoteRead = async (f: Fixture): Promise<string> => {
      await answer(f, REFRESH, TRANSPORT_REACH.local);
      return answer(f, { session_id: SESSION });
    };
    const withheld = await remoteRead(fixture(true));
    expect(withheld).toBe(await remoteRead(fixture(false)));
    expect(withheld).toContain("cache_state");
    expect(withheld).not.toContain(PRIVATE_PRINCIPLE);
  });

  test("local reach: the cached bundle carries the withheld preference", async () => {
    const f = fixture(true);
    expect(await answer(f, REFRESH, TRANSPORT_REACH.local)).toContain(PRIVATE_PRINCIPLE);
    expect(await answer(f, { session_id: SESSION }, TRANSPORT_REACH.local)).toContain(
      PRIVATE_PRINCIPLE,
    );
  });
});
