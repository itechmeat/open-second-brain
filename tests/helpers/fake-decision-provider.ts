/**
 * Test doubles for the optional decision-model feature (issue #213).
 *
 *   - {@link FakeDecisionProvider}: an in-process `DecisionProvider` with
 *     scripted answers per question id, configurable latency, errors and
 *     invalid items. Never touches the network.
 *   - {@link startFakeSystemOne}: a loopback `/v1/systemone` server that
 *     records every request and answers with whatever the test scripts,
 *     including hangs, redirects and reset connections.
 *   - {@link activeDecisionConfig}: a resolved, active decision config for
 *     tests that inject a provider.
 *
 * Not shipped in `src/`.
 */

import { createServer, type Server, type Socket } from "node:net";

import {
  DecisionProviderError,
  type DecideOptions,
  type DecisionAnswer,
  type DecisionDegradeReason,
  type DecisionPingResult,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResponse,
} from "../../src/core/decision-model/contract.ts";
import type { ResolvedDecisionModelConfig } from "../../src/core/decision-model/config.ts";
import { DECISION_MODEL_USES } from "../../src/core/decision-model/contract.ts";

export type ScriptedAnswer = number | string | { readonly invalid: true };

export interface FakeDecisionProviderOptions {
  /** Answer per question id; a function receives the id and the request. */
  readonly answer?: (id: string, req: DecisionRequest) => ScriptedAnswer | undefined;
  readonly latencyMs?: number;
  readonly fail?: DecisionDegradeReason;
  readonly model?: string;
  readonly usage?: DecisionResponse["usage"];
}

export class FakeDecisionProvider implements DecisionProvider {
  readonly name = "fake";
  readonly model: string;
  readonly calibrated = true;
  readonly requests: DecisionRequest[] = [];
  private readonly opts: FakeDecisionProviderOptions;

  constructor(opts: FakeDecisionProviderOptions = {}) {
    this.opts = opts;
    this.model = opts.model ?? "fake-model-1";
  }

  async decide(req: DecisionRequest, _opts: DecideOptions): Promise<DecisionResponse> {
    this.requests.push(req);
    if (this.opts.latencyMs !== undefined) {
      await new Promise((r) => setTimeout(r, this.opts.latencyMs));
    }
    if (this.opts.fail !== undefined) {
      throw new DecisionProviderError(this.opts.fail, `fake failure ${this.opts.fail}`);
    }
    const answers: Record<string, DecisionAnswer> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      const scripted = this.opts.answer?.(id, req);
      if (scripted === undefined) {
        answers[id] = { type: q.type, value: q.type === "noul" ? 0.5 : 0, valid: true };
      } else if (typeof scripted === "object") {
        answers[id] = { type: q.type, value: Number.NaN, valid: false };
      } else {
        answers[id] = { type: q.type, value: scripted, valid: true };
      }
    }
    return {
      model: this.model,
      answers,
      usage: this.opts.usage ?? { inputTokens: 100, outputTokens: 5 },
      calibrated: true,
      stateHash: "0".repeat(64),
    };
  }

  async ping(): Promise<DecisionPingResult> {
    return { ok: true, model: this.model, latencyMs: 1 };
  }
}

/** A resolved, active config; overrides patch individual fields. */
export function activeDecisionConfig(
  overrides: Partial<ResolvedDecisionModelConfig> = {},
): ResolvedDecisionModelConfig {
  const uses = Object.fromEntries(DECISION_MODEL_USES.map((u) => [u, "off"])) as Record<
    string,
    "off" | "shadow" | "enforce"
  >;
  return {
    status: "active",
    errors: [],
    notes: [],
    enabled: true,
    provider: "compatible",
    adapter: "systemone",
    baseUrl: "http://127.0.0.1:9",
    model: "fake-model-1",
    envKey: "FAKE_DECISION_KEY_UNUSED",
    keyPresent: true,
    allowInsecureHttp: false,
    timeoutMs: 3000,
    hookBudgetMs: 700,
    maxStateTokens: 32_000,
    uses: { ...uses, rerank: "enforce" } as ResolvedDecisionModelConfig["uses"],
    configuredUses: { ...uses, rerank: "enforce" } as ResolvedDecisionModelConfig["uses"],
    dailyCostGateUsd: 0.5,
    inputPriceUsdPerMtok: 0.042,
    allowUncalibrated: false,
    calibrated: true,
    processor: null,
    vault: null,
    ...overrides,
  };
}

// ----- loopback /v1/systemone server ----------------------------------------------

export interface SystemOneRequestLog {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly bodyText: string;
  readonly body: Record<string, unknown>;
}

export type SystemOneReply =
  | {
      readonly status?: number;
      readonly headers?: Record<string, string>;
      readonly json?: unknown;
      readonly text?: string;
    }
  | { readonly hang: true }
  | { readonly reset: true };

export interface FakeSystemOne {
  readonly url: string;
  readonly requests: SystemOneRequestLog[];
  /** Raw TCP connections accepted (a reset request never reaches `requests`). */
  connections(): number;
  setReply(fn: (req: SystemOneRequestLog, index: number) => SystemOneReply): void;
  close(): Promise<void>;
}

/** Answer every question of a request: noul by `p(id)`. */
export function answerAll(
  req: SystemOneRequestLog,
  p: (id: string) => number,
  model = "fake-model-1.0",
): Record<string, unknown> {
  const questions = req.body["questions"] as Record<string, { type: string }>;
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "noul") answers[id] = { type: "noul", noul: p(id) };
  }
  return { model, answers, usage: { input_tokens: 321, output_tokens: 7 } };
}

/**
 * A minimal HTTP/1.1 server over `node:net`, so a test can also hang a
 * request or reset the connection, which `Bun.serve` cannot express.
 */
function defaultReply(req: SystemOneRequestLog): SystemOneReply {
  return { json: answerAll(req, () => 0.5) };
}

export async function startFakeSystemOne(): Promise<FakeSystemOne> {
  const requests: SystemOneRequestLog[] = [];
  let connections = 0;
  let reply: (req: SystemOneRequestLog, index: number) => SystemOneReply = defaultReply;
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const head = buffer.subarray(0, headerEnd).toString("utf8");
      const lines = head.split("\r\n");
      const [, path = "/"] = lines[0]!.split(" ");
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(":");
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      const length = Number(headers["content-length"] ?? "0");
      if (buffer.length < headerEnd + 4 + length) return;
      const bodyText = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
      buffer = Buffer.alloc(0);
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(bodyText) as Record<string, unknown>;
      } catch {
        body = {};
      }
      const log: SystemOneRequestLog = { path, headers, bodyText, body };
      if (reply === undefined) return;
      const r = reply(log, requests.length);
      if ("reset" in r) {
        if (typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
        else socket.destroy();
        return;
      }
      requests.push(log);
      if ("hang" in r) return;
      const status = r.status ?? 200;
      const payload = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : "");
      const extra = Object.entries(r.headers ?? {})
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join("");
      socket.write(
        `HTTP/1.1 ${status} X\r\ncontent-type: application/json\r\n${extra}` +
          `content-length: ${Buffer.byteLength(payload)}\r\nconnection: close\r\n\r\n${payload}`,
      );
      socket.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    connections: () => connections,
    setReply(fn) {
      reply = fn;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
