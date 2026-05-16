/**
 * Tiny Bun-native HTTP server stub for embedding-provider tests.
 *
 * Each test can install a handler that decides what to return for any
 * incoming request. The default handler returns OpenAI-shaped vectors
 * deterministically derived from the input texts (no randomness — so
 * `toBeCloseTo` checks stay stable).
 */


export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface FakeResponseSpec {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  delayMs?: number;
}

type Handler = (req: FakeRequest, callIndex: number) => FakeResponseSpec | Promise<FakeResponseSpec>;

export interface FakeHttp {
  url: string;
  close: () => Promise<void>;
  setHandler: (h: Handler) => void;
  /** Number of requests received since creation. */
  callCount: () => number;
}

function defaultHandler(req: FakeRequest): FakeResponseSpec {
  if (req.path.endsWith("/embeddings") && req.method === "POST") {
    const body = (req.body ?? {}) as { input?: string[]; model?: string };
    const inputs = Array.isArray(body.input) ? body.input : [];
    const data = inputs.map((text, index) => {
      // Deterministic 4-dim vector from token count + position.
      const tokens = text.split(/\s+/).filter(Boolean).length;
      const v = [tokens, index, text.length, 1];
      return { object: "embedding", embedding: v, index };
    });
    return { status: 200, body: { data, model: body.model ?? "fake-model" } };
  }
  return { status: 404, body: { error: "not_found" } };
}

export async function startFakeHttp(): Promise<FakeHttp> {
  let handler: Handler = defaultHandler;
  let count = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      let body: unknown = null;
      const ctype = req.headers.get("content-type") ?? "";
      if (ctype.startsWith("application/json")) {
        try {
          body = await req.json();
        } catch {
          body = null;
        }
      }
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      const idx = count++;
      const resp = await handler({ method: req.method, path: url.pathname, headers, body }, idx);
      if (resp.delayMs && resp.delayMs > 0) {
        await new Promise<void>((r) => setTimeout(r, resp.delayMs));
      }
      return new Response(
        resp.body === undefined ? "" : JSON.stringify(resp.body),
        {
          status: resp.status ?? 200,
          headers: { "content-type": "application/json", ...(resp.headers ?? {}) },
        },
      );
    },
  });

  const url = `http://127.0.0.1:${server.port}/v1`;
  return {
    url,
    close: () => server.stop(true) as unknown as Promise<void>,
    setHandler: (h: Handler) => {
      handler = h;
    },
    callCount: () => count,
  };
}
