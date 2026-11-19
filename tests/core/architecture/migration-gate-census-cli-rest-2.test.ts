/**
 * The migration-gate census (`migration-gate-census/table.ts`), the CLI readers, recorders and undriven writers, shard 2 of 2.
 * One table, split across files sharing the census fixture so no file runs
 * for minutes.
 */
import { setDefaultTimeout } from "bun:test";

import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { cliRestSuite } from "./migration-gate-census/suites.ts";

// Tests here run the CLI, the MCP dispatch or the hooks; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

cliRestSuite(1, 2);
