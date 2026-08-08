/**
 * `o2b search index` / `o2b search status` over an index the census
 * cannot decide (what-the-index-already-knew, task H follow-up).
 *
 * The end-to-end half of `tests/core/search/chunk-window-estimate.ts`:
 * these runs go through real config resolution, so the instruction
 * prefix is the one the recommended default auto-resolves rather than one
 * a fixture wrote down, and the model window is the one the preset table
 * declares.
 *
 * The obligation discharged here is that a Chinese vault under the
 * Chinese preset stops being SILENT - it used to emit nothing on any
 * surface, and absence is documented to mean "every chunk fits" - while
 * an all-Latin vault emits the exact bytes it emitted before the
 * undecided band existed.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { requireNextStep } from "../../src/core/brain/next-step.ts";
import { declaredInputWindowTokens } from "../../src/core/search/embeddings/presets.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

/** The Chinese preset, and the window its own model card declares. */
const ZH_MODEL = "BAAI/bge-small-zh-v1.5";
const ZH_WINDOW = declaredInputWindowTokens(ZH_MODEL)!;

const OVERFLOW_COMMAND = requireNextStep("search-chunk-window-overflow").nextCommand;

/**
 * The exact `stats` bytes a one-file, one-chunk run emitted before the
 * census had an undecided band. Written out rather than rebuilt from the
 * parsed object: a re-serialized comparison agrees with itself whatever
 * the writer emitted.
 */
const BASELINE_STATS_JSON =
  '"stats":{"added":1,"updated":0,"unchanged":0,"deleted":0,' +
  '"chunks_total":1,"embeddings_computed":0,"embeddings_retries":0}';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-chunk-window-estimate-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  configPath = join(tmp, "config.yaml");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Semantic on, no key use: nothing in these runs contacts a provider. */
function writeConfig(model: string): void {
  writeFileSync(
    configPath,
    [
      `vault: "${vault}"`,
      'search_semantic_enabled: "true"',
      'embedding_provider: "openai-compat"',
      'embedding_base_url: "https://embeddings.invalid/v1"',
      `embedding_model: "${model}"`,
      'embedding_api_key: "test-key"',
    ].join("\n") + "\n",
  );
}

function writeNote(rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

function env(): Record<string, string> {
  return { OPEN_SECOND_BRAIN_CONFIG: configPath };
}

/**
 * A Chinese body several times its model's window: a BERT-family Chinese
 * tokenizer is roughly character-level, so the character count IS about
 * the token count, while characters-over-four reads a quarter of it.
 */
const HAN_NOTE = `# 记录\n\n${"知识管理系统的检索质量取决于分块大小".repeat(35)}\n`;
const LATIN_NOTE = "# Short\n\nA note that fits any declared window.\n";

test("a Chinese vault under the Chinese preset is no longer silent", async () => {
  writeConfig(ZH_MODEL);
  writeNote("zh.md", HAN_NOTE);
  const r = await runCli(["search", "index", "--json"], { env: env() });
  expect(r.returncode).toBe(0);

  const payload = JSON.parse(r.stdout) as {
    stats: { chunk_window?: Record<string, unknown> };
  };
  const census = payload.stats.chunk_window;
  expect(census?.["verdict"]).toBe("estimate-undecided");
  expect(census!["model"]).toBe(ZH_MODEL);
  expect(census!["window_tokens"]).toBe(ZH_WINDOW);
  expect(census!["chunks_undecided"]).toBeGreaterThan(0);
  // Nothing was PROVED over the window, so no count claims it was.
  expect("chunks_over_window" in census!).toBe(false);
  expect(census!["next_command"]).toBe(OVERFLOW_COMMAND);
});

test("the undecided verdict states the reason in the human run", async () => {
  writeConfig(ZH_MODEL);
  writeNote("zh.md", HAN_NOTE);
  const r = await runCli(["search", "index"], { env: env() });
  expect(r.returncode).toBe(0);
  expect(r.stdout).toContain("chunk window:");
  expect(r.stdout).toContain("undecided against");
  expect(r.stdout).toContain(`${ZH_WINDOW}-token window`);
  expect(r.stdout).toContain(`next: ${OVERFLOW_COMMAND}\n`);
});

test("search status carries the undecided band as a warning that denies a pass", async () => {
  writeConfig(ZH_MODEL);
  writeNote("zh.md", HAN_NOTE);
  await runCli(["search", "index"], { env: env() });
  const r = await runCli(["search", "status", "--json"], { env: env() });
  expect(r.returncode).toBe(0);
  const status = JSON.parse(r.stdout) as { warnings: string[] };
  const warning = status.warnings.find((w) => w.includes(OVERFLOW_COMMAND));
  expect(warning ?? "(the census said nothing)").toContain("not a pass");
  expect(warning!).toContain("search_chunk_size");
  // The check RAN - it is not the undeclared-window state.
  expect("chunk_window_undeclared" in status).toBe(false);
});

test("an all-Latin vault emits the pre-band bytes on both surfaces", async () => {
  writeConfig(ZH_MODEL);
  writeNote("a.md", LATIN_NOTE);
  const indexed = await runCli(["search", "index", "--json"], { env: env() });
  expect(indexed.returncode).toBe(0);
  expect(indexed.stdout).toContain(BASELINE_STATS_JSON);
  expect(indexed.stdout).not.toContain("chunk_window");
  expect(indexed.stdout).not.toContain("undecided");

  const status = await runCli(["search", "status", "--json"], { env: env() });
  expect(status.returncode).toBe(0);
  expect(status.stdout).not.toContain("chunk_window");
  expect((JSON.parse(status.stdout) as { warnings: string[] }).warnings).toEqual([]);
});
