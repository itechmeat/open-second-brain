/**
 * The dream work queue's surfaces (design D8, spec "The queue is
 * visible"): the doctor codes on a built queue, the queue section of the
 * dream owner status, and `o2b dream queue` (listing, JSON, retry,
 * cancel, and the refusal of retry and cancel off the owner's device).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  claimDreamOwner,
  claimSettled,
  readDreamOwner,
} from "../../src/core/brain/dream-owner/owner.ts";
import {
  answerWork,
  dreamQueueOn,
  produceWork,
  takeWork,
  type ProduceSpec,
} from "../../src/core/brain/dream-queue/queue.ts";
import { appendRecord } from "../../src/core/store/appender.ts";
import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { initStore } from "../../src/core/store/store-init.ts";
import { openStore } from "../../src/core/store/store-open.ts";
import { listShards } from "../../src/core/store/shard-list.ts";
import { partitionDir } from "../../src/core/store/store-paths.ts";
import {
  FIXTURE_CLOSED,
  registerFixtureOperations,
  type FixtureOperations,
} from "../helpers/dream-queue-fixtures.ts";
import { homeEnv } from "../helpers/platform.ts";
import { runCli } from "../helpers/run-cli.ts";

let parent: string;
let storeRoot: string;
let configPath: string;
let ops: FixtureOperations;
let parkedId: string;
let readyId: string;
const savedEnv = new Map<string, string | undefined>();

const env = (device: string) => ({
  OPEN_SECOND_BRAIN_CONFIG: configPath,
  [STORE_ROOT_ENV]: storeRoot,
  O2B_DEVICE_ID: device,
  ...homeEnv(join(parent, "home")),
  XDG_CONFIG_HOME: join(parent, "config"),
  XDG_DATA_HOME: join(parent, "data"),
  XDG_STATE_HOME: join(parent, "state"),
  XDG_CACHE_HOME: join(parent, "cache"),
  LOCALAPPDATA: join(parent, "state"),
});

const spec = (subject: string, operation = FIXTURE_CLOSED): ProduceSpec => ({
  operation,
  subject,
  occurrence: `2026-11-20/${subject}`,
  input: subject,
  prompt_version: "1",
  schema_version: "1",
  answer_schema: {},
  after: [],
  resources: [],
  evidence: [],
  payload: {},
  sources: ["shared"],
});

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-dream-queue-cli-"));
  for (const key of [
    "HOME",
    "USERPROFILE",
    "OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S",
    "OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "LOCALAPPDATA",
    "APPDATA",
  ])
    savedEnv.set(key, process.env[key]);
  Object.assign(process.env, homeEnv(join(parent, "home")));
  process.env["XDG_CONFIG_HOME"] = join(parent, "config");
  process.env["XDG_DATA_HOME"] = join(parent, "data");
  process.env["XDG_STATE_HOME"] = join(parent, "state");
  process.env["XDG_CACHE_HOME"] = join(parent, "cache");
  process.env["LOCALAPPDATA"] = join(parent, "state");
  storeRoot = join(parent, "store");
  configPath = join(parent, "config.yaml");
  writeFileSync(configPath, "agent_name: claude\n");
  initStore({ root: storeRoot });
  ops = registerFixtureOperations();
  // Everything happens three days ago, so the ready item is a backlog now.
  let clock = Date.now() - 72 * 60 * 60_000;
  const now = () => (clock += 1000);
  const a = openStore({ root: storeRoot, device: "dev-a" });
  claimDreamOwner(a, "claude", { writer: "o2b", authority: "human", now });
  claimSettled(a, readDreamOwner(a, now));
  const q = dreamQueueOn(a, { vault: null, writer: "o2b", now: () => clock });
  readyId = produceWork(q, spec("ready")).id;
  parkedId = produceWork(q, spec("parked")).id;
  produceWork(q, spec("newer", "from-a-newer-release"));
  // "parked" sorts before "ready", so each take after its backoff leases it.
  for (let i = 0; i < 5; i++) {
    const taken = takeWork(q, { run: `r${i}` });
    expect(taken.item?.id).toBe(parkedId);
    answerWork(q, {
      item: parkedId,
      generation: taken.item!.generation,
      lease_token: taken.item!.lease_token,
      value: "bad",
      agent: "a",
      model: "m",
    });
    clock += 7 * 60 * 60_000;
  }
  // A lease another device wrote: the fold rejects it.
  const b = openStore({ root: storeRoot, device: "dev-b" });
  appendRecord(b, {
    partition: "shared",
    stream: "dream-work",
    kind: "dream-work-lease",
    agent: "o2b",
    body: {
      item: readyId,
      generation: 9,
      lease_token: "foreign",
      run: "x",
      owner_revision: "r",
      expires_at: new Date().toISOString(),
    },
  });
});

afterEach(() => {
  ops.unregister();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

type Finding = { code: string; message: string };

describe("doctor", () => {
  test("reports parked items, the backlog, no executor, unknown operations and rejected records", async () => {
    const res = await runCli(["brain", "doctor", "--json"], { env: env("dev-a") });
    const out = JSON.parse(res.stdout) as {
      errors?: Finding[];
      warnings?: Finding[];
      uncertain?: Finding[];
    };
    const pick = (list: Finding[] | undefined) =>
      (list ?? []).filter((f) => f.code.startsWith("dream-queue"));
    const errors = pick(out.errors);
    expect(errors.map((f) => f.code)).toEqual(["dream-queue-parked"]);
    expect(errors[0]!.message).toContain(`o2b dream queue retry ${parkedId}`);
    expect(errors[0]!.message).toContain("the value must be yes or no");
    const warnings = pick(out.warnings)
      .map((f) => f.code)
      .toSorted();
    expect(warnings).toEqual([
      "dream-queue-backlog",
      "dream-queue-rejected",
      "dream-queue-unknown-operation",
    ]);
    const unknown = pick(out.warnings).find((f) => f.code === "dream-queue-unknown-operation")!;
    expect(unknown.message).toContain("from-a-newer-release");
    expect(pick(out.uncertain).map((f) => f.code)).toEqual(["dream-queue-no-executor"]);
  });

  test("does not report backlog from an incomplete queue snapshot", async () => {
    const a = openStore({ root: storeRoot, device: "dev-a" });
    const q = dreamQueueOn(a, { vault: null, writer: "o2b" });
    produceWork(q, { ...spec("private-unreadable"), sources: ["shared", "private"] });
    const shard = listShards(partitionDir(storeRoot, "private"), { stream: "dream-work" })[0]!;
    renameSync(shard.path, `${shard.path}.hidden`);

    const res = await runCli(["brain", "doctor", "--json"], { env: env("dev-a") });
    const out = JSON.parse(res.stdout) as { warnings?: Finding[] };
    expect((out.warnings ?? []).map((finding) => finding.code)).not.toContain(
      "dream-queue-backlog",
    );
  });
});

describe("the dream owner status", () => {
  test("carries a queue section in text and JSON", async () => {
    const json = await runCli(["dream", "owner", "--json"], { env: env("dev-a") });
    const parsed = JSON.parse(json.stdout) as { queue: { counts: Record<string, number> } };
    expect(parsed.queue.counts).toMatchObject({ waiting: 2, parked: 1 });
    const text = await runCli(["dream", "owner"], { env: env("dev-a") });
    expect(text.stdout).toContain("Dream work queue:");
  });
});

describe("o2b dream queue", () => {
  test("JSON identifies an unbound queue refusal", async () => {
    storeRoot = join(parent, "unbound-store");
    initStore({ root: storeRoot });
    const refused = await runCli(["dream", "queue", "retry", readyId, "--json"], {
      env: env("dev-a"),
    });
    expect(refused.returncode).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, code: "dream_queue_unbound" });
  });

  test("lists the queue as text and as one JSON document", async () => {
    const text = await runCli(["dream", "queue"], { env: env("dev-b") });
    expect(text.returncode).toBe(0);
    expect(text.stdout).toContain(parkedId);
    expect(text.stdout).toContain("parked");
    const json = await runCli(["dream", "queue", "--json"], { env: env("dev-b") });
    expect(json.returncode).toBe(0);
    const doc = JSON.parse(json.stdout) as {
      counts: Record<string, number>;
      items: Array<{ id: string; state: string }>;
    };
    expect(doc.counts["parked"]).toBe(1);
    expect(doc.items.map((i) => i.id)).toContain(readyId);
    const parkedOnly = await runCli(["dream", "queue", "--json", "--state", "parked"], {
      env: env("dev-b"),
    });
    expect((JSON.parse(parkedOnly.stdout) as typeof doc).items.map((i) => i.id)).toEqual([
      parkedId,
    ]);
  });

  test("retry and cancel are refused off the owner's device", async () => {
    const retry = await runCli(["dream", "queue", "retry", parkedId, "--json"], {
      env: env("dev-b"),
    });
    expect(retry.returncode).toBe(1);
    expect(retry.stderr).toContain("not the dream owner");
    expect(JSON.parse(retry.stdout)).toMatchObject({ ok: false, code: "dream_not_owner" });
    const cancel = await runCli(["dream", "queue", "cancel", readyId, "--reason", "x"], {
      env: env("dev-b"),
    });
    expect(cancel.returncode).toBe(1);
  });

  test("retry offers a parked item again and cancel closes one, on the owner's device", async () => {
    const retry = await runCli(["dream", "queue", "retry", parkedId], { env: env("dev-a") });
    expect(retry.returncode).toBe(0);
    const cancel = await runCli(["dream", "queue", "cancel", readyId, "--reason", "not needed"], {
      env: env("dev-a"),
    });
    expect(cancel.returncode).toBe(0);
    const doc = JSON.parse(
      (await runCli(["dream", "queue", "--json"], { env: env("dev-a") })).stdout,
    ) as { items: Array<{ id: string; state: string; attempts: number }> };
    expect(doc.items.find((i) => i.id === parkedId)).toMatchObject({
      state: "waiting",
      attempts: 0,
    });
    expect(doc.items.find((i) => i.id === readyId)?.state).toBe("closed");
    const again = await runCli(["dream", "queue", "retry", parkedId], { env: env("dev-a") });
    expect(again.returncode).toBe(1);
  });
});
