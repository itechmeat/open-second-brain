/**
 * Folds never call a model (task 4.1, the "Verify" line): the topic
 * fold, the store folds, the planner and the view renderers read stored
 * verdicts only. Proven at runtime, by running them all with every use
 * armed `enforce` against a local fake provider and asserting it
 * received no request: a behavioural proof, which an import inventory
 * (blind to dynamic imports and renames) would only duplicate.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { discoverConfig } from "../../../src/core/config.ts";

import { dream } from "../../../src/core/brain/dream.ts";
import { readPinnedContext } from "../../../src/core/brain/pinned.ts";
import {
  resolveDecisionModelConfig,
  decisionModelModeFor,
} from "../../../src/core/decision-model/config.ts";
import { DECISION_MODEL_USES } from "../../../src/core/decision-model/contract.ts";
import { BUILTIN_USE_THRESHOLDS } from "../../../src/core/decision-model/questions.ts";
import {
  decisionThresholdsPath,
  resetThresholdsStoreCache,
  writeThresholdEntry,
} from "../../../src/core/decision-model/thresholds.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { foldPreferences } from "../../../src/core/store/fold-preferences.ts";
import { foldSettings } from "../../../src/core/store/fold-settings.ts";
import { inspectStore, type StoreHandle } from "../../../src/core/store/store-open.ts";
import { foldTopics } from "../../../src/core/topics/fold.ts";
import { readTopicsOf } from "../../../src/core/topics/read.ts";
import { reviewTopics } from "../../../src/core/topics/plan.ts";
import { partitionRecords } from "../../../src/core/view/catch-up.ts";
import { catchUp } from "../../../src/core/view/catch-up.ts";
import { buildPages } from "../../../src/core/view/render.ts";
import {
  AUTO_NOW,
  makeAutoViewEnv,
  makeLegacyDreamVault,
  seedWriterStore,
  type AutoViewEnv,
} from "../view/fixtures/auto-env.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";
import { startFakeSystemOne, type FakeSystemOne } from "../../helpers/fake-decision-provider.ts";

describe("folds never call a model", () => {
  describe("runtime: every fold over an armed store sends nothing", () => {
    let server: FakeSystemOne;
    let env: AutoViewEnv;
    let vault: string;
    let store: StoreHandle;

    beforeAll(async () => {
      server = await startFakeSystemOne();
    });
    afterAll(async () => {
      await server.close();
    });

    const saved: Record<string, string | undefined> = {};
    const ENV_KEYS = ["OPEN_SECOND_BRAIN_CONFIG", "O2B_TEST_FOLDS_KEY"] as const;

    afterEach(() => {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      env.cleanup();
    });

    beforeEach(() => {
      env = makeAutoViewEnv("o2b-folds-no-model-");
      vault = makeLegacyDreamVault(env.parent);
      store = seedWriterStore(env.root);
      // Seed one unassigned record so the passes have something to read.
      appendRecord(
        store,
        {
          partition: "shared",
          stream: "events",
          kind: "signal",
          agent: "agent-1",
          body: {
            id: "sig-2026-11-06-f0",
            path: "Brain/inbox/f0.md",
            staged: false,
            frontmatter: {
              principle: "Release notes list every migration step",
              project: "o2b",
              session: "s1",
            },
            raw: null,
            raw_shape: "bare",
          },
        },
        { now: () => AUTO_NOW - 5_000 },
      );
    });

    test("foldTopics, readTopics, the store folds, the renders and a dream pass send nothing", () => {
      // Everything armed: every use enforce, a key set, the endpoint the
      // fake server, in the machine config the process reads; the
      // thresholds store tunes every use so nothing downgrades to shadow.
      const configPath = join(env.parent, "config.yaml");
      writeFileSync(
        configPath,
        [
          "decision_model_enabled: true",
          "decision_model_provider: compatible",
          `decision_model_base_url: ${server.url}`,
          "decision_model_id: fold-model",
          "decision_model_env_key: O2B_TEST_FOLDS_KEY",
          `decision_model_uses: ${[...DECISION_MODEL_USES].map((u) => `${u}:enforce`).join(",")}`,
        ].join("\n") + "\n",
      );
      for (const key of ENV_KEYS) saved[key] = process.env[key];
      process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
      process.env["O2B_TEST_FOLDS_KEY"] = FAKE_DECISION_KEY;
      const thresholdsPath = decisionThresholdsPath(configPath);
      for (const use of DECISION_MODEL_USES) {
        writeThresholdEntry(thresholdsPath, "fold-model", use, {
          values: { ...BUILTIN_USE_THRESHOLDS[use] },
          source: "set",
        });
      }
      resetThresholdsStoreCache();
      // The configuration every call below discovers is the armed one.
      const cfg = resolveDecisionModelConfig({
        env: process.env,
        config: discoverConfig().data,
        vault: null,
      });
      expect(cfg.status).toBe("active");
      for (const use of DECISION_MODEL_USES) {
        expect(`${use}:${decisionModelModeFor(cfg, use)}`).toBe(`${use}:enforce`);
      }

      // Now every fold, planner and renderer, exactly as a pass runs them.
      const read = catchUp(store, () => AUTO_NOW);
      const records = [...read.records.values()].flat();
      const fold = foldTopics(records);
      const topics = readTopicsOf(inspectStore(env.root)!);
      expect(topics.unreadable).toEqual([]);
      foldPreferences(records);
      foldSettings(partitionRecords(read, "shared"));
      readPinnedContext(vault);
      reviewTopics(fold, AUTO_NOW, 30);
      buildPages(store, read);
      expect(dream(vault).topics?.report.status).toBe("waiting-for-claim");
      const second = dream(vault);
      expect(["planned", "not-writer", "no-writer"]).toContain(
        second.topics?.report.status ?? "none",
      );

      expect(server.requests).toEqual([]);
      expect(server.connections()).toBe(0);
    });
  });
});
