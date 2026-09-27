/**
 * One contract suite, run against every decision-model adapter
 * (`systemone`, `vercel-evaluate`, `llm-emulation`) through the loopback
 * fake server (issue #213, Part 7).
 *
 * Each fixture is written once in adapter-neutral terms and encoded into
 * each route's own reply format, so the same judgment must come out of
 * every adapter: success, a missing confidence, invalid probabilities,
 * unknown keys, a missing answer, HTTP errors, retries, a malformed body,
 * a reset connection and a timeout. No test here reaches the network.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  DecisionProviderError,
  type DecisionProvider,
  type DecisionRequest,
} from "../../../src/core/decision-model/contract.ts";
import type { DecisionModelAdapter } from "../../../src/core/decision-model/presets.ts";
import { makeDecisionProvider } from "../../../src/core/decision-model/provider.ts";
import { FAKE_DECISION_KEY, fakeCredential } from "../../helpers/fake-credentials.ts";
import {
  activeDecisionConfig,
  startFakeSystemOne,
  type FakeSystemOne,
} from "../../helpers/fake-decision-provider.ts";

const KEY_VAR = "O2B_TEST_DECISION_CONTRACT_KEY";
const ENV = { [KEY_VAR]: FAKE_DECISION_KEY };

/** A string an error body carries; it must never surface in a message. */
const BODY_CANARY = fakeCredential("canary-", "error-body-", "5d1f");

const REQUEST: DecisionRequest = {
  use: "rerank",
  state: { query: "q", passages: { P0: "alpha", P1: "beta" } },
  questions: {
    yes: { type: "noul", instructions: "Does `passages.P0` help?" },
    pick: { type: "choice", instructions: "Pick one", criteria: { a: "first", b: null } },
    level: { type: "score", instructions: "How much?", criteria: ["low", "mid", "high"] },
  },
};

// ----- adapter-neutral fixtures -------------------------------------------------

/** One answer as a decision model means it, before any route renames it. */
type Neutral =
  | { readonly kind: "noul"; readonly p: unknown }
  | {
      readonly kind: "choice" | "score";
      readonly probabilities: unknown;
      readonly pick?: string;
      readonly score?: number;
      readonly confidence?: number;
    };

interface Expected {
  readonly valid: boolean;
  readonly value?: number | string;
  readonly confidence?: number;
}

interface AnswerFixture {
  readonly name: string;
  readonly answers: Readonly<Record<string, Neutral>>;
  readonly expect: Readonly<Record<keyof typeof REQUEST.questions & string, Expected>>;
}

const SUCCESS: Readonly<Record<string, Neutral>> = {
  yes: { kind: "noul", p: 0.9 },
  // Chosen so the reported confidence equals the recomputed one: every
  // adapter must then agree, whether it trusts or recomputes it.
  pick: { kind: "choice", pick: "a", probabilities: { a: 0.8, b: 0.2 }, confidence: 0.6 },
  level: {
    kind: "score",
    score: 1.1,
    probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 },
    confidence: 0.55,
  },
};

const ANSWER_FIXTURES: ReadonlyArray<AnswerFixture> = [
  {
    name: "success",
    answers: SUCCESS,
    expect: {
      yes: { valid: true, value: 0.9 },
      pick: { valid: true, value: "a", confidence: 0.6 },
      level: { valid: true, value: 1.1, confidence: 0.55 },
    },
  },
  {
    name: "missing confidence is recomputed",
    answers: {
      ...SUCCESS,
      pick: { kind: "choice", pick: "a", probabilities: { a: 0.8, b: 0.2 } },
      level: { kind: "score", score: 1.1, probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 } },
    },
    expect: {
      yes: { valid: true, value: 0.9 },
      // (n * p_max - 1) / (n - 1)
      pick: { valid: true, value: "a", confidence: 0.6 },
      level: { valid: true, value: 1.1, confidence: 0.55 },
    },
  },
  {
    name: "invalid probabilities make only their item invalid",
    answers: {
      yes: { kind: "noul", p: "high" },
      pick: { kind: "choice", pick: "a", probabilities: { a: "0.8", b: 0.2 } },
      level: SUCCESS["level"]!,
    },
    expect: {
      yes: { valid: false },
      pick: { valid: false },
      level: { valid: true, value: 1.1, confidence: 0.55 },
    },
  },
  {
    name: "an unknown option or level key makes the item invalid",
    answers: {
      yes: SUCCESS["yes"]!,
      pick: { kind: "choice", pick: "a", probabilities: { a: 0.5, zzz: 0.5 } },
      level: { kind: "score", score: 1, probabilities: { "0": 0.5, "7": 0.5 } },
    },
    expect: {
      yes: { valid: true, value: 0.9 },
      pick: { valid: false },
      level: { valid: false },
    },
  },
  {
    name: "a missing answer is invalid, an extra one ignored",
    answers: { yes: SUCCESS["yes"]!, level: SUCCESS["level"]!, surplus: SUCCESS["yes"]! },
    expect: {
      yes: { valid: true, value: 0.9 },
      pick: { valid: false },
      level: { valid: true, value: 1.1, confidence: 0.55 },
    },
  },
];

