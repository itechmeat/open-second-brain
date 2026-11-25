/**
 * The server of a dream session (change `dream-launched-agent`, design
 * D3): the exact profile `dream-executor`, three tools and nothing else.
 *
 *  - `dream_work_take {}`: one ready item the run may take, with its
 *    bounded evidence and its answer shape, or none with the reason.
 *  - `dream_work_answer { id, generation, value | text, model,
 *    confidence? }`: the queue's answer rules; the agent recorded is the
 *    run's, the model is the session's statement.
 *  - `dream_work_finish {}`: every lease the run still holds is released.
 *
 * No capability tool, no resource, no prompt: the resource methods answer
 * an empty list and a read is refused; initialize advertises tools only
 * and gives the fixed task as its instructions.
 *
 * The profile is not a value of the `tool_profile` setting and not an
 * install profile: it is reachable only as `o2b mcp --tool-profile
 * dream-executor`, and the server refuses to start without a live run
 * (the run id and token in its environment, `run-record.ts`). Every call
 * checks the run again; a refused call writes nothing. A call under a
 * live run appends one line to the run's call log.
 */

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { openDreamOwnerStore } from "../core/brain/dream-owner/gate.ts";
import { readDreamOwner } from "../core/brain/dream-owner/owner.ts";
import {
  DREAM_EXECUTOR_SERVER_NAME,
  DREAM_EXECUTOR_TOOLS,
  DREAM_RUN_ENV,
  DREAM_TOKEN_ENV,
  DREAM_WORK_ANSWER,
  DREAM_WORK_FINISH,
  DREAM_WORK_TAKE,
  dreamSessionTask,
} from "../core/brain/dream-queue/dream-session.ts";
import type { DreamWorkItem } from "../core/brain/dream-queue/fold.ts";
import { dreamWorkReads, type DreamWorkReads } from "../core/brain/dream-queue/operations.ts";
import {
  answerWork,
  answerWorkBatch,
  dreamQueueOn,
  readDreamWork,
  releaseRunWork,
  takeWork,
  takeWorkBatch,
  type AnswerInput,
  type DreamQueue,
  type TakenItem,
} from "../core/brain/dream-queue/queue.ts";
import {
  appendDreamRunCallUnderLock,
  checkDreamRun,
  readDreamRunCalls,
  withAuthorizedDreamRun,
  type DreamRunRecord,
  type DreamRunLease,
} from "../core/brain/dream-queue/run-record.ts";
import type { StoreHandle } from "../core/store/store-open.ts";
// The operations a session may answer register at module load.
import "../core/brain/dream-queue/rollup-work.ts";
import "../core/brain/dream-queue/agent-check.ts";
import { isChoiceOperation, isClosedOperation } from "../core/topics/decide-operations.ts";
import { PROTOCOL_VERSION, SERVER_VERSION } from "./protocol.ts";

export const DREAM_EXECUTOR_PROFILE = "dream-executor";
export {
  DREAM_EXECUTOR_SERVER_NAME,
  DREAM_EXECUTOR_TOOLS,
  DREAM_WORK_ANSWER,
  DREAM_WORK_FINISH,
  DREAM_WORK_TAKE,
  dreamSessionTask,
};

