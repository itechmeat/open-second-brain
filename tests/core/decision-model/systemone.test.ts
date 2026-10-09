/**
 * `systemone` adapter against a loopback fake `/v1/systemone` server.
 * No test here reaches the network.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  DecisionProviderError,
  type DecisionRequest,
} from "../../../src/core/decision-model/contract.ts";
import {
  MAX_REPLY_BYTES,
  SystemOneDecisionProvider,
} from "../../../src/core/decision-model/systemone.ts";
import { FAKE_DECISION_KEY, FAKE_VENDOR_KEY } from "../../helpers/fake-credentials.ts";
import { REDACTION_PLACEHOLDER } from "../../../src/core/redactor.ts";
import { fakeCredential } from "../../helpers/fake-credentials.ts";
import {
  answerAll,
  startFakeSystemOne,
  type FakeSystemOne,
} from "../../helpers/fake-decision-provider.ts";

let server: FakeSystemOne;
beforeEach(async () => {
  server = await startFakeSystemOne();
});
afterEach(async () => {
  await server.close();
});

function provider(timeoutMs = 2000): SystemOneDecisionProvider {
  return new SystemOneDecisionProvider({
    name: "compatible",
    baseUrl: server.url,
    model: "fake-model-1",
    envKey: "FAKE_DECISION_KEY_VAR",
    apiKey: FAKE_DECISION_KEY,
    calibrated: true,
    timeoutMs,
  });
}

const REQUEST: DecisionRequest = {
  use: "rerank",
  state: { query: "q", passages: { P0: "alpha", P1: "beta" } },
  questions: {
    rel_0: { type: "noul", instructions: "Does `passages.P0` help?" },
    pick: { type: "choice", instructions: "Pick one", criteria: { a: "first", b: null } },
    level: { type: "score", instructions: "How much?", criteria: ["low", "mid", "high"] },
  },
};

async function decideError(timeoutMs = 2000): Promise<DecisionProviderError> {
  try {
    await provider(timeoutMs).decide(REQUEST, { timeoutMs });
  } catch (e) {
    if (e instanceof DecisionProviderError) return e;
    throw e;
  }
  throw new Error("expected decide to throw");
}

describe("systemone adapter", () => {
  test("posts model, state and questions to /v1/systemone with bearer auth", async () => {
    server.setReply(() => ({
      json: {
        model: "fake-model-1.0",
        answers: {
          rel_0: { type: "noul", noul: 0.9 },
          pick: { type: "choice", choice: "a", probabilities: { a: 0.8, b: 0.2 }, confidence: 0.6 },
          level: { type: "score", score: 1.1, probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 } },
        },
        usage: { input_tokens: 42, output_tokens: 3, cost: 0.000002 },
      },
    }));
    const res = await provider().decide(REQUEST, { timeoutMs: 2000 });
    expect(server.requests).toHaveLength(1);
    const sent = server.requests[0]!;
    expect(sent.path).toBe("/v1/systemone");
    expect(sent.headers["authorization"]).toBe(`Bearer ${FAKE_DECISION_KEY}`);
    expect(sent.body["model"]).toBe("fake-model-1");
    expect(sent.body["state"]).toEqual(REQUEST.state);
    expect(Object.keys(sent.body["questions"] as object)).toEqual(["rel_0", "pick", "level"]);
    expect(res.model).toBe("fake-model-1.0");
    expect(res.answers["rel_0"]).toMatchObject({ valid: true, value: 0.9 });
    expect(res.answers["pick"]).toMatchObject({ valid: true, value: "a", confidence: 0.6 });
    // Missing confidence is recomputed: (n * p_max - 1) / (n - 1) = (3*0.7-1)/2.
    expect(res.answers["level"]!.confidence).toBeCloseTo(0.55, 6);
    expect(res.usage).toEqual({ inputTokens: 42, outputTokens: 3, costUsd: 0.000002 });
    expect(res.stateHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the request body scrubs an occurrence of the bearer key itself (wired resolved literal)", async () => {
    server.setReply(() => ({
      json: {
        model: "m",
        answers: {
          rel_0: { type: "noul", noul: 0.9 },
          pick: { type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.8 },
          level: { type: "score", score: 1, probabilities: { "0": 0.5, "1": 0.5, "2": 0 } },
        },
      },
    }));
    // A quiet key the shape passes cannot see, leaked into the vault text
    // the state was built from: the adapter knows the value it is about
    // to send as the Bearer credential, so its egress scan carries that
    // value as a resolved literal.
    const quiet = fakeCredential("quiet-key-", "alpha-bravo");
    const leaked = new SystemOneDecisionProvider({
      name: "compatible",
      baseUrl: server.url,
      model: "fake-model-1",
      envKey: "QUIET_KEY_VAR",
      apiKey: quiet,
      calibrated: true,
      timeoutMs: 2000,
    });
    await leaked.decide(
      { ...REQUEST, state: { query: `echo ${quiet}`, passages: { P0: "alpha" } } },
      { timeoutMs: 2000 },
    );
    const body = JSON.stringify(server.requests[0]!.body);
    expect(body).not.toContain(quiet);
    expect(body).toContain(REDACTION_PLACEHOLDER);
  });

  test("an invalid item is marked invalid without failing the batch", async () => {
    server.setReply(() => ({
      json: {
        model: "m",
        answers: {
          rel_0: { type: "noul", noul: 1.7 },
          // argmax disagrees with the reported choice
          pick: { type: "choice", choice: "b", probabilities: { a: 0.9, b: 0.1 } },
          // unknown level key
          level: { type: "score", score: 1, probabilities: { "0": 0.5, "7": 0.5 } },
        },
      },
    }));
    const res = await provider().decide(REQUEST, { timeoutMs: 2000 });
    expect(res.answers["rel_0"]!.valid).toBe(false);
    expect(res.answers["pick"]!.valid).toBe(false);
    expect(res.answers["level"]!.valid).toBe(false);
  });

  test("probabilities that do not sum to one are invalid", async () => {
    server.setReply(() => ({
      json: {
        answers: {
          rel_0: { type: "noul", noul: 0.2 },
          pick: { type: "choice", choice: "a", probabilities: { a: 0.6, b: 0.6 } },
        },
      },
    }));
    const res = await provider().decide(REQUEST, { timeoutMs: 2000 });
    expect(res.answers["rel_0"]!.valid).toBe(true);
    expect(res.answers["pick"]!.valid).toBe(false);
    expect(res.answers["level"]!.valid).toBe(false);
  });

  test("a reply that is not JSON, or has no answers map, is invalid_reply", async () => {
    server.setReply(() => ({ text: "not json" }));
    expect((await decideError()).reason).toBe("invalid_reply");
    server.setReply(() => ({ json: { model: "m" } }));
    expect((await decideError()).reason).toBe("invalid_reply");
  });

  for (const status of [401, 402, 422]) {
    test(`HTTP ${status} is http_${status}, not retried, and never echoes the body or key`, async () => {
      server.setReply(() => ({ status, json: { error: `body mentions ${FAKE_DECISION_KEY}` } }));
      const err = await decideError();
      expect(err.reason).toBe(`http_${status}`);
      expect(server.requests).toHaveLength(1);
      expect(err.message).not.toContain(FAKE_DECISION_KEY);
      expect(err.message).not.toContain("body mentions");
      if (status === 401) expect(err.message).toContain("FAKE_DECISION_KEY_VAR");
    });
  }

  test("429 with retry-after is retried once and then succeeds", async () => {
    server.setReply((req, i) =>
      i === 0
        ? { status: 429, headers: { "retry-after": "0" } }
        : { json: answerAll(req, () => 0.7) },
    );
    const res = await provider().decide(REQUEST, { timeoutMs: 2000 });
    expect(server.requests).toHaveLength(2);
    expect(res.answers["rel_0"]).toMatchObject({ valid: true, value: 0.7 });
  });

  test("a retry-after beyond the remaining timeout is not waited for", async () => {
    server.setReply(() => ({ status: 429, headers: { "retry-after": "30" } }));
    const started = Date.now();
    const err = await decideError(1000);
    // The structural witnesses carry the pin: honoring the 30s retry-after
    // would blow the 1000ms decide deadline first, so the refusal would
    // surface as a timeout, not as this named 429, and no second request
    // would exist either way. The elapsed bound below therefore only has to
    // separate "did not sleep for the retry-after" (>=30s) from a slow
    // machine, so it sits an order of magnitude under the wait it refuses
    // to wait instead of at the decide deadline, where scheduler jitter
    // alone could flake it.
    expect(err.reason).toBe("http_429");
    expect(server.requests).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("529 twice is retried at most once", async () => {
    server.setReply(() => ({ status: 529 }));
    const err = await decideError();
    expect(err.reason).toBe("http_529");
    expect(server.requests).toHaveLength(2);
  });

  for (const status of [501, 507, 599]) {
    test(`HTTP ${status} (any 5xx) is retried once`, async () => {
      server.setReply((req, i) => (i === 0 ? { status } : { json: answerAll(req, () => 0.6) }));
      const res = await provider().decide(REQUEST, { timeoutMs: 2000 });
      expect(server.requests).toHaveLength(2);
      expect(res.answers["rel_0"]).toMatchObject({ valid: true, value: 0.6 });
    });
  }

  test("a wait before the retry that is cut short reports timeout, not the status", async () => {
    server.setReply(() => ({ status: 503, headers: { "retry-after": "1" } }));
    const outer = new AbortController();
    setTimeout(() => outer.abort(), 100);
    let err: unknown;
    try {
      await provider(3000).decide(REQUEST, { timeoutMs: 3000, signal: outer.signal });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DecisionProviderError);
    expect((err as DecisionProviderError).reason).toBe("timeout");
    expect(server.requests).toHaveLength(1);
  });

  test("a reply larger than the cap is invalid_reply", async () => {
    // A valid reply in every other respect: only its size is wrong.
    server.setReply((req) => ({
      json: { ...answerAll(req, () => 0.5), pad: "x".repeat(MAX_REPLY_BYTES) },
    }));
    const err = await decideError();
    expect(err.reason).toBe("invalid_reply");
    expect(err.message).toContain("larger than");
  });

  test("a hanging response times out", async () => {
    server.setReply(() => ({ hang: true }));
    const err = await decideError(300);
    expect(err.reason).toBe("timeout");
  });

  test("a redirect is refused, never followed", async () => {
    server.setReply(() => ({ status: 302, headers: { location: "http://127.0.0.1:9/elsewhere" } }));
    const err = await decideError();
    expect(err.reason).toBe("network");
    expect(server.requests).toHaveLength(1);
  });

  test("a reset connection is not retried", async () => {
    server.setReply(() => ({ reset: true }));
    const err = await decideError();
    expect(err.reason).toBe("network");
    expect(server.connections()).toBe(1);
  });

  test("secret-shaped strings in the state are redacted before sending", async () => {
    server.setReply((req) => ({ json: answerAll(req, () => 0.5) }));
    await provider().decide(
      {
        use: "rerank",
        state: { query: "q", passages: { P0: `deploy with key ${FAKE_VENDOR_KEY} today` } },
        questions: { rel_0: { type: "noul", instructions: "?" } },
      },
      { timeoutMs: 2000 },
    );
    expect(server.requests[0]!.bodyText).not.toContain(FAKE_VENDOR_KEY);
  });

  test("client-side limits refuse an oversized choice before sending", async () => {
    const criteria: Record<string, null> = {};
    for (let i = 0; i < 256; i++) criteria[`o${i}`] = null;
    let caught: unknown;
    try {
      await provider().decide(
        {
          use: "rerank",
          state: "s",
          questions: { big: { type: "choice", instructions: "?", criteria } },
        },
        { timeoutMs: 2000 },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DecisionProviderError);
    expect((caught as DecisionProviderError).reason).toBe("budget");
    expect(server.requests).toHaveLength(0);
  });

  test("ping sends a synthetic state and reports the answering model", async () => {
    server.setReply((req) => ({ json: answerAll(req, () => 0.99, "fake-model-1.0") }));
    const pong = await provider().ping();
    expect(pong).toMatchObject({ ok: true, model: "fake-model-1.0" });
    expect(JSON.stringify(server.requests[0]!.body["state"])).toContain("connectivity check");
  });
});
