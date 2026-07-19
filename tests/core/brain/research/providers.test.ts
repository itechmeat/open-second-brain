/**
 * Web-research providers plus pool wiring (R1, t_1dcbf352). A provider joins
 * the pool only when its key env is set; a keyless pool reports itself empty
 * explicitly. Network and auth failures surface as typed errors carried in
 * the pool report, never as invented content. All HTTP is mocked at the
 * transport boundary.
 */

import { describe, expect, test } from "bun:test";

import {
  ExternalFetchError,
  type ExternalFetchResponse,
  type ExternalFetchTransport,
} from "../../../../src/core/brain/research/external-fetch.ts";
import {
  createBraveProvider,
  BRAVE_PROVIDER_NAME,
} from "../../../../src/core/brain/research/providers/brave.ts";
import {
  createTavilyProvider,
  TAVILY_PROVIDER_NAME,
} from "../../../../src/core/brain/research/providers/tavily.ts";
import {
  BRAVE_API_KEY_ENV,
  TAVILY_API_KEY_ENV,
  buildResearchPool,
  resolveResearchPoolEnv,
  runResearchPool,
} from "../../../../src/core/brain/research/research.ts";

function jsonResponse(status: number, payload: unknown): ExternalFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function transportOf(res: ExternalFetchResponse | (() => never)): ExternalFetchTransport {
  return async () => (typeof res === "function" ? res() : res);
}

const BRAVE_PAYLOAD = {
  web: {
    results: [
      { title: "Restaking risks", url: "https://a.example/1", description: "slashing compounds" },
      { title: "Withdrawal queues", url: "https://a.example/2", description: "queues lengthen" },
    ],
  },
};

const TAVILY_PAYLOAD = {
  results: [{ title: "AVS survey", url: "https://b.example/1", content: "operator set overlap" }],
};

describe("providers parse mocked responses", () => {
  test("brave maps web.results into provider results", async () => {
    const provider = createBraveProvider({
      apiKey: "k",
      transport: transportOf(jsonResponse(200, BRAVE_PAYLOAD)),
    });
    expect(provider.name).toBe(BRAVE_PROVIDER_NAME);
    const results = await provider.search("restaking");
    expect(results.length).toBe(2);
    expect(results[0]).toEqual({
      title: "Restaking risks",
      url: "https://a.example/1",
      snippet: "slashing compounds",
    });
  });

  test("tavily maps results into provider results", async () => {
    const provider = createTavilyProvider({
      apiKey: "k",
      transport: transportOf(jsonResponse(200, TAVILY_PAYLOAD)),
    });
    expect(provider.name).toBe(TAVILY_PROVIDER_NAME);
    const results = await provider.search("avs");
    expect(results).toEqual([
      { title: "AVS survey", url: "https://b.example/1", snippet: "operator set overlap" },
    ]);
  });
});

describe("pool env gating", () => {
  test("resolveResearchPoolEnv reads both key envs", () => {
    const env = resolveResearchPoolEnv({ [BRAVE_API_KEY_ENV]: "b", [TAVILY_API_KEY_ENV]: "t" });
    expect(env.braveApiKey).toBe("b");
    expect(env.tavilyApiKey).toBe("t");
  });

  test("a keyless pool is explicitly empty", () => {
    const pool = buildResearchPool(
      { braveApiKey: null, tavilyApiKey: null },
      { transport: transportOf(jsonResponse(200, {})) },
    );
    expect(pool.isEmpty()).toBe(true);
    expect(pool.providers.length).toBe(0);
    expect(pool.enabledNames).toEqual([]);
  });

  test("a provider joins the pool only when its key is set", () => {
    const pool = buildResearchPool(
      { braveApiKey: "b", tavilyApiKey: null },
      { transport: transportOf(jsonResponse(200, {})) },
    );
    expect(pool.isEmpty()).toBe(false);
    expect(pool.enabledNames).toEqual([BRAVE_PROVIDER_NAME]);
  });
});

describe("runResearchPool carries typed errors", () => {
  test("an auth failure is recorded as a typed error, not content", async () => {
    let calls = 0;
    const transport: ExternalFetchTransport = async () => {
      calls += 1;
      return jsonResponse(401, {});
    };
    const pool = buildResearchPool({ braveApiKey: "b", tavilyApiKey: null }, { transport });
    const report = await runResearchPool(pool, "restaking");
    expect(calls).toBe(1);
    expect(report.results).toEqual([]);
    expect(report.errors.length).toBe(1);
    expect(report.errors[0]!.kind).toBe("auth");
    expect(report.errors[0]!.provider).toBe(BRAVE_PROVIDER_NAME);
  });

  test("a successful provider contributes results", async () => {
    const pool = buildResearchPool(
      { braveApiKey: "b", tavilyApiKey: null },
      { transport: transportOf(jsonResponse(200, BRAVE_PAYLOAD)) },
    );
    const report = await runResearchPool(pool, "restaking");
    expect(report.errors).toEqual([]);
    expect(report.results.length).toBe(2);
    expect(report.results[0]!.provider).toBe(BRAVE_PROVIDER_NAME);
  });

  test("the provider surfaces a typed ExternalFetchError to callers", async () => {
    const provider = createBraveProvider({
      apiKey: "k",
      transport: transportOf(() => {
        throw new Error("boom");
      }),
    });
    await expect(provider.search("x")).rejects.toBeInstanceOf(ExternalFetchError);
  });
});
