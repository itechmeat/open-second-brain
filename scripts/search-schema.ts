/**
 * `bun run search-schema` / `bun run search-schema:check` - the
 * regeneration driver for the committed search-query artifact
 * (t_50c81d5c, Task E4), matching the sync-version / sync-plugin-mirrors
 * script pattern: regeneration is a human action, freshness is enforced
 * by check (exit 2 on drift), never by a test writing to the repo.
 *
 *   - no args (or `export`): rewrite schemas/brain/search-query.schema.json
 *     from the descriptor;
 *   - `--check` (or `check`): re-derive and diff, exit 0 clean / 2 drift.
 */

import { cmdSearchSchema } from "../src/cli/search/verbs/schema-export.ts";

const arg = process.argv[2];
const verb =
  arg === undefined || arg === "export"
    ? ["export"]
    : arg === "--check" || arg === "check"
      ? ["check"]
      : null;
if (verb === null) {
  process.stderr.write(`usage: bun run scripts/search-schema.ts [export|--check]\n`);
  process.exit(2);
}
process.exit(await cmdSearchSchema(verb));
