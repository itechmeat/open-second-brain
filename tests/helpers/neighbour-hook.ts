/**
 * The harness of the neighbour-updates hook tests: a store with an
 * index for two devices, a workspace of project `o2b` whose pointer names
 * the vault, the hook run as a subprocess with this machine as `dev-a`,
 * and writers for the records a neighbour or this session writes.
 *
 * Every run spawns the hook with {@link lingerGuardEnv}: a hook that kept
 * its process alive past its work would hold the test until it times out.
 */

import { afterEach, beforeEach } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { homeEnv } from "./platform.ts";
import { FAKE_DECISION_KEY } from "./fake-credentials.ts";
import { lingerGuardEnv } from "./hook-linger.ts";
import type { FakeSystemOne } from "./fake-decision-provider.ts";
import { STORE_CATCH_UP_INTERVAL_ENV } from "../../src/core/search/brain-store/constants.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { appendRecord } from "../../src/core/store/appender.ts";
import { observeClock } from "../../src/core/store/clock-store.ts";
import { buildRecord, type RecordBody } from "../../src/core/store/envelope.ts";
import type { Hlc } from "../../src/core/store/hlc.ts";
import { shardMonth, shardPath } from "../../src/core/store/store-paths.ts";
import {
  LOCAL_DEVICE,
  REMOTE_DEVICE as REMOTE_DEVICE_ID,
  makeStoreIndexFixture,
  type StoreIndexFixture,
} from "../core/search/fixtures/brain-store-index.ts";

export { LOCAL_DEVICE, REMOTE_DEVICE } from "../core/search/fixtures/brain-store-index.ts";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "neighbour-updates.ts",
);

export const SELF_AGENT = "agent-a";
export const NEIGHBOUR_AGENT = "agent-b";

export interface HookRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number;
}

export interface NeighbourHarness {
  readonly fx: () => StoreIndexFixture;
  readonly configHome: () => string;
  readonly workspace: () => string;
  server: FakeSystemOne | null;
  readonly runHook: (payload: unknown, extra?: Record<string, string>) => Promise<HookRun>;
  readonly payload: (prompt: string, sessionId: string) => unknown;
  readonly reindex: () => Promise<void>;
  readonly now: () => number;
  readonly clock: () => number;
  /** A topic create in `project:o2b` (or `scope`), once per topic, by this session unless named. */
  readonly seedTopic: (
    topic: string,
    options?: {
      scope?: string;
      title?: string;
      partition?: "shared" | "private";
      device?: string;
      agent?: string;
    },
  ) => void;
  /** A decision a device writes on a topic. */
  readonly decision: (
    device: string,
    topic: string | null,
    text: string,
    options?: {
      agent?: string;
      scope?: string | null;
      partition?: "shared" | "private";
      authority?: string;
      extra?: Record<string, unknown>;
    },
  ) => string;
  readonly logEntry: (device: string, topic: string, text: string, routine: boolean) => string;
  /**
   * Records another device's shard brings in one sync: written as whole
   * shard lines in one file write per shard, not one append each, so a
   * test that needs thousands of them stays fast on every platform.
   * Answers the record ids, in order.
   */
  readonly importRecords: (
    device: string,
    records: ReadonlyArray<{
      readonly stream: "events" | "topics";
      readonly kind: string;
      readonly topic?: string | null;
      readonly body: RecordBody;
    }>,
  ) => string[];
  /** `count` records of another stream the lane never surfaces, from `device`, in one sync. */
  readonly noise: (count: number, device?: string) => void;
  readonly decisionEnv: (mode: string, url: string | null) => Record<string, string>;
}

export function injected(stdout: string): string | null {
  if (stdout.trim() === "") return null;
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  return parsed.hookSpecificOutput?.additionalContext ?? null;
}

