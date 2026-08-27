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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexVault, resolveSearchConfig } from "../../src/core/search/index.ts";
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
