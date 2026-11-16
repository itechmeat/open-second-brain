/**
 * The front doors of the decide pass (task 4.1.4 item 5, design D10,
 * D20): the CLI dream verb, the MCP dream tool and the maintenance
 * lane's dream task each decide before a live pass - the fake systemone
 * server on loopback is the provider, named by the machine config - and
 * a dry run or preview sends nothing. The provider is injected through
 * the config's base URL, the same way a real self-hosted provider is.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { newUlid } from "../../../src/core/store/ulid.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import {
  decisionThresholdsPath,
  resetThresholdsStoreCache,
  writeThresholdEntry,
} from "../../../src/core/decision-model/thresholds.ts";
import { buildLaneTasks } from "../../../src/core/brain/maintenance/lane-tasks.ts";
import { LANE_TASK } from "../../../src/core/brain/maintenance/lane.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { claimSettled, claimViewWriter, readViewWriter } from "../../../src/core/view/writer.ts";
import { runCli } from "../../helpers/run-cli.ts";
import { TEST_DEVICE_ID } from "../../helpers/test-vault.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";
import { startFakeSystemOne, type FakeSystemOne } from "../../helpers/fake-decision-provider.ts";
import { initStore } from "../../../src/core/store/store-init.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../../src/mcp/index.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { openStore } from "../../../src/core/store/store-open.ts";

const T0 = Date.UTC(2026, 11, 1, 9, 0, 0);

let server: FakeSystemOne;
beforeAll(async () => {
  server = await startFakeSystemOne();
});
afterAll(async () => {
  await server.close();
});

let tmp: string;
let vault: string;
let storeRoot: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-front-doors-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  for (const key of ["OPEN_SECOND_BRAIN_CONFIG", "VAULT_DIR", "OPEN_SECOND_BRAIN_STORE_ROOT"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  process.env["O2B_TEST_FRONT_KEY"] = FAKE_DECISION_KEY;
  resetThresholdsStoreCache();
});

afterEach(() => {
  delete process.env["OPEN_SECOND_BRAIN_STORE_ROOT"];
  rmSync(tmp, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env["O2B_TEST_FRONT_KEY"];
  resetThresholdsStoreCache();
});

/** One store with the writer role, a topic pair and one unassigned record. */
function seedStore(): { shardTopic: string; gardenTopic: string; record: string } {
  storeRoot = join(tmp, "store");
  writeFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  // The suite pins a store root of its own; this test's store is named by
  // both the config and the env override the env resolution prefers.
  process.env["OPEN_SECOND_BRAIN_STORE_ROOT"] = storeRoot;
  writeFileSync(
    configPath,
    [
      `vault: ${vault}`,
      `store_root: ${storeRoot}`,
      `device_id: ${TEST_DEVICE_ID}`,
      "decision_model_enabled: true",
      "decision_model_provider: compatible",
      `decision_model_base_url: ${server.url}`,
      "decision_model_id: decide-model",
      "decision_model_env_key: O2B_TEST_FRONT_KEY",
      "decision_model_uses: topic_route:enforce",
    ].join("\n"),
  );
  initStore({ root: storeRoot });
  const handle = openStore({ root: storeRoot, device: TEST_DEVICE_ID });
  claimViewWriter(handle, { agent: "dream", now: () => T0 });
  claimSettled(
    handle,
    readViewWriter(handle, () => T0),
  );
  const shardTopic = newUlid(T0 + 1);
  appendRecord(
    handle,
    {
      partition: "shared",
      stream: "topics",
      kind: "topic-create",
      agent: "seed",
      topic: shardTopic,
      body: {
        authority: "agent",
        title: "Shard compaction keeps monthly shard files small",
        scope: "project:o2b",
      },
    },
    { now: () => T0 + 2 },
  );
  const gardenTopic = newUlid(T0 + 3);
  appendRecord(
    handle,
    {
      partition: "shared",
      stream: "topics",
      kind: "topic-create",
      agent: "seed",
      topic: gardenTopic,
      body: {
        authority: "agent",
        title: "Garden watering schedule for the alley beds",
        scope: "project:o2b",
      },
    },
    { now: () => T0 + 4 },
  );
  const record = appendRecord(
    handle,
    {
      partition: "shared",
      stream: "events",
      kind: "signal",
      agent: "agent-1",
      body: {
        id: "sig-2026-12-01-f0",
        path: "Brain/inbox/f0.md",
        staged: false,
        frontmatter: {
          principle: "Shard compaction and garden watering schedules were tuned today",
          project: "o2b",
          session: "s1",
        },
        raw: null,
        raw_shape: "bare",
      },
    },
    { now: () => T0 + 5 },
  ).record.id;
  writeThresholdEntry(decisionThresholdsPath(configPath), "decide-model", "topic_route", {
    values: { route_min: 0.6 },
    source: "set",
  });
  resetThresholdsStoreCache();
  return { shardTopic, gardenTopic, record };
}

/** The model answers: route every question to option T1 with p 0.9. */
function scriptGardenRoute(): void {
  server.setReply((req) => {
    const questions = req.body["questions"] as Record<
      string,
      { type: string; criteria?: Record<string, string> }
    >;
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.type === "choice") {
        // A full distribution over the question's options: the reply is
        // valid only when the chosen label is its argmax and the sum is 1.
        const options = Object.keys(q.criteria ?? {});
        const distribution: Record<string, number> = {};
        for (const option of options)
          distribution[option] = option === "T1" ? 0.9 : 0.1 / Math.max(1, options.length - 1);
        answers[id] = { type: "choice", choice: "T1", probabilities: distribution };
      } else answers[id] = { type: q.type, noul: 0.5 };
    }
    return {
      json: { model: "front-model-1.0", answers, usage: { input_tokens: 50, output_tokens: 7 } },
    };
  });
}

