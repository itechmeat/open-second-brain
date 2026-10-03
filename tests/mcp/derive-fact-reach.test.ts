/**
 * `brain_derive_fact` answers at the caller's reach.
 *
 * Vault A of tests/helpers/reach-log-fixture.ts holds a preference
 * withheld from a remote caller by visibility; vault B never had it. Both
 * hold the same readable preference and enable derived-fact synthesis. A
 * server with no reach minted is a remote caller: a derived fact citing
 * the withheld preference as a premise must be refused exactly as one
 * citing a missing preference is, and no vault file may change. The local
 * control proves the withheld premise is there to cite.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brainConfigPath } from "../../src/core/brain/paths.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  PRIVATE_SLUG,
  reachServer,
  SHARED_SLUG,
  type ReachLogFixture as Fixture,
} from "../helpers/reach-log-fixture.ts";

const TOOL = "brain_derive_fact";

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-derive-reach-"));
  bases.push(base);
  const f = buildReachLogFixture(base, withPrivate);
  writeFileSync(
    brainConfigPath(f.vault),
    "schema_version: 1\nguardrails:\n  derived_fact_synthesis: true\n",
  );
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

/** Every file under the vault with its bytes, so any write shows. */
function vaultBytes(f: Fixture): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(f.vault, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = join(entry.parentPath, entry.name);
    out[abs] = readFileSync(abs, "utf8");
  }
  return out;
}

function derivation(premises: ReadonlyArray<string>): Record<string, unknown> {
  return {
    slug: "derived-probe",
    topic: "derived-probe",
    principle: "A conclusion drawn from the premises.",
    premises,
    level: "deduced",
  };
}

describe("brain_derive_fact answers at the caller's reach", () => {
  for (const premises of [[`pref-${PRIVATE_SLUG}`], [`pref-${SHARED_SLUG}`, PRIVATE_SLUG]]) {
    test(`remote reach: premises ${premises.join(", ")} are refused as missing`, async () => {
      const a = fixture(true);
      const before = vaultBytes(a);
      const withheld = await answer(a, derivation(premises));
      expect(withheld).toBe(await answer(fixture(false), derivation(premises)));
      expect(withheld).toContain("premise preference not found");
      expect(vaultBytes(a)).toEqual(before);
    });
  }

  test("remote reach: a readable premise still derives the fact", async () => {
    const args = derivation([`pref-${SHARED_SLUG}`]);
    const withheld = await answer(fixture(true), args);
    expect(withheld).toBe(await answer(fixture(false), args));
    expect(withheld).toContain('"id":"pref-derived-probe"');
  });

  test("local control: the operator's shell cites the withheld premise", async () => {
    const local = await answer(
      fixture(true),
      derivation([`pref-${PRIVATE_SLUG}`]),
      TRANSPORT_REACH.local,
    );
    expect(local).toContain('"id":"pref-derived-probe"');
  });
});
