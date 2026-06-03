/**
 * Config-level role filtering for session capture (t_e2346fe9): the
 * `session_capture_roles` key supplies the default `--filter-role`
 * set; an explicit flag always wins.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;
const FIXTURE = join(process.cwd(), "tests/fixtures/sessions/claude-minimal.jsonl");

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-roles-cli-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  config = join(tmp, "config.yaml");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(extra = ""): void {
  writeFileSync(config, `vault: "${vault}"\n${extra}`);
}

async function importJson(extraArgs: string[] = []): Promise<Record<string, unknown>> {
  const r = await runCli(
    ["brain", "import-session", FIXTURE, "--vault", vault, "--json", ...extraArgs],
    { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
  );
  expect(r.returncode).toBe(0);
  const parsed = JSON.parse(r.stdout) as { files: Array<Record<string, unknown>> };
  return parsed.files[0]!;
}

test("session_capture_roles filters turns when no flag is given", async () => {
  writeConfig('session_capture_roles: "assistant"\n');
  const file = await importJson();
  // The claude fixture has user turns; with an assistant-only default
  // they are filtered out instead of scanned for facts/markers.
  expect(file["filtered_turns"] as number).toBeGreaterThan(0);
});

test("absent key keeps capture-all behaviour (bit-identical default)", async () => {
  writeConfig();
  const file = await importJson();
  expect(file["filtered_turns"]).toBe(0);
});

test("an explicit --filter-role flag wins over the config default", async () => {
  writeConfig('session_capture_roles: "assistant"\n');
  const withFlag = await importJson(["--filter-role", "user", "--filter-role", "assistant"]);
  expect(withFlag["filtered_turns"]).toBe(0);
});

test("an invalid config role fails fast with a clear error", async () => {
  writeConfig('session_capture_roles: "user,reviewer"\n');
  const r = await runCli(["brain", "import-session", FIXTURE, "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(r.returncode).not.toBe(0);
  expect(r.stderr + r.stdout).toContain("session_capture_roles");
});
