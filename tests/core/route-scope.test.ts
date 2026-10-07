import { describe, expect, test } from "bun:test";

import {
  createRouteScope,
  isRouteStageName,
  noteDecisionLatency,
  ROUTE_STAGE,
  ROUTE_STAGE_NAMES,
  timeStage,
  timeStageSync,
} from "../../src/core/route-scope.ts";

describe("route scope", () => {
  test("with no scope open, both helpers return the value of fn", async () => {
    expect(timeStageSync(ROUTE_STAGE.validate, () => 7)).toBe(7);
    expect(await timeStage(ROUTE_STAGE.documentWrite, async () => "ok")).toBe("ok");
  });

  test("a scope with no stage noted reports undefined", async () => {
    const scope = createRouteScope();
    await scope.run(async () => undefined);
    expect(scope.stages()).toBeUndefined();
    expect(scope.decisionMs()).toBeUndefined();
  });

  test("inside run, sync and async stages are recorded", async () => {
    const scope = createRouteScope();
    await scope.run(async () => {
      timeStageSync(ROUTE_STAGE.validate, () => 1);
      await timeStage(ROUTE_STAGE.logAppend, async () => 2);
    });
    const stages = scope.stages() ?? [];
    expect(stages.map((s) => s.name)).toEqual(["validate", "log_append"]);
    for (const stage of stages) {
      expect(Number.isFinite(stage.ms)).toBe(true);
      expect(stage.ms).toBeGreaterThanOrEqual(0);
    }
  });

  test("repeated names are summed in first-seen order", async () => {
    const scope = createRouteScope();
    await scope.run(async () => {
      timeStageSync(ROUTE_STAGE.writeReceipt, () => undefined);
      timeStageSync(ROUTE_STAGE.lint, () => undefined);
      timeStageSync(ROUTE_STAGE.writeReceipt, () => undefined);
    });
    expect((scope.stages() ?? []).map((s) => s.name)).toEqual(["write_receipt", "lint"]);
  });

  test("values are rounded to 0.1 ms", async () => {
    const scope = createRouteScope();
    await scope.run(async () => {
      await timeStage(ROUTE_STAGE.documentWrite, () => new Promise((r) => setTimeout(r, 3)));
    });
    const [stage] = scope.stages() ?? [];
    expect(stage).toBeDefined();
    expect(Math.round(stage!.ms * 10) / 10).toBe(stage!.ms);
  });

  test("an error inside a stage still records and rethrows", async () => {
    const scope = createRouteScope();
    await scope.run(async () => {
      expect(() =>
        timeStageSync(ROUTE_STAGE.validate, () => {
          throw new Error("sync-boom");
        }),
      ).toThrow("sync-boom");
      await expect(
        timeStage(ROUTE_STAGE.idempotencyLookup, async () => {
          throw new Error("async-boom");
        }),
      ).rejects.toThrow("async-boom");
    });
    expect((scope.stages() ?? []).map((s) => s.name)).toEqual(["validate", "idempotency_lookup"]);
  });

  test("decisionMs sums noted decision latency and rounds to whole ms", async () => {
    const scope = createRouteScope();
    await scope.run(async () => {
      noteDecisionLatency(10.4);
      noteDecisionLatency(5.3);
      noteDecisionLatency(Number.NaN);
      noteDecisionLatency(-4);
    });
    expect(scope.decisionMs()).toBe(16);
    expect(createRouteScope().decisionMs()).toBeUndefined();
    noteDecisionLatency(3);
  });

  test("isRouteStageName accepts exactly the nine allowlisted names", () => {
    expect(ROUTE_STAGE_NAMES.size).toBe(9);
    for (const name of Object.values(ROUTE_STAGE)) expect(isRouteStageName(name)).toBe(true);
    for (const bad of ["Notes/private.md", "topic-x", "", "VALIDATE", 3, undefined, null]) {
      expect(isRouteStageName(bad)).toBe(false);
    }
  });
});
