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
  createFetchTransport,
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

describe("keyedFetch url gate (t_sec_keyedfetch_url)", () => {
  test("a non-https, non-loopback URL is refused before the key is attached", async () => {
    const { transport, calls } = recordingTransport(jsonResponse(200, {}));
    // The whole point of the ordering: the refusal carries no auth
    // headers because the transport is never reached.
    try {
      await keyedFetch({ apiKey: API_KEY, transport }, { url: "http://internal.example/x" });
      throw new Error("expected the plain-http URL to be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(ExternalFetchError);
      expect((err as ExternalFetchError).kind).toBe("refused");
    }
    expect(calls).toEqual([]);
  });

  test("a value that is not a URL is refused the same way", async () => {
    const { transport, calls } = recordingTransport(jsonResponse(200, {}));
    await expect(
      keyedFetch({ apiKey: API_KEY, transport }, { url: "not a url at all" }),
    ).rejects.toMatchObject({ kind: "refused" });
    expect(calls).toEqual([]);
  });

  test("https URLs pass to the transport unchanged", async () => {
    const { transport, calls } = recordingTransport(jsonResponse(200, { ok: true }));
    await keyedFetch({ apiKey: API_KEY, transport }, { url: "https://api.example.com/x" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.example.com/x");
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

  test("the body is keyed by the shared canonical encoding, sorted and undefined-free", () => {
    // This module used to carry its own sorted-key stringifier. The shared
    // one differs in exactly one place - an object entry whose value is
    // `undefined` is omitted rather than rendered as null - and omitting it
    // is what the body actually sent does, so two requests that go out as
    // identical bytes now share one cache entry instead of two.
    const withUndefined = normalizeRequestKey({
      url: "https://x/y",
      method: "POST",
      body: { b: 2, a: 1, absent: undefined },
    });
    const without = normalizeRequestKey({
      url: "https://x/y",
      method: "POST",
      body: { a: 1, b: 2 },
    });
    expect(withUndefined).toBe(without);
    expect(withUndefined).toContain('{"a":1,"b":2}');
  });

  test("the accept type is part of the cache key so json and text never collide", () => {
    const base = { url: "https://x/y", query: { q: "z" } } as const;
    const asJson = normalizeRequestKey({ ...base, accept: "json" });
    const asText = normalizeRequestKey({ ...base, accept: "text" });
    const asDefault = normalizeRequestKey(base);
    expect(asJson).not.toBe(asText);
    // The default accept is json, so an unspecified accept matches accept: json.
    expect(asDefault).toBe(asJson);
  });

  test("a shared cache never serves a json value where text was expected", async () => {
    const { transport, calls } = recordingTransport(jsonResponse(200, { shape: "json" }));
    const cache = createMemoryResponseCache();
    const base = { url: "https://api.example.com/x", query: { q: "z" } } as const;
    const asJson = await keyedFetch({ apiKey: API_KEY, transport, cache }, { ...base });
    // A text request for the same url/query must NOT reuse the cached json value;
    // it makes its own transport call because the accept type differs.
    const asText = await keyedFetch(
      { apiKey: API_KEY, transport, cache },
      { ...base, accept: "text" },
    );
    expect(asJson).toEqual({ shape: "json" });
    expect(asText).toBe(JSON.stringify({ shape: "json" }));
    expect(calls.length).toBe(2);
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

/**
 * A keyed request never goes to a private address (audit L2).
 *
 * The https-only rule admits `https://169.254.169.254/` and the LAN, and
 * `extractPage` fetches a URL harvested from content, so an IP literal in a
 * private, link-local or CGNAT range is refused before the key is attached.
 */
describe("keyedFetch private-address guard", () => {
  test.each([
    ["https://169.254.169.254/latest/meta-data/"],
    ["https://10.0.0.5/x"],
    ["https://172.20.1.1/x"],
    ["https://192.168.1.10/x"],
    ["https://100.64.0.5/x"],
    ["https://0.0.0.0/x"],
    ["https://[fe80::1]/x"],
    ["https://[fd12:3456::1]/x"],
    ["https://[::ffff:10.0.0.1]/x"],
  ])("refuses %s without calling the transport", async (url) => {
    const { transport, calls } = recordingTransport(jsonResponse(200, {}));
    const err = await keyedFetch({ apiKey: API_KEY, transport }, { url }).catch((e) => e);
    expect(err).toBeInstanceOf(ExternalFetchError);
    expect((err as ExternalFetchError).kind).toBe("refused");
    expect(calls).toHaveLength(0);
  });

  test("a public name and a public address still go through", async () => {
    const { transport, calls } = recordingTransport(jsonResponse(200, { ok: 1 }));
    await keyedFetch({ apiKey: API_KEY, transport }, { url: "https://api.example.com/x" });
    await keyedFetch({ apiKey: API_KEY, transport }, { url: "https://93.184.216.34/x" });
    expect(calls).toHaveLength(2);
  });
});

describe("createFetchTransport", () => {
  test("does not follow a redirect with the key on it", async () => {
    let stolen = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        if (new URL(req.url).pathname === "/stolen") {
          stolen += 1;
          return new Response("{}");
        }
        return new Response(null, { status: 307, headers: { location: "/stolen" } });
      },
    });
    try {
      const err = await keyedFetch(
        { apiKey: API_KEY, transport: createFetchTransport() },
        { url: `http://127.0.0.1:${server.port}/api` },
      ).catch((e) => e);
      expect(err).toBeInstanceOf(ExternalFetchError);
      expect((err as ExternalFetchError).kind).toBe("network");
      expect(stolen).toBe(0);
    } finally {
      await server.stop(true);
    }
  });
});
