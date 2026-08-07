/**
 * `o2b search index` reports the oversize-chunk census, and reports
 * NOTHING when there is nothing to report (what-the-index-already-knew,
 * task H).
 *
 * The byte-identity obligation is discharged against the actual bytes of
 * the `stats` object the `--json` payload carries: a run whose chunks fit
 * the configured model's declared window emits the exact substring it
 * emitted before this field existed, character for character, and so does
 * a run with semantic search off. Both are compared to one literal, so a
 * field that leaked in as `null` or `0` would change those bytes and fail
 * here rather than in a consumer.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { requireNextStep } from "../../src/core/brain/next-step.ts";
import {
  declaredInputWindowTokens,
  RECOMMENDED_EMBEDDING_MODEL,
} from "../../src/core/search/embeddings/presets.ts";
import { charLengthOverTokenBudget } from "../../src/core/search/embeddings/signature.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

/** The declared window of the shipped recommended default. */
const WINDOW = declaredInputWindowTokens(RECOMMENDED_EMBEDDING_MODEL)!;

/** A model deliberately outside the curated table. */
const UNCURATED_MODEL = "acme/custom-embed-9000";

/**
 * The exact `stats` bytes a one-file, one-chunk run emitted before the
 * census field existed. Written out rather than rebuilt from the parsed
 * object on purpose: a re-serialized comparison would agree with itself
 * no matter what the writer emitted.
 */
const BASELINE_STATS_JSON =
  '"stats":{"added":1,"updated":0,"unchanged":0,"deleted":0,' +
  '"chunks_total":1,"embeddings_computed":0,"embeddings_retries":0}';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-chunk-window-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  configPath = join(tmp, "config.yaml");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(lines: ReadonlyArray<string>): void {
  writeFileSync(configPath, [`vault: "${vault}"`, ...lines].join("\n") + "\n");
}

/** Semantic on, no key use: nothing in these runs contacts a provider. */
function semanticConfig(model: string): ReadonlyArray<string> {
  return [
    'search_semantic_enabled: "true"',
    'embedding_provider: "openai-compat"',
    'embedding_base_url: "https://embeddings.invalid/v1"',
    `embedding_model: "${model}"`,
    'embedding_api_key: "test-key"',
  ];
}

function writeNote(rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

const SHORT_NOTE = "# Short\n\nA note that fits any declared window.\n";
const OVERSIZE_NOTE = `# Big\n\n${"overflow ".repeat(charLengthOverTokenBudget(WINDOW))}\n`;

async function index(json: boolean): Promise<{ stdout: string; returncode: number }> {
  const argv = json ? ["search", "index", "--json"] : ["search", "index"];
  const r = await runCli(argv, { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } });
  return { stdout: r.stdout, returncode: r.returncode };
}

test("with semantic search off the stats bytes are the pre-feature bytes", async () => {
  writeConfig([]);
  writeNote("a.md", SHORT_NOTE);
  const r = await index(true);
  expect(r.returncode).toBe(0);
  expect(r.stdout).toContain(BASELINE_STATS_JSON);
  expect(r.stdout).not.toContain("chunk_window");
});

test("a clean census leaves those same bytes untouched", async () => {
  writeConfig(semanticConfig(RECOMMENDED_EMBEDDING_MODEL));
  writeNote("a.md", SHORT_NOTE);
  const r = await index(true);
  expect(r.returncode).toBe(0);
  // The census ran - the model is curated and its window is declared -
  // and found nothing, so it says nothing.
  expect(r.stdout).toContain(BASELINE_STATS_JSON);
  expect(r.stdout).not.toContain("chunk_window");
});

test("a clean census adds no line to the human report either", async () => {
  writeConfig(semanticConfig(RECOMMENDED_EMBEDDING_MODEL));
  writeNote("a.md", SHORT_NOTE);
  const r = await index(false);
  expect(r.returncode).toBe(0);
  expect(r.stdout).not.toContain("chunk window");
  expect(r.stdout).not.toContain(requireNextStep("search-chunk-window-overflow").nextCommand);
});

test("oversize chunks are counted, named, and carry their registered exit", async () => {
  writeConfig(semanticConfig(RECOMMENDED_EMBEDDING_MODEL));
  writeNote("big.md", OVERSIZE_NOTE);
  const r = await index(true);
  expect(r.returncode).toBe(0);
  const payload = JSON.parse(r.stdout) as {
    stats: {
      chunk_window?: {
        verdict: string;
        model: string;
        window_tokens: number;
        chunks_over_window: number;
        chunks_measured: number;
        next_command?: string;
      };
    };
  };
  const census = payload.stats.chunk_window;
  expect(census?.verdict).toBe("over-window");
  expect(census!.model).toBe(RECOMMENDED_EMBEDDING_MODEL);
  expect(census!.window_tokens).toBe(WINDOW);
  expect(census!.chunks_over_window).toBeGreaterThan(0);
  expect(census!.next_command).toBe(requireNextStep("search-chunk-window-overflow").nextCommand);
});

