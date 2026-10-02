/**
 * `brain_doctor` and the `schema_inspect` record views answer for a page
 * the caller may not read at its reach exactly as for an absent one.
 *
 * The fixture is a private Brain preference with no `status` field (a
 * record the doctor and the schema report both flag by path) whose `id`
 * was hand-edited after the first index (one tier-drift row). Vault A
 * keeps it, vault B never had it; the same remote call must answer
 * identically in both once the vault paths are normalised, and a local
 * call must still name it, so an identical pair is not an empty surface.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { MCPServer } from "../../src/mcp/server.ts";

const PREF = "Brain/preferences/pref-secret.md";

/** A private preference with no `status`, whose identity field is `id`. */
function prefBody(id: string, body: string): string {
  return (
    `---\nkind: brain-preference\nid: ${id}\ncreated_at: 2026-05-01T00:00:00Z\n` +
    `topic: style\nvisibility: private\n---\n\n${body}`
  );
}

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

interface Fixture {
  readonly base: string;
  readonly configPath: string;
  readonly vault: string;
}

async function fixture(withSecret: boolean): Promise<Fixture> {
  const base = mkdtempSync(join(tmpdir(), "o2b-doctor-schema-reach-"));
  bases.push(base);
  const vault = join(base, "vault");
  mkdirSync(vault, { recursive: true });
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  mkdirSync(join(vault, "Brain/preferences"), { recursive: true });
  const config = resolveSearchConfig({ vault, configPath });
  if (withSecret) writeFileSync(join(vault, PREF), prefBody("pref-secret", "Use spaces.\n"));
  await indexVault(config);
  if (withSecret) {
    // A size change, so the indexer's mtime+size fast path re-reads it.
    writeFileSync(join(vault, PREF), prefBody("pref-renamed", "Use considerably more spaces.\n"));
  }
  await indexVault(config);
  return { base, configPath, vault };
}

async function answer(
  f: Fixture,
  tool: string,
  args: Record<string, unknown>,
  reach?: typeof TRANSPORT_REACH.local,
): Promise<string> {
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = f.configPath;
  const server = new MCPServer(
    { vault: f.vault, configPath: f.configPath },
    reach !== undefined ? { reach } : undefined,
  );
  const result = await server.callTool(tool, args);
  return JSON.stringify(result).split(f.vault).join("<V>").split(f.base).join("<B>");
}

describe("a malformed private preference answers as an absent one at remote reach", () => {
  for (const [tool, args] of [
    ["brain_doctor", {}],
    ["schema_inspect", { view: "lint" }],
    ["schema_inspect", { view: "orphans" }],
    ["schema_inspect", { view: "stats" }],
  ] as const) {
    test(`${tool} ${JSON.stringify(args)}`, async () => {
      const withheld = await answer(await fixture(true), tool, args);
      const absent = await answer(await fixture(false), tool, args);
      expect(withheld).toBe(absent);
      expect(withheld).not.toContain("pref-secret");
    });
  }

  test("a local caller is still told about the record and the drift", async () => {
    const a = await fixture(true);
    const doctor = await answer(a, "brain_doctor", {}, TRANSPORT_REACH.local);
    expect(doctor).toContain(PREF);
    expect(doctor).toContain("tier-drift");
    expect(await answer(a, "schema_inspect", { view: "orphans" }, TRANSPORT_REACH.local)).toContain(
      PREF,
    );
  });
});
