import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OpenAICompatProvider } from "../../../src/core/search/embeddings/openai-compat.ts";
import { providerCeilingKey } from "../../../src/core/search/embeddings/provider-semaphore.ts";
import { embeddingSignature } from "../../../src/core/search/embeddings/signature.ts";
import {
  RESERVED_EMBEDDING_BODY_KEYS,
  resolveSearchConfig,
} from "../../../src/core/search/index.ts";
import { SearchError } from "../../../src/core/search/search-error.ts";
import type {
  ResolvedEmbeddingConfig,
  ResolvedSearchConfig,
} from "../../../src/core/search/types.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";

const EXTRA_BODY_KEY = "embedding_extra_body";
const EXTRA_BODY_ENV = "OPEN_SECOND_BRAIN_EMBEDDING_EXTRA_BODY";

let server: FakeHttp;
let tmp: string;
let configPath: string;
let savedEnv: string | undefined;

beforeEach(async () => {
  server = await startFakeHttp();
  tmp = mkdtempSync(join(tmpdir(), "o2b-extra-body-"));
  configPath = join(tmp, "config.yaml");
  savedEnv = process.env[EXTRA_BODY_ENV];
  delete process.env[EXTRA_BODY_ENV];
});

afterEach(async () => {
  await server.close();
  rmSync(tmp, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env[EXTRA_BODY_ENV];
  else process.env[EXTRA_BODY_ENV] = savedEnv;
});

function cfg(overrides: Partial<ResolvedEmbeddingConfig> = {}): ResolvedEmbeddingConfig {
  return Object.freeze({
    enabled: true,
    provider: "openai-compat",
    baseUrl: server.url,
    model: "fake-model",
    apiKey: FAKE_PROVIDER_KEY,
    dimension: 4,
    timeoutMs: 5_000,
    concurrency: 2,
    batchSize: 32,
    costGateUsd: 0,
    maxRetries: 1,
    ...overrides,
  });
}

/** Records every request body and answers with `width`-wide vectors. */
function captureBodies(bodies: unknown[], width = 4) {
  return (req: { body: unknown }) => {
    bodies.push(req.body);
    const input = (req.body as { input: string[] }).input;
    const data = input.map((_, i) => ({
      object: "embedding",
      embedding: Array.from({ length: width }, (_, j) => (j === 0 ? 1 : 0)),
      index: i,
    }));
    return { status: 200, body: { data } };
  };
}

function resolveWith(lines: string[], envValue?: string): ResolvedSearchConfig {
  writeFileSync(configPath, [`vault: "${tmp}"`, ...lines, ""].join("\n"));
  if (envValue !== undefined) process.env[EXTRA_BODY_ENV] = envValue;
  return resolveSearchConfig({ vault: tmp, configPath });
}

function refusal(lines: string[], envValue?: string): SearchError {
  try {
    resolveWith(lines, envValue);
  } catch (e) {
    if (e instanceof SearchError) return e;
    throw e;
  }
  throw new Error("expected resolveSearchConfig to refuse");
}

// ── request body ─────────────────────────────────────────────────────────────

test("an absent extra body sends exactly the owned fields", async () => {
  const bodies: unknown[] = [];
  server.setHandler(captureBodies(bodies));
  await new OpenAICompatProvider(cfg()).embed(["alpha", "beta"]);
  expect(bodies).toEqual([
    { model: "fake-model", input: ["alpha", "beta"], encoding_format: "float" },
  ]);
});

test("declared extra fields arrive next to the owned fields", async () => {
  const bodies: unknown[] = [];
  server.setHandler(captureBodies(bodies));
  const extraBody = Object.freeze({ dimensions: 256, user: "x" });
  await new OpenAICompatProvider(cfg({ extraBody })).embed(["alpha"]);
  expect(bodies).toEqual([
    {
      dimensions: 256,
      user: "x",
      model: "fake-model",
      input: ["alpha"],
      encoding_format: "float",
    },
  ]);
});

test("owned fields win over an extra body that slipped past resolution", async () => {
  const bodies: unknown[] = [];
  server.setHandler(captureBodies(bodies));
  const extraBody = Object.freeze({ model: "other", input: ["x"], encoding_format: "base64" });
  await new OpenAICompatProvider(cfg({ extraBody })).embed(["alpha"]);
  expect(bodies).toEqual([{ model: "fake-model", input: ["alpha"], encoding_format: "float" }]);
});

test("a response width changed by the extra body surfaces as a named error", async () => {
  server.setHandler(captureBodies([], 2));
  const provider = new OpenAICompatProvider(cfg({ extraBody: Object.freeze({ dimensions: 2 }) }));
  const error = await provider.embed(["alpha"]).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SearchError);
  expect((error as SearchError).code).toBe("EMBEDDING_DIMENSION_MISMATCH");
});

