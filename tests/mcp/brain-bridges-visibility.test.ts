/**
 * Root closure over `brain_bridges` (private-is-not-a-suggestion).
 *
 * The registry classified this tool COVERED off its `list` mode alone.
 * `list` reads `Brain/proposals/bridges.md` by path and asks the rule at
 * the site of the read; `discover` returned `discoverBridges()`'s
 * proposals verbatim, each naming two pages by vault-relative path off
 * the vec index - which keeps reserved pages by design, because the
 * `documents.visibility` column reports what the index measured rather
 * than excluding what it holds.
 *
 * Detection stays vault-wide and the shared artifact is still written
 * unfiltered: a bridge proposed from the visible half of a link graph
 * would differ per caller, and the file is one file. The rule is applied
 * to what the CALLER is told, which is the shape `brain_clusters run`
 * already uses - and a proposal with one end withheld is dropped whole,
 * because a bridge reported with one end missing is not a narrower true
 * finding but a false one.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexVault, resolveSearchConfig } from "../../src/core/search/index.ts";
import { brainConfigPath } from "../../src/core/brain/paths.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import { BRAIN_TOOLS } from "../../src/mcp/brain-tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

const RESERVED = "beta-deploy.md";
const OPEN = "alpha-deploy.md";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), "o2b-bridges-vis-"));
  // An unswitched vault: its Brain/ tree is the legacy layout under test.
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), "o2b-bridges-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(
    configPath,
    [
      `vault: ${vault}`,
      "search_semantic_enabled: true",
      "embedding_provider: local",
      "embedding_dimension: 256",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(vault, OPEN),
    "# Canary deployment runbook\n\nShip the canary release to one production instance, watch error rates, expand the deployment gradually, roll back on regression.\n",
  );
  writeFileSync(
    join(vault, RESERVED),
    `---\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]\n---\n\n# Deployment safety checklist\n\nCanary release first: one production instance, watch error rates, expand deployment gradually, roll back the release on regression.\n`,
  );
  await indexVault(resolveSearchConfig({ vault, configPath }), { embeddings: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

async function discover(reach: TransportReach): Promise<string> {
  const tool = BRAIN_TOOLS.find((t) => t.name === "brain_bridges")!;
  const ctx: ServerContext = { vault, reach, configPath, repoRoot: null };
  return JSON.stringify(await tool.handler(ctx, { operation: "discover", min_similarity: 0.5 }));
}

describe("brain_bridges operation=discover", () => {
  test("proposes the reserved pair at local reach", async () => {
    const out = await discover(TRANSPORT_REACH.local);
    expect(out).toContain(RESERVED);
    expect(out).toContain(OPEN);
  });

  test("names neither end of that pair at remote reach", async () => {
    const out = await discover(TRANSPORT_REACH.remote);
    expect(out).not.toContain(RESERVED);
    // Dropped WHOLE: the open end goes with it rather than being
    // reported as a bridge to nowhere.
    expect(JSON.parse(out).proposals).toEqual([]);
  });

  test("the corpus-size count is the same measurement at both reaches", async () => {
    // `scanned_candidates` names no page and detection is vault-wide, so
    // it is not a per-caller number and is not withheld.
    const local = JSON.parse(await discover(TRANSPORT_REACH.local));
    const remote = JSON.parse(await discover(TRANSPORT_REACH.remote));
    expect(remote.scanned_candidates).toBe(local.scanned_candidates);
  });
});

describe("brain_clusters operation=run", () => {
  /** Four mutually linked pages, one of them the reserved one. */
  async function writeCommunity(): Promise<void> {
    const group = ["team-a", "team-b", "team-c", RESERVED];
    for (const name of group) {
      const others = group
        .filter((g) => g !== name)
        .map((g) => `[[${g}]]`)
        .join(" ");
      const frontmatter =
        name === RESERVED ? `---\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]\n---\n\n` : "";
      writeFileSync(join(vault, `${name}.md`), `${frontmatter}# ${name}\n\nSee ${others}.\n`);
    }
    await indexVault(resolveSearchConfig({ vault, configPath }));
  }

  async function clusters(reach: TransportReach): Promise<Record<string, unknown>> {
    const tool = BRAIN_TOOLS.find((t) => t.name === "brain_clusters")!;
    const ctx: ServerContext = { vault, reach, configPath, repoRoot: null };
    return (await tool.handler(ctx, { operation: "run", batch_size: 1 })) as Record<
      string,
      unknown
    >;
  }

  test("each batch is filtered by the same visibility rules as the top-level result", async () => {
    await writeCommunity();
    const remote = await clusters(TRANSPORT_REACH.remote);
    const body = JSON.stringify(remote);
    // Every detected community names the reserved page, so a remote
    // caller sees no community and therefore NO batch: the offsets and
    // index count detected communities, and a `{start: 0, end: 1}` beside
    // an empty `communities` would show that a withheld community exists
    // and how many there are. No batch may name the cluster note its
    // seed produced (or any stale removal, or a raw write error's seed
    // path) either - `batch_size` must not be the side door back in.
    expect(remote["batches"]).toEqual([]);
    expect(remote["communities"]).toEqual([]);
    expect(body).not.toContain("Brain/clusters/");
    expect(body).not.toContain(RESERVED);

    // The unrestricted view keeps the batches verbatim: the note this run
    // materialised is reported.
    const local = await clusters(TRANSPORT_REACH.local);
    const localBatches = local["batches"] as Array<Record<string, unknown>> | undefined;
    expect(localBatches).toHaveLength(1);
    expect((localBatches as Array<{ written: string[] }>)[0]!.written.length).toBeGreaterThan(0);
    expect(JSON.stringify(local)).toContain("Brain/clusters/");
  });
});

