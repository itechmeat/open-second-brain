/**
 * The rollup ladder's model step is queued (design D7, spec "The rollup
 * ladder's model step is queued", "The queue needs the brain store",
 * "Accepted is not finished" scenario "A dry run").
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dream } from "../../../../src/core/brain/dream.ts";
import { stageDream, validateDreamBundle } from "../../../../src/core/brain/dream-stage.ts";
import { assertDreamOwner } from "../../../../src/core/brain/dream-owner/gate.ts";
import { claimDreamOwner } from "../../../../src/core/brain/dream-owner/owner.ts";
import { appendRecord } from "../../../../src/core/store/appender.ts";
import {
  DREAM_WORK_CLOSED_KIND,
  DREAM_WORK_EVIDENCE_MAX,
  DREAM_WORK_STREAM,
} from "../../../../src/core/brain/dream-queue/constants.ts";
import * as queueModule from "../../../../src/core/brain/dream-queue/queue.ts";
import {
  dreamQueueOn,
  readDreamWork,
  releaseWork,
  takeWork,
} from "../../../../src/core/brain/dream-queue/queue.ts";
import { dreamWorkOperation } from "../../../../src/core/brain/dream-queue/operations.ts";
import { dreamWorkInputHash } from "../../../../src/core/brain/dream-queue/records.ts";
import {
  produceRollupWork,
  ROLLUP_SUMMARY_OPERATION,
} from "../../../../src/core/brain/dream-queue/rollup-work.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { setBrainSetting } from "../../../../src/core/brain/policy/settings-write.ts";
import { writePreference } from "../../../../src/core/brain/preference.ts";
import { applySalienceGate, gateSalience } from "../../../../src/core/brain/salience-gate.ts";
import type { RollupLadderPlan } from "../../../../src/core/brain/rollup-ladder.ts";
import { STORE_ROOT_ENV } from "../../../../src/core/store/constants.ts";
import { readStreamRecords } from "../../../../src/core/store/read/stream-read.ts";
import { initStore } from "../../../../src/core/store/store-init.ts";
import { openStore, type StoreHandle } from "../../../../src/core/store/store-open.ts";
import { withDeviceId } from "../../../helpers/device-id.ts";
import { homeEnv } from "../../../helpers/platform.ts";

let tmp: string;
let vault: string;
let storeRoot: string;
let configPath: string;
const saved: Record<string, string | undefined> = {};
const NOW = new Date("2026-11-20T12:00:00Z");

function seed(slug: string): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `Rule ${slug}`,
    created_at: "2026-10-01T00:00:00Z",
    unconfirmed_until: "2026-10-15T00:00:00Z",
    status: "confirmed",
    evidenced_by: [],
    confirmed_at: "2026-10-05T00:00:00Z",
    applied_count: 3,
    violated_count: 0,
    last_evidence_at: "2026-11-10T00:00:00Z",
    confidence: "medium",
  });
}

function store(): StoreHandle {
  return openStore({ root: storeRoot, device: "dev-a" });
}

function items() {
  const state = readDreamWork(store(), { now: NOW.getTime() });
  return state.order.map((id) => state.items.get(id)!);
}

function workRecordCount(): number {
  return ["shared", "private"].reduce(
    (n, p) =>
      n +
      readStreamRecords(storeRoot, p as "shared" | "private", { stream: DREAM_WORK_STREAM }).records
        .length,
    0,
  );
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-dream-queue-rollup-"));
  vault = join(tmp, "vault");
  storeRoot = join(tmp, "store");
  configPath = join(tmp, "config.yaml");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "note.md"), "# A note\n");
  initStore({ root: storeRoot });
  writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  for (const key of ["OPEN_SECOND_BRAIN_CONFIG", STORE_ROOT_ENV, "O2B_DEVICE_ID", "VAULT_DIR"]) {
    saved[key] = process.env[key];
  }
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
    saved[key] = process.env[key];
  Object.assign(process.env, homeEnv(join(tmp, "home")));
  process.env["XDG_CONFIG_HOME"] = join(tmp, "config");
  process.env["XDG_DATA_HOME"] = join(tmp, "data");
  process.env["XDG_STATE_HOME"] = join(tmp, "state");
  process.env["XDG_CACHE_HOME"] = join(tmp, "cache");
  process.env["LOCALAPPDATA"] = join(tmp, "state");
  delete process.env["VAULT_DIR"];
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  process.env[STORE_ROOT_ENV] = storeRoot;
  process.env["O2B_DEVICE_ID"] = "dev-a";
  claimDreamOwner(store(), "claude", { writer: "o2b", authority: "human" });
  withDeviceId("dev-a", () => {
    try {
      assertDreamOwner(vault, { live: true, configPath });
    } catch {
      // the first look notes the claim
    }
  });
  setBrainSetting(
    { vault, authority: "human", agent: "t", configPath },
    "rollup.fact_threshold",
    3,
  );
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("the salience gate", () => {
  test("returns the admitted ids next to the verdict", () => {
    for (const s of ["a", "b", "c"]) seed(s);
    const preferences = ["a", "b", "c"].map((s) => ({
      path: join(vault, `pref-${s}.md`),
      pref: { id: `pref-${s}` } as never,
    }));
    const cfg = { dream: {} } as never;
    const result = gateSalience({ vault, preferences, cfg, now: NOW });
    expect(result.admitted_ids).toEqual(["pref-a", "pref-b", "pref-c"]);
    expect(result.verdict).toEqual(applySalienceGate({ vault, preferences, cfg, now: NOW }));
    expect(result.verdict.admitted).toBe(3);
  });
});

describe("a live pass", () => {
  test("a fired fact rung produces one item whose evidence is the admitted ids", () => {
    for (const s of ["a", "b", "c"]) seed(s);
    const summary = dream(vault, { now: NOW, agentName: "claude", configPath });
    expect(summary.rollups.map((r) => r.tier)).toEqual(["fact"]);
    const queued = items();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.body.operation).toBe(ROLLUP_SUMMARY_OPERATION);
    expect(queued[0]!.body.evidence).toEqual(["pref-a", "pref-b", "pref-c"]);
    expect(queued[0]!.body.resources).toEqual(["rung:fact"]);
    expect(queued[0]!.state).toBe("waiting");
    expect(summary.model_work).toEqual({ produced: 1, waiting: 1, applied: 0, abstained: 0 });

    // A second pass over the same state adds none.
    const again = dream(vault, { now: new Date(NOW.getTime() + 60_000), configPath });
    expect(again.rollups).toEqual([]);
    expect(items()).toHaveLength(1);
    expect(again.model_work).toEqual({ produced: 0, waiting: 1, applied: 0, abstained: 0 });

    // The next firing's item holds only the new ids.
    for (const s of ["d", "e", "f"]) seed(s);
    dream(vault, { now: new Date(NOW.getTime() + 120_000), configPath });
    const both = items();
    expect(both).toHaveLength(2);
    expect(both[1]!.body.evidence).toEqual(["pref-d", "pref-e", "pref-f"]);
  });

  test("a dry run, the staged stage and validate produce nothing", () => {
    for (const s of ["a", "b", "c"]) seed(s);
    const produce = spyOn(queueModule, "produceWork");
    const apply = spyOn(queueModule, "applyAccepted");
    try {
      const preview = dream(vault, { now: NOW, dryRun: true, configPath });
      expect(preview.rollups).toHaveLength(1);
      expect(preview.model_work).toBeUndefined();
      const bundle = stageDream(vault, { now: NOW, configPath });
      validateDreamBundle(vault, bundle.runId, { now: NOW, configPath });
      expect(produce).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
    } finally {
      produce.mockRestore();
      apply.mockRestore();
    }
    expect(workRecordCount()).toBe(0);
  });

  test("a failed rollup production is retried on the next pass", () => {
    for (const s of ["a", "b", "c"]) seed(s);
    const original = queueModule.produceWork;
    const produce = spyOn(queueModule, "produceWork");
    let fail = true;
    produce.mockImplementation((...args) => {
      if (fail) {
        fail = false;
        throw new Error("temporary queue write failure");
      }
      return original(...args);
    });
    try {
      const first = dream(vault, { now: NOW, agentName: "claude", configPath });
      expect(first.warnings.some((warning) => warning.code === "dream-queue-produce-failed")).toBe(
        true,
      );
      expect(items()).toHaveLength(0);
      const second = dream(vault, {
        now: new Date(NOW.getTime() + 60_000),
        agentName: "claude",
        configPath,
      });
      expect(second.rollups.map((r) => r.tier)).toEqual(["fact"]);
      expect(items()).toHaveLength(1);
    } finally {
      produce.mockRestore();
    }
  }, 60_000);
});

describe("produceRollupWork", () => {
  function plan(tiers: ReadonlyArray<"fact" | "rollup">, produced: number): RollupLadderPlan {
    return {
      fired: true,
      entries: tiers.map((tier) => ({
        tier,
        produces: tier === "fact" ? "rollup" : "identity",
        fromCount: 0,
        toCount: 1,
        newSinceLast: 1,
        envelope: {
          step: `rollup:${tier}`,
          prompt: "Consolidate.",
          schema_hints: [],
          target_path: `Brain/rollups/rollup-${tier}.md`,
        } as never,
      })),
      ledger: {
        version: 1,
        baselines: {},
        produced: { fact: produced, rollup: produced },
      },
    };
  }
  const queue = () => dreamQueueOn(store(), { vault, writer: "o2b", configPath });

  test("rollup answers reject malformed YAML and frontmatter without a mapping kind", () => {
    const validate = dreamWorkOperation(ROLLUP_SUMMARY_OPERATION)!.validate;
    const item = { body: { payload: {} } } as Parameters<typeof validate>[1];
    expect(validate({ text: "---\nkind: [\n---\nbody" }, item)).not.toBeNull();
    expect(validate({ text: "---\nhello\n---\nbody" }, item)).not.toBeNull();
    expect(validate({ text: "---\nkind: rollup\n---\nbody" }, item)).toBeNull();
  });

  test("more than the bound produces bounded follow-up items in the same pass", () => {
    const ids = Array.from(
      { length: DREAM_WORK_EVIDENCE_MAX + 5 },
      (_, i) => `pref-x${String(i).padStart(4, "0")}`,
    );
    const first = produceRollupWork(queue(), {
      plan: plan(["fact"], 1),
      admittedIds: ids,
      day: "2026-11-20",
    });
    expect(first.produced).toBe(2);
    expect(first.left).toBe(5);
    const [item, followup] = items();
    expect(item!.body.evidence).toHaveLength(DREAM_WORK_EVIDENCE_MAX);
    expect(item!.body.payload["left_for_next_firing"]).toBe(0);
    expect(followup!.body.evidence).toEqual(ids.slice(DREAM_WORK_EVIDENCE_MAX));
    expect(followup!.body.evidence).toHaveLength(5);
  });

  test("chooses a partition for each fact chunk", () => {
    const ids = Array.from({ length: DREAM_WORK_EVIDENCE_MAX }, (_, i) => {
      const slug = `a${String(i).padStart(3, "0")}`;
      seed(slug);
      return `pref-${slug}`;
    });
    ids.push("pref-unknown");
    const q = queue();
    const original = queueModule.produceWork;
    const produce = spyOn(queueModule, "produceWork");
    let calls = 0;
    produce.mockImplementation((...args) => {
      calls += 1;
      if (calls === 2) throw new Error("temporary queue write failure");
      return original(...args);
    });
    try {
      expect(() =>
        produceRollupWork(q, {
          plan: plan(["fact"], 1),
          admittedIds: ids,
          day: "2026-11-20",
        }),
      ).toThrow("temporary queue write failure");
    } finally {
      produce.mockRestore();
    }
    expect(items().map((item) => item.partition)).toEqual(["shared"]);
    produceRollupWork(q, { plan: plan(["fact"], 1), admittedIds: ids, day: "2026-11-20" });
    expect(items().map((item) => item.partition)).toEqual(["shared", "private"]);
    expect(
      items()
        .flatMap((item) => item.body.evidence)
        .toSorted(),
    ).toEqual(ids.toSorted());
  }, 60_000);

  test("the identity rung names the fact rung's items as evidence and the unfinished in after", () => {
    const result = produceRollupWork(queue(), {
      plan: plan(["fact", "rollup"], 1),
      admittedIds: ["pref-a", "pref-b"],
      day: "2026-11-20",
    });
    expect(result.produced).toBe(2);
    const [fact, identity] = items();
    expect(fact!.body.resources).toEqual(["rung:fact"]);
    expect(identity!.body.resources).toEqual(["rung:rollup"]);
    expect(identity!.body.evidence).toEqual([fact!.id]);
    expect(identity!.body.after).toEqual([fact!.id]);
    expect(identity!.ready).toBe(false);
  });

  test("a superseded lower item keeps its resolved identity in higher-rung evidence", () => {
    const q = queue();
    const rungSpec = (
      tier: "fact" | "rollup",
      subject: string,
      input: unknown,
      evidence: string[],
    ) => ({
      operation: ROLLUP_SUMMARY_OPERATION,
      subject,
      occurrence: "2026-11-20/000001",
      input,
      prompt_version: "1",
      schema_version: "1",
      answer_schema: { type: "text" },
      after: [] as string[],
      resources: [],
      evidence,
      payload: { tier },
      sources: ["shared"] as const,
    });
    const old = queueModule.produceWork(q, rungSpec("fact", "lower", ["a"], ["pref-a"]));
    const higher = queueModule.produceWork(q, rungSpec("rollup", "higher", [old.id], [old.id]));
    const successor = queueModule.produceWork(q, rungSpec("fact", "lower", ["b"], ["pref-b"]));
    appendRecord(
      store(),
      {
        partition: "shared",
        stream: DREAM_WORK_STREAM,
        kind: DREAM_WORK_CLOSED_KIND,
        agent: "o2b",
        body: {
          item: old.id,
          reason: "superseded",
          note: "input changed",
          successor: successor.id,
          authority: "agent",
        },
      },
      { now: () => NOW.getTime() + 100 },
    );
    const currentHigher = readDreamWork(store(), { now: NOW.getTime() }).items.get(higher.id)!;
    const current = dreamWorkOperation(ROLLUP_SUMMARY_OPERATION)!.currentInput(currentHigher, {
      store: store(),
      vault,
      configPath,
      now: NOW.getTime(),
    });
    expect(current).toEqual({
      input_hash: dreamWorkInputHash([successor.id]),
      evidence: [successor.id],
    });
    expect(
      produceRollupWork(q, {
        plan: plan(["fact", "rollup"], 1),
        admittedIds: ["pref-a", "pref-b"],
        day: "2026-11-20",
      }).produced,
    ).toBe(0);
  });
});

describe("a brain that is not on the store", () => {
  test("the pass calls nothing of the queue and still reports the rung", () => {
    const legacy = join(tmp, "legacy");
    const legacyConfig = join(tmp, "legacy.yaml");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(legacyConfig, `vault: ${legacy}\n`);
    process.env["OPEN_SECOND_BRAIN_CONFIG"] = legacyConfig;
    rmSync(storeRoot, { recursive: true, force: true });
    process.env[STORE_ROOT_ENV] = join(tmp, "no-store");
    bootstrapBrain(legacy, { configPath: legacyConfig });
    const brainYaml = join(legacy, "Brain", "_brain.yaml");
    writeFileSync(
      brainYaml,
      `${require("node:fs").readFileSync(brainYaml, "utf8")}\nrollup:\n  fact_threshold: 2\n`,
    );
    const save = vault;
    vault = legacy;
    try {
      for (const s of ["a", "b"]) seed(s);
    } finally {
      vault = save;
    }
    const produce = spyOn(queueModule, "produceWork");
    const apply = spyOn(queueModule, "applyAccepted");
    try {
      const summary = dream(legacy, { now: NOW, configPath: legacyConfig });
      expect(summary.rollups.map((r) => r.tier)).toEqual(["fact"]);
      expect(summary.model_work).toBeUndefined();
      expect(produce).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
    } finally {
      produce.mockRestore();
      apply.mockRestore();
    }
    expect(existsSync(join(tmp, "no-store"))).toBe(false);
  });
});
