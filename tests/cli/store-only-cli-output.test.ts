/**
 * CLI output on a store-only machine names the record, never a legacy
 * `Brain/` path (task 2.11 follow-up), and the memory-contract verbs run
 * with no vault or refuse by name. An unswitched machine keeps its
 * output.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { runCli } from "../helpers/run-cli.ts";
import { brainTreeDigest, switchDevice } from "../core/brain/store-only/fixtures.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

function cli(args: ReadonlyArray<string>) {
  return runCli(args, { env: { OPEN_SECOND_BRAIN_CONFIG: env!.configPath } });
}

const FEEDBACK = [
  "brain",
  "feedback",
  "--topic",
  "naming",
  "--signal",
  "positive",
  "--principle",
  "Name records, not files.",
  "--force-confirmed",
];

describe("o2b brain feedback output", () => {
  test("store-only: text and JSON name store records", async () => {
    env = makeStoreEnv("osb-cliout-fb-store-");
    switchDevice(env.storeRoot);
    const before = brainTreeDigest(env.vault);
    const text = await cli(FEEDBACK);
    expect(text.returncode).toBe(0);
    expect(text.stdout).toMatch(/^signal: store:sig-/m);
    expect(text.stdout).toMatch(/^preference: store:pref-/m);
    expect(text.stdout).not.toContain("Brain/");

    const json = await cli([...FEEDBACK.slice(0, 7), "Second rule.", "--json"]);
    const parsed = JSON.parse(json.stdout) as Record<string, string>;
    expect(parsed["signal_path"]).toBe(`store:${parsed["signal_id"]}`);
    expect(json.stdout).not.toContain("Brain/");
    expect(brainTreeDigest(env.vault)).toBe(before);
  });

  test("unswitched: the vault-relative files, as before", async () => {
    env = makeStoreEnv("osb-cliout-fb-legacy-");
    const text = await cli(FEEDBACK);
    expect(text.stdout).toMatch(/^signal: Brain\/inbox\/sig-/m);
    expect(text.stdout).toMatch(/^preference: Brain\/preferences\/pref-/m);
  });
});

describe("o2b brain export --format llms-txt header", () => {
  test("store-only: points at the brain store, not Brain/preferences/", async () => {
    env = makeStoreEnv("osb-cliout-export-store-");
    switchDevice(env.storeRoot);
    const res = await cli(["brain", "export", "--format", "llms-txt"]);
    expect(res.returncode).toBe(0);
    expect(res.stdout).not.toContain("Brain/preferences/");
    expect(res.stdout).toContain("o2b store path");
  });

  test("unswitched: the header names the files, as before", async () => {
    env = makeStoreEnv("osb-cliout-export-legacy-");
    const res = await cli(["brain", "export", "--format", "llms-txt"]);
    expect(res.stdout).toContain("live under `<vault>/Brain/preferences/`");
  });
});

describe("help texts", () => {
  test("note and scan-inline describe the brain log and inbox, not only their files", async () => {
    env = makeStoreEnv("osb-cliout-help-");
    const note = await cli(["brain", "note", "--help"]);
    expect(note.stdout).toContain("brain log");
    expect(note.stdout).not.toMatch(/line to Brain\/log/);
    const scan = await cli(["brain", "scan-inline", "--help"]);
    expect(scan.stdout).not.toMatch(/create signals in Brain\/inbox/);
  });
});

describe("no vault configured on a store-only machine", () => {
  test("brain note works and names the store shard", async () => {
    env = makeStoreEnv("osb-cliout-novault-note-", { legacyTree: false, configureVault: false });
    const res = await cli(["brain", "note", "milestone without a vault", "--json"]);
    expect(res.returncode).toBe(0);
    const parsed = JSON.parse(res.stdout) as Record<string, string>;
    expect(parsed["log_path"]).toMatch(/^shared\/log\//);
    expect(parsed["record_id"]).toBeDefined();
  });

  test("the memory-contract verbs no longer refuse for lack of a vault", async () => {
    env = makeStoreEnv("osb-cliout-novault-refuse-", { legacyTree: false, configureVault: false });
    for (const [verb, args] of [
      ["feedback", ["--topic", "t", "--signal", "positive", "--principle", "p"]],
      ["status", []],
      ["doctor", []],
      ["changes", []],
      ["dream", []],
    ] as const) {
      const res = await cli(["brain", verb, ...args]);
      expect({ verb, code: res.returncode, stderr: res.stderr }).toEqual({
        verb,
        code: 0,
        stderr: res.stderr,
      });
      expect(res.stderr).not.toContain("needs a vault");
    }
  });
});
