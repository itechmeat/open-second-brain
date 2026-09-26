/**
 * Provider endpoint egress validation (t_sec_endpoint_https).
 *
 * Every indexed chunk body and the `authorization: Bearer` header travel
 * to the configured provider endpoint, and the registry file that
 * carries `baseUrl` lives inside the vault - so the scheme rule is a
 * boundary, not a lint. `https` everywhere; plain `http` only for
 * loopback hosts, where the hop never leaves the machine.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertHttpEgressEndpoint } from "../../../../src/core/search/embeddings/http-util.ts";
import { OpenAICompatProvider } from "../../../../src/core/search/embeddings/openai-compat.ts";
import { resolveOpenAiCompatEndpoint } from "../../../../src/core/search/embeddings/provider-resolve.ts";
import { addProviderProfile } from "../../../../src/core/search/embeddings/registry.ts";
import { resolveSearchConfig } from "../../../../src/core/search/index.ts";
import { CrossEncoderRerankProvider } from "../../../../src/core/search/rerank/cross-encoder.ts";
import { SearchError } from "../../../../src/core/search/types.ts";

/**
 * The operator's per-endpoint plain-http opt-out.
 *
 * A local embedding server on a LAN or tailnet address has no
 * certificate, so `embedding_allow_insecure_http` /
 * `search_rerank_allow_insecure_http` in the operator's config lets that
 * one endpoint be plain http. It is off by default, it warns, and it binds
 * to the URL the operator wrote in config or env: a URL the in-vault
 * provider registry supplies never inherits it.
 */
describe("the plain-http opt-out, end to end through config resolution", () => {
  const LAN = "http://100.64.0.5:1234/v1";
  const ENV_KEYS = [
    "OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER",
    "OPEN_SECOND_BRAIN_EMBEDDING_BASE_URL",
    "OPEN_SECOND_BRAIN_EMBEDDING_MODEL",
    "OPEN_SECOND_BRAIN_EMBEDDING_KEY",
    "OPEN_SECOND_BRAIN_EMBEDDING_ALLOW_INSECURE_HTTP",
    "OPEN_SECOND_BRAIN_SEARCH_RERANK_BASE_URL",
    "OPEN_SECOND_BRAIN_SEARCH_RERANK_MODEL",
    "OPEN_SECOND_BRAIN_SEARCH_RERANK_ENV_KEY",
    "OPEN_SECOND_BRAIN_SEARCH_RERANK_ALLOW_INSECURE_HTTP",
    "O2B_TEST_LAN_KEY",
  ];
  let tmp: string;
  let configPath: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "o2b-insecure-http-"));
    configPath = join(tmp, "config.yaml");
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env["O2B_TEST_LAN_KEY"] = "lan-key";
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  function config(lines: ReadonlyArray<string>) {
    writeFileSync(configPath, [`vault: "${tmp}"`, ...lines].join("\n") + "\n");
    return resolveSearchConfig({ vault: tmp, configPath });
  }

  const EMBEDDING = ["embedding_base_url: " + LAN, "embedding_model: m", "embedding_api_key: k"];

  test("without the opt-out a LAN http endpoint is refused, and the refusal names the switch", () => {
    const cfg = config(EMBEDDING);
    expect(() => new OpenAICompatProvider(cfg.semantic)).toThrow(/embedding_allow_insecure_http/);
  });

  test("with the opt-out the same endpoint is accepted and warned about once", () => {
    const cfg = config([...EMBEDDING, "embedding_allow_insecure_http: true"]);
    const writes: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      expect(() => new OpenAICompatProvider(cfg.semantic)).not.toThrow();
      expect(() => new OpenAICompatProvider(cfg.semantic)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    const warnings = writes.filter((w) => w.includes(LAN));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("unencrypted");
  });

  test("a registry-supplied http URL does not inherit an opt-out granted in config", () => {
    addProviderProfile(tmp, {
      name: "lan-box",
      baseUrl: LAN,
      defaultModel: "m",
      envKey: "O2B_TEST_LAN_KEY",
    });
    const cfg = config(["embedding_provider: lan-box", "embedding_allow_insecure_http: true"]);
    expect(cfg.semantic.baseUrl).toBe(LAN);
    expect(() => new OpenAICompatProvider(cfg.semantic)).toThrow(SearchError);
  });

  test("the rerank endpoint has its own opt-out", () => {
    const rerank = [
      "search_rerank_enabled: true",
      "search_rerank_base_url: " + LAN,
      "search_rerank_model: r",
      "search_rerank_env_key: O2B_TEST_LAN_KEY",
    ];
    const endpointOf = (cfg: ReturnType<typeof config>) =>
      resolveOpenAiCompatEndpoint(
        {
          enabled: true,
          baseUrl: cfg.rerank.baseUrl,
          model: cfg.rerank.model,
          envKey: cfg.rerank.envKey,
          ...(cfg.rerank.allowInsecureHttp === true ? { allowInsecureHttp: true } : {}),
        },
        "search_rerank",
      )!;
    expect(() => new CrossEncoderRerankProvider(endpointOf(config(rerank)))).toThrow(
      /search_rerank_allow_insecure_http/,
    );
    // The embedding opt-out does not reach the reranker.
    expect(
      () =>
        new CrossEncoderRerankProvider(
          endpointOf(config([...rerank, "embedding_allow_insecure_http: true"])),
        ),
    ).toThrow(SearchError);
    const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(
        () =>
          new CrossEncoderRerankProvider(
            endpointOf(config([...rerank, "search_rerank_allow_insecure_http: true"])),
          ),
      ).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("assertHttpEgressEndpoint", () => {
  test("https endpoints of any host pass through unchanged", () => {
    expect(assertHttpEgressEndpoint("https://api.openai.com/v1", "embedding_base_url")).toBe(
      "https://api.openai.com/v1",
    );
  });

  test("plain http passes for loopback hosts only", () => {
    expect(assertHttpEgressEndpoint("http://127.0.0.1:8080/v1", "embedding_base_url")).toBe(
      "http://127.0.0.1:8080/v1",
    );
    expect(assertHttpEgressEndpoint("http://localhost:11434/v1", "embedding_base_url")).toBe(
      "http://localhost:11434/v1",
    );
    expect(assertHttpEgressEndpoint("http://[::1]:9000/v1", "embedding_base_url")).toBe(
      "http://[::1]:9000/v1",
    );
  });

  test("plain http to any other host is refused, naming the config key", () => {
    for (const url of [
      "http://api.openai.com/v1",
      "http://internal-server.local:9999/v1",
      "http://192.168.1.10:8080/v1",
    ]) {
      try {
        assertHttpEgressEndpoint(url, "embedding_base_url");
        throw new Error(`expected ${url} to be refused`);
      } catch (err) {
        expect(err).toBeInstanceOf(SearchError);
        expect((err as SearchError).code).toBe("INVALID_INPUT");
        expect((err as SearchError).message).toContain("embedding_base_url");
        expect((err as SearchError).message).toContain("https");
      }
    }
  });

  test("a value that is not a URL at all is refused as one", () => {
    try {
      assertHttpEgressEndpoint("not a url", "search_rerank_base_url");
      throw new Error("expected the garbage value to be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(SearchError);
      expect((err as SearchError).message).toContain("not a URL");
    }
  });
});
