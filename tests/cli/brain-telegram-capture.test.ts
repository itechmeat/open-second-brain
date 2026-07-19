/**
 * `o2b brain telegram-capture <run|catchup>` (Knowledge intake suite,
 * t_f8f5ef6a). Wires the inbound capture runner and catchup renderer.
 *
 * The runner's long-poll path is never exercised against the real network
 * here: only the missing-token startup error and the disk-only catchup
 * renderer are covered, mirroring how the core is unit-tested with an
 * injected transport.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { writeCaptureNote } from "../../src/core/brain/capture/capture-note.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-telegram-capture-cli-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  config = join(tmp, "config.yaml");
  writeFileSync(config, `vault: "${vault}"\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = (extra: Record<string, string> = {}) => ({
  OPEN_SECOND_BRAIN_CONFIG: config,
  ...extra,
});

test("run without a configured token exits with a typed error", async () => {
  const res = await runCli(["brain", "telegram-capture", "run"], { env: env() });
  expect(res.returncode).not.toBe(0);
  expect(res.stderr.toLowerCase()).toContain("token");
});

test("catchup renders staged captures without needing a token or network", async () => {
  writeCaptureNote(vault, {
    body: "first captured idea",
    provenance: { source: "telegram", sender: "100", capturedAt: "2026-07-19T12:00:01Z" },
  });
  writeCaptureNote(vault, {
    body: "second captured idea",
    provenance: { source: "telegram", sender: "100", capturedAt: "2026-07-19T12:00:02Z" },
  });
  const res = await runCli(["brain", "telegram-capture", "catchup"], { env: env() });
  expect(res.returncode).toBe(0);
  expect(res.stdout).toContain("first captured idea");
  expect(res.stdout).toContain("second captured idea");

  // Watermark advanced: a second catchup reports nothing new.
  const again = await runCli(["brain", "telegram-capture", "catchup"], { env: env() });
  expect(again.stdout).not.toContain("first captured idea");
});

test("an unknown action is a usage error", async () => {
  const res = await runCli(["brain", "telegram-capture", "wat"], { env: env() });
  expect(res.returncode).toBe(2);
});
