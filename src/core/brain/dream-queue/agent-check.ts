/**
 * The verification of a dream agent command (change
 * `dream-launched-agent`, design D5; spec "The command is verified by a
 * real call"): a real session, started exactly as the worker starts one,
 * against two canary items in a throwaway store with both partitions.
 * It passes when both items were answered correctly and finish was
 * called, within its limit; the result is recorded on the machine by the
 * command's hash. The throwaway store is removed by its exact paths.
 *
 * The canary operation `agent-check` is registered at module load, not
 * for the duration of the call as the design says: the session's server
 * is another process and knows only what production registers. It is
 * never produced outside a check's own store.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { discoverConfig, readDeviceId } from "../../config.ts";
import { findProgram } from "../../process/run-program.ts";
import { initStore } from "../../store/store-init.ts";
import { openStore } from "../../store/store-open.ts";
import { claimDreamOwner, claimSettled, readDreamOwner } from "../dream-owner/owner.ts";
import { resolveDreamAgentConfig, type DreamAgentCommand } from "./agent-config.ts";
import { runAgentSession, type AgentSessionRun } from "./agent-executor.ts";
import { dreamAgentStateDir, recordDreamAgentVerification } from "./agent-verified.ts";
import { registerDreamWorkOperation } from "./operations.ts";
import { dreamQueueOn, produceWork, readDreamWork } from "./queue.ts";
import { DREAM_WORK_ANSWER, DREAM_WORK_FINISH, DREAM_WORK_TAKE } from "./dream-session.ts";

export const AGENT_CHECK_OPERATION = "agent-check";
/** The longest a check waits for its session. */
export const AGENT_CHECK_LIMIT_MS = 120_000;
const CANARY_WORD = "canary";
const CANARY_OPTIONS = ["red", "blue", "green"] as const;
const CANARY_CHOICE = "blue";

registerDreamWorkOperation({
  name: AGENT_CHECK_OPERATION,
  closedPredecessor: "release",
  validate(answer, item) {
    if (item.body.payload["kind"] === "closed") {
      return answer.value === CANARY_CHOICE ? null : `the answer is ${CANARY_CHOICE}`;
    }
    return typeof answer.text === "string" && answer.text.toLowerCase().includes(CANARY_WORD)
      ? null
      : `the answer is the word ${CANARY_WORD}`;
  },
  currentInput: (item) => ({ input_hash: item.body.input_hash }),
  apply: () => [],
});

export type AgentCheckResult =
  | {
      readonly ok: true;
      readonly agent: string;
      readonly model: string;
      readonly programVersion: string | null;
      readonly session: AgentSessionRun;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      /** What the session did, from its call log. */
      readonly seen: ReadonlyArray<string>;
      readonly session: AgentSessionRun | null;
    };

/** The program's version line (`<program> --version`, ten second cap), or `null`. */
function programVersion(
  program: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const path = findProgram(program, env);
  if (path === null) return null;
  const out = spawnSync(path, ["--version"], { timeout: 10_000, encoding: "utf8", shell: false });
  const line = (out.stdout ?? "").split("\n")[0]?.trim();
  return line !== undefined && line !== "" ? line : null;
}

/** What a session did, in words, from its run. */
export function describeSession(session: AgentSessionRun): string[] {
  const seen: string[] = [
    `the session ${session.ended.startsWith("not-started") ? "did not start" : "started"} (${session.ended})`,
  ];
  const listed = session.calls.some((c) => c.tool === "tools/list");
  seen.push(listed ? "it listed the tools" : "it never listed the tools");
  const counts = new Map<string, number>();
  for (const c of session.calls) {
    if (c.tool === "tools/list" || c.tool === "initialize") continue;
    const key = `${c.tool} ${c.outcome}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) seen.push("it made no tool call");
  for (const [key, n] of counts) seen.push(`${key} x${n}`);
  return seen;
}

/** Run the check of `command`. */
export async function checkDreamAgent(
  command: DreamAgentCommand,
  options: {
    readonly configPath?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly limitMs?: number;
  } = {},
): Promise<AgentCheckResult> {
  const env = options.env ?? process.env;
  const base = join(dreamAgentStateDir(), `check-${randomUUID()}`);
  const root = join(base, "store");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  let deviceStateDir: string | null = null;
  try {
    initStore({ root });
    const device = readDeviceId(options.configPath) ?? "dream-check";
    const store = openStore({ root, device });
    deviceStateDir = store.deviceStateDir;
    const configPath = join(base, "config.yaml");
    writeFileSync(configPath, `store_root: ${root}\ndevice_id: ${device}\n`, { mode: 0o600 });
    claimDreamOwner(store, command.label, { writer: "o2b", authority: "human" });
    claimSettled(store, readDreamOwner(store));
    const owner = readDreamOwner(store).owner!;
    const queue = dreamQueueOn(store, { vault: null, writer: "o2b", configPath });
    const canary = (kind: "closed" | "text") =>
      produceWork(queue, {
        operation: AGENT_CHECK_OPERATION,
        subject: kind,
        occurrence: `0000-00-00/${kind}`,
        input: kind,
        prompt_version: "1",
        schema_version: "1",
        answer_schema:
          kind === "closed" ? { type: "choice", options: [...CANARY_OPTIONS] } : { type: "text" },
        after: [],
        resources: [],
        evidence: [],
        payload:
          kind === "closed"
            ? {
                kind,
                prompt: `Which of the options is the colour of a clear daytime sky? Answer with that option.`,
              }
            : { kind, prompt: `Answer with exactly the word: ${CANARY_WORD}` },
        sources: ["shared"],
      }).id;
    const ids = [canary("closed"), canary("text")];
    // The check speaks the protocol the machine's sessions will speak:
    // the batch of a run is the batch of the configuration, capped by
    // its item limit, as a production run's is. The check's own item
    // budget stays 4, so both canaries can be taken.
    const { batch, items } = resolveDreamAgentConfig({
      config: discoverConfig(options.configPath).data,
      env,
    });
    const session = await runAgentSession(queue, owner, command, {
      budgetMs: options.limitMs ?? AGENT_CHECK_LIMIT_MS,
      operations: [AGENT_CHECK_OPERATION],
      privateAllowed: true,
      items: 4,
      batch: Math.min(batch, items),
      configPath,
      env,
    });
    const seen = describeSession(session);
    const state = readDreamWork(store);
    const answered = ids.every((id) => state.items.get(id)?.state === "accepted");
    const finished = session.calls.some((c) => c.tool === DREAM_WORK_FINISH);
    if (!answered) {
      const wrong = session.calls.some(
        (c) => c.tool === DREAM_WORK_ANSWER && c.outcome === "failed",
      );
      const took = session.calls.some((c) => c.tool === DREAM_WORK_TAKE);
      const reason = wrong
        ? "the session answered a canary wrongly"
        : took
          ? "the session did not answer both canaries"
          : session.ended === "timed-out"
            ? "the session never took a canary within the limit"
            : "the session never called the tools";
      return { ok: false, reason, seen, session };
    }
    if (!finished) return { ok: false, reason: "the session did not call finish", seen, session };
    if (session.failed || session.ended !== "exited 0") {
      return { ok: false, reason: "the session did not end successfully", seen, session };
    }
    const model = session.models[0] ?? "unknown";
    const version = programVersion(command.program, env);
    recordDreamAgentVerification(command, { agent: command.label, model, programVersion: version });
    return { ok: true, agent: command.label, model, programVersion: version, session };
  } finally {
    rmSync(base, { recursive: true, force: true });
    if (deviceStateDir !== null) rmSync(deviceStateDir, { recursive: true, force: true });
  }
}