/**
 * The ownership half of the same root closure: a proposal names two pages
 * by path, so under `integrity.owner_scope_delivery: fail` a proposal
 * naming another owner's page is dropped whole, and a lane page carrying
 * an owner is answered only to that owner - the same composed view every
 * sibling reader asks.
 */
describe("brain_bridges under integrity.owner_scope_delivery: fail", () => {
  const OWNER_A = "agent-a";
  const CALLER = "agent-b";
  const OWNED_A = "canary-alpha.md";
  const OWNED_B = "canary-beta.md";

  /** A near-identical pair owned by `OWNER_A`, indexed into the vec store. */
  async function writeOwnedPair(): Promise<void> {
    const body =
      "Release the candidate build to staging, watch error rates closely, expand gradually, roll back on regression.";
    for (const name of [OWNED_A, OWNED_B]) {
      writeFileSync(join(vault, name), `---\nowner: ${OWNER_A}\n---\n\n# ${name}\n\n${body}\n`);
    }
    await indexVault(resolveSearchConfig({ vault, configPath }), { embeddings: true });
  }

  function setGateFail(): void {
    writeFileSync(
      brainConfigPath(vault),
      "schema_version: 1\nintegrity:\n  owner_scope_delivery: fail\n",
    );
  }

  function ctxFor(reach: TransportReach, agentName?: string): ServerContext {
    return { vault, reach, configPath, repoRoot: null, agentName };
  }

  function bridgesTool() {
    return BRAIN_TOOLS.find((t) => t.name === "brain_bridges")!;
  }

  test("discover drops a pair that names another owner's pages, whole", async () => {
    await writeOwnedPair();
    setGateFail();

    // The owner sees its own pair.
    const asA = (
      (await bridgesTool().handler(ctxFor(TRANSPORT_REACH.local, OWNER_A), {
        operation: "discover",
        min_similarity: 0.5,
      })) as { proposals: ReadonlyArray<{ source: string; target: string }> }
    ).proposals;
    expect(
      asA.some((p) => p.source === OWNED_A || p.target === OWNED_A || p.source === OWNED_B),
    ).toBe(true);

    // Another scope sees neither end - the proposal is gone whole, not
    // reported with one end missing.
    const asB = (
      (await bridgesTool().handler(ctxFor(TRANSPORT_REACH.local, CALLER), {
        operation: "discover",
        min_similarity: 0.5,
      })) as { proposals: ReadonlyArray<{ source: string; target: string }> }
    ).proposals;
    expect(
      asB.some((p) => p.source === OWNED_A || p.target === OWNED_A || p.source === OWNED_B),
    ).toBe(false);
  });

  test("list answers an owner-stamped proposals artifact only to its owner", async () => {
    await writeOwnedPair();
    setGateFail();
    // Produce the shared artifact, then stamp the page with an owner - the
    // state a writer resolved under an enforced identity leaves.
    const bridges = bridgesTool();
    await bridges.handler(ctxFor(TRANSPORT_REACH.local, OWNER_A), {
      operation: "discover",
      min_similarity: 0.5,
    });
    const artifact = join(vault, "Brain", "proposals", "bridges.md");
    const text = readFileSync(artifact, "utf8");
    writeFileSync(artifact, text.replace("---\n", `---\nowner: ${OWNER_A}\n`));

    const asB = (await bridges.handler(ctxFor(TRANSPORT_REACH.local, CALLER), {
      operation: "list",
    })) as Record<string, unknown>;
    // A withheld lane page answers exactly as an absent one.
    expect(asB["exists"]).toBe(false);
    expect(asB["proposals"]).toBe(0);

    const asA = (await bridges.handler(ctxFor(TRANSPORT_REACH.local, OWNER_A), {
      operation: "list",
    })) as Record<string, unknown>;
    expect(asA["exists"]).toBe(true);
  });
});
