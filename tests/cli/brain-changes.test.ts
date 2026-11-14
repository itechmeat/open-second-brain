/**
 * `o2b brain changes [--since <watermark>]` (task 1.9): the CLI front
 * door of the change probe. The probe's semantics are covered in
 * `tests/core/search/brain-store-changes.test.ts`; this file covers the
 * verb: it finds the configured store, builds the index on first use, and
 * returns a neighbour's record under its topic and scope after the
 * watermark it printed.
 */
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { STORE_CATCH_UP_INTERVAL_ENV } from "../../src/core/search/brain-store/constants.ts";
import { appendRecord } from "../../src/core/store/appender.ts";
import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import {
  LOCAL_DEVICE,
  makeStoreIndexFixture,
  REMOTE_DEVICE,
  type StoreIndexFixture,
} from "../core/search/fixtures/brain-store-index.ts";
import { runCli } from "../helpers/run-cli.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let fx: StoreIndexFixture;
let env: Record<string, string>;

beforeEach(() => {
  fx = makeStoreIndexFixture("osb-cli-changes-");
  fx.open(LOCAL_DEVICE);
  fx.writeNote("notes/a.md", "# A\n\nA note.\n");
  const configPath = join(fx.parent, "config.yaml");
  writeFileSync(configPath, `vault: ${fx.vault}\n`);
  const state = fx.dirs(LOCAL_DEVICE).env;
  env = {
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    [STORE_ROOT_ENV]: fx.root,
    [STORE_CATCH_UP_INTERVAL_ENV]: "0",
    XDG_STATE_HOME: state["XDG_STATE_HOME"]!,
    LOCALAPPDATA: state["LOCALAPPDATA"]!,
  };
});
afterEach(() => fx.cleanup());

interface ChangesJson {
  measured: boolean;
  storeInUse: boolean;
  watermark: string;
  count: number;
  groups: Array<{ stream: string; scope: string | null; topic: string | null; ids: string[] }>;
}

async function changes(...args: string[]): Promise<ChangesJson> {
  const res = await runCli(["brain", "changes", "--vault", fx.vault, "--json", ...args], { env });
  expect(res.stderr).not.toContain("error");
  expect(res.returncode).toBe(0);
  return JSON.parse(res.stdout) as ChangesJson;
}

// The grouping itself is the core probe's (tests/core/search/brain-store-changes.test.ts);
// here the verb finds the configured store and the watermark round-trips.
test("returns a neighbour's record id after the watermark it printed", async () => {
  const neighbour = fx.open(REMOTE_DEVICE);
  const decide = (text: string) =>
    appendRecord(neighbour, {
      partition: "shared",
      stream: "events",
      kind: "decision",
      agent: "agent-b",
      body: { text },
    }).record;
  decide("an earlier decision");
  const first = await changes();
  expect(first).toMatchObject({ measured: true, storeInUse: true, count: 1 });

  const record = decide("pick the north bank");
  const after = await changes("--since", first.watermark);
  expect(after.count).toBe(1);
  expect(after.groups.flatMap((g) => g.ids)).toEqual([record.id]);
});

test("the text form ends with the watermark, and a bad one is refused", async () => {
  const text = await runCli(["brain", "changes", "--vault", fx.vault], { env });
  expect(text.returncode).toBe(0);
  expect(text.stdout).toMatch(/watermark: [0-9A-Z]{26}\.\d+\n$/);
  const bad = await runCli(["brain", "changes", "--vault", fx.vault, "--since", "yesterday"], {
    env,
  });
  expect(bad.returncode).not.toBe(0);
  expect(bad.stderr).toContain("not a watermark");
});

test.each(["1e3", "0x10", " 5 ", "2.0"])(
  "--limit %p is refused: only plain digits",
  async (raw) => {
    const res = await runCli(["brain", "changes", "--vault", fx.vault, "--limit", raw], { env });
    expect(res.returncode).not.toBe(0);
    expect(res.stderr).toContain("--limit must be an integer");
  },
);
