/**
 * CLI tests for `o2b search feedback` and `o2b search weights`
 * (recall-trust-suite, Feature B).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { feedbackDir, learnedWeightsPath } from "../../src/core/search/feedback.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-search-fb-cli-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  config = join(tmp, "config.yaml");
  writeFileSync(config, `vault: "${vault}"\n`);
  writeFileSync(join(vault, "note.md"), "# Note\n\nthe quarterly ledger reconciliation runbook\n");
  const out = await runCli(["search", "index"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(out.returncode).toBe(0);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("search feedback records an event and search weights reports it", async () => {
  const fb = await runCli(
    [
      "search",
      "feedback",
      "--query",
      "quarterly ledger reconciliation",
      "--result",
      "note.md",
      "--verdict",
      "up",
      "--json",
    ],
    { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
  );
  expect(fb.returncode).toBe(0);
  const fbJson = JSON.parse(fb.stdout) as { recorded: boolean; learned: { events: number } };
  expect(fbJson.recorded).toBe(true);
  expect(fbJson.learned.events).toBe(1);
  expect(readdirSync(feedbackDir(vault))).toHaveLength(1);

  const w = await runCli(["search", "weights", "--json"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(w.returncode).toBe(0);
  const wJson = JSON.parse(w.stdout) as {
    learned: { events: number } | null;
    base: { keywordWeight: number };
    enabled: boolean;
    bounds: { min: number; max: number };
  };
  expect(wJson.learned?.events).toBe(1);
  expect(wJson.base.keywordWeight).toBeGreaterThan(0);
  expect(wJson.bounds.min).toBeLessThan(1);
});

test("search weights --reset removes the derived file but keeps events", async () => {
  await runCli(
    ["search", "feedback", "--query", "ledger", "--result", "note.md", "--verdict", "down"],
    { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
  );
  expect(existsSync(learnedWeightsPath(vault))).toBe(true);

  const reset = await runCli(["search", "weights", "--reset"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(reset.returncode).toBe(0);
  expect(existsSync(learnedWeightsPath(vault))).toBe(false);
  expect(readdirSync(feedbackDir(vault))).toHaveLength(1);
});

test("search feedback rejects an invalid verdict with exit 2", async () => {
  const out = await runCli(
    ["search", "feedback", "--query", "ledger", "--result", "note.md", "--verdict", "maybe"],
    { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
  );
  expect(out.returncode).toBe(2);
  expect(out.stderr).toContain("verdict");
});
