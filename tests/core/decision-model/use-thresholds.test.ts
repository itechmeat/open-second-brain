/**
 * `appliedThreshold` (design D10, D13): the stored value of the answering
 * model decides, but only a probability. A value outside 0..1 (a
 * hand-edited or damaged store; the CLI refuses to write one) is ignored
 * and the built-in value applies.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveDecisionModelConfig } from "../../../src/core/decision-model/config.ts";
import { BUILTIN_USE_THRESHOLDS } from "../../../src/core/decision-model/questions.ts";
import {
  decisionThresholdsPath,
  resetThresholdsStoreCache,
  writeThresholdEntry,
} from "../../../src/core/decision-model/thresholds.ts";
import { appliedThreshold } from "../../../src/core/decision-model/use-thresholds.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetThresholdsStoreCache();
});

function configWith(values: Record<string, number>) {
  const dir = mkdtempSync(join(tmpdir(), "osb-use-thresholds-"));
  dirs.push(dir);
  const path = decisionThresholdsPath(join(dir, "config.yaml"));
  writeThresholdEntry(path, "kind-model", "event_kind", { values, source: "set" });
  resetThresholdsStoreCache();
  return resolveDecisionModelConfig({
    env: { O2B_TEST_UT_KEY: FAKE_DECISION_KEY } as NodeJS.ProcessEnv,
    config: {
      decision_model_enabled: "true",
      decision_model_provider: "compatible",
      decision_model_base_url: "https://decide.invalid/v1",
      decision_model_id: "kind-model",
      decision_model_env_key: "O2B_TEST_UT_KEY",
      decision_model_uses: "event_kind:enforce",
    },
    vault: null,
    thresholdsPath: path,
  })!;
}

describe("appliedThreshold", () => {
  test("a stored probability decides", () => {
    expect(
      appliedThreshold(configWith({ kind_min: 0.8 }), "event_kind", "kind-model", "kind_min"),
    ).toBe(0.8);
  });

  test.each([-1, 2, 1.0001])(
    "a stored %p outside 0..1 is ignored for the built-in value",
    (value) => {
      const builtin = BUILTIN_USE_THRESHOLDS.event_kind.kind_min as number;
      expect(
        appliedThreshold(configWith({ kind_min: value }), "event_kind", "kind-model", "kind_min"),
      ).toBe(builtin);
    },
  );
});