/** Register the per-test setup and teardown and return the harness. */
export function neighbourHarness(prefix: string): NeighbourHarness {
  let fx: StoreIndexFixture;
  let savedInterval: string | undefined;
  let workspace: string;
  let configHome: string;
  let clock = Date.UTC(2026, 11, 1, 9, 0, 0);
  const createdTopics = new Set<string>();

  const harness: NeighbourHarness = {
    fx: () => fx,
    configHome: () => configHome,
    workspace: () => workspace,
    server: null,
    runHook: async (payload, extra = {}) => {
      const proc = Bun.spawn(["bun", "run", HOOK], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env["PATH"] ?? "",
          ...homeEnv(configHome),
          // The store's index lives under the local device's state base;
          // the subprocess must resolve the same one.
          XDG_STATE_HOME: fx.dirs(LOCAL_DEVICE).env["XDG_STATE_HOME"] ?? "",
          LOCALAPPDATA: fx.dirs(LOCAL_DEVICE).env["LOCALAPPDATA"] ?? "",
          VAULT_DIR: fx.vault,
          OPEN_SECOND_BRAIN_STORE_ROOT: fx.root,
          O2B_DEVICE_ID: LOCAL_DEVICE,
          VAULT_AGENT_NAME: SELF_AGENT,
          ...lingerGuardEnv(),
          ...extra,
        },
      });
      proc.stdin.write(JSON.stringify(payload));
      await proc.stdin.end();
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exit = await proc.exited;
      return { stdout, stderr, exit };
    },
    payload: (prompt, sessionId) => ({
      hook_event_name: "UserPromptSubmit",
      cwd: workspace,
      session_id: sessionId,
      prompt,
    }),
    reindex: async () => {
      await indexVault(fx.config());
    },
    now: () => (clock += 1000),
    clock: () => clock,
    seedTopic: (topic, options = {}) => {
      if (createdTopics.has(topic)) return;
      createdTopics.add(topic);
      appendRecord(
        fx.open(options.device ?? LOCAL_DEVICE),
        {
          partition: options.partition ?? "shared",
          stream: "topics",
          kind: "topic-create",
          agent: options.agent ?? SELF_AGENT,
          topic,
          body: {
            authority: "agent",
            title: options.title ?? `Topic ${topic.slice(-4)}`,
            scope: options.scope ?? "project:o2b",
          },
        },
        { now: harness.now },
      );
    },
    decision: (device, topic, text, options = {}) => {
      if (topic !== null) harness.seedTopic(topic);
      return appendRecord(
        fx.open(device),
        {
          partition: options.partition ?? "shared",
          stream: "topics",
          kind: "decision",
          agent: options.agent ?? SELF_AGENT,
          topic,
          ...(options.scope !== undefined ? { scope: options.scope } : {}),
          body: { authority: options.authority ?? "agent", text, ...options.extra },
        },
        { now: harness.now },
      ).record.id;
    },
    logEntry: (device, topic, text, routine) => {
      harness.seedTopic(topic);
      return appendRecord(
        fx.open(device),
        {
          partition: "shared",
          stream: "topics",
          kind: "log-entry",
          agent: NEIGHBOUR_AGENT,
          topic,
          body: { authority: "agent", text, class: routine ? "routine" : "blocker" },
        },
        { now: harness.now },
      ).record.id;
    },
    importRecords: (device, records) => {
      const store = fx.open(device);
      const shards = new Map<string, string[]>();
      const ids: string[] = [];
      let last: Hlc | null = null;
      for (const input of records) {
        const hlc: Hlc = { physical: harness.now(), counter: 0 };
        const record = buildRecord({
          hlc,
          device,
          agent: NEIGHBOUR_AGENT,
          kind: input.kind,
          topic: input.topic ?? null,
          body: input.body,
        });
        const path = shardPath(
          store.root,
          "shared",
          { stream: input.stream },
          device,
          shardMonth(hlc.physical),
        );
        const lines = shards.get(path) ?? [];
        lines.push(`${JSON.stringify(record)}\n`);
        shards.set(path, lines);
        ids.push(record.id);
        last = hlc;
      }
      for (const [path, lines] of shards) {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, lines.join(""));
      }
      // The device's own clock moves past what it wrote, as an append would.
      if (last !== null) observeClock(store.deviceStateDir, device, last, () => last!.physical);
      return ids;
    },
    noise: (count, device = REMOTE_DEVICE_ID) => {
      harness.importRecords(
        device,
        Array.from({ length: count }, (_, i) => ({
          stream: "events" as const,
          kind: "decision",
          body: { authority: "agent", text: `noise ${i}` },
        })),
      );
    },
    decisionEnv: (mode, url) => {
      const env: Record<string, string> = {
        OPEN_SECOND_BRAIN_DECISION_MODEL_ENABLED: "true",
        OPEN_SECOND_BRAIN_DECISION_MODEL_PROVIDER: "compatible",
        OPEN_SECOND_BRAIN_DECISION_MODEL_ID: "nb-model",
        OPEN_SECOND_BRAIN_DECISION_MODEL_ENV_KEY: "O2B_TEST_NB_KEY",
        OPEN_SECOND_BRAIN_DECISION_MODEL_USES: `neighbour_relevant:${mode}`,
        O2B_TEST_NB_KEY: FAKE_DECISION_KEY,
        OPEN_SECOND_BRAIN_CONFIG: join(configHome, "config.yaml"),
      };
      if (url !== null) env["OPEN_SECOND_BRAIN_DECISION_MODEL_BASE_URL"] = url;
      return env;
    },
  };

  beforeEach(() => {
    savedInterval = process.env[STORE_CATCH_UP_INTERVAL_ENV];
    process.env[STORE_CATCH_UP_INTERVAL_ENV] = "0";
    fx = makeStoreIndexFixture(prefix);
    workspace = join(mkdtempSync(join(tmpdir(), `${prefix}work-`)), "o2b");
    configHome = mkdtempSync(join(tmpdir(), `${prefix}cfg-`));
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, ".o2b-vault.json"), JSON.stringify({ vault: fx.vault }));
    createdTopics.clear();
  });

  afterEach(async () => {
    if (harness.server !== null) {
      await harness.server.close();
      harness.server = null;
    }
    if (savedInterval === undefined) delete process.env[STORE_CATCH_UP_INTERVAL_ENV];
    else process.env[STORE_CATCH_UP_INTERVAL_ENV] = savedInterval;
    fx.cleanup();
    rmSync(dirname(workspace), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(configHome, { recursive: true, force: true });
  });

  return harness;
}
