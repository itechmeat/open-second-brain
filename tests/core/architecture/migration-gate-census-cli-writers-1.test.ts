/**
 * The migration-gate census (`migration-gate-census/table.ts`), the driven CLI writers, shard 1 of 8.
 * One table, split across files sharing the census fixture so no file runs
 * for minutes.
 */
import { setDefaultTimeout } from "bun:test";

import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { cliWriterSuite } from "./migration-gate-census/suites.ts";

// Tests here run the CLI, the MCP dispatch or the hooks; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

cliWriterSuite(0, 8);
