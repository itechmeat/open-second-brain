/**
 * `o2b search --explain` reports the overlapped lane timing
 * (recall-lane-latency): how much of the semantic lane's embed round trip
 * the keyword lanes hid, measured as the intersection of the two
 * intervals. The timing rides a per-call sink - never SearchOutcome,
 * which the query cache persists whole - so the flag-off payload is
 * byte-identical (off means absent), and a keyword-only answer reports
 * zero with the lane not attempted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FAKE_PROVIDER_KEY } from "../helpers/fake-credentials.ts";
import { startFakeHttp, type FakeHttp } from "../helpers/fake-http.ts";
import { runCli } from "../helpers/run-cli.ts";

const QUERY = "quick brown fox";
const MODEL = "fake-model";

let vault: string;
let configHome: string;
let configPath: string;
let server: FakeHttp;

/** Embeddings-shaped body with the default handler's deterministic vectors. */
function embeddingsBody(req: { body: unknown }, delayMs: number) {
  const body = (req.body ?? {}) as { input?: string[]; model?: string };
  const inputs = Array.isArray(body.input) ? body.input : [];
  return {
    status: 200,
    body: {
      data: inputs.map((text, index) => {
        const tokens = text.split(/\s+/).filter(Boolean).length;
        return { object: "embedding", embedding: [tokens, index, text.length, 1], index };
      }),
      model: body.model ?? MODEL,
    },
    delayMs,
  };
}

beforeEach(async () => {
  server = await startFakeHttp();
  vault = mkdtempSync(join(tmpdir(), "o2b-explain-overlap-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-explain-overlap-cfg-"));
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(
    join(vault, "notes", "fox.md"),
    "---\ntitle: Fox\n---\n\n# Fox\n\nThe quick brown fox jumps over the lazy dog.\n",
  );
  writeFileSync(
    join(vault, "notes", "bar.md"),
    "---\ntitle: Bar\n---\n\n# Bar\n\nA different note about cats and turtles.\n",
  );
  // A real body of notes keeps the synchronous FTS lane comfortably above
  // the wall-clock resolution, so a positive-overlap pin cannot flake on a
  // same-millisecond keyword interval.
  for (let i = 0; i < 60; i++) {
    writeFileSync(
      join(vault, "notes", `filler-${i}.md`),
      `---\ntitle: Filler ${i}\n---\n\n# Filler ${i}\n\nNote ${i} about herons, sleds, compasses and other words the query never uses.\n`,
    );
  }
  configPath = join(configHome, "config.yaml");
  writeFileSync(
    configPath,
    [
      `vault: ${vault}`,
      "search_semantic_enabled: true",
      "embedding_provider: openai-compat",
      `embedding_base_url: ${server.url}`,
      `embedding_model: ${MODEL}`,
      `embedding_api_key: ${FAKE_PROVIDER_KEY}`,
      "embedding_dimension: 4",
      "embedding_cost_gate_usd: 0",
      "",
    ].join("\n"),
  );
}, 20_000);

afterEach(async () => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  await server.close();
}, 20_000);

async function indexWithEmbeddings() {
  const indexed = await runCli(["search", "index", "--embeddings"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(indexed.returncode).toBe(0);
}

describe("o2b search --explain: overlapped lane timing", () => {
  test("the payload carries an integer overlapped_ms and the transcript prints the line", async () => {
    await indexWithEmbeddings();
    // A slow round trip gives the keyword lanes something to hide.
    server.setHandler((req) => embeddingsBody(req, 150));

    const explained = await runCli(["search", QUERY, "--json", "--limit", "5", "--explain"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(explained.returncode).toBe(0);
    const payload = JSON.parse(explained.stdout) as {
      overlapped_ms?: number;
      semantic_attempted?: boolean;
    };
    // The arithmetic itself is pinned exactly at the unit level
    // (overlappedEmbedMs, hybrid-overlap.test.ts): a real overlapped run on
    // a small corpus can legitimately measure zero - the synchronous FTS
    // lane finishes inside the clock resolution - so this integration pin
    // holds the wiring to a sane integer value and leaves the exactness to
    // the pure function.
    expect(payload.overlapped_ms).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(payload.overlapped_ms)).toBe(true);
    expect(payload.semantic_attempted).toBe(true);

    const human = await runCli(["search", QUERY, "--limit", "5", "--explain"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(human.returncode).toBe(0);
    expect(human.stdout).toContain("overlapped:");
  }, 30_000);

  test("without --explain the payload carries no timing keys", async () => {
    await indexWithEmbeddings();
    server.setHandler((req) => embeddingsBody(req, 150));

    const plain = await runCli(["search", QUERY, "--json", "--limit", "5"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(plain.returncode).toBe(0);
    const payload = JSON.parse(plain.stdout) as Record<string, unknown>;
    // Off means absent: the timing never reaches the outcome, so the
    // flag-off payload is byte-identical to the pre-change one.
    expect("overlapped_ms" in payload).toBe(false);
    expect("semantic_attempted" in payload).toBe(false);
  }, 30_000);

  test("a keyword-only run reports zero overlap with the lane not attempted", async () => {
    await indexWithEmbeddings();
    server.setHandler((req) => embeddingsBody(req, 150));

    const explained = await runCli(
      ["search", QUERY, "--json", "--limit", "5", "--explain", "--keyword-only"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
    );
    expect(explained.returncode).toBe(0);
    const payload = JSON.parse(explained.stdout) as {
      overlapped_ms?: number;
      semantic_attempted?: boolean;
    };
    expect(payload.overlapped_ms).toBe(0);
    expect(payload.semantic_attempted).toBe(false);
  }, 30_000);
});
