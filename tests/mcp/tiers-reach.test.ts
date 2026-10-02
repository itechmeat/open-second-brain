/**
 * `brain_tiers` answers for a page the caller may not read at its reach
 * exactly as for an absent one.
 *
 * A tier-drift row names a page's path, the drifted identity field, and
 * both its expected and its actual value. `check` keeps only the rows of
 * pages the caller may read, and `restore` and `accept` refuse a page it
 * may not read with the refusal a page the index never saw gets, before
 * anything is written. At local reach the drift is listed as before.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { MCPServer } from "../../src/mcp/server.ts";

const PREF = "Brain/preferences/pref-secret.md";

/** A private preference whose identity field is `id`. */
function prefBody(id: string, body: string): string {
  return (
    `---\nkind: brain-preference\nid: ${id}\ncreated_at: 2026-05-01T00:00:00Z\n` +
    `topic: style\nvisibility: private\n---\n\n${body}`
  );
}

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

interface Fixture {
  readonly vault: string;
  readonly server: MCPServer;
}

/**
 * One indexed vault where the private preference's `id` was hand-edited
 * after the first index (so one drift row stands), or one where the page
 * never existed. With no `reach`, the server mints none: remote.
 */
async function fixture(
  withSecret: boolean,
  reach?: typeof TRANSPORT_REACH.local,
): Promise<Fixture> {
  const base = mkdtempSync(join(tmpdir(), "o2b-tiers-reach-"));
  bases.push(base);
  const vault = join(base, "vault");
  mkdirSync(vault, { recursive: true });
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  mkdirSync(join(vault, "Brain/preferences"), { recursive: true });
  writeFileSync(join(vault, "Brain/preferences/pref-open.md"), "# Open\n");
  const config = resolveSearchConfig({ vault, configPath });
  if (withSecret) writeFileSync(join(vault, PREF), prefBody("pref-secret", "Use spaces.\n"));
  await indexVault(config);
  if (withSecret) {
    // A size change, so the indexer's mtime+size fast path re-reads it.
    writeFileSync(join(vault, PREF), prefBody("pref-renamed", "Use considerably more spaces.\n"));
  }
  await indexVault(config);
  const server = new MCPServer({ vault, configPath }, reach !== undefined ? { reach } : undefined);
  return { vault, server };
}

async function answer(f: Fixture, args: Record<string, unknown>): Promise<string> {
  try {
    return `ok: ${JSON.stringify(await f.server.callTool("brain_tiers", args))}`;
  } catch (err) {
    const e = err as Error & { code?: unknown; data?: unknown };
    return `error: ${e.message} ${JSON.stringify(e.code)} ${JSON.stringify(e.data)}`;
  }
}

describe("a page the caller cannot read answers as an absent one", () => {
  for (const args of [
    { operation: "check" },
    { operation: "restore", path: PREF, apply: true },
    { operation: "accept", path: PREF },
  ]) {
    test(JSON.stringify(args), async () => {
      const hidden = await fixture(true);
      const absent = await fixture(false);
      expect(await answer(hidden, args)).toBe(await answer(absent, args));
      expect(readFileSync(join(hidden.vault, PREF), "utf8")).toContain("id: pref-renamed");
    });
  }
});

describe("at local reach the drift is listed", () => {
  test("check names the page and the field", async () => {
    const local = await fixture(true, TRANSPORT_REACH.local);
    const out = await answer(local, { operation: "check" });
    expect(out).toContain(PREF);
    expect(out).toContain("pref-renamed");
  });
});
