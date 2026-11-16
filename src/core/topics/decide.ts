/**
 * The decide pass of the dream-time uses (design D10, D20): runs on the
 * view writer before the synchronous dream pass, so the verdicts are in
 * hand when planning takes its lock. `dream()` stays synchronous; the
 * asynchronous front doors (`decide-auto.ts`) await this pass and hand
 * the result to the dream as `DreamOptions.topicVerdicts`.
 *
 * Fail-closed to the deterministic plan everywhere: a use that is `off`
 * (the default), a machine that is not the view writer, an incomplete
 * shard read, a spent budget, a timeout, an invalid answer or an answer
 * below the use's threshold all leave that lane empty, and the
 * deterministic rule decides in `planTopics`. `shadow` answers are
 * recorded by `runDecision` and are not returned. One file per use
 * family: `decide-route.ts` (`topic_route`, `topic_new`),
 * `decide-same.ts` (`topic_same`), `decide-items.ts` (the record-item
 * uses); the shared context lives in `decide-shared.ts`.
 */

import { discoverConfig, resolveAgentName, resolveVault } from "../config.ts";
import { decisionModelModeFor, resolveDecisionModelConfig } from "../decision-model/config.ts";
import { DREAM_TOPIC_USES } from "../decision-model/questions-topics.ts";
import type { StoreHandle } from "../store/store-open.ts";
import {
  SETTING_TOPIC_MIN_RECORDS,
  SETTING_TOPIC_MIN_SESSIONS,
  SETTING_TOPIC_QUIET_DAYS,
} from "../store/constants.ts";
import { foldSettings, settingValue } from "../store/fold-settings.ts";
import { catchUp, partitionRecords } from "../view/catch-up.ts";
import type { StoreRecord } from "../store/envelope.ts";
import { topicCandidates } from "./candidates.ts";
import { foldTopics } from "./fold.ts";
import { planTopics } from "./plan.ts";
import { writerGate } from "./planning.ts";
import { emptyTopicVerdicts, type TopicVerdicts } from "./verdicts.ts";
import {
  askableCandidates,
  DECIDE_LOOKBACK_MS,
  DECIDE_PASS_BUDGET_MS,
  useShareUntil,
  type DecideTopicPlanOptions,
  type PassContext,
  type PassState,
} from "./decide-shared.ts";
import { decideNew, decideRoutes } from "./decide-route.ts";
import { decideSameTopics } from "./decide-same.ts";
import { decideCompletions, decideEventKinds, decideResolutions } from "./decide-items.ts";
import { decideHistory } from "./decide-history.ts";
import { loadAskedSet } from "./decide-asked.ts";

/**
 * The decide pass for the dream-time uses over `store` (design D10,
 * D20). Returns the verdicts of `enforce` answers only, keyed by
 * subject; every other lane stays empty and the deterministic rule
 * decides in `planTopics`.
 */
export async function decideTopicPlan(
  store: StoreHandle,
  options: DecideTopicPlanOptions = {},
): Promise<TopicVerdicts> {
  const clock = options.now ?? Date.now;
  const runAt = options.runAt;
  const at = runAt !== undefined ? () => runAt.getTime() : clock;
  const cfg = resolveDecisionModelConfig({
    env: options.env ?? process.env,
    config: discoverConfig(options.configPath).data,
    vault: resolveVault(options.configPath),
  });
  if (cfg.status !== "active") return emptyTopicVerdicts();
  if (DREAM_TOPIC_USES.every((use) => decisionModelModeFor(cfg, use) === "off")) {
    return emptyTopicVerdicts();
  }
  // Only the view writer decides, the same gate the planning pass runs
  // (D20): one machine decides and every machine folds the stored result.
  const gate = writerGate(store, {
    agent: resolveAgentName(options.configPath),
    now: at,
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
  });
  if (!gate.ok) return emptyTopicVerdicts();
  // The read happens outside the planning lock; planTopics re-applies
  // every verdict against the fold read under the lock.
  const read = catchUp(store, at);
  if (read.unreadable.length > 0) return emptyTopicVerdicts();
  const records = [...read.records.values()].flat();
  const sharedRecords: ReadonlyArray<StoreRecord> = partitionRecords(read, "shared");
  const privateIds = new Set(partitionRecords(read, "private").map((r) => r.id));
  const fold = foldTopics(records, { privateIds });
  const candidates = topicCandidates(records, privateIds);
  const shared = foldSettings(partitionRecords(read, "shared"));
  const plan = planTopics(
    fold,
    candidates,
    {
      minRecords: settingValue(shared, SETTING_TOPIC_MIN_RECORDS) as number,
      minSessions: settingValue(shared, SETTING_TOPIC_MIN_SESSIONS) as number,
      quietDays: settingValue(shared, SETTING_TOPIC_QUIET_DAYS) as number,
    },
    at(),
  );
  const askable = askableCandidates(candidates, at());
  const out: PassState = {
    routes: new Map(),
    kinds: new Map(),
    vetoes: new Map(),
    sameTopics: [],
    resolutions: new Map(),
    completions: [],
    hidden: new Map(),
    kept: new Map(),
  };
  const passUntil = clock() + (options.deadlineMs ?? DECIDE_PASS_BUDGET_MS);
  const base: PassContext = {
    store,
    cfg,
    clock,
    at,
    options,
    fold,
    candidates: askable,
    byId: new Map(candidates.map((c) => [c.id, c])),
    plan,
    until: passUntil,
    out,
    asked: loadAskedSet(store, cfg, at() - DECIDE_LOOKBACK_MS),
  };
  // Each use gets its share of what is left of the budget, in the fixed
  // order; what a use leaves unspent rolls over to the next.
  const uses: Array<(ctx: PassContext) => Promise<void>> = [
    decideRoutes,
    decideSameTopics,
    decideNew,
    decideEventKinds,
    decideResolutions,
    decideCompletions,
    (ctx) => decideHistory(ctx, sharedRecords),
  ];
  // Saved on a failed pass too: an entry is only ever an answer that
  // arrived, so the subjects it names are not asked again.
  try {
    for (let i = 0; i < uses.length; i++) {
      const until = useShareUntil(clock(), passUntil, uses.length - i);
      // Sequential by design: each use's share depends on what the last spent.
      // oxlint-disable-next-line no-await-in-loop
      await uses[i]!({ ...base, until });
    }
  } finally {
    base.asked.save();
  }
  return out;
}
