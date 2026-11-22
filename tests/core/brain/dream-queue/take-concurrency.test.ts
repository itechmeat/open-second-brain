/**
 * Two real processes take from one store on one device at the same
 * moment (spec "One live lease per item", scenario "Two workers on the
 * owner's machine"): no item is leased twice. Kept in a file of its own:
 * it spawns processes.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  claimDreamOwner,
  claimSettled,
  readDreamOwner,
} from "../../../../src/core/brain/dream-owner/owner.ts";
import { dreamQueueOn, produceWork } from "../../../../src/core/brain/dream-queue/queue.ts";
import { readStreamRecords } from "../../../../src/core/store/read/stream-read.ts";
import { STORE_ROOT_ENV } from "../../../../src/core/store/constants.ts";
import {
  registerFixtureOperations,
  FIXTURE_CLOSED,
} from "../../../helpers/dream-queue-fixtures.ts";
import { homeEnv } from "../../../helpers/platform.ts";
import { makeMachines, type Machines } from "../../view/fixtures/machines.ts";

const ITEMS = 12;
let m: Machines;
beforeEach(() => {
  m = makeMachines(["dev-a"], "osb-dream-queue-two-");
});
afterEach(() => m.cleanup());

test("two processes taking at once never lease one item twice", async () => {
  const store = m.open("dev-a");
  claimDreamOwner(store, "claude", { writer: "o2b", authority: "human" });
  claimSettled(store, readDreamOwner(store));
  const ops = registerFixtureOperations();
  try {
    const queue = dreamQueueOn(store, { vault: null, writer: "o2b" });
    for (let i = 0; i < ITEMS; i++) {
      produceWork(queue, {
        operation: FIXTURE_CLOSED,
        subject: `s${i}`,
        occurrence: `2026-11-20/${String(i).padStart(3, "0")}`,
        input: i,
        prompt_version: "1",
        schema_version: "1",
        answer_schema: {},
        after: [],
        resources: [],
        evidence: [],
        payload: {},
        sources: ["shared"],
      });
    }
  } finally {
    ops.unregister();
  }
  const stateHome = join(m.parent, "state", "dev-a");
  const home = join(m.parent, "home", "dev-a");
  const configPath = join(m.parent, "config.yaml");
  writeFileSync(configPath, "\n");
  const goFile = join(m.parent, "go");
  const worker = join(import.meta.dir, "fixtures", "take-worker.ts");
  const ready = [0, 1].map((i) => join(m.parent, `ready-${i}`));
  const childEnv = {
    ...process.env,
    ...homeEnv(home),
    XDG_CONFIG_HOME: join(m.parent, "config"),
    XDG_DATA_HOME: join(m.parent, "data"),
    XDG_STATE_HOME: stateHome,
    XDG_CACHE_HOME: join(m.parent, "cache"),
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    [STORE_ROOT_ENV]: m.root("dev-a"),
    O2B_DEVICE_ID: "dev-a",
  };
  const children = ready.map((readyFile) =>
    Bun.spawn([process.execPath, worker, m.root("dev-a"), "dev-a", stateHome, readyFile, goFile], {
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const readyBy = Date.now() + 30_000;
  while (!ready.every((f) => existsSync(f)) && Date.now() < readyBy) await Bun.sleep(5);
  if (!ready.every((f) => existsSync(f))) {
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.exited));
    throw new Error("a take worker did not reach the start barrier");
  }
  writeFileSync(goFile, "go\n");
  const [codes, outs, errs] = await Promise.all([
    Promise.all(children.map((c) => c.exited)),
    Promise.all(children.map((c) => new Response(c.stdout).text())),
    Promise.all(children.map((c) => new Response(c.stderr).text())),
  ]);
  expect(errs.filter((e) => e.trim() !== "")).toEqual([]);
  expect(codes).toEqual([0, 0]);
  const taken = outs.flatMap((o) => o.split("\n").filter((l) => l !== ""));
  expect(taken).toHaveLength(ITEMS);
  expect(new Set(taken).size).toBe(ITEMS);
  const leases = readStreamRecords(m.root("dev-a"), "shared", {
    stream: "dream-work",
  }).records.filter((r) => r.kind === "dream-work-lease");
  expect(leases).toHaveLength(ITEMS);
  expect(new Set(leases.map((r) => r.body["item"])).size).toBe(ITEMS);
}, 60_000);
