/**
 * `scripts/hermes-plugin-scan.ts` - the pinned scanner fetch.
 *
 * The CI gate fetches Hermes' scanner modules from the GitHub contents API.
 * A shared runner can hit that API's rate limit (HTTP 429) or a transient
 * server error; the fetch retries those a bounded number of times with
 * backoff, honours a `Retry-After` header, and otherwise surfaces the last
 * status by name. A stubbed fetch and sleep keep the tests off the network.
 */

import { describe, expect, test } from "bun:test";

import {
  GUARD_FETCH_ATTEMPTS,
  GUARD_FETCH_BASE_DELAY_MS,
  fetchGuardFile,
  type GuardFetchDeps,
} from "../../scripts/hermes-plugin-scan.ts";

const PATH = "tools/skills_guard.py";
const BODY = new TextEncoder().encode("print('guard')\n");

function stubFetch(responses: Array<() => Response>): {
  fetch: GuardFetchDeps["fetch"];
  calls: () => number;
} {
  let calls = 0;
  const fetchImpl = (async () => {
    const next = responses[Math.min(calls, responses.length - 1)]!;
    calls += 1;
    return next();
  }) satisfies GuardFetchDeps["fetch"];
  return { fetch: fetchImpl, calls: () => calls };
}

function recordingSleep(): {
  sleep: (ms: number) => Promise<void>;
  delays: number[];
} {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

const status = (code: number, headers?: Record<string, string>) => () =>
  new Response("rate limited", { status: code, headers });
const ok = () => new Response(BODY, { status: 200 });

describe("fetchGuardFile", () => {
  test("a rate-limited fetch is retried with exponential backoff until it succeeds", async () => {
    const stub = stubFetch([status(429), status(429), ok]);
    const clock = recordingSleep();
    const data = await fetchGuardFile(PATH, {
      fetch: stub.fetch,
      sleep: clock.sleep,
    });
    expect(new TextDecoder().decode(data)).toBe("print('guard')\n");
    expect(stub.calls()).toBe(3);
    expect(clock.delays).toEqual([GUARD_FETCH_BASE_DELAY_MS, GUARD_FETCH_BASE_DELAY_MS * 2]);
  });

  test("a Retry-After header in seconds sets the wait", async () => {
    const stub = stubFetch([status(429, { "Retry-After": "7" }), ok]);
    const clock = recordingSleep();
    await fetchGuardFile(PATH, { fetch: stub.fetch, sleep: clock.sleep });
    expect(clock.delays).toEqual([7000]);
  });

  test("a server error is retried like a rate limit", async () => {
    const stub = stubFetch([status(503), ok]);
    const clock = recordingSleep();
    await fetchGuardFile(PATH, { fetch: stub.fetch, sleep: clock.sleep });
    expect(stub.calls()).toBe(2);
  });

  test("exhausted attempts throw the last status by name", async () => {
    const stub = stubFetch([status(429)]);
    const clock = recordingSleep();
    await expect(fetchGuardFile(PATH, { fetch: stub.fetch, sleep: clock.sleep })).rejects.toThrow(
      new RegExp(`${PATH}@[0-9a-f]{40}: HTTP 429 after ${GUARD_FETCH_ATTEMPTS} attempts`),
    );
    expect(stub.calls()).toBe(GUARD_FETCH_ATTEMPTS);
    expect(clock.delays).toHaveLength(GUARD_FETCH_ATTEMPTS - 1);
  });

  test("a client error other than 429 is not retried", async () => {
    const stub = stubFetch([status(404)]);
    const clock = recordingSleep();
    await expect(fetchGuardFile(PATH, { fetch: stub.fetch, sleep: clock.sleep })).rejects.toThrow(
      /HTTP 404 after 1 attempt/,
    );
    expect(stub.calls()).toBe(1);
    expect(clock.delays).toEqual([]);
  });
});
