/**
 * `o2b brain inbox-drain` (Knowledge intake suite, I2, t_b0bba8cb).
 * Dry-run report by default, --apply to route and archive.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { writeCaptureNote } from "../../src/core/brain/capture/capture-note.ts";
import { CAPTURE_OBLIGATION_MARKER } from "../../src/core/brain/capture/inbox-drain.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-inbox-drain-cli-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  config = join(tmp, "config.yaml");
  writeFileSync(config, `vault: "${vault}"\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: config });

function seed() {
  writeCaptureNote(vault, {
    body: `${CAPTURE_OBLIGATION_MARKER}:weekly review the backlog`,
    provenance: { source: "telegram", sender: "100", capturedAt: "2026-07-19T12:00:01Z" },
  });
  writeCaptureNote(vault, {
    body: "an atomic idea to keep",
    provenance: { source: "telegram", sender: "100", capturedAt: "2026-07-19T12:00:02Z" },
  });
}

test("default run is a dry-run report that writes nothing", async () => {
  seed();
  const res = await runCli(["brain", "inbox-drain", "--json"], { env: env() });
  expect(res.returncode).toBe(0);
  const parsed = JSON.parse(res.stdout) as {
    mode: string;
    routed: number;
    items: Array<{ classification: string; action: string; reason: string }>;
  };
  expect(parsed.mode).toBe("dry-run");
  expect(parsed.routed).toBe(0);
  expect(parsed.items).toHaveLength(2);

  // Rerun still sees both captures: the dry-run archived nothing.
  const again = await runCli(["brain", "inbox-drain", "--json"], { env: env() });
  expect((JSON.parse(again.stdout) as { items: unknown[] }).items).toHaveLength(2);
});

test("--apply routes and archives; a second apply is a no-op", async () => {
  seed();
  const res = await runCli(["brain", "inbox-drain", "--apply", "--json"], { env: env() });
  expect(res.returncode).toBe(0);
  const parsed = JSON.parse(res.stdout) as { mode: string; routed: number };
  expect(parsed.mode).toBe("apply");
  expect(parsed.routed).toBe(2);

  const rerun = await runCli(["brain", "inbox-drain", "--apply", "--json"], { env: env() });
  const rerunParsed = JSON.parse(rerun.stdout) as { routed: number; items: unknown[] };
  expect(rerunParsed.routed).toBe(0);
  expect(rerunParsed.items).toHaveLength(0);
});

test("text report names each action and reason", async () => {
  seed();
  const res = await runCli(["brain", "inbox-drain"], { env: env() });
  expect(res.returncode).toBe(0);
  expect(res.stdout).toContain("obligation");
  expect(res.stdout).toContain("idea");
});
