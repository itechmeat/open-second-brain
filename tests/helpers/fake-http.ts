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

type Handler = (
  req: FakeRequest,
  callIndex: number,
) => FakeResponseSpec | Promise<FakeResponseSpec>;

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

/**
 * Distinguishes one fake server from every other one this process starts.
 *
 * The port cannot do it. It is ephemeral, the operating system hands the
 * same number back once a server closes, and a process-scoped registry
 * keyed by endpoint URL then reads two unrelated test files as one
 * endpoint - the embedding concurrency ceiling
 * (`embeddings/provider-semaphore.ts`) is exactly that, and refuses by
 * design when two configurations disagree about the limit for one
 * endpoint. So a file embedding at concurrency 2 failed inside another
 * file's ceiling of 1, at whatever rate the port came back around: green
 * on nineteen runs and red on the twentieth, in a file that had nothing
 * to do with the one that set the limit.
 *
 * A path segment costs nothing and makes each server what it already is -
 * a distinct endpoint. Providers append their own suffix to this base
 * (`/embeddings`, `/models/embed`), so handlers that match on the tail of
 * the path are unaffected.
 */
let instances = 0;

/** Status a throwing handler answers with. */
const HANDLER_ERROR_STATUS = 500;

export async function startFakeHttp(): Promise<FakeHttp> {
  let handler: Handler = defaultHandler;
  let count = 0;
  // Bun 1.4.0's Server.stop(true) waits for in-flight fetch handlers to
  // return, and a stalled-lane test holds one until its (never) answer, so
  // teardown under the CI toolchain waited out the stall and the hook
  // timeout fired first. The closer therefore settles every in-flight
  // handler with a synthetic response before stopping, which costs nothing
  // on the newer Bun and keeps "never answers" a legitimate handler shape.
  const pending = new Set<(response: FakeResponseSpec) => void>();
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
      const resp = await new Promise<FakeResponseSpec>((resolve) => {
        const settle = (value: FakeResponseSpec) => {
          pending.delete(settle);
          resolve(value);
        };
        pending.add(settle);
        // A handler that throws (or rejects) answers 500 with its message,
        // so the test fails on the real error instead of timing out.
        Promise.resolve()
          .then(() => handler({ method: req.method, path: url.pathname, headers, body }, idx))
          .then(settle, (err: unknown) =>
            settle({
              status: HANDLER_ERROR_STATUS,
              body: { error: err instanceof Error ? err.message : String(err) },
            }),
          );
      });
      if (resp.delayMs && resp.delayMs > 0) {
        await new Promise<void>((r) => setTimeout(r, resp.delayMs));
      }
      return new Response(resp.body === undefined ? "" : JSON.stringify(resp.body), {
        status: resp.status ?? 200,
        headers: { "content-type": "application/json", ...resp.headers },
      });
    },
  });

  const url = `http://127.0.0.1:${server.port}/i${++instances}/v1`;
  return {
    url,
    close: () => {
      for (const settle of pending) settle({ status: 503, body: { error: "server-closing" } });
      server.stop(true);
      return Promise.resolve();
    },
    setHandler: (h: Handler) => {
      handler = h;
    },
    callCount: () => count,
  };
}
