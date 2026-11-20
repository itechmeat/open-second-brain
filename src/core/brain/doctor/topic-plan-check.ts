/**
 * Doctor advice: the last topic planning pass on this machine made no
 * topic because the records no topic holds name no project
 * (`topics/plan-outcome.ts`). Topic planning makes a topic only from the
 * records of one project, so a history whose records name none plans
 * nothing; this says so, with how many records and what gives a record its
 * project, instead of leaving the person to read "0 topic(s) created" as
 * "nothing to plan". It is advice: it goes to the non-counting channel
 * (`uncertain`), never to the warnings. Silent before the first pass, after
 * a pass that made a topic, and when every record no topic holds names a
 * project. Read-only.
 *
 * Below local reach (`withholdsPrivate`) it counts as a machine that holds
 * only `shared` would: no count it names includes a private record.
 */

import {
  readTopicPlanOutcome,
  topicPlanOutcomeAtReach,
  unscopedTopicsAdvice,
} from "../../topics/plan-outcome.ts";
import type { DoctorFindings, StoreSideCheckContext, StoreSideDoctorCheck } from "./check.ts";
import { withholdsPrivate } from "./store-check.ts";

/** The last planning pass made no topic: the unassigned records name no project. */
export const TOPICS_WITHOUT_PROJECT_CODE = "topics-records-without-project";

export const topicPlanCheck: StoreSideDoctorCheck = {
  failSoft: true,
  run(ctx: StoreSideCheckContext, out: DoctorFindings): void {
    const outcome = topicPlanOutcomeAtReach(
      readTopicPlanOutcome(ctx.configPath),
      withholdsPrivate(ctx),
    );
    const advice = unscopedTopicsAdvice(outcome);
    if (advice === null) return;
    out.uncertain.push({
      code: TOPICS_WITHOUT_PROJECT_CODE,
      message: `${advice[0]!.toUpperCase()}${advice.slice(1)}`,
    });
  },
};
