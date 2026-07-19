/**
 * Seam 2 of the knowledge-intake-and-consolidation wave (R1, t_1dcbf352):
 * the keyed external-fetch helper. Env-gated HTTP, Bearer auth by default,
 * typed errors, and a shared response cache keyed by the normalized request.
 * Keys never appear in cache keys, error messages, or redacted logs. Every
 * test mocks at the transport boundary; no test path reaches the network.
 */

import { describe, expect, test } from "bun:test";

import {
  ExternalFetchError,
  createMemoryResponseCache,
  keyedFetch,
  normalizeRequestKey,
  type ExternalFetchResponse,
  type ExternalFetchTransport,
} from "../../../../src/core/brain/research/external-fetch.ts";

const API_KEY = "sk-secret-abc123def456ghi789";

function jsonResponse(status: number, payload: unknown): ExternalFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function recordingTransport(res: ExternalFetchResponse): {
  transport: ExternalFetchTransport;
  calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
  }>;
} {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
  }> = [];
  const transport: ExternalFetchTransport = async (input) => {
    calls.push({
      url: input.url,
      method: input.method,
      headers: { ...input.headers },
      body: input.body,
    });
    return res;
  };
  return { transport, calls };
}

const throwingTransport: ExternalFetchTransport = async () => {
  throw new Error("socket hang up");
};

describe("keyedFetch env gate", () => {
  test("a null key is a typed disabled error and never calls the transport", async () => {
    const { transport, calls } = recordingTransport(jsonResponse(200, {}));
    await expect(
      keyedFetch({ apiKey: null, transport }, { url: "https://api.example.com/x" }),
    ).rejects.toBeInstanceOf(ExternalFetchError);
    expect(calls.length).toBe(0);
    try {
      await keyedFetch({ apiKey: null, transport }, { url: "https://api.example.com/x" });
    } catch (err) {
      expect((err as ExternalFetchError).kind).toBe("disabled");
    }
  });
});

describe("keyedFetch auth", () => {
  test("Bearer is the default scheme", async () => {
    const { transport, calls } = recordingTransport(jsonResponse(200, { ok: true }));
    await keyedFetch({ apiKey: API_KEY, transport }, { url: "https://api.example.com/x" });
    expect(calls[0]!.headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
  });

  test("a custom header scheme carries the key in the named header", async () => {
    const { transport, calls } = recordingTransport(jsonResponse(200, { ok: true }));
    await keyedFetch(
      { apiKey: API_KEY, transport },
      {
        url: "https://api.example.com/x",
        auth: { scheme: "header", header: "X-Subscription-Token" },
      },
    );
    expect(calls[0]!.headers["X-Subscription-Token"]).toBe(API_KEY);
    expect(calls[0]!.headers["Authorization"]).toBeUndefined();
  });
});

describe("keyedFetch typed errors", () => {
  test("HTTP 401 surfaces as an auth error", async () => {
    const { transport } = recordingTransport(jsonResponse(401, {}));
    try {
      await keyedFetch({ apiKey: API_KEY, transport }, { url: "https://api.example.com/x" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExternalFetchError);
      expect((err as ExternalFetchError).kind).toBe("auth");
      expect((err as ExternalFetchError).status).toBe(401);
    }
  });

  test("a non-2xx non-auth status surfaces as an http error", async () => {
    const { transport } = recordingTransport(jsonResponse(503, {}));
    try {
      await keyedFetch({ apiKey: API_KEY, transport }, { url: "https://api.example.com/x" });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalFetchError).kind).toBe("http");
      expect((err as ExternalFetchError).status).toBe(503);
    }
  });

  test("a transport throw surfaces as a network error", async () => {
    try {
      await keyedFetch(
        { apiKey: API_KEY, transport: throwingTransport },
        { url: "https://api.example.com/x" },
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalFetchError).kind).toBe("network");
    }
  });

  test("an unparseable payload surfaces as a payload error", async () => {
    const bad: ExternalFetchResponse = {
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("unexpected end of JSON input");
      },
      text: async () => "",
    };
    const transport: ExternalFetchTransport = async () => bad;
    try {
      await keyedFetch({ apiKey: API_KEY, transport }, { url: "https://api.example.com/x" });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalFetchError).kind).toBe("payload");
    }
  });
});

describe("keyedFetch cache", () => {
  test("a cache hit returns the stored value without a second transport call", async () => {
    const { transport, calls } = recordingTransport(jsonResponse(200, { hit: 1 }));
    const cache = createMemoryResponseCache();
    const req = { url: "https://api.example.com/x", query: { q: "restaking" } };
    const first = await keyedFetch({ apiKey: API_KEY, transport, cache }, req);
    const second = await keyedFetch({ apiKey: API_KEY, transport, cache }, req);
    expect(first).toEqual(second);
    expect(calls.length).toBe(1);
  });

  test("the normalized cache key is order-independent for query fields", () => {
    const a = normalizeRequestKey({ url: "https://x/y", query: { b: "2", a: "1" } });
    const b = normalizeRequestKey({ url: "https://x/y", query: { a: "1", b: "2" } });
    expect(a).toBe(b);
  });
});

describe("keyedFetch key hygiene (redactor)", () => {
  test("the API key never appears in the cache key", () => {
    const key = normalizeRequestKey({
      url: "https://api.example.com/x",
      query: { q: "z" },
      auth: { scheme: "bearer" },
    });
    expect(key).not.toContain(API_KEY);
  });

  test("the API key never appears in a network error message", async () => {
    const transport: ExternalFetchTransport = async () => {
      throw new Error(`connect failed to host carrying ${API_KEY}`);
    };
    try {
      await keyedFetch({ apiKey: API_KEY, transport }, { url: "https://api.example.com/x" });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalFetchError).message).not.toContain(API_KEY);
    }
  });
});
