/**
 * The nine topic and agent-context uses (brain-store-and-topics, design
 * D10): registered in the contract in order after `recall_inject`, off
 * unless `decision_model_uses` names them, each with a built-in threshold
 * and a primary threshold name. The shipped `jev-1.13` baseline was tuned
 * for the eight original uses only, so a new use needs a thresholds-store
 * entry (or a measured mark) before `enforce` acts; without one the
 * resolver holds it to `shadow` and lists it in `shadowOnlyUses`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decisionModelModeFor,
  parseDecisionModelUses,
  resolveDecisionModelConfig,
} from "../../../src/core/decision-model/config.ts";
import { DECISION_MODEL_USES } from "../../../src/core/decision-model/contract.ts";
import {
  BUILTIN_USE_THRESHOLDS,
  PRIMARY_THRESHOLD_NAME,
} from "../../../src/core/decision-model/questions.ts";
import {
  TOPIC_DECISION_LIMITS,
  TOPIC_USE_QUESTION_VERSION,
  TOPIC_USES,
} from "../../../src/core/decision-model/questions-topics.ts";
import {
  decisionThresholdsPath,
  resetThresholdsStoreCache,
  writeThresholdEntry,
} from "../../../src/core/decision-model/thresholds.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";

const BASELINE_USES = [
  "rerank",
  "answerable",
  "skills",
  "extract_prefilter",
  "dedup",
  "tension",
  "labels",
  "recall_inject",
] as const;

const KEY_VAR = "O2B_TEST_TOPIC_USES_KEY";

function typesafeConfig(uses: string): Record<string, string> {
  return {
    decision_model_enabled: "true",
    decision_model_provider: "typesafe",
    decision_model_env_key: KEY_VAR,
    decision_model_uses: uses,
  };
}

const ENV = { [KEY_VAR]: FAKE_DECISION_KEY } as NodeJS.ProcessEnv;

let tmp: string;
let storePath: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-dm-topic-uses-"));
  storePath = decisionThresholdsPath(join(tmp, "config.yaml"));
  resetThresholdsStoreCache();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  resetThresholdsStoreCache();
});

describe("the nine topic and agent-context uses are registered", () => {
  test("the contract lists seventeen uses, the nine new ones last, in order", () => {
    expect([...DECISION_MODEL_USES]).toEqual([...BASELINE_USES, ...TOPIC_USES]);
  });

  test("every use defaults to off", () => {
    const errors: string[] = [];
    const uses = parseDecisionModelUses(null, errors);
    expect(errors).toEqual([]);
    for (const use of DECISION_MODEL_USES) expect(uses[use]).toBe("off");
  });

  test("a new use parses from decision_model_uses", () => {
    const errors: string[] = [];
    const uses = parseDecisionModelUses("topic_route:shadow", errors);
    expect(errors).toEqual([]);
    expect(uses.topic_route).toBe("shadow");
  });

  test("each new use has a built-in threshold and a primary threshold name", () => {
    for (const use of TOPIC_USES) {
      expect(Object.hasOwn(BUILTIN_USE_THRESHOLDS, use)).toBe(true);
      expect(Object.hasOwn(PRIMARY_THRESHOLD_NAME, use)).toBe(true);
    }
    expect(BUILTIN_USE_THRESHOLDS.topic_route).toEqual({ route_min: 0.6 });
    expect(BUILTIN_USE_THRESHOLDS.event_kind).toEqual({ kind_min: 0.7 });
    expect(BUILTIN_USE_THRESHOLDS.human_readable).toEqual({ hide_below: 0.3 });
    expect(BUILTIN_USE_THRESHOLDS.topic_new).toEqual({ veto_below: 0.3 });
    expect(BUILTIN_USE_THRESHOLDS.topic_same).toEqual({ same_min: 0.7 });
    expect(BUILTIN_USE_THRESHOLDS.question_resolved).toEqual({ resolved_min: 0.7 });
    expect(BUILTIN_USE_THRESHOLDS.milestone_done).toEqual({ done_min: 0.8 });
    expect(BUILTIN_USE_THRESHOLDS.head_select).toEqual({ drop_below: 0.1 });
    expect(BUILTIN_USE_THRESHOLDS.neighbour_relevant).toEqual({ inject_min: 0.5 });
  });

  test("every new use has a question version and the shared limits are set", () => {
    for (const use of TOPIC_USES) {
      expect(Number.isInteger(TOPIC_USE_QUESTION_VERSION[use])).toBe(true);
      expect(TOPIC_USE_QUESTION_VERSION[use]).toBeGreaterThanOrEqual(1);
    }
    expect(TOPIC_DECISION_LIMITS.recordsPerPass).toBe(50);
    expect(TOPIC_DECISION_LIMITS.recordsPerRequest).toBe(10);
    expect(TOPIC_DECISION_LIMITS.topicOptionsPerQuestion).toBe(20);
    expect(TOPIC_DECISION_LIMITS.recordClipChars).toBe(900);
    expect(TOPIC_DECISION_LIMITS.headFieldClipChars).toBe(300);
    expect(TOPIC_DECISION_LIMITS.pairsPerPass).toBe(20);
    expect(TOPIC_DECISION_LIMITS.groupsPerPass).toBe(10);
    expect(TOPIC_DECISION_LIMITS.groupMembersShown).toBe(10);
    expect(TOPIC_DECISION_LIMITS.groupMemberClipChars).toBe(300);
    expect(TOPIC_DECISION_LIMITS.historyNotesPerPass).toBe(50);
    expect(TOPIC_DECISION_LIMITS.headsPerRequest).toBe(40);
    expect(TOPIC_DECISION_LIMITS.neighbourCandidatesPerTurn).toBe(20);
  });
});

describe("the shipped baseline covers the eight original uses only", () => {
  const allNineEnforce = `${TOPIC_USES.map((use) => `${use}:enforce`).join(",")}`;

  test("a new use set to enforce runs shadow on jev-1.13 without a store entry", () => {
    const cfg = resolveDecisionModelConfig({
      env: ENV,
      config: typesafeConfig(allNineEnforce),
      vault: null,
      thresholdsPath: null,
    });
    expect(cfg.status).toBe("active");
    expect(cfg.thresholdProfile).toBe("jev-1.13");
    expect(cfg.shadowOnlyUses).toEqual([...TOPIC_USES]);
    for (const use of TOPIC_USES) {
      expect(cfg.configuredUses[use]).toBe("enforce");
      expect(decisionModelModeFor(cfg, use)).toBe("shadow");
    }
    for (const use of BASELINE_USES) {
      expect(decisionModelModeFor(cfg, use)).toBe("off");
    }
  });

  test("the eight original uses still enforce on jev-1.13", () => {
    const allEnforce = `${DECISION_MODEL_USES.map((use) => `${use}:enforce`).join(",")}`;
    const cfg = resolveDecisionModelConfig({
      env: ENV,
      config: typesafeConfig(allEnforce),
      vault: null,
      thresholdsPath: null,
    });
    expect(cfg.status).toBe("active");
    expect(cfg.shadowOnlyUses).toEqual([...TOPIC_USES]);
    for (const use of BASELINE_USES) expect(decisionModelModeFor(cfg, use)).toBe("enforce");
    for (const use of TOPIC_USES) expect(decisionModelModeFor(cfg, use)).toBe("shadow");
  });

  test("a thresholds-store entry for the model and the use lets it enforce", () => {
    // The store keys on the model id the server reports (here the hosted
    // baseline family's), never the preset name.
    const probe = resolveDecisionModelConfig({
      env: ENV,
      config: typesafeConfig("topic_route:enforce"),
      vault: null,
      thresholdsPath: null,
    });
    writeThresholdEntry(storePath, String(probe.model), "topic_route", {
      values: { route_min: 0.6 },
      source: "set",
    });
    resetThresholdsStoreCache();
    const cfg = resolveDecisionModelConfig({
      env: ENV,
      config: typesafeConfig("topic_route:enforce"),
      vault: null,
      thresholdsPath: storePath,
    });
    expect(cfg.status).toBe("active");
    expect(cfg.shadowOnlyUses).toEqual([]);
    expect(decisionModelModeFor(cfg, "topic_route")).toBe("enforce");
  });
});
