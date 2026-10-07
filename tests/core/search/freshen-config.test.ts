import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { SearchError } from "../../../src/core/search/types.ts";

// The test preload pins the interval to 0 so the suite never spawns a
// background indexer; these tests own the variable while they run.
const ENV_KEYS = [
  "OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S",
  "OPEN_SECOND_BRAIN_SEARCH_FRESHEN_EMBEDDINGS",
];

let tmp: string;
let configPath: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-freshen-cfg-"));
  configPath = join(tmp, "config.yaml");
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

function resolve(extra = ""): ReturnType<typeof resolveSearchConfig> {
  writeFileSync(configPath, `vault: "${tmp}"\n${extra}`);
  return resolveSearchConfig({ vault: tmp, configPath });
}

test("freshening is on every 60 s by default, keyword-only, with the config path", () => {
  expect(resolve().freshen).toEqual({ intervalSeconds: 60, embeddings: false, configPath });
});

test("the config key sets the interval and 0 turns freshening off", () => {
  expect(resolve('search_freshen_interval_s: "300"\n').freshen?.intervalSeconds).toBe(300);
  expect(resolve('search_freshen_interval_s: "0"\n').freshen?.intervalSeconds).toBe(0);
});

test("the env variable wins over the config key", () => {
  process.env["OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S"] = "0";
  expect(resolve('search_freshen_interval_s: "300"\n').freshen?.intervalSeconds).toBe(0);
});

test("a negative or non-numeric interval is refused by name", () => {
  for (const bad of ['"-1"', '"abc"']) {
    expect(() => resolve(`search_freshen_interval_s: ${bad}\n`)).toThrow(SearchError);
    expect(() => resolve(`search_freshen_interval_s: ${bad}\n`)).toThrow(
      /search_freshen_interval_s/,
    );
  }
});

test("background embeddings are opt-in", () => {
  expect(resolve('search_freshen_embeddings: "true"\n').freshen?.embeddings).toBe(true);
});

test("a config resolved without a file carries no config path", () => {
  expect(resolveSearchConfig({ vault: tmp }).freshen?.configPath).toBeNull();
});
