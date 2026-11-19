/**
 * The migration-gate census (`migration-gate-census/table.ts`), the rows that
 * write to a destination the caller names: one inside the gated vault is
 * refused, one outside it proceeds.
 */
import { setDefaultTimeout } from "bun:test";

import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { destinationSuite } from "./migration-gate-census/suites.ts";

// Tests here run the CLI; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

destinationSuite();
