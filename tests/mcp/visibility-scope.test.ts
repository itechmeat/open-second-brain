/**
 * `brain_search` honours the content-visibility scope (typed graph
 * semantics, unit 3) through the same handler path the MCP server uses.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SEARCH_TOOLS } from "../../src/mcp/search-tools.ts";
import { indexVault, resolveSearchConfig } from "../../src/core/search/index.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

let vault: string;
let configHome: string;
/** A caller this server established nothing about: the narrowest reach. */
let ctx: ServerContext;
/** The same caller, arriving on a transport that proved local access. */
let localCtx: ServerContext;

beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), "o2b-vis-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-vis-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(
    join(vault, "notes", "public.md"),
    "---\ntitle: Public\n---\n\nshared lattice notes about widgets",
  );
  writeFileSync(
    join(vault, "notes", "secret.md"),
    "---\nvisibility: [private]\n---\n# Secret\n\nclassified lattice notes about widgets",
  );
  ctx = { vault, configPath, repoRoot: null };
  localCtx = { ...ctx, reach: TRANSPORT_REACH.local };
  const config = resolveSearchConfig({ vault, configPath });
  await indexVault(config, {});
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function paths(out: { results: Array<{ path: string }> }): string[] {
  return out.results.map((r) => r.path).toSorted();
}

function brainSearch(): (typeof SEARCH_TOOLS)[number] {
  const tool = SEARCH_TOOLS.find((t) => t.name === "brain_search");
  if (tool === undefined) throw new Error("brain_search is not in SEARCH_TOOLS");
  return tool;
}

describe("brain_search visibility scope", () => {
  test("a private page is hidden by default", async () => {
    const out = (await brainSearch().handler(ctx, { query: "lattice widgets" })) as {
      results: Array<{ path: string }>;
    };
    expect(paths(out)).toEqual(["notes/public.md"]);
  });

  test("the private page appears when its visibility is requested at local reach", async () => {
    const out = (await brainSearch().handler(localCtx, {
      query: "lattice widgets",
      visibility: [REMOTE_DENY_VISIBILITY_TOKEN],
    })) as { results: Array<{ path: string }> };
    expect(paths(out)).toEqual(["notes/public.md", "notes/secret.md"]);
  });

  test("the same request at remote reach gets nothing back", async () => {
    // The caller argument narrows and cannot lift: asking for the
    // reserved scope over a transport that established nothing is
    // answered exactly as the default scope is.
    const out = (await brainSearch().handler(ctx, {
      query: "lattice widgets",
      visibility: [REMOTE_DENY_VISIBILITY_TOKEN],
    })) as { results: Array<{ path: string }> };
    expect(paths(out)).toEqual(["notes/public.md"]);
  });

  test("a non-array visibility argument is rejected", async () => {
    await expect(
      brainSearch().handler(ctx, { query: "lattice", visibility: "private" }),
    ).rejects.toThrow(/visibility/);
  });
});
