/**
 * The outbound-request ceiling, from the counting primitive up
 * (nothing-runs-unwatched, U4).
 *
 * Four claims, in the order they compose:
 *   1. `Semaphore` never lets more holders in than its ceiling, including
 *      when a fresh acquire lands in the same synchronous turn as a
 *      release.
 *   2. A permit cannot be given back twice, so no caller can widen the
 *      ceiling for every other caller - and `peakInFlight` counts what
 *      actually entered rather than a number the breach itself lowers.
 *   3. The ceiling is taken exactly as configured or refused - never
 *      truncated into a different one.
 *   4. The ceiling spans the PROCESS and is keyed per (identity,
 *      endpoint): two overlapping `embed()` calls against one resolved
 *      provider identity share one budget, and two identities against one
 *      endpoint get one budget EACH - so an endpoint carries
 *      `embedding_concurrency x identities` at most.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";

import { Semaphore } from "../../../src/core/search/embeddings/http-util.ts";
import type { SemaphorePermit } from "../../../src/core/search/embeddings/http-util.ts";
import { OpenAICompatProvider } from "../../../src/core/search/embeddings/openai-compat.ts";
import { _resetProviderCeilingsForTests } from "../../../src/core/search/embeddings/provider-semaphore.ts";
import { ZeroEntropyProvider } from "../../../src/core/search/embeddings/zeroentropy.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import type { ResolvedEmbeddingConfig } from "../../../src/core/search/types.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";

test("Semaphore hands a released permit to the waiter, not to a racing acquirer", async () => {
  const sem = new Semaphore(1);
  let held = 0;
  let peak = 0;
  const enter = (): void => {
    held++;
    if (held > peak) peak = held;
  };
  const leave = (permit: SemaphorePermit): void => {
    held--;
    permit();
  };

  // A holds the only permit.
  const a = await sem.acquire();
  enter();

  // The critical section spans an await, so two holders overlap rather
  // than running to completion one microtask apart.
  const hold = async (permit: SemaphorePermit): Promise<void> => {
    enter();
    await Promise.resolve();
    leave(permit);
  };

  // B queues behind A.
  const b = sem.acquire().then(hold);

  // A releases. The freed permit is B's.
  leave(a);

  // C arrives in the SAME synchronous turn as that release - before B's
  // continuation has had a microtask to run. A semaphore that bumps its
  // permit count on release and lets the woken waiter decrement it later
  // hands this permit to C as well, and both run.
  const c = sem.acquire().then(hold);

  await Promise.all([b, c]);
  expect(peak).toBe(1);
  expect(held).toBe(0);
});

/**
 * Yield one macrotask turn, which drains every pending microtask first -
 * so a waiter that was going to be resumed has been resumed by the time
 * this returns, and one that was not, was not.
 */
