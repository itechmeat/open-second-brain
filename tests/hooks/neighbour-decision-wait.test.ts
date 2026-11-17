/**
 * The neighbour-updates lane's decision wait, without a subprocess: the
 * request gets the rest of the lane's budget and never more than half the
 * hook's process ceiling, measured from the hook's start. The elapsed time
 * is passed in, so these tests do not depend on how fast a process starts.
 * The subprocess tests in `neighbour-updates.test.ts` prove the hook emits
 * before its ceiling; this file proves which bound ends the wait.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LANE_BUDGET_MS, neighbourDecisionWaitMs } from "../../hooks/neighbour-updates.ts";
import { runNeighbourRelevant } from "../../src/core/agent-context/neighbour-relevant.ts";
import { resolveDecisionModelConfig } from "../../src/core/decision-model/config.ts";
import { MIN_REQUEST_MS } from "../../src/core/decision-model/request-floor.ts";
import { FAKE_DECISION_KEY } from "../helpers/fake-credentials.ts";
import { type FakeSystemOne, startFakeSystemOne } from "../helpers/fake-decision-provider.ts";

const dirs: string[] = [];
let server: FakeSystemOne | null = null;
afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (server !== null) {
    await server.close();
    server = null;
  }
});

/** A ceiling whose half ends the wait before the lane's budget does. */
const SMALL_CEILING_MS = 1400;

describe("the neighbour lane's decision wait", () => {
  test("half a small ceiling ends the wait before the lane's budget", () => {
    expect(SMALL_CEILING_MS / 2).toBeLessThan(LANE_BUDGET_MS);
    expect(neighbourDecisionWaitMs(SMALL_CEILING_MS, 0)).toBe(SMALL_CEILING_MS / 2);
    expect(neighbourDecisionWaitMs(SMALL_CEILING_MS, 300)).toBe(SMALL_CEILING_MS / 2 - 300);
    expect(neighbourDecisionWaitMs(SMALL_CEILING_MS, SMALL_CEILING_MS)).toBe(0);
  });

  test("under a large ceiling the lane's budget ends the wait", () => {
    expect(neighbourDecisionWaitMs(10_000, 0)).toBe(LANE_BUDGET_MS);
    expect(neighbourDecisionWaitMs(10_000, 400)).toBe(LANE_BUDGET_MS - 400);
    expect(neighbourDecisionWaitMs(10_000, LANE_BUDGET_MS + 1)).toBe(0);
  });

  test("a provider that never answers within a configured budget past the ceiling is asked, and the deterministic gate stands at the end of the wait", async () => {
    const vault = mkdtempSync(join(tmpdir(), "osb-neighbour-wait-"));
    mkdirSync(join(vault, "Brain"), { recursive: true });
    dirs.push(vault);
    server = await startFakeSystemOne();
    server.setReply(() => ({ hang: true }));
    const env = { O2B_TEST_WAIT_KEY: FAKE_DECISION_KEY };
    const config = resolveDecisionModelConfig({
      env: env as NodeJS.ProcessEnv,
      config: {
        decision_model_enabled: "true",
        decision_model_provider: "compatible",
        decision_model_base_url: server.url,
        decision_model_id: "nb-model",
        decision_model_env_key: "O2B_TEST_WAIT_KEY",
        decision_model_uses: "neighbour_relevant:enforce",
        decision_model_hook_budget_ms: "60000",
      },
      vault,
      thresholdsPath: null,
    });
    // The hook's start, as the lane sees it: nothing elapsed yet.
    const remainingMs = neighbourDecisionWaitMs(SMALL_CEILING_MS, 0);
    expect(remainingMs).toBeGreaterThanOrEqual(MIN_REQUEST_MS);
    const out = await runNeighbourRelevant({
      config,
      candidates: [
        {
          record: "rec-2",
          kind: "decision",
          topic: "01KA0000000000000000000001",
          topicTitle: "Shard writer",
          text: "pending decision on the session topic",
          seq: 1,
          device: "dev-b",
          agent: "neighbour",
          private: false,
          titlePrivate: false,
        },
      ],
      prompt: "Work.",
      remainingMs,
      env,
    });
    // Asked once: the wait ended on its deadline, not on a skipped request.
    expect(server.requests).toHaveLength(1);
    expect(out.applied).toBe(false);
    expect(out.judged.size).toBe(0);
  });
});