// ----- per-route encoders ------------------------------------------------------------

interface Route {
  readonly adapter: DecisionModelAdapter;
  readonly path: string;
  readonly calibrated: boolean;
  /** The route's success reply for these neutral answers. */
  encode(answers: Readonly<Record<string, Neutral>>): unknown;
  /** The route's own error body shape, carrying the canary. */
  readonly errorBody: unknown;
  /** Extra requests a 422 causes (the emulation retries without response_format). */
  readonly requestsOn422: number;
}

function systemoneItem(a: Neutral): Record<string, unknown> {
  if (a.kind === "noul") return { type: "noul", noul: a.p };
  return {
    type: a.kind,
    ...(a.kind === "choice" ? { choice: a.pick } : { score: a.score }),
    probabilities: a.probabilities,
    ...(a.confidence !== undefined ? { confidence: a.confidence } : {}),
  };
}

const ROUTES: ReadonlyArray<Route> = [
  {
    adapter: "systemone",
    path: "/v1/systemone",
    calibrated: true,
    encode: (answers) => ({
      model: "fake-model-1.0",
      answers: Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, systemoneItem(a)])),
      usage: { input_tokens: 40, output_tokens: 3 },
    }),
    errorBody: { error: BODY_CANARY },
    requestsOn422: 1,
  },
  {
    adapter: "vercel-evaluate",
    path: "/v1/evaluate",
    calibrated: true,
    encode: (answers) => ({
      model: "typesafe-ai/jev",
      answers: Object.fromEntries(
        Object.entries(answers).map(([id, a]) => [
          id,
          a.kind === "noul" ? { type: "boolean", probability: a.p } : systemoneItem(a),
        ]),
      ),
      usage: { inputTokens: 40, outputTokens: 3 },
    }),
    errorBody: { message: BODY_CANARY, error_type: "invalid_request_error" },
    requestsOn422: 1,
  },
  {
    adapter: "llm-emulation",
    path: "/chat/completions",
    calibrated: false,
    encode: (answers) => ({
      model: "fake-chat-1",
      choices: [
        {
          message: {
            role: "assistant",
            content: JSON.stringify(
              Object.fromEntries(
                Object.entries(answers).map(([id, a]) => [
                  id,
                  a.kind === "noul" ? { p: a.p } : { probabilities: a.probabilities },
                ]),
              ),
            ),
          },
        },
      ],
      usage: { prompt_tokens: 40, completion_tokens: 30 },
    }),
    errorBody: { error: { message: BODY_CANARY, type: "invalid_request_error" } },
    requestsOn422: 2,
  },
];

let server: FakeSystemOne;
beforeAll(async () => {
  server = await startFakeSystemOne();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  server.requests.length = 0;
});

function providerFor(route: Route, timeoutMs = 2000): DecisionProvider {
  const cfg = activeDecisionConfig({
    provider: `contract-${route.adapter}`,
    adapter: route.adapter,
    baseUrl: route.adapter === "llm-emulation" ? `${server.url}/v1` : server.url,
    envKey: KEY_VAR,
    calibrated: route.calibrated,
    timeoutMs,
  });
  const provider = makeDecisionProvider(cfg, ENV);
  if (provider === null) throw new Error(`no provider for ${route.adapter}`);
  return provider;
}

async function failure(route: Route, timeoutMs = 2000): Promise<DecisionProviderError> {
  try {
    await providerFor(route, timeoutMs).decide(REQUEST, { timeoutMs });
  } catch (e) {
    if (e instanceof DecisionProviderError) return e;
    throw e;
  }
  throw new Error("expected decide to throw");
}