async function settlePendingAcquirers(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

test("a permit cannot be given back twice, so no caller can widen the ceiling", async () => {
  const sem = new Semaphore(2);
  const first = await sem.acquire();
  const second = await sem.acquire();

  first();
  expect(() => first()).toThrow(SearchError);
  expect(() => first()).toThrow(/released twice/);

  // Exactly one permit came back, so exactly one of two acquirers enters.
  let entered = 0;
  const third = sem.acquire().then((p) => {
    entered++;
    return p;
  });
  const fourth = sem.acquire().then((p) => {
    entered++;
    return p;
  });
  await settlePendingAcquirers();
  expect(entered).toBe(1);
  expect(sem.peakInFlight).toBe(2);

  second();
  (await third)();
  (await fourth)();
});

test("a stray release cannot smuggle a queued waiter past the ceiling", async () => {
  const sem = new Semaphore(2);
  const a = await sem.acquire();
  const b = await sem.acquire();

  // C queues: both permits are out, so nothing is free for it to take.
  const queued = sem.acquire();
  a();
  const c = await queued;

  // The permit went straight from A to C, so the pool count is still 0
  // and a guard on "permits >= limit" sees nothing wrong here. The stray
  // release has to be refused on the holder's own record instead, or a
  // third permit exists against a ceiling of two.
  expect(() => a()).toThrow(SearchError);

  let entered = false;
  const fourth = sem.acquire().then((p) => {
    entered = true;
    return p;
  });
  await settlePendingAcquirers();
  expect(entered).toBe(false);
  expect(sem.peakInFlight).toBe(2);

  b();
  c();
  (await fourth)();
});

test("peakInFlight counts the holders that entered, not a number a stray release lowers", async () => {
  // The review's reproduction, turned into an assertion. Against the
  // previous Semaphore this printed:
  //   limit: 2 | real concurrent holders: 4 | semaphore reports peakInFlight: 2
  // - the bound broken, and the instrument built to show it reading clean,
  // because the same stray releases drove the held count negative.
  const sem = new Semaphore(2);

  const stray = await sem.acquire();
  stray();
  expect(() => stray()).toThrow(SearchError);
  expect(() => stray()).toThrow(SearchError);

  let live = 0;
  let observedPeak = 0;
  const work = async (): Promise<void> => {
    const permit = await sem.acquire();
    live++;
    if (live > observedPeak) observedPeak = live;
    await new Promise<void>((r) => setTimeout(r, 5));
    live--;
    permit();
  };

  await Promise.all([work(), work(), work(), work()]);

  expect(observedPeak).toBe(2);
  expect(sem.peakInFlight).toBe(observedPeak);
  expect(live).toBe(0);
});

test("Semaphore takes a ceiling above 2^31-1 as given rather than truncating it", () => {
  // `embedding_concurrency` is validated as an integer >= 1 with no upper
  // bound, so this value is reachable from config. The former
  // `Math.max(1, n | 0)` wrapped it negative and the clamp lifted it to 1:
  // the largest ceiling an operator can ask for silently became the
  // smallest one possible.
  const sem = new Semaphore(3_000_000_000);
  expect(sem.limit).toBe(3_000_000_000);
});

test("Semaphore refuses a ceiling it cannot honour", () => {
  expect(() => new Semaphore(0)).toThrow(SearchError);
  expect(() => new Semaphore(-1)).toThrow(SearchError);
  expect(() => new Semaphore(2.5)).toThrow(SearchError);
  expect(() => new Semaphore(Number.NaN)).toThrow(SearchError);
});

/**
 * Milliseconds a stubbed embedding request stays in flight. Long enough
 * that overlapping requests are observable, short enough to keep the
 * suite fast.
 */
const STUB_LATENCY_MS = 25;

interface ConcurrencyProbe {
  /** Most stubbed requests in flight at once, over the server's lifetime. */
  peak: number;
}

/** Fixed-width, non-zero vector so unit-normalisation succeeds. */
const STUB_VECTOR: ReadonlyArray<number> = [1, 2];

/** OpenAI `/v1/embeddings` response body for `n` inputs. */
function openAiBody(inputs: ReadonlyArray<string>, model: string): unknown {
  return {
    model,
    data: inputs.map((_, index) => ({ object: "embedding", embedding: STUB_VECTOR, index })),
  };
}

/** ZeroEntropy `/models/embed` response body for `n` inputs. */
function zeroEntropyBody(inputs: ReadonlyArray<string>): unknown {
  return { results: inputs.map((_, index) => ({ index, embedding: STUB_VECTOR })) };
}

/**
 * Install a handler that holds each request open for {@link STUB_LATENCY_MS}
 * and reports the high-water mark of concurrent in-flight requests. Both
 * provider wire shapes carry their texts in `input`, so one probe serves
 * both; `respond` supplies the shape of the reply.
 */
function probeConcurrency(
  server: FakeHttp,
  respond: (inputs: ReadonlyArray<string>, model: string) => unknown = openAiBody,
): ConcurrencyProbe {
  const probe: ConcurrencyProbe = { peak: 0 };
  let inFlight = 0;
  server.setHandler(async (req) => {
    inFlight++;
    if (inFlight > probe.peak) probe.peak = inFlight;
    await new Promise<void>((r) => setTimeout(r, STUB_LATENCY_MS));
    inFlight--;
    const body = (req.body ?? {}) as { input?: string[]; model?: string };
    const inputs = Array.isArray(body.input) ? body.input : [];
    return { status: 200, body: respond(inputs, body.model ?? "fake-model") };
  });
  return probe;
}

/** One text per request, so the batch count equals the request count. */
function ceilingCfg(
  baseUrl: string,
  overrides: Partial<ResolvedEmbeddingConfig> = {},
): ResolvedEmbeddingConfig {
  return Object.freeze({
    enabled: true,
    provider: "openai-compat",
    baseUrl,
    model: "fake-model",
    apiKey: "test-key",
    dimension: 2,
    timeoutMs: 5_000,
    concurrency: 2,
    batchSize: 1,
    costGateUsd: 0,
    maxRetries: 1,
    ...overrides,
  });
}

const FOUR_TEXTS = ["a", "b", "c", "d"];

describe("the ceiling spans the process", () => {
  let server: FakeHttp;

  beforeEach(async () => {
    _resetProviderCeilingsForTests();
    server = await startFakeHttp();
  });

  afterEach(async () => {
    await server.close();
  });

  test("two overlapping embed() calls on one identity share one budget", async () => {
    const probe = probeConcurrency(server);
    const first = new OpenAICompatProvider(ceilingCfg(server.url));
    const second = new OpenAICompatProvider(ceilingCfg(server.url));

    await Promise.all([first.embed(FOUR_TEXTS), second.embed(FOUR_TEXTS)]);

    // A semaphore built inside embed() would allow 2 per call = 4.
    expect(probe.peak).toBe(2);
    expect(server.callCount()).toBe(FOUR_TEXTS.length * 2);
  });

  test("a ceiling of 1 serialises across two overlapping calls", async () => {
    const probe = probeConcurrency(server);
    const cfg = ceilingCfg(server.url, { concurrency: 1 });
    const first = new OpenAICompatProvider(cfg);
    const second = new OpenAICompatProvider(cfg);

    await Promise.all([first.embed(FOUR_TEXTS), second.embed(FOUR_TEXTS)]);

    expect(probe.peak).toBe(1);
  });

  test("two identities on one endpoint do not share a ceiling", async () => {
    const probe = probeConcurrency(server);
    const first = new OpenAICompatProvider(
      ceilingCfg(server.url, { concurrency: 1, model: "model-a" }),
    );
    const second = new OpenAICompatProvider(
      ceilingCfg(server.url, { concurrency: 1, model: "model-b" }),
    );

    await Promise.all([first.embed(FOUR_TEXTS), second.embed(FOUR_TEXTS)]);

    expect(probe.peak).toBe(2);
  });

  test("an endpoint carries the ceiling ONCE PER IDENTITY, not once in total", async () => {
    // What the ceiling bounds, pinned in the one arrangement that can
    // distinguish the three readings of it. Two identities, two
    // overlapping calls each, ceiling 2:
    //   - 2 would mean the endpoint itself is the budget (it is not: the
    //     key carries the identity, and `embedding_concurrency` is
    //     configured per identity, so there is no per-host number to
    //     enforce);
    //   - 8 would mean the semaphore is per `embed()` call again;
    //   - 4 is the shipped behaviour: one shared budget per identity.
    // The two negative tests below cannot tell these apart on their own -
    // they pin the partition, not the ceiling.
    const probe = probeConcurrency(server);
    const a = ceilingCfg(server.url, { concurrency: 2, model: "model-a" });
    const b = ceilingCfg(server.url, { concurrency: 2, model: "model-b" });

    await Promise.all([
      new OpenAICompatProvider(a).embed(FOUR_TEXTS),
      new OpenAICompatProvider(a).embed(FOUR_TEXTS),
      new OpenAICompatProvider(b).embed(FOUR_TEXTS),
      new OpenAICompatProvider(b).embed(FOUR_TEXTS),
    ]);

    expect(probe.peak).toBe(4);
  });

  test("one identity on two endpoints does not share a ceiling", async () => {
    const other = await startFakeHttp();
    try {
      const probe = probeConcurrency(server);
      const otherProbe = probeConcurrency(other);
      const here = new OpenAICompatProvider(ceilingCfg(server.url, { concurrency: 1 }));
      const there = new OpenAICompatProvider(ceilingCfg(other.url, { concurrency: 1 }));

      await Promise.all([here.embed(FOUR_TEXTS), there.embed(FOUR_TEXTS)]);

      expect(probe.peak).toBe(1);
      expect(otherProbe.peak).toBe(1);
    } finally {
      await other.close();
    }
  });

  test("two configurations that disagree on the ceiling are refused, not reconciled", async () => {
    probeConcurrency(server);
    const first = new OpenAICompatProvider(ceilingCfg(server.url, { concurrency: 2 }));
    const second = new OpenAICompatProvider(ceilingCfg(server.url, { concurrency: 3 }));

    await first.embed(["a"]);
    await expect(second.embed(["b"])).rejects.toThrow(SearchError);
    await expect(second.embed(["b"])).rejects.toThrow(/embedding_concurrency/);
  });

  test("the zeroentropy provider is bounded the same way", async () => {
    const probe = probeConcurrency(server, zeroEntropyBody);
    const cfg = ceilingCfg(server.url, { provider: "zeroentropy", concurrency: 2 });
    const first = new ZeroEntropyProvider(cfg);
    const second = new ZeroEntropyProvider(cfg);

    await Promise.all([first.embed(FOUR_TEXTS), second.embed(FOUR_TEXTS)]);

    expect(probe.peak).toBe(2);
    expect(server.callCount()).toBe(FOUR_TEXTS.length * 2);
  });
});
