/**
 * `o2b search index` reports the vectors an edit carried over: the count
 * the carry-over exists to save is shown in the JSON stats and on the
 * human `embeddings:` line, and a run that carried nothing keeps the
 * payload it emitted before the field existed.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { sqliteVecLoadable } from "../helpers/sqlite-vec.ts";

const VEC_LOADABLE = sqliteVecLoadable();

let tmp: string;
let vault: string;
let configPath: string;

/** Three sections small enough that each is its own chunk. */
const SECTIONS = [
  "# Alpha\n\nThe first section talks about compost and soil.",
  "# Beta\n\nThe second section talks about tomatoes in spring.",
  "# Gamma\n\nThe third section talks about watering at dawn.",
] as const;
const EDITED_BETA = "# Beta\n\nThe second section now talks about peppers.";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-index-reuse-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Notes"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(
    configPath,
    [
      `vault: "${vault}"`,
      'search_semantic_enabled: "true"',
      'embedding_provider: "local"',
      'search_chunk_size: "60"',
      'search_chunk_overlap: "0"',
      'search_chunk_min_size: "1"',
    ].join("\n") + "\n",
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeNote(sections: ReadonlyArray<string>): void {
  writeFileSync(join(vault, "Notes", "garden.md"), sections.join("\n\n"));
}

async function index(json: boolean): Promise<string> {
  const argv = ["search", "index", "--embeddings", ...(json ? ["--json"] : [])];
  const r = await runCli(argv, { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } });
  expect(r.returncode).toBe(0);
  return r.stdout;
}

function statsOf(stdout: string): Record<string, unknown> {
  return (JSON.parse(stdout) as { stats: Record<string, unknown> }).stats;
}

test.skipIf(!VEC_LOADABLE)(
  "an edit reports the carried vectors as embeddings_reused in JSON",
  async () => {
    writeNote(SECTIONS);
    const first = statsOf(await index(true));
    expect(first).not.toHaveProperty("embeddings_reused");

    writeNote([SECTIONS[0], EDITED_BETA, SECTIONS[2]]);
    const second = statsOf(await index(true));
    expect(second["embeddings_computed"]).toBe(1);
    expect(second["embeddings_reused"]).toBe((first["embeddings_computed"] as number) - 1);
  },
);

test.skipIf(!VEC_LOADABLE)("the human embeddings line names the reused count", async () => {
  writeNote(SECTIONS);
  expect(await index(false)).not.toContain("reused");

  writeNote([SECTIONS[0], EDITED_BETA, SECTIONS[2]]);
  expect(await index(false)).toMatch(/embeddings: 1 computed \(0 retries\), \d+ reused/);
});