test("the human run states the count and the rail names the exit", async () => {
  writeConfig(semanticConfig(RECOMMENDED_EMBEDDING_MODEL));
  writeNote("big.md", OVERSIZE_NOTE);
  const r = await index(false);
  expect(r.returncode).toBe(0);
  expect(r.stdout).toContain("chunk window:");
  expect(r.stdout).toContain(`${WINDOW}-token window`);
  expect(r.stdout).toContain(
    `next: ${requireNextStep("search-chunk-window-overflow").nextCommand}\n`,
  );
});

test("an uncurated model reports a check that did not run, with no count", async () => {
  writeConfig(semanticConfig(UNCURATED_MODEL));
  writeNote("a.md", SHORT_NOTE);
  const r = await index(true);
  expect(r.returncode).toBe(0);
  const payload = JSON.parse(r.stdout) as {
    stats: { chunk_window?: Record<string, unknown> };
  };
  const census = payload.stats.chunk_window;
  expect(census?.["verdict"]).toBe("window-undeclared");
  expect(census!["model"]).toBe(UNCURATED_MODEL);
  // Nothing was counted, so no count is reported. A zero here would be a
  // measurement nobody took.
  expect("chunks_over_window" in census!).toBe(false);
  expect("window_tokens" in census!).toBe(false);
  expect(census!["next_command"]).toBe(
    requireNextStep("search-chunk-window-undeclared").nextCommand,
  );
});

test("the uncurated human report says the check did not run", async () => {
  writeConfig(semanticConfig(UNCURATED_MODEL));
  writeNote("a.md", SHORT_NOTE);
  const r = await index(false);
  expect(r.returncode).toBe(0);
  expect(r.stdout).toContain("not checked");
  expect(r.stdout).toContain(UNCURATED_MODEL);
  expect(r.stdout).toContain(
    `next: ${requireNextStep("search-chunk-window-undeclared").nextCommand}\n`,
  );
});

test("search status carries measured overflow as a warning", async () => {
  writeConfig(semanticConfig(RECOMMENDED_EMBEDDING_MODEL));
  writeNote("big.md", OVERSIZE_NOTE);
  await index(false);
  const r = await runCli(["search", "status", "--json"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(r.returncode).toBe(0);
  const status = JSON.parse(r.stdout) as { warnings: string[] };
  const command = requireNextStep("search-chunk-window-overflow").nextCommand;
  expect(status.warnings.some((w) => w.includes(command) && w.includes("search_chunk_size"))).toBe(
    true,
  );
  // A measured fault is not an unmeasurable one.
  expect("chunk_window_undeclared" in status).toBe(false);
});

test("search status distinguishes all three census states", async () => {
  // 1. Not measurable: a field, and NOT a warning.
  writeConfig(semanticConfig(UNCURATED_MODEL));
  writeNote("a.md", SHORT_NOTE);
  await index(false);
  const uncurated = await runCli(["search", "status", "--json"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(uncurated.returncode).toBe(0);
  const notMeasurable = JSON.parse(uncurated.stdout) as {
    warnings: string[];
    chunk_window_undeclared?: Record<string, unknown>;
  };
  expect(notMeasurable.chunk_window_undeclared).toEqual({
    verdict: "window-undeclared",
    model: UNCURATED_MODEL,
    chunks_measured: 1,
  });
  expect(notMeasurable.warnings).toEqual([]);

  // 2. Measured clean: neither. The same vault, the same chunks, a
  // model that declares a window - and the status says nothing at all.
  writeConfig(semanticConfig(RECOMMENDED_EMBEDDING_MODEL));
  await runCli(["search", "reindex"], { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } });
  const clean = await runCli(["search", "status", "--json"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(clean.returncode).toBe(0);
  expect(clean.stdout).not.toContain("chunk_window");
  expect((JSON.parse(clean.stdout) as { warnings: string[] }).warnings).toEqual([]);
});

test("the human status names the check that did not run, outside the warnings", async () => {
  writeConfig(semanticConfig(UNCURATED_MODEL));
  writeNote("a.md", SHORT_NOTE);
  await index(false);
  const r = await runCli(["search", "status"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(r.returncode).toBe(0);
  expect(r.stdout).toContain(`chunk_window_check:  not run`);
  expect(r.stdout).toContain(UNCURATED_MODEL);
  expect(r.stdout).not.toContain("warning:");
});