// ── resolution ───────────────────────────────────────────────────────────────

test("an absent key resolves to no extra body", () => {
  const resolved = resolveWith([]);
  expect(resolved.semantic.extraBody).toBeUndefined();
  expect("extraBody" in resolved.semantic).toBe(false);
});

test("a JSON object in the config key resolves to the extra body", () => {
  const resolved = resolveWith([`${EXTRA_BODY_KEY}: {"dimensions": 256, "user": "x"}`]);
  expect(resolved.semantic.extraBody).toEqual({ dimensions: 256, user: "x" });
  expect(Object.isFrozen(resolved.semantic.extraBody)).toBe(true);
});

test("the env value beats the config value", () => {
  const resolved = resolveWith([`${EXTRA_BODY_KEY}: {"user": "config"}`], '{"user": "env"}');
  expect(resolved.semantic.extraBody).toEqual({ user: "env" });
});

test("the reserved keys are the owned request fields", () => {
  expect([...RESERVED_EMBEDDING_BODY_KEYS]).toEqual(["model", "input", "encoding_format"]);
});

for (const spelling of ["model", "Input", "encoding-format"]) {
  test(`a reserved key spelled '${spelling}' is refused by its spelling`, () => {
    const e = refusal([`${EXTRA_BODY_KEY}: {"${spelling}": 1, "user": "x"}`]);
    expect(e.code).toBe("INVALID_INPUT");
    expect(e.message).toContain(EXTRA_BODY_KEY);
    expect(e.message).toContain(`'${spelling}'`);
    expect(e.message).not.toContain("'user'");
  });
}

test("every reserved spelling is listed in one refusal", () => {
  const e = refusal([`${EXTRA_BODY_KEY}: {"MODEL": 1, "Encoding_Format": "x"}`]);
  expect(e.message).toContain("'MODEL'");
  expect(e.message).toContain("'Encoding_Format'");
});

const MALFORMED: ReadonlyArray<readonly [string, string]> = [
  ["invalid JSON", "{not json"],
  ["an array", '["dimensions", 256]'],
  ["a scalar", "256"],
  ["null", "null"],
];

for (const [label, value] of MALFORMED) {
  test(`${label} is refused naming the key`, () => {
    const e = refusal([`${EXTRA_BODY_KEY}: ${value}`]);
    expect(e.code).toBe("INVALID_INPUT");
    expect(e.message).toContain(EXTRA_BODY_KEY);
  });
}

test("a blank config value is refused naming the key", () => {
  const e = refusal([`${EXTRA_BODY_KEY}: "  "`]);
  expect(e.code).toBe("INVALID_INPUT");
  expect(e.message).toContain(EXTRA_BODY_KEY);
});

test("a blank env value is refused naming the env variable", () => {
  const e = refusal([], " ");
  expect(e.code).toBe("INVALID_INPUT");
  expect(e.message).toContain(EXTRA_BODY_ENV);
});

test("a refusal from the env value names the env variable", () => {
  const e = refusal([`${EXTRA_BODY_KEY}: {"user": "x"}`], '{"model": "y"}');
  expect(e.code).toBe("INVALID_INPUT");
  expect(e.message).toContain(EXTRA_BODY_ENV);
  expect(e.message).toContain("'model'");
});

test("a dimensions field that disagrees with embedding_dimension is refused", () => {
  const e = refusal(["embedding_dimension: 4", `${EXTRA_BODY_KEY}: {"dimensions": 256}`]);
  expect(e.code).toBe("INVALID_INPUT");
  expect(e.message).toContain("embedding_dimension");
  expect(e.message).toContain(EXTRA_BODY_KEY);
});

test("a dimensions field that agrees with embedding_dimension resolves", () => {
  const resolved = resolveWith([
    "embedding_dimension: 256",
    `${EXTRA_BODY_KEY}: {"dimensions": 256}`,
  ]);
  expect(resolved.semantic.extraBody).toEqual({ dimensions: 256 });
});

// ── identity ─────────────────────────────────────────────────────────────────

test("the extra body is not part of the embedding identity", () => {
  const base = [
    "embedding_provider: openai-compat",
    "embedding_model: fake-model",
    "embedding_dimension: 4",
  ];
  const plain = resolveWith(base).semantic;
  const extra = resolveWith([...base, `${EXTRA_BODY_KEY}: {"user": "x"}`]).semantic;
  const identity = (s: ResolvedEmbeddingConfig) =>
    embeddingSignature({ provider: s.provider, model: s.model, dimension: s.dimension });
  expect(identity(extra)).toBe(identity(plain));
  expect(providerCeilingKey("openai-compat", extra, server.url)).toBe(
    providerCeilingKey("openai-compat", plain, server.url),
  );
});
