/**
 * The brain works with no vault (spec brain-store, scenario "No vault
 * configured"; design D14, task 2.10): on a machine whose config names no
 * vault, the memory-contract verbs write and read the brain store, and
 * `o2b search` finds the records. A second machine sharing the store sees
 * them once its own index catches up.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  isStoreRecordPath,
  STORE_CATCH_UP_INTERVAL_ENV,
} from "../../src/core/search/brain-store/constants.ts";
import { forgetMachineStateCache } from "../../src/core/state/machine-state.ts";
import { runCli } from "../helpers/run-cli.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

function noVaultEnv(prefix: string): StoreEnv {
  return makeStoreEnv(prefix, { legacyTree: false, configureVault: false });
}

function cli(args: ReadonlyArray<string>, extra: Record<string, string> = {}) {
  return runCli(args, {
    // A write relative to the working directory lands under the test's
    // parent, where the "nothing next to the config" checks look.
    cwd: env!.parent,
    env: {
      OPEN_SECOND_BRAIN_CONFIG: env!.configPath,
      [STORE_CATCH_UP_INTERVAL_ENV]: "0",
      ...extra,
    },
  });
}

const PRINCIPLE = "Prefer kingfisher naming for heron migrations.";

function feedbackArgs(topic: string, principle: string, ...extra: string[]): string[] {
  return [
    "brain",
    "feedback",
    "--topic",
    topic,
    "--signal",
    "positive",
    "--principle",
    principle,
    ...extra,
  ];
}

async function searchPaths(extra: Record<string, string> = {}): Promise<string[]> {
  const res = await cli(["search", "query", "kingfisher heron migrations", "--json"], extra);
  expect({ code: res.returncode, stderr: res.stderr }).toEqual({ code: 0, stderr: res.stderr });
  const parsed = JSON.parse(res.stdout) as { results: ReadonlyArray<{ path: string }> };
  return parsed.results.map((r) => r.path);
}

describe("no vault configured", () => {
  test("feedback then search returns the record", async () => {
    env = noVaultEnv("osb-novault-e2e-");
    const fb = await cli([...feedbackArgs("kingfisher-naming", PRINCIPLE), "--json"]);
    expect({ code: fb.returncode, stderr: fb.stderr }).toEqual({ code: 0, stderr: "" });
    const written = JSON.parse(fb.stdout) as Record<string, string>;
    expect(written["signal_path"]).toBe(`store:${written["signal_id"]}`);

    const paths = await searchPaths();
    expect(paths.some((p) => isStoreRecordPath(p))).toBe(true);
  });

  test("a second machine sharing the store sees the record after catch-up", async () => {
    env = noVaultEnv("osb-novault-peer-");
    const fb = await cli(feedbackArgs("kingfisher-naming", PRINCIPLE));
    expect(fb.returncode).toBe(0);
    expect((await searchPaths()).length).toBeGreaterThan(0);

    // Machine B: its own device id and its own device-local state (so its
    // own index), the same synced store root.
    const peerState = join(env.parent, "peer-state");
    mkdirSync(peerState, { recursive: true });
    const peer = {
      O2B_DEVICE_ID: "dev-b",
      XDG_STATE_HOME: peerState,
      LOCALAPPDATA: peerState,
    };
    // `runCli` applies `peer` over the process environment for the run;
    // only the in-process machine-state memo must forget machine A.
    forgetMachineStateCache();
    try {
      const paths = await searchPaths(peer);
      expect(paths.some((p) => isStoreRecordPath(p))).toBe(true);
      // B built a search index of its own, in its own state, not A's.
      const peerIndexes = readdirSync(peerState, { recursive: true, encoding: "utf8" }).filter(
        (rel) => rel.endsWith("brain.sqlite") && rel.split(/[\\/]/).includes("index"),
      );
      expect(peerIndexes).toHaveLength(1);
    } finally {
      forgetMachineStateCache();
    }
  });

  test("the memory-contract verbs run on the store alone", async () => {
    env = noVaultEnv("osb-novault-verbs-");
    const fb = await cli([
      ...feedbackArgs("plain-words", "Use plain words in reports."),
      "--force-confirmed",
      "--json",
    ]);
    expect({ code: fb.returncode, stderr: fb.stderr }).toEqual({ code: 0, stderr: "" });
    const pref = (JSON.parse(fb.stdout) as Record<string, string>)["preference_id"]!;
    expect(pref).toMatch(/^pref-/);

    for (const args of [
      ["apply-evidence", "--pref", pref, "--artifact", "[[report]]", "--result", "applied"],
      ["pin", "--id", pref],
      ["unpin", "--id", pref],
      ["status"],
      ["changes"],
      ["dream"],
    ]) {
      const res = await cli(["brain", ...args]);
      expect({ args, code: res.returncode, stderr: res.stderr }).toEqual({
        args,
        code: 0,
        stderr: res.stderr,
      });
      expect(res.stderr).not.toContain("needs a vault");
    }

    const status = await cli(["brain", "status", "--json"]);
    const snapshot = JSON.parse(status.stdout) as { counts: { preferences: number } };
    expect(snapshot.counts.preferences).toBe(1);

    // The store-side doctor checks run, and a fresh store is clean.
    const doctor = await cli(["brain", "doctor", "--json"]);
    expect({ code: doctor.returncode, stderr: doctor.stderr }).toEqual({ code: 0, stderr: "" });
    const report = JSON.parse(doctor.stdout) as { warnings: unknown[]; errors: unknown[] };
    expect(report).toMatchObject({ warnings: [], errors: [] });

    // Nothing was written next to the config, where a vault would be.
    expect(readdirSync(env.parent)).not.toContain("Brain");
    expect(existsSync(join(env.vault, "Brain"))).toBe(false);
  });

  test("modes that work on vault files still refuse by name (exit 1)", async () => {
    env = noVaultEnv("osb-novault-refuse-");
    for (const [args, named] of [
      [["doctor", "--repair"], "doctor --repair"],
      [["doctor", "--remediate"], "doctor --remediate"],
      [["dream", "--step", "scan"], "dream --step"],
      [["dream", "list"], "dream list"],
    ] as const) {
      const res = await cli(["brain", ...args]);
      expect({ args, code: res.returncode }).toEqual({ args, code: 1 });
      expect(res.stderr).toContain(`\`o2b brain ${named}\` needs a vault`);
    }
  });
});
