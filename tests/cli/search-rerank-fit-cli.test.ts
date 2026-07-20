/**
 * CLI surface for the reranker fit check (R2, t_267f3b4c):
 * `o2b search rerank-fit`. Read-only diagnostic; JSON envelope carries the
 * verdict, correlation, and recommendation; a rerankerless vault reports
 * inapplicable; bad flags are usage errors (exit 2).
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { handleSearchSubcommand } from "../../src/cli/search.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { recordQueryDemand } from "../../src/core/brain/query-demand.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import { createTempVault, writeMd } from "../helpers/search-fixtures.ts";

let vault: string;
let configPath: string;
let cleanup: () => void;
let out: string;
const origWrite = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  ({ vault, cleanup } = createTempVault("rerank-fit-cli"));
  configPath = join(vault, "config.json");
  out = "";
  // Capture stdout for JSON assertions.
  process.stdout.write = ((chunk: string) => {
    out += chunk;
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = origWrite;
  cleanup();
});

function writeConfig(rerankEnabled: boolean): void {
  const lines = [`vault: "${vault}"`];
  if (rerankEnabled) {
    lines.push("search_rerank_enabled: true", 'search_rerank_kind: "local"');
  }
  writeFileSync(configPath, lines.join("\n") + "\n", "utf8");
}

test("a rerankerless vault reports inapplicable (exit 0)", async () => {
  writeConfig(false);
  writeMd(vault, "a.md", "# A\n\nalpha beta gamma content.\n");
  await indexVault(resolveSearchConfig({ vault, configPath }));
  const code = await handleSearchSubcommand([
    "rerank-fit",
    "--vault",
    vault,
    "--config",
    configPath,
    "--json",
  ]);
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.ok).toBe(true);
  expect(parsed.applicable).toBe(false);
  expect(parsed.verdict).toBe("inapplicable");
});

test("an enabled reranker over recorded queries reports an applicable verdict", async () => {
  writeConfig(true);
  // Varied length / term frequency so base BM25 scores are distinct (a tie
  // carries no rank signal and would be filtered as uninformative).
  writeMd(vault, "a.md", "# A\n\nalpha beta gamma alpha beta gamma alpha beta gamma tight.\n");
  writeMd(
    vault,
    "b.md",
    "# B\n\nalpha beta gamma with a moderate amount of surrounding words about deploy staging pipelines and config notes here today.\n",
  );
  writeMd(vault, "c.md", `# C\n\nalpha beta gamma then a long tail ${"lorem ipsum ".repeat(20)}\n`);
  await indexVault(resolveSearchConfig({ vault, configPath }));
  recordQueryDemand(vault, { query: "alpha beta gamma", resultCount: 3 });
  recordQueryDemand(vault, { query: "alpha beta gamma", resultCount: 3 });
  const code = await handleSearchSubcommand([
    "rerank-fit",
    "--vault",
    vault,
    "--config",
    configPath,
    "--json",
  ]);
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.ok).toBe(true);
  expect(parsed.applicable).toBe(true);
  expect(["fits", "out_of_domain", "inverted"]).toContain(parsed.verdict);
});

test("a non-numeric --top-k is a usage error (exit 2)", async () => {
  writeConfig(true);
  const code = await handleSearchSubcommand([
    "rerank-fit",
    "--vault",
    vault,
    "--config",
    configPath,
    "--top-k",
    "nope",
  ]);
  expect(code).toBe(2);
});