const TOOLS = [
  {
    name: DREAM_WORK_TAKE,
    description: "Take the next ready work item, or learn that none is left.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: DREAM_WORK_ANSWER,
    description: "Answer a taken item in its answer shape: `value` or `text`, with your model.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        generation: { type: "integer" },
        value: { description: "The answer value of a closed question." },
        text: { type: "string", description: "The answer text of a text item." },
        model: { type: "string", description: "The model that wrote the answer." },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["id", "generation", "model"],
      additionalProperties: false,
    },
  },
  {
    name: DREAM_WORK_FINISH,
    description: "Release whatever this session still holds and end the work.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

/**
 * The tools of a run with `batch` items per take: the one-item tools as
 * they are for 1, else a take that hands out up to `batch` items and an
 * answer that carries a list.
 */
function toolsFor(batch: number): ReadonlyArray<(typeof TOOLS)[number] | Record<string, unknown>> {
  if (batch <= 1) return TOOLS;
  return [
    {
      name: DREAM_WORK_TAKE,
      description: `Take up to ${batch} ready work items at once, or learn that none is left.`,
      inputSchema: {
        type: "object",
        properties: {
          max: {
            type: "integer",
            minimum: 1,
            maximum: batch,
            description: `Take at most this many (default ${batch}).`,
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: DREAM_WORK_ANSWER,
      description:
        "Answer taken items, each in its answer shape (`value` or `text`), in one call, with your model.",
      inputSchema: {
        type: "object",
        properties: {
          answers: {
            type: "array",
            minItems: 1,
            maxItems: batch,
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                generation: { type: "integer" },
                value: { description: "The answer value of a closed question." },
                text: { type: "string", description: "The answer text of a text item." },
                confidence: { type: "number", minimum: 0, maximum: 1 },
              },
              required: ["id", "generation"],
              additionalProperties: false,
            },
          },
          model: { type: "string", description: "The model that wrote the answers." },
        },
        required: ["answers", "model"],
        additionalProperties: false,
      },
    },
    TOOLS[2],
  ];
}

/** What a closed question asks, by operation. */
const QUESTIONS: Readonly<Record<string, string>> = {
  "topic-route":
    "Which of the listed topics does the record belong to? Answer with one option, or `none`.",
  "topic-new":
    "Is this group of records a real topic worth tracking? Answer p, the probability of yes.",
  "topic-same": "Are these two topics the same topic? Answer `same` or `different`.",
  "event-kind": "What kind of event is this record within its topic? Answer with one option.",
  "question-resolved":
    "Does the record resolve one of the topic's open questions? Answer with its key, or `none`.",
  "milestone-done": "Do the records show the milestone is done? Answer p, the probability of yes.",
  "human-readable":
    "Is this note worth showing to a person in the history? Answer p, the probability of yes.",
};

function questionOf(item: {
  operation: string;
  payload: Readonly<Record<string, unknown>>;
}): string {
  const prompt = item.payload["prompt"];
  if (typeof prompt === "string" && prompt !== "") return prompt;
  return QUESTIONS[item.operation] ?? "Answer the item in its answer shape.";
}

function answerShape(operation: string, schema: Readonly<Record<string, unknown>>): unknown {
  if (!isClosedOperation(operation)) {
    return { ...schema, answer_with: schema["type"] === "text" ? "text" : "value" };
  }
  if (isChoiceOperation(operation)) {
    return {
      ...schema,
      answer_with: "value",
      value: "one of the options, as a string",
      confidence: "the probability of the chosen option, 0 to 1",
    };
  }
  return { ...schema, answer_with: "value", value: "p, the probability of yes, 0 to 1" };
}

export interface DreamExecutorOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The machine config the store is resolved from. */
  readonly configPath?: string;
  /** The vault the run's brain is served from (null: none). */
  readonly vault: string | null;
  readonly now?: () => number;
}

export type DreamExecutorOpen =
  | { readonly ok: true; readonly server: DreamExecutorServer }
  | { readonly ok: false; readonly reason: string };

/** Open the server of the run named in `options.env`, or say why it may not start. */
export function openDreamExecutor(options: DreamExecutorOptions): DreamExecutorOpen {
  const run = options.env[DREAM_RUN_ENV];
  const token = options.env[DREAM_TOKEN_ENV];
  if (run === undefined || run === "" || token === undefined || token === "") {
    return {
      ok: false,
      reason: "no dream run: this profile starts only for a run the worker made",
    };
  }
  const opened = openDreamOwnerStore(options.vault, options.configPath);
  if (opened.store === null) return { ok: false, reason: `no brain store (${opened.reason})` };
  const server = new DreamExecutorServer(opened.store, run, token, options);
  const check = server.check();
  if (!check.ok) return { ok: false, reason: check.reason };
  return { ok: true, server };
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function result(value: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

export class DreamExecutorServer {
  readonly #store: StoreHandle;
  readonly #run: string;
  readonly #token: string;
  readonly #options: DreamExecutorOptions;
  /**
   * The reads the server keeps for the life of the session: every take
   * and answer rechecks its item's input, and through these only what was
   * written since the previous call is read.
   */
  readonly #reads: DreamWorkReads = dreamWorkReads();

  constructor(store: StoreHandle, run: string, token: string, options: DreamExecutorOptions) {
    this.#store = store;
    this.#run = run;
    this.#token = token;
    this.#options = options;
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #ownerRevision(): string | null {
    const owner = readDreamOwner(this.#store).owner;
    return owner !== null && owner.device === this.#store.device ? owner.revision : null;
  }

  /** Items per take of the run (1 when its record cannot be read: the one-item protocol). */
  #batch(): number {
    const check = this.check();
    return check.ok ? check.record.batch : 1;
  }

  /** The run, checked against its record, the token and the owner's revision now. */
  check(): { ok: true; record: DreamRunRecord } | { ok: false; reason: string } {
    return checkDreamRun(this.#store.deviceStateDir, {
      run: this.#run,
      token: this.#token,
      ownerRevision: this.#ownerRevision(),
      now: this.#now(),
    });
  }

  #queue(record: DreamRunRecord): DreamQueue {
    return dreamQueueOn(this.#store, {
      vault: this.#options.vault,
      writer: record.agent,
      reads: this.#reads,
      ...(this.#options.configPath !== undefined ? { configPath: this.#options.configPath } : {}),
      ...(this.#options.now !== undefined ? { now: this.#options.now } : {}),
    });
  }

  /** When the tool call being served began (`performance.now()`), or null between calls. */
  #callStarted: number | null = null;

  #log(tool: string, outcome: string, model?: string): void {
    appendDreamRunCallUnderLock(this.#store.deviceStateDir, this.#run, {
      tool,
      outcome,
      ...(model !== undefined ? { model } : {}),
      ...(this.#callStarted !== null ? { ms: this.#slice() } : {}),
      now: this.#now(),
    });
  }

  /** The ms since the call began or since its previous log line (a batch logs a line per item). */
  #slice(): number {
    const at = performance.now();
    const ms = Math.round(at - (this.#callStarted ?? at));
    this.#callStarted = at;
    return ms;
  }

  /** Log a protocol step while the run is live (a refused run logs nothing). */
  #logIfLive(step: string): void {
    withAuthorizedDreamRun(
      this.#store.deviceStateDir,
      {
        run: this.#run,
        token: this.#token,
        ownerRevision: this.#ownerRevision(),
        now: this.#now(),
      },
      () => this.#log(step, "ok"),
    );
  }

  /** Dispatch one JSON-RPC message; `null` for a notification. */
  handle(message: unknown): Record<string, unknown> | null {
    if (typeof message !== "object" || message === null) {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
    }
    const m = message as { id?: unknown; method?: unknown; params?: unknown };
    const id = m.id;
    if (id === undefined) return null;
    const ok = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });
    const fail = (code: number, msg: string) => ({
      jsonrpc: "2.0",
      id,
      error: { code, message: msg },
    });
    switch (m.method) {
      case "initialize": {
        this.#logIfLive("initialize");
        const requested = (m.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        return ok({
          protocolVersion: typeof requested === "string" ? requested : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: DREAM_EXECUTOR_SERVER_NAME, version: SERVER_VERSION },
          instructions: dreamSessionTask(this.#run, this.#batch()),
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        this.#logIfLive("tools/list");
        return ok({ tools: toolsFor(this.#batch()) });
      case "resources/list":
        return ok({ resources: [] });
      case "resources/templates/list":
        return ok({ resourceTemplates: [] });
      case "prompts/list":
        return ok({ prompts: [] });
      case "resources/read":
        return fail(-32602, "this server serves no resources");
      case "tools/call": {
        const params = (m.params ?? {}) as { name?: unknown; arguments?: unknown };
        return ok(
          this.call(String(params.name), (params.arguments ?? {}) as Record<string, unknown>),
        );
      }
      default:
        return fail(-32601, `method not found: ${String(m.method)}`);
    }
  }

  /** One tool call. */
  call(name: string, args: Record<string, unknown>): ToolResult {
    if (!(DREAM_EXECUTOR_TOOLS as ReadonlyArray<string>).includes(name)) {
      return result({ refused: `unknown tool ${name}` }, true);
    }
    this.#callStarted = performance.now();
    try {
      const called = withAuthorizedDreamRun(
        this.#store.deviceStateDir,
        {
          run: this.#run,
          token: this.#token,
          ownerRevision: this.#ownerRevision(),
          now: this.#now(),
        },
        (record, leases) => {
          try {
            if (name === DREAM_WORK_TAKE) return this.#take(record, leases, args);
            if (name === DREAM_WORK_ANSWER) return this.#answer(record, leases, args);
            return this.#finish(record, leases);
          } catch (err) {
            this.#log(name, "error");
            return result({ refused: err instanceof Error ? err.message : String(err) }, true);
          }
        },
      );
      return called.ok ? called.value : result({ refused: called.reason }, true);
    } catch (err) {
      return result({ refused: err instanceof Error ? err.message : String(err) }, true);
    } finally {
      this.#callStarted = null;
    }
  }

  /**
   * Take one item (batch 1), or up to the run's batch (or `max`, when
   * smaller) under one queue entry (`takeWorkBatch`): each item rechecked
   * and leased as one take of the one-item protocol, with its own call log
   * line.
   */
  #take(
    record: DreamRunRecord,
    leases: Map<string, DreamRunLease>,
    args: Record<string, unknown>,
  ): ToolResult {
    let taken = readDreamRunCalls(this.#store.deviceStateDir, this.#run).filter(
      (c) => c.tool === DREAM_WORK_TAKE && c.outcome === "item",
    ).length;
    const max = args["max"];
    const want =
      record.batch <= 1
        ? 1
        : typeof max === "number" && Number.isInteger(max) && max >= 1
          ? Math.min(max, record.batch)
          : record.batch;
    const operations = new Set(record.operations);
    const filter = (item: DreamWorkItem): boolean =>
      operations.has(item.body.operation) &&
      (record.private_allowed || item.partition !== "private");
    const items: Array<Record<string, unknown>> = [];
    let reason: string | null = null;
    const keep = (item: TakenItem): void => {
      leases.set(item.id, { generation: item.generation, lease_token: item.lease_token });
      this.#log(DREAM_WORK_TAKE, "item");
      taken += 1;
      items.push({
        id: item.id,
        generation: item.generation,
        operation: item.operation,
        question: questionOf(item),
        payload: item.payload,
        evidence: item.evidence,
        answer_shape: answerShape(item.operation, item.answer_schema),
      });
    };
    if (taken >= record.item_budget) {
      reason = "item-budget";
    } else if (record.batch <= 1) {
      const got = takeWork(this.#queue(record), { run: this.#run, filter });
      if (got.item === null) reason = got.reason;
      else keep(got.item);
    } else {
      // The batch under one queue entry: each item taken as one take takes it.
      const got = takeWorkBatch(this.#queue(record), {
        run: this.#run,
        max: Math.min(want, record.item_budget - taken),
        filter,
      });
      for (const item of got.items) keep(item);
      reason = got.reason;
    }
    if (items.length === 0) this.#log(DREAM_WORK_TAKE, reason ?? "empty");
    if (record.batch <= 1) {
      return result(items.length === 0 ? { item: null, reason } : { item: items[0] });
    }
    return result(items.length === 0 ? { items, reason } : { items });
  }

  #answer(
    record: DreamRunRecord,
    leases: Map<string, DreamRunLease>,
    args: Record<string, unknown>,
  ): ToolResult {
    const list = args["answers"];
    if (!Array.isArray(list)) return this.#answerOne(record, leases, args);
    const model = args["model"];
    if (typeof model !== "string" || model.trim() === "" || list.length === 0) {
      this.#log(DREAM_WORK_ANSWER, "invalid");
      return result({ refused: "answers (a non-empty list) and model are required" }, true);
    }
    // The run's batch is how many answers one call may carry: an agent
    // that took more items than its batch keeps the queue work of a
    // call under the configured limit.
    if (list.length > record.batch) {
      this.#log(DREAM_WORK_ANSWER, "invalid");
      return result({ refused: `answers (at most ${record.batch} per call) are required` }, true);
    }
    // Each entry gets the checks of one answer of the one-item protocol,
    // with the call's model, over one read of the queue; those that pass
    // are answered under one queue entry, each recheck, validation and
    // record as one answer's.
    const state = this.#workOnce();
    const results: Array<Record<string, unknown>> = [];
    const passed: Array<{ readonly at: number; readonly input: AnswerInput }> = [];
    list.forEach((entry: unknown, at: number) => {
      const one =
        typeof entry === "object" && entry !== null && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)
          : {};
      const prepared = this.#prepareAnswer(record, leases, { ...one, model }, state);
      if ("refusal" in prepared) {
        results.push({ id: one["id"] ?? null, ...prepared.refusal });
      } else {
        results.push({ id: one["id"] ?? null });
        passed.push({ at, input: prepared.input });
      }
    });
    const outcomes = answerWorkBatch(
      this.#queue(record),
      passed.map((p) => p.input),
    );
    outcomes.forEach((outcome, k) => {
      const at = passed[k]!.at;
      results[at] = { ...results[at], ...outcome };
      this.#log(DREAM_WORK_ANSWER, outcome.status, model);
    });
    return result(
      { results },
      results.every((r) => r["status"] !== "accepted"),
    );
  }

  /** The queue as this session's reads hold it now, folded once, on first use. */
  #workOnce(): () => ReturnType<typeof readDreamWork> {
    let state: ReturnType<typeof readDreamWork> | undefined;
    return () => (state ??= readDreamWork(this.#store, { now: this.#now(), reads: this.#reads }));
  }

  /**
   * The checks of one answer before the queue sees it: its fields, that
   * this session holds the lease (in the run's record and in the queue),
   * and the answer value of its operation. A refusal is logged as the
   * one-item protocol logs it.
   */
  #prepareAnswer(
    record: DreamRunRecord,
    leases: Map<string, DreamRunLease>,
    args: Record<string, unknown>,
    work: () => ReturnType<typeof readDreamWork>,
  ): { readonly refusal: Record<string, unknown> } | { readonly input: AnswerInput } {
    const id = args["id"];
    const generation = args["generation"];
    const model = args["model"];
    if (
      typeof id !== "string" ||
      typeof generation !== "number" ||
      typeof model !== "string" ||
      model.trim() === ""
    ) {
      this.#log(DREAM_WORK_ANSWER, "invalid");
      return { refusal: { status: "refused", reason: "id, generation and model are required" } };
    }
    const lease = leases.get(id);
    if (lease === undefined || lease.generation !== generation) {
      this.#log(DREAM_WORK_ANSWER, "not-this-run");
      return {
        refusal: { status: "refused", reason: "this session holds no lease on that item" },
      };
    }
    const item = work().items.get(id);
    if (
      item === undefined ||
      item.lease === null ||
      item.lease.run !== this.#run ||
      item.lease.lease_token !== lease.lease_token
    ) {
      leases.delete(id);
      return { refusal: { status: "refused", reason: "this session no longer holds the lease" } };
    }
    const operation = item.body.operation;
    let answer: { value?: unknown; text?: string };
    if (isClosedOperation(operation)) {
      answer = { value: closedValue(operation, args, record.agent, model) };
    } else if (typeof args["text"] === "string") {
      answer = { text: args["text"] };
    } else {
      answer = { value: args["value"] };
    }
    return {
      input: {
        item: id,
        generation,
        lease_token: lease.lease_token,
        ...answer,
        agent: record.agent,
        model,
      },
    };
  }

  #answerOne(
    record: DreamRunRecord,
    leases: Map<string, DreamRunLease>,
    args: Record<string, unknown>,
  ): ToolResult {
    const prepared = this.#prepareAnswer(record, leases, args, this.#workOnce());
    if ("refusal" in prepared) return result(prepared.refusal, true);
    const outcome = answerWork(this.#queue(record), prepared.input);
    this.#log(DREAM_WORK_ANSWER, outcome.status, String(args["model"]));
    return result(outcome, outcome.status !== "accepted");
  }

  #finish(record: DreamRunRecord, leases: Map<string, DreamRunLease>): ToolResult {
    let released: number;
    try {
      released = releaseRunWork(this.#queue(record), this.#run);
    } finally {
      leases.clear();
    }
    this.#log(DREAM_WORK_FINISH, `released ${released}`);
    return result({ released });
  }
}

/** The value of a closed answer as the queue's operation checks it. */
function closedValue(
  operation: string,
  args: Record<string, unknown>,
  agent: string,
  model: string,
): unknown {
  const raw = args["value"];
  const obj =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const confidence = args["confidence"] ?? obj["confidence"];
  if (isChoiceOperation(operation)) {
    const choice = typeof raw === "string" ? raw : obj["choice"];
    return {
      choice,
      ...(typeof confidence === "number" ? { confidence } : {}),
      provider: agent,
      model,
    };
  }
  const p = typeof raw === "number" ? raw : (obj["p"] ?? confidence);
  return { p, provider: agent, model };
}

/** Serve the profile over newline-delimited JSON on stdio until the input ends. */
export async function serveDreamExecutor(
  options: DreamExecutorOptions & {
    readonly stdin?: Readable;
    readonly stdout?: Writable;
    readonly stderr?: Writable;
  },
): Promise<number> {
  const stderr = options.stderr ?? process.stderr;
  const stdout = options.stdout ?? process.stdout;
  const opened = openDreamExecutor(options);
  if (!opened.ok) {
    stderr.write(
      `o2b mcp: the ${DREAM_EXECUTOR_PROFILE} profile refuses to start: ${opened.reason}\n`,
    );
    return 2;
  }
  const reader = createInterface({ input: options.stdin ?? process.stdin, crlfDelay: Infinity });
  for await (const line of reader) {
    if (line.trim() === "") continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        }) + "\n",
      );
      continue;
    }
    const response = opened.server.handle(message);
    if (response !== null) stdout.write(JSON.stringify(response) + "\n");
  }
  return 0;
}
