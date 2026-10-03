/**
 * `brain_apply_evidence` and the `apply_evidence` operation of
 * `brain_write_batch` answer at the caller's reach.
 *
 * Vault A of tests/helpers/reach-log-fixture.ts holds a preference
 * withheld from a remote caller by visibility; vault B never had it. A
 * server with no reach minted is a remote caller: evidence against the
 * withheld preference must be refused exactly as evidence against a
 * missing one is, and no vault file may change. The local control proves
 * the withheld preference is there to record evidence against.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  PRIVATE_SLUG,
  reachServer,
  SHARED_SLUG,
  type ReachLogFixture as Fixture,
} from "../helpers/reach-log-fixture.ts";

const ARTIFACT = "[[Notes/artifact]]";

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-apply-evidence-reach-"));
  bases.push(base);
  return buildReachLogFixture(base, withPrivate);
}

async function answer(
  f: Fixture,
  tool: string,
  args: Record<string, unknown>,
  reach?: TransportReach,
): Promise<string> {
  try {
    const result = await reachServer(f, reach).callTool(tool, args);
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

function evidenceArgs(prefId: string): Record<string, unknown> {
  return { pref_id: prefId, artifact: ARTIFACT, result: "outdated" };
}

function batchArgs(prefId: string): Record<string, unknown> {
  return { operations: [{ op: "apply_evidence", ...evidenceArgs(prefId) }] };
}

const ENTRY_POINTS = [
  { tool: "brain_apply_evidence", args: evidenceArgs },
  { tool: "brain_write_batch", args: batchArgs },
] as const;

describe("apply-evidence writers answer at the caller's reach", () => {
  for (const { tool, args } of ENTRY_POINTS) {
    for (const id of [`pref-${PRIVATE_SLUG}`, PRIVATE_SLUG]) {
      test(`${tool}: remote reach refuses ${id} as a missing preference`, async () => {
        const a = fixture(true);
        const before = vaultBytes(a);
        const withheld = await answer(a, tool, args(id));
        expect(withheld).toBe(await answer(fixture(false), tool, args(id)));
        expect(withheld).toContain(`preference not found: pref-${PRIVATE_SLUG}`);
        expect(vaultBytes(a)).toEqual(before);
      });
    }

    test(`${tool}: remote reach still records evidence on a readable preference`, async () => {
      const withheld = await answer(fixture(true), tool, args(`pref-${SHARED_SLUG}`));
      expect(withheld).toBe(await answer(fixture(false), tool, args(`pref-${SHARED_SLUG}`)));
      expect(withheld).toContain("logged_at");
    });

    test(`${tool}: local control records evidence on the withheld preference`, async () => {
      const a = fixture(true);
      const local = await answer(a, tool, args(`pref-${PRIVATE_SLUG}`), TRANSPORT_REACH.local);
      expect(local).toContain("logged_at");
      expect(local).not.toContain("not found");
    });
  }
});
