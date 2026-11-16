/**
 * The environment a hook test spawns a hook with so that a hook keeping
 * its process alive after its work fails the test, with no wall time
 * asserted: the process ceiling and the decision provider's own timeout
 * sit past the test's timeout, so neither can end such a process early.
 * A hook that drains its event loop exits on its own well before; one
 * that leaves a timer or a request tied to either value running holds
 * the test until it times out.
 */

import { CLI_SPAWN_BUDGET_MS } from "./cli-timeout.ts";

const PAST_THE_TEST_MS = String(10 * CLI_SPAWN_BUDGET_MS);

export function lingerGuardEnv(): Record<string, string> {
  return {
    OPEN_SECOND_BRAIN_HOOK_CEILING_MS: PAST_THE_TEST_MS,
    OPEN_SECOND_BRAIN_DECISION_MODEL_TIMEOUT_MS: PAST_THE_TEST_MS,
  };
}
