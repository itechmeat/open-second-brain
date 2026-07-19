/**
 * `o2b brain diarize <entity>` CLI surface (t_28ba3fc4).
 *
 * A missing entity is a usage error (exit 2, plain stderr); an operational
 * failure honours the repo's JSON error-envelope contract under --json and
 * stays plain-text on stderr otherwise.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-diarize-cli-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  config = join(tmp, "config.yaml");
  writeFileSync(config, `vault: "${vault}"\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: config });

test("a missing entity argument is a usage error (exit 2, plain stderr)", async () => {
  const res = await runCli(["brain", "diarize"], { env: env() });
  expect(res.returncode).toBe(2);
  expect(res.stderr).toContain("usage");
});

test("an operational failure under --json emits a JSON error envelope (exit 1)", async () => {
  const res = await runCli(["brain", "diarize", "no-such-entity", "--json"], { env: env() });
  expect(res.returncode).toBe(1);
  const parsed = JSON.parse(res.stdout) as { ok: boolean; message: string };
  expect(parsed.ok).toBe(false);
  expect(parsed.message).toContain("unknown entity");
});

test("an operational failure without --json stays plain-text on stderr (exit 1)", async () => {
  const res = await runCli(["brain", "diarize", "no-such-entity"], { env: env() });
  expect(res.returncode).toBe(1);
  expect(res.stderr).toContain("unknown entity");
});
