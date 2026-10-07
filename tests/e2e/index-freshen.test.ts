/**
 * Freshen on read end to end, with a real detached child: a note written
 * after the last index run is not found by the first search, which starts
 * a background `o2b search index --freshen`; once that run has recorded
 * its outcome, the next search finds the note. No test seam is used.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FRESHEN_CLAIM_FILE, readFreshenState } from "../../src/core/search/freshen.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-freshen-e2e-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "notes"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
  writeFileSync(join(vault, "notes", "old.md"), "# Old\n\nan older note about kestrels.\n");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const env = (interval: string) => ({
  OPEN_SECOND_BRAIN_CONFIG: configPath,
  OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S: interval,
});

test(
  "a stale read starts a background run and the next read finds the new note",
  async () => {
    expect((await runCli(["search", "index"], { env: env("0") })).returncode).toBe(0);
    await Bun.sleep(1_100);
    writeFileSync(join(vault, "notes", "new.md"), "# New\n\na fresh note about wagtails.\n");

    const first = await runCli(["search", "query", "wagtails", "--json"], { env: env("1") });
    expect(first.returncode).toBe(0);
    expect(JSON.parse(first.stdout).results ?? []).toHaveLength(0);

    const derived = join(vault, ".open-second-brain");
    const deadline = Date.now() + 30_000;
    while (readFreshenState(derived).lastOutcome === null && Date.now() < deadline) {
      await Bun.sleep(200);
    }
    const state = readFreshenState(derived);
    expect(state.lastOutcome).toBe("completed");
    expect(state.lastChanged).toBe(1);
    expect(existsSync(join(derived, FRESHEN_CLAIM_FILE))).toBe(false);

    const second = await runCli(["search", "query", "wagtails", "--json"], { env: env("0") });
    const paths = (JSON.parse(second.stdout).results as Array<{ path: string }>).map((r) => r.path);
    expect(paths).toContain("notes/new.md");
  },
  { timeout: 60_000 },
);
