/**
 * Cross-vault union search over a machine that holds a brain store
 * (design D5). The store is machine-wide, so every vault resolves it; a
 * read-only origin still reads the index its own vault has, and the
 * store's records come back once, from the active origin.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { addRecallSource } from "../../../src/core/brain/portability/recall-sources.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { STORE_CATCH_UP_INTERVAL_ENV } from "../../../src/core/search/brain-store/constants.ts";
import { catchUpBrainStore } from "../../../src/core/search/brain-store/catch-up.ts";
import { storeRecordPath } from "../../../src/core/search/brain-store/ingest.ts";
import { searchAcrossVaults } from "../../../src/core/search/cross-vault.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { resolveIndexPath } from "../../../src/core/search/paths.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { STORE_ROOT_ENV } from "../../../src/core/store/constants.ts";
import { makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import {
  LOCAL_DEVICE,
  makeStoreIndexFixture,
  REMOTE_DEVICE,
  type StoreIndexFixture,
} from "./fixtures/brain-store-index.ts";

const ENV_KEYS = [STORE_ROOT_ENV, STORE_CATCH_UP_INTERVAL_ENV, "XDG_STATE_HOME", "LOCALAPPDATA"];

let fx: StoreIndexFixture;
let configPath: string;
let external: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  fx = makeStoreIndexFixture("osb-cross-vault-store-");
  external = join(fx.parent, "external-vault");
  mkdirSync(join(external, "Brain"), { recursive: true });
  configPath = join(fx.parent, "config.yaml");
  writeFileSync(configPath, `vault: "${fx.vault}"\n`);
  const state = fx.dirs(LOCAL_DEVICE).env;
  process.env[STORE_ROOT_ENV] = fx.root;
  process.env[STORE_CATCH_UP_INTERVAL_ENV] = "0";
  process.env["XDG_STATE_HOME"] = state["XDG_STATE_HOME"];
  process.env["LOCALAPPDATA"] = state["LOCALAPPDATA"];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fx.cleanup();
});

test("a read-only origin reads its own index and the store answers once", async () => {
  // The external vault's index was built where a vault without a store keeps it.
  writeMd(
    external,
    "Brain/notes/external.md",
    "# External\n\nThe griffin visits the external vault.",
  );
  await indexVault(makeConfig({ vault: external, dbPath: resolveIndexPath(external, null, null) }));

  fx.open(LOCAL_DEVICE);
  fx.writeNote("notes/local.md", "# Local\n\nThe griffin nests in the local vault.\n");
  await indexVault(resolveSearchConfig({ vault: fx.vault, configPath }));
  const { record } = appendRecord(fx.open(REMOTE_DEVICE), {
    partition: "shared",
    stream: "events",
    kind: "decision",
    agent: "agent-b",
    body: { text: "Griffin ringing decision" },
  });
  addRecallSource(configPath, fx.vault, "team", external);

  const outcome = await searchAcrossVaults(configPath, fx.vault, {
    query: "griffin",
    limit: 10,
    transportReach: TRANSPORT_REACH.local,
  });
  expect(outcome.warnings).toEqual([]);
  const answered = outcome.results.map((r) => `${r.origin} ${r.path}`);
  expect(answered.toSorted()).toEqual(
    [
      `local ${storeRecordPath("shared", record.id)}`,
      "local notes/local.md",
      "source/team Brain/notes/external.md",
    ].toSorted(),
  );
});

test("store records a read-only origin ranks first do not take its notes' slots", async () => {
  fx.open(LOCAL_DEVICE);
  const remote = fx.open(REMOTE_DEVICE);
  for (const n of [1, 2, 3]) {
    appendRecord(remote, {
      partition: "shared",
      stream: "events",
      kind: "decision",
      agent: "agent-b",
      body: { text: `Kittiwake kittiwake kittiwake decision ${n}` },
    });
  }
  // The external vault's index was built on this machine, so it is store-aware
  // and holds the store's records, which outrank its one note.
  writeMd(
    external,
    "Brain/notes/external.md",
    `# External\n\nA kittiwake was seen once. ${"Filler words about the coast. ".repeat(40)}`,
  );
  const externalConfig = resolveSearchConfig({ vault: external, configPath });
  await indexVault(externalConfig);
  expect((await catchUpBrainStore(externalConfig, { force: true })).added).toBe(3);
  // The records are gone from the store before the active vault reads it,
  // so only the external index still ranks them.
  rmSync(join(fx.root, "shared", "events"), { recursive: true, force: true });
  fx.writeNote("notes/local.md", "# Local\n\nNothing about seabirds here.\n");
  await indexVault(resolveSearchConfig({ vault: fx.vault, configPath }));
  addRecallSource(configPath, fx.vault, "team", external);

  const outcome = await searchAcrossVaults(configPath, fx.vault, {
    query: "kittiwake",
    limit: 2,
    transportReach: TRANSPORT_REACH.local,
  });
  const answered = outcome.results.map((r) => `${r.origin} ${r.path}`);
  expect(answered).toEqual(["source/team Brain/notes/external.md"]);
});
