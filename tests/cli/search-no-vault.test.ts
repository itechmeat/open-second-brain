/**
 * The search verbs that need vault notes refuse on a machine with no
 * vault, each naming itself, before doing any work: `watch` (not as a
 * failed watch of `null`), `query --global`, `rerank-eval --kind
 * decision-model` and the provider registries. `search index` says it
 * indexed the brain store.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

function cli(args: ReadonlyArray<string>) {
  return runCli(args, { env: { OPEN_SECOND_BRAIN_CONFIG: env!.configPath } });
}

function noVault(): StoreEnv {
  return makeStoreEnv("osb-search-novault-", { legacyTree: false, configureVault: false });
}

describe("search verbs that need a vault, with none", () => {
  test("watch refuses as a missing vault, not as a failed watch", async () => {
    env = noVault();
    const res = await cli(["search", "watch"]);
    expect(res.returncode).not.toBe(0);
    expect(res.stderr).toContain("o2b search watch");
    expect(res.stderr).not.toContain("recursive watch");
  });

  test("query --global refuses before the refresh", async () => {
    env = noVault();
    const res = await cli(["search", "query", "anything", "--global", "--auto-refresh"]);
    expect(res.returncode).not.toBe(0);
    expect(res.stderr).toContain("o2b search query --global");
  });

  test("rerank-eval --kind decision-model refuses", async () => {
    env = noVault();
    const dataset = join(env.parent, "dataset.json");
    writeFileSync(
      dataset,
      JSON.stringify({ queries: [{ id: "q", query: "x", expected: ["x.md"] }] }),
    );
    const res = await cli([
      "search",
      "rerank-eval",
      "--dataset",
      dataset,
      "--kind",
      "decision-model",
    ]);
    expect(res.returncode).not.toBe(0);
    expect(res.stderr).toContain("o2b search rerank-eval");
  });

  test("the provider registries refuse", async () => {
    env = noVault();
    for (const verb of ["provider", "rerank-provider"]) {
      const res = await cli(["search", verb, "list"]);
      expect(res.returncode).not.toBe(0);
      expect(res.stderr).toContain(`o2b search ${verb}`);
    }
  });
});

describe("search index with no vault", () => {
  test("says it indexed the brain store, not a vault named null", async () => {
    env = noVault();
    const res = await cli(["search", "index"]);
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("indexing the brain store (no vault)");
    expect(res.stdout).not.toContain("indexing vault: null");
  });
});
