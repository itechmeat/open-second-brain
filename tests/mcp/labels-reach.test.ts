/**
 * `brain_labels` assign and remove answer at the caller's reach.
 *
 * Vault A holds a labelled note withheld from a remote caller by
 * visibility; vault B never had it. Both declare the same label dimension
 * and hold the same public note. A server with no reach minted is a
 * remote caller: assigning or removing a label on the withheld note must
 * be refused exactly as on a missing one, and leave every vault byte
 * unchanged. The local control proves the withheld note is there to label.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  reachServer,
  type ReachLogFixture as Fixture,
} from "../helpers/reach-log-fixture.ts";

const TOOL = "brain_labels";
const PUBLIC_NOTE = "Notes/public.md";
const PRIVATE_NOTE = "Notes/withheld.md";
const SCHEMA = [
  "schema_version: 1",
  "schema:",
  "  labels:",
  "    - priority=low",
  "    - priority=high",
];

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-labels-reach-"));
  bases.push(base);
  const f = buildReachLogFixture(base, false);
  writeFileSync(join(f.vault, "Brain", "_brain.yaml"), `${SCHEMA.join("\n")}\n`);
  mkdirSync(join(f.vault, "Notes"), { recursive: true });
  writeFileSync(join(f.vault, PUBLIC_NOTE), "---\nlabels: [priority/low]\n---\n\n# Public\n");
  if (withPrivate) {
    writeFileSync(
      join(f.vault, PRIVATE_NOTE),
      `---\nlabels: [priority/low]\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]\n---\n\n# Withheld\n`,
    );
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

/** Every file under the vault with its bytes. */
function vaultBytes(root: string, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(out, vaultBytes(root, child));
    else out[child] = readFileSync(join(root, child), "utf8");
  }
  return out;
}

const WRITES: ReadonlyArray<[string, Record<string, unknown>]> = [
  ["assign", { operation: "assign", path: PRIVATE_NOTE, dimension: "priority", value: "high" }],
  ["remove", { operation: "remove", path: PRIVATE_NOTE, dimension: "priority" }],
];

describe("brain_labels answers at the caller's reach", () => {
  for (const [name, args] of WRITES) {
    test(`remote reach: ${name} on the withheld note is refused as on a missing one`, async () => {
      const a = fixture(true);
      const before = vaultBytes(a.vault);
      const withheld = await answer(a, args);
      expect(withheld).toBe(await answer(fixture(false), args));
      expect(withheld).toContain(`note does not exist: ${PRIVATE_NOTE}`);
      expect(vaultBytes(a.vault)).toEqual(before);
    });
  }

  test("remote reach: a readable note still takes a label", async () => {
    const args = { operation: "assign", path: PUBLIC_NOTE, dimension: "priority", value: "high" };
    const withheld = await answer(fixture(true), args);
    expect(withheld).toBe(await answer(fixture(false), args));
    expect(withheld).toContain('"changed":true');
  });

  test("local control: the operator's own shell labels the withheld note", async () => {
    const a = fixture(true);
    const local = TRANSPORT_REACH.local;
    for (const [, args] of WRITES) {
      expect(await answer(a, args, local)).toContain('"changed":true');
    }
    expect(readFileSync(join(a.vault, PRIVATE_NOTE), "utf8")).not.toContain("priority/");
  });
});
