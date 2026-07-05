/**
 * Provider-resolution / no-op seam (semantic-retrieval-precision, parent
 * t_47fd9523). The parent lands this helper as the seam the child
 * cross-encoder reuses, so its fail-closed-validation + graceful-no-op
 * discipline is tested here directly.
 */

import { describe, expect, test } from "bun:test";

import { SearchError } from "../../../src/core/search/types.ts";
import { resolveOpenAiCompatEndpoint } from "../../../src/core/search/embeddings/provider-resolve.ts";

describe("resolveOpenAiCompatEndpoint", () => {
  test("disabled → graceful no-op (null), no validation", () => {
    expect(
      resolveOpenAiCompatEndpoint({ enabled: false, baseUrl: null, model: null }, "search_rerank"),
    ).toBeNull();
  });

  test("enabled + missing base_url fails closed with a clear error", () => {
    expect(() =>
      resolveOpenAiCompatEndpoint(
        { enabled: true, baseUrl: null, model: "m", apiKey: "k" },
        "search_rerank",
      ),
    ).toThrow(/search_rerank_base_url is required/);
  });

  test("enabled + missing model fails closed", () => {
    expect(() =>
      resolveOpenAiCompatEndpoint(
        { enabled: true, baseUrl: "https://x/v1", model: null, apiKey: "k" },
        "search_rerank",
      ),
    ).toThrow(/search_rerank_model is required/);
  });

  test("enabled + missing api key fails closed with EMBEDDING_KEY_MISSING", () => {
    try {
      resolveOpenAiCompatEndpoint(
        { enabled: true, baseUrl: "https://x/v1", model: "m", apiKey: null },
        "search_rerank",
      );
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SearchError);
      expect((e as SearchError).code).toBe("EMBEDDING_KEY_MISSING");
    }
  });

  test("resolves the api key from the named env variable", () => {
    const resolved = resolveOpenAiCompatEndpoint(
      {
        enabled: true,
        baseUrl: "https://x/v1/",
        model: "rerank-1",
        envKey: "MY_RERANK_KEY",
        env: { MY_RERANK_KEY: "secret-value" },
      },
      "search_rerank",
    );
    expect(resolved).not.toBeNull();
    expect(resolved).toEqual({
      baseUrl: "https://x/v1",
      model: "rerank-1",
      apiKey: "secret-value",
    });
  });

  test("a direct api key wins over the env lookup", () => {
    const resolved = resolveOpenAiCompatEndpoint(
      {
        enabled: true,
        baseUrl: "https://x/v1",
        model: "m",
        apiKey: "direct",
        envKey: "MY_RERANK_KEY",
        env: { MY_RERANK_KEY: "from-env" },
      },
      "search_rerank",
    );
    expect(resolved?.apiKey).toBe("direct");
  });
});