for (const route of ROUTES) {
  describe(`decision-model contract: ${route.adapter}`, () => {
    test("the factory picks this adapter, and requests go to its path with the key", async () => {
      server.setReply(() => ({ json: route.encode(SUCCESS) }));
      const provider = providerFor(route);
      expect(provider.calibrated).toBe(route.calibrated);
      await provider.decide(REQUEST, { timeoutMs: 2000 });
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]!.path).toBe(
        route.adapter === "llm-emulation" ? `/v1${route.path}` : route.path,
      );
      expect(server.requests[0]!.headers["authorization"]).toBe(`Bearer ${FAKE_DECISION_KEY}`);
    });

    for (const fixture of ANSWER_FIXTURES) {
      test(`answers: ${fixture.name}`, async () => {
        server.setReply(() => ({ json: route.encode(fixture.answers) }));
        const res = await providerFor(route).decide(REQUEST, { timeoutMs: 2000 });
        expect(res.calibrated).toBe(route.calibrated);
        expect(res.usage.inputTokens).toBe(40);
        for (const [id, want] of Object.entries(fixture.expect)) {
          const got = res.answers[id]!;
          expect(`${id}: ${got.valid}`).toBe(`${id}: ${want.valid}`);
          if (!want.valid) continue;
          if (typeof want.value === "number")
            expect(got.value as number).toBeCloseTo(want.value, 9);
          else if (want.value !== undefined) expect(got.value).toBe(want.value);
          if (want.confidence !== undefined)
            expect(got.confidence!).toBeCloseTo(want.confidence, 9);
        }
        expect(Object.keys(res.answers).toSorted()).toEqual(["level", "pick", "yes"]);
      });
    }

    test("a reply that is not the route's JSON shape is invalid_reply", async () => {
      server.setReply(() => ({ text: "<html>gateway</html>" }));
      expect((await failure(route)).reason).toBe("invalid_reply");
      server.setReply(() => ({ json: { unexpected: true } }));
      expect((await failure(route)).reason).toBe("invalid_reply");
    });

    test("401: http_401, names the key variable, never the error body", async () => {
      server.setReply(() => ({ status: 401, json: route.errorBody }));
      const err = await failure(route);
      expect(err.reason).toBe("http_401");
      expect(err.message).toContain(KEY_VAR);
      expect(err.message).not.toContain(BODY_CANARY);
      expect(err.message).not.toContain(FAKE_DECISION_KEY);
      expect(server.requests).toHaveLength(1);
    });

    test("422: http_422 without a retry of the same request", async () => {
      server.setReply(() => ({ status: 422, json: route.errorBody }));
      const err = await failure(route);
      expect(err.reason).toBe("http_422");
      expect(err.message).not.toContain(BODY_CANARY);
      expect(server.requests).toHaveLength(route.requestsOn422);
    });

    test("429 with retry-after: one retry, then the answer", async () => {
      server.setReply((_req, i) =>
        i === 0
          ? { status: 429, headers: { "retry-after": "0" }, json: route.errorBody }
          : { json: route.encode(SUCCESS) },
      );
      const res = await providerFor(route).decide(REQUEST, { timeoutMs: 2000 });
      expect(res.answers["yes"]!.valid).toBe(true);
      expect(server.requests).toHaveLength(2);
    });

    test("529 twice: one retry at most, then http_529", async () => {
      server.setReply(() => ({ status: 529, json: route.errorBody }));
      expect((await failure(route)).reason).toBe("http_529");
      expect(server.requests).toHaveLength(2);
    });

    test("a reset connection is network and is never retried", async () => {
      const before = server.connections();
      server.setReply(() => ({ reset: true }));
      expect((await failure(route)).reason).toBe("network");
      expect(server.connections() - before).toBe(1);
    });

    test("a hanging reply is a timeout", async () => {
      server.setReply(() => ({ hang: true }));
      const started = Date.now();
      expect((await failure(route, 300)).reason).toBe("timeout");
      expect(Date.now() - started).toBeLessThan(2000);
    });

    test("a choice above the route's option limit is refused before sending", async () => {
      const cfg = activeDecisionConfig({
        provider: `contract-${route.adapter}`,
        adapter: route.adapter,
        baseUrl: route.adapter === "llm-emulation" ? `${server.url}/v1` : server.url,
        envKey: KEY_VAR,
        calibrated: route.calibrated,
        maxChoiceOptions: 2,
      });
      const provider = makeDecisionProvider(cfg, ENV)!;
      const wide: DecisionRequest = {
        ...REQUEST,
        questions: {
          pick: { type: "choice", instructions: "Pick", criteria: { a: null, b: null, c: null } },
        },
      };
      try {
        await provider.decide(wide, { timeoutMs: 2000 });
        throw new Error("expected a budget refusal");
      } catch (e) {
        expect((e as DecisionProviderError).reason).toBe("budget");
      }
      expect(server.requests).toHaveLength(0);
    });
  });
}

describe("decision-model contract: answering model id", () => {
  for (const route of ROUTES) {
    test(`${route.adapter}: an oversized or control-character model id falls back to the pinned one`, async () => {
      for (const bad of ["m".repeat(500), "model\nforged: line"]) {
        server.setReply(() => {
          const reply = route.encode(SUCCESS) as Record<string, unknown>;
          return { json: { ...reply, model: bad } };
        });
        // eslint-disable-next-line no-await-in-loop -- one shared server reply at a time
        const res = await providerFor(route).decide(REQUEST, { timeoutMs: 2000 });
        expect(res.model).toBe("fake-model-1");
      }
    });
  }
});