function assigns(): Array<{ topic: string; body: string }> {
  return readPartition(join(storeRoot, "shared"))
    .flatMap((s) => s.records)
    .filter((r) => r.kind === "assign")
    .map((r) => ({ topic: r.topic ?? "", body: JSON.stringify(r.body) }));
}

describe("the dream front doors decide before a live pass", () => {
  test("the CLI dream verb decides and writes the model route; a dry run sends nothing", async () => {
    const { gardenTopic } = seedStore();
    scriptGardenRoute();
    // A dry run on the fresh store, its record still unassigned, sends nothing.
    const start = server.requests.length;
    const dry = await runCli(["brain", "dream", "--vault", vault, "--dry-run", "--json"], {
      env: {
        OPEN_SECOND_BRAIN_CONFIG: configPath,
        OPEN_SECOND_BRAIN_STORE_ROOT: storeRoot,
        O2B_TEST_FRONT_KEY: FAKE_DECISION_KEY,
      },
    });
    expect(dry.returncode).toBe(0);
    expect(server.requests.length).toBe(start);
    expect(assigns()).toEqual([]);
    const live = await runCli(["brain", "dream", "--vault", vault, "--json"], {
      env: {
        OPEN_SECOND_BRAIN_CONFIG: configPath,
        OPEN_SECOND_BRAIN_STORE_ROOT: storeRoot,
        O2B_TEST_FRONT_KEY: FAKE_DECISION_KEY,
      },
    });
    expect(live.returncode).toBe(0);
    expect(live.stderr).not.toContain("error:");
    expect(server.requests.length).toBeGreaterThan(start);
    const written = assigns();
    expect(written).toHaveLength(1);
    expect(written[0]!.topic).toBe(gardenTopic);
    expect(JSON.parse(written[0]!.body)).toMatchObject({
      authority: "model",
      verdict: {
        use: "topic_route",
        model: "front-model-1.0",
        mode: "enforce",
        version: 2,
        confidence: 0.9,
      },
    });
  });

  test("the MCP dream tool decides on a live run; a dry run sends nothing", async () => {
    const { gardenTopic } = seedStore();
    scriptGardenRoute();
    const server2 = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.local });
    await server2.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    await server2.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
    // A dry run on the fresh store, its record still unassigned, sends nothing.
    const start = server.requests.length;
    await server2.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 3,
      method: "tools/call",
      params: { name: "brain_dream", arguments: { dry_run: true } },
    });
    expect(server.requests.length).toBe(start);
    expect(assigns()).toEqual([]);
    const run = (await server2.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 2,
      method: "tools/call",
      params: { name: "brain_dream", arguments: {} },
    })) as { result?: { content?: ReadonlyArray<{ text?: string }> } };
    const text = run.result?.content?.map((c) => c.text ?? "").join("") ?? "";
    expect(text).not.toContain("error");
    expect(server.requests.length).toBeGreaterThan(start);
    expect(assigns()).toHaveLength(1);
    expect(assigns()[0]!.topic).toBe(gardenTopic);
  });

  test("the maintenance lane's dream task decides before its live pass", async () => {
    const { gardenTopic } = seedStore();
    scriptGardenRoute();
    // The process names another config with another store: the lane
    // decides and plans in the store its caller's config names.
    const otherStore = join(tmp, "other-store");
    initStore({ root: otherStore });
    const otherConfig = join(tmp, "other-config.yaml");
    writeFileSync(
      otherConfig,
      [`vault: ${vault}`, `store_root: ${otherStore}`, `device_id: ${TEST_DEVICE_ID}`].join("\n"),
    );
    process.env["OPEN_SECOND_BRAIN_CONFIG"] = otherConfig;
    delete process.env["OPEN_SECOND_BRAIN_STORE_ROOT"];
    const tasks = buildLaneTasks({
      vault,
      configPath,
      searchConfig: resolveSearchConfig({ vault, configPath }),
      now: new Date(T0),
      forceCost: false,
      safeguardFor: () => ({
        operation: "dream",
        timeoutMs: 60_000,
        checkpoint: () => {},
      }),
    });
    const dreamTask = tasks.tasks.find((t) => t.name === LANE_TASK.dream)!;
    await dreamTask.run();
    expect(server.requests.length).toBeGreaterThanOrEqual(1);
    expect(assigns()).toHaveLength(1);
    expect(assigns()[0]!.topic).toBe(gardenTopic);
  });

  test("the lane's dream task starts its one deadline before the decide pass", async () => {
    const { gardenTopic } = seedStore();
    scriptGardenRoute();
    // How many decision requests had arrived each time a dream deadline
    // was started: one deadline, started before any request.
    const startedAfter: number[] = [];
    const before = server.requests.length;
    const tasks = buildLaneTasks({
      vault,
      configPath,
      searchConfig: resolveSearchConfig({ vault, configPath }),
      now: new Date(T0),
      forceCost: false,
      safeguardFor: (operation) => {
        if (operation === LANE_TASK.dream) startedAfter.push(server.requests.length - before);
        return { operation, timeoutMs: 60_000, checkpoint: () => {} };
      },
    });
    const dreamTask = tasks.tasks.find((t) => t.name === LANE_TASK.dream)!;
    await dreamTask.run();
    expect(startedAfter).toEqual([0]);
    expect(server.requests.length - before).toBeGreaterThanOrEqual(1);
    expect(assigns()[0]!.topic).toBe(gardenTopic);
  });
});
