/**
 * A verb that records its run in the log and goes on when that fails
 * (`scan-inline`, through `appendLogEvent`'s fail-open mode) still tells
 * the operator: on a store-only machine whose store cannot be written,
 * the store's own notice names the failure and the remedy.
 *
 * The notice is printed once per process (later failures are counted for
 * the doctor), and one `o2b` run is one process. The run is therefore a
 * real subprocess: in-process, it would share the once-per-process flag
 * with every earlier test file of the same `bun test` process, and a
 * Windows shard that ran another fail-open store write first saw an empty
 * stderr.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

test("scan-inline reports a log event it could not store", async () => {
  // A fresh vault (store-only) on a machine with no store: every store write fails.
  env = makeStoreEnv("osb-log-warn-", { legacyTree: false, partitions: [], dualWrite: false });
  mkdirSync(join(env.vault, "notes"), { recursive: true });
  writeFileSync(join(env.vault, "notes", "a.md"), "# A\n\nplain text\n");
  const res = await runCli(["brain", "scan-inline", "--vault", env.vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: env.configPath },
    subprocess: true,
  });
  expect(res.stderr).toContain("the brain store write failed");
  expect(res.stderr).toContain("o2b store init");
});
