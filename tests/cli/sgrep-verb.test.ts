/**
 * `o2b brain sgrep` + `o2b brain profile` (Workspace Insight Suite,
 * t_323a9a83): shell-native surface CLI tests.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { O2BFS_MARKER_FILE, PROFILE_DOC_REL } from "../../src/core/brain/profile-doc.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-sgrep-cli-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
  mkdirSync(join(vault, "Projects"), { recursive: true });
  writeFileSync(
    join(vault, "Brain", "notes", "creatures.md"),
    "# Creatures\n\nThe basilisk hibernates in winter.\n",
  );
  writeFileSync(join(vault, "Projects", "plan.md"), "# Plan\n\nThe basilisk project ships soon.\n");
  config = join(tmp, "config.yaml");
  writeFileSync(config, `vault: "${vault}"\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: config });

test("sgrep prints grep-shaped path:line: matches", async () => {
  const r = await runCli(["brain", "sgrep", "basilisk"], { env: env() });
  expect(r.returncode).toBe(0);
  expect(r.stdout).toMatch(/Brain\/notes\/creatures\.md:\d+: /);
});

test("sgrep scopes by path prefix and supports --json", async () => {
  const r = await runCli(["brain", "sgrep", "basilisk", "Projects/", "--json"], { env: env() });
  expect(r.returncode).toBe(0);
  const parsed = JSON.parse(r.stdout) as { results: Array<{ path: string }> };
  expect(parsed.results.length).toBeGreaterThan(0);
  expect(parsed.results.every((x) => x.path.startsWith("Projects/"))).toBe(true);
});

test("sgrep with no matches exits 1, grep-style", async () => {
  const r = await runCli(["brain", "sgrep", "zzznothing"], { env: env() });
  expect(r.returncode).toBe(1);
});

test("profile writes Brain/profile.md and the .o2bfs marker, then stays fresh", async () => {
  const first = await runCli(["brain", "profile", "--json"], { env: env() });
  expect(first.returncode).toBe(0);
  expect((JSON.parse(first.stdout) as Record<string, unknown>)["refreshed"]).toBe(true);
  expect(existsSync(join(vault, PROFILE_DOC_REL))).toBe(true);
  expect(existsSync(join(vault, O2BFS_MARKER_FILE))).toBe(true);

  const second = await runCli(["brain", "profile", "--json"], { env: env() });
  expect((JSON.parse(second.stdout) as Record<string, unknown>)["refreshed"]).toBe(false);

  const forced = await runCli(["brain", "profile", "--force", "--json"], { env: env() });
  expect((JSON.parse(forced.stdout) as Record<string, unknown>)["refreshed"]).toBe(true);
});
