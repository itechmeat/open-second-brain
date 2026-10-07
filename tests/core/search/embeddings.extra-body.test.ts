import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OpenAICompatProvider } from "../../../src/core/search/embeddings/openai-compat.ts";
import { makeProvider } from "../../../src/core/search/embeddings/provider.ts";
import { providerCeilingKey } from "../../../src/core/search/embeddings/provider-semaphore.ts";
import {
  EXTRA_BODY_ENV,
  EXTRA_BODY_KEY,
  RESERVED_EMBEDDING_BODY_KEYS,
  resolveSearchConfig,
} from "../../../src/core/search/index.ts";
import { indexStatus, indexVault, reindexVault } from "../../../src/core/search/indexer.ts";
import { SearchError } from "../../../src/core/search/search-error.ts";
import type {
  ResolvedEmbeddingConfig,
  ResolvedSearchConfig,
} from "../../../src/core/search/types.ts";
import { SafeguardAbortError } from "../../../src/core/brain/safeguard.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";
import { makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";

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
  const resolved = resolveWith([
    "embedding_dimension: 256",
    `${EXTRA_BODY_KEY}: {"dimensions": 256, "user": "x"}`,
  ]);
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

for (const spelling of ["\uFF4D\uFF4F\uFF44\uFF45\uFF4C", " input ", "encoding\u200B_format"]) {
  test(`a reserved key in a compatibility or invisible spelling ${JSON.stringify(spelling)} is refused`, () => {
    const e = refusal([`${EXTRA_BODY_KEY}: ${JSON.stringify({ [spelling]: 1 })}`]);
    expect(e.code).toBe("INVALID_INPUT");
    expect(e.message).toContain(`'${spelling}'`);
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

test("a dimensions field with no embedding_dimension is refused", () => {
  const e = refusal([`${EXTRA_BODY_KEY}: {"dimensions": 256}`]);
  expect(e.code).toBe("INVALID_INPUT");
  expect(e.message).toContain(EXTRA_BODY_KEY);
  expect(e.message).toContain("embedding_dimension");
});

test("a dimensions field in another spelling is checked by its spelling", () => {
  const e = refusal(["embedding_dimension: 4", `${EXTRA_BODY_KEY}: {"Dimensions": 256}`]);
  expect(e.code).toBe("INVALID_INPUT");
  expect(e.message).toContain("'Dimensions'");
});

function overrideRefusal(semantic: Partial<ResolvedEmbeddingConfig>): SearchError {
  writeFileSync(configPath, [`vault: "${tmp}"`, ""].join("\n"));
  try {
    resolveSearchConfig({ vault: tmp, configPath, overrides: { semantic } });
  } catch (e) {
    if (e instanceof SearchError) return e;
    throw e;
  }
  throw new Error("expected resolveSearchConfig to refuse");
}

test("an override cannot carry a dimensions field past an unset width", () => {
  const e = overrideRefusal({ dimension: null, extraBody: Object.freeze({ dimensions: 256 }) });
  expect(e.code).toBe("INVALID_INPUT");
  expect(e.message).toContain("embedding_dimension");
});

test("an override cannot carry a dimensions field that disagrees with its width", () => {
  const e = overrideRefusal({ dimension: 4, extraBody: Object.freeze({ dimensions: 256 }) });
  expect(e.code).toBe("INVALID_INPUT");
  expect(e.message).toContain("embedding_dimension is 4");
});

for (const provider of ["zeroentropy", "local"]) {
  test(`an extra body is refused for the ${provider} provider, naming it`, () => {
    const e = refusal([`embedding_provider: ${provider}`, `${EXTRA_BODY_KEY}: {"user": "x"}`]);
    expect(e.code).toBe("INVALID_INPUT");
    expect(e.message).toContain(EXTRA_BODY_KEY);
    expect(e.message).toContain(`'${provider}'`);
  });
}

test("an extra body from the env for another provider is refused naming the env variable", () => {
  const e = refusal(["embedding_provider: zeroentropy"], '{"user": "x"}');
  expect(e.code).toBe("INVALID_INPUT");
  expect(e.message).toContain(EXTRA_BODY_ENV);
  expect(e.message).not.toContain(EXTRA_BODY_KEY);
});

test("a dimensions field from the env is refused naming the env variable", () => {
  const e = refusal(["embedding_dimension: 4"], '{"dimensions": 256}');
  expect(e.code).toBe("INVALID_INPUT");
  expect(e.message).toContain(EXTRA_BODY_ENV);
  expect(e.message).toContain("embedding_dimension is 4");
});

test("an override cannot pair a non-openai-compat provider with an extra body", () => {
  const e = overrideRefusal({ provider: "zeroentropy", extraBody: Object.freeze({ user: "x" }) });
  expect(e.code).toBe("INVALID_INPUT");
  expect(e.message).toContain("'zeroentropy'");
});

test("an override cannot carry an owned request field in any spelling", () => {
  const e = overrideRefusal({ extraBody: Object.freeze({ Encoding_Format: "base64" }) });
  expect(e.code).toBe("INVALID_INPUT");
  expect(e.message).toContain(EXTRA_BODY_KEY);
  expect(e.message).toContain("'Encoding_Format'");
});

test("a disabled provider accepts an extra body and builds a provider that sends nothing", async () => {
  const resolved = resolveWith([
    "embedding_provider: disabled",
    `${EXTRA_BODY_KEY}: {"user": "x"}`,
  ]);
  expect(resolved.semantic.provider).toBe("disabled");
  const provider = makeProvider(resolved.semantic);
  expect(provider.producesVectors).toBe(false);
  await expect(provider.embed(["hello"])).rejects.toMatchObject({ code: "EMBEDDING_DISABLED" });
});

// ── identity ─────────────────────────────────────────────────────────────────

/** A config over the test vault that indexes through the fake provider. */
function indexConfig(
  extraBody?: Readonly<Record<string, unknown>>,
  rest: Partial<ResolvedSearchConfig> = {},
): ResolvedSearchConfig {
  const semantic = cfg(extraBody === undefined ? {} : { extraBody: Object.freeze(extraBody) });
  return Object.freeze({
    ...makeConfig({
      vault: tmp,
      dbPath: join(tmp, ".open-second-brain", "brain.sqlite"),
      semantic,
    }),
    ...rest,
  });
}

test.skipIf(!sqliteVecLoadable())(
  "adding an extra body to an indexed vault re-embeds nothing and keeps the status signature",
  async () => {
    writeMd(tmp, "a.md", "# A\n\nFirst note about something.");
    const plain = indexConfig();
    const first = await indexVault(plain, { embeddings: true });
    expect(first.embeddingsComputed).toBeGreaterThan(0);
    const plainStatus = await indexStatus(plain);
    const calls = server.callCount();

    const extra = indexConfig({ user: "x" });
    const second = await indexVault(extra, { embeddings: true });
    expect(second.embeddingsComputed).toBe(0);
    expect(server.callCount()).toBe(calls);

    const extraStatus = await indexStatus(extra);
    expect(extraStatus.embeddingSignature).toBe(plainStatus.embeddingSignature);
    expect(extraStatus.staleEmbeddings).toBe(0);
    expect(extraStatus.embeddings).toBe(extraStatus.chunks);

    // The body is in force: a new note goes out with it, and alone.
    const bodies: unknown[] = [];
    server.setHandler(captureBodies(bodies));
    writeMd(tmp, "b.md", "# B\n\nSecond note discussing things.");
    await indexVault(extra, { embeddings: true });
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).toMatchObject({ user: "x" });
      expect(JSON.stringify(body)).not.toContain("First note");
    }
  },
);

test.skipIf(!sqliteVecLoadable())(
  "an interrupted rebuild resumes under a config that adds an extra body",
  async () => {
    for (let i = 0; i < 4; i++) writeMd(tmp, `n${i}.md`, `# N${i}\n\nbody number ${i}`);
    const ac = new AbortController();
    let processed = 0;
    await expect(
      reindexVault(indexConfig(undefined, { resumeReindex: true }), {
        embeddings: true,
        signal: ac.signal,
        onFile: () => {
          if (++processed === 1) ac.abort();
        },
      }),
    ).rejects.toBeInstanceOf(SafeguardAbortError);

    const stats = await reindexVault(indexConfig({ user: "x" }, { resumeReindex: true }), {
      embeddings: true,
    });
    // A discarded staging build would count every note as added.
    expect(stats.unchanged).toBeGreaterThanOrEqual(1);
    expect(stats.added + stats.unchanged).toBe(4);
  },
);

test("an extra body shares the provider's concurrency ceiling", () => {
  const base = [
    "embedding_provider: openai-compat",
    "embedding_model: fake-model",
    "embedding_dimension: 4",
  ];
  const plain = resolveWith(base).semantic;
  const extra = resolveWith([...base, `${EXTRA_BODY_KEY}: {"user": "x"}`]).semantic;
  expect(extra.extraBody).toEqual({ user: "x" });
  expect(providerCeilingKey("openai-compat", extra, server.url)).toBe(
    providerCeilingKey("openai-compat", plain, server.url),
  );
});
