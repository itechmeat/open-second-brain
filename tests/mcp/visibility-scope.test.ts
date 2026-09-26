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
import { expandHit } from "../../src/core/search/cards.ts";
import { Store } from "../../src/core/search/store.ts";
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

  test("the reserved token is refused as a caller scope at any reach (t_sec_scope_reserved)", async () => {
    // `visibility` scopes NARROW; the reserved token is not liftable by
    // argument. This is the contract `visibility.ts` states - the caller's
    // scope may only ever narrow, and can no longer lift the reserved
    // token - now enforced at the argument gate: the transport that mints
    // `local` grants private visibility (key-addressed reads, the
    // operator's own surfaces), never a search argument. A prompt-injected
    // agent asking for the class by name gets a refusal that names why.
    await expect(
      brainSearch().handler(localCtx, {
        query: "lattice widgets",
        visibility: [REMOTE_DENY_VISIBILITY_TOKEN],
      }),
    ).rejects.toThrow(/reserved token/);
    // A case or whitespace variant meets the same refusal: the gate
    // compares normalized forms, the same normalization the scope itself
    // undergoes.
    await expect(
      brainSearch().handler(localCtx, {
        query: "lattice widgets",
        visibility: [" PRIVATE "],
      }),
    ).rejects.toThrow(/reserved token/);
    await expect(
      brainSearch().handler(ctx, {
        query: "lattice widgets",
        visibility: [REMOTE_DENY_VISIBILITY_TOKEN],
      }),
    ).rejects.toThrow(/reserved token/);
  });

  test("a non-reserved visibility token keeps its caller-liftable semantics", async () => {
    // The gate is about the ONE reserved identifier, not about scopes.
    // A page tagged `team` is still reachable by asking for `team`.
    writeFileSync(
      join(vault, "notes", "internal.md"),
      "---\nvisibility: [team]\n---\n\nteam lattice notes about widgets",
    );
    const config = resolveSearchConfig({ vault, configPath: join(configHome, "config.yaml") });
    await indexVault(config, {});
    const out = (await brainSearch().handler(ctx, {
      query: "lattice widgets",
      visibility: ["team"],
    })) as { results: Array<{ path: string }> };
    expect(paths(out)).toContain("notes/internal.md");
    // The private page stays hidden under the non-reserved scope.
    expect(paths(out)).toEqual(["notes/internal.md", "notes/public.md"]);
  });

  test("a non-array visibility argument is rejected", async () => {
    await expect(
      brainSearch().handler(ctx, { query: "lattice", visibility: "private" }),
    ).rejects.toThrow(/visibility/);
  });
});

describe("a public page written over a private page's indexed path", () => {
  // The shape a caller reaches with brain_note_lifecycle delete (or move)
  // followed by brain_create_note at the same path: until the next index
  // run the index still holds the private body under that path, and the
  // file there now says "public". Search serves the INDEXED text, so the
  // reach verdict must honour what that text was indexed under.
  beforeEach(() => {
    rmSync(join(vault, "notes", "secret.md"));
    writeFileSync(join(vault, "notes", "secret.md"), "# Mine\n\nharmless replacement text");
  });

  test("remote search does not serve the stale private chunks", async () => {
    const out = (await brainSearch().handler(ctx, { query: "lattice widgets" })) as {
      results: Array<{ path: string; snippet?: string }>;
    };
    expect(paths(out)).toEqual(["notes/public.md"]);
    expect(JSON.stringify(out)).not.toContain("classified");
    // The operator's own local reach still sees the stale row it must fix.
    const local = (await brainSearch().handler(localCtx, { query: "lattice widgets" })) as {
      results: Array<{ path: string }>;
    };
    expect(paths(local)).toContain("notes/secret.md");
  });

  test("the remote chunk drill-down refuses the stale private chunk", async () => {
    const config = resolveSearchConfig({ vault, configPath: join(configHome, "config.yaml") });
    const store = await Store.open(config, { mode: "read" });
    let chunkId: number;
    try {
      chunkId = store.getChunksByDocument(store.getDocumentIdByPath("notes/secret.md")!)[0]!.id;
    } finally {
      await store.close();
    }
    await expect(expandHit(config, { chunkId })).rejects.toThrow(/chunk not found/);
    const local = await expandHit(config, { chunkId, transportReach: TRANSPORT_REACH.local });
    expect(local.note.path).toBe("notes/secret.md");
  });
});
