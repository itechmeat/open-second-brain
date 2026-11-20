/**
 * The first search after the switch to the brain store, with no build
 * running yet (no session start began one): the search starts the same
 * detached background build a session start starts, instead of building
 * the whole store in its own process, and answers once the build can
 * answer. A small vault is built within the wait, so its first search
 * answers from the whole index.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import {
  readSelfHealReindexRows,
  SELF_HEAL_REINDEX_OUTCOME,
  SELF_HEAL_SPAWN,
} from "../../../src/core/maintenance/self-heal-reindex.ts";
import { IndexBuildStartingError } from "../../../src/core/search/build-progress.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { search } from "../../../src/core/search/search.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { switchDevice } from "../brain/fixtures/memory-twins.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";

// The build runs in a spawned o2b; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

test("the first search after the switch starts the background build and answers from it", async () => {
  env = makeStoreEnv("osb-first-search-build-", { dualWrite: false });
  switchDevice(env);
  mkdirSync(join(env.vault, "Notes"), { recursive: true });
  writeFileSync(join(env.vault, "Notes", "godwit.md"), "# Godwit\n\nBar-tailed godwit notes.\n");
  const config = resolveSearchConfig({ vault: env.vault, configPath: env.configPath });
  expect(config.brainStore).not.toBeNull();
  expect(existsSync(config.dbPath)).toBe(false);

  // The first answer may come from the staging file of a build still
  // running (a slow runner passes the wait before the swap), or, on a
  // runner slow to start the child, be the "just started" refusal; its
  // content is asserted once the build ended. Any other error fails.
  try {
    await search(config, { query: "godwit", limit: 5, transportReach: TRANSPORT_REACH.local });
  } catch (e) {
    if (!(e instanceof IndexBuildStartingError)) throw e;
  }

  // The build was the detached child's: the search recorded its spawn,
  // and the child its own outcome under the same run id.
  const spawned = readSelfHealReindexRows(env.vault).find(
    (row) => row.decision === SELF_HEAL_SPAWN.spawned,
  );
  expect(spawned?.runId).toBeString();
  const deadline = Date.now() + 30_000;
  let outcomeRow = readSelfHealReindexRows(env.vault).find(
    (row) => row.runId === spawned!.runId && row.outcome !== null,
  );
  while (outcomeRow === undefined && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(50);
    outcomeRow = readSelfHealReindexRows(env.vault).find(
      (row) => row.runId === spawned!.runId && row.outcome !== null,
    );
  }
  expect(outcomeRow?.outcome).toBe(SELF_HEAL_REINDEX_OUTCOME.completed);
  const after = await search(config, {
    query: "godwit",
    limit: 5,
    transportReach: TRANSPORT_REACH.local,
  });
  expect(after.results.map((r) => r.path)).toContain("Notes/godwit.md");
  expect(after.warnings.some((w) => w.startsWith("the search index is being built"))).toBe(false);
});

test("a search whose own settings differ from the config file builds the index itself", async () => {
  env = makeStoreEnv("osb-first-search-own-", { dualWrite: false });
  switchDevice(env);
  mkdirSync(join(env.vault, "Notes"), { recursive: true });
  writeFileSync(join(env.vault, "Notes", "godwit.md"), "# Godwit\n\nBar-tailed godwit notes.\n");
  const resolved = resolveSearchConfig({ vault: env.vault, configPath: env.configPath });
  // Same index path, other chunking: a child reading the config file
  // would build an index this search does not expect.
  const config = { ...resolved, chunkSize: resolved.chunkSize + 7 };
  const outcome = await search(config, {
    query: "godwit",
    limit: 5,
    transportReach: TRANSPORT_REACH.local,
  });
  expect(outcome.results.map((r) => r.path)).toContain("Notes/godwit.md");
  expect(
    readSelfHealReindexRows(env.vault).some((r) => r.decision === SELF_HEAL_SPAWN.spawned),
  ).toBe(false);
});
