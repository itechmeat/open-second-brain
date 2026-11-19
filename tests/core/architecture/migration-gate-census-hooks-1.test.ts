/**
 * The migration-gate census (`migration-gate-census/table.ts`), every hook in hooks.json (shard 1 of 2), including the session start, prompt and stop hooks (a hook never fails a session over the gate).
 * One table, split across files sharing the census fixture so no file runs
 * for minutes.
 */
import { setDefaultTimeout } from "bun:test";

import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { hookSuite } from "./migration-gate-census/suites.ts";

// Tests here run the CLI, the MCP dispatch or the hooks; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

hookSuite(0, 2);
