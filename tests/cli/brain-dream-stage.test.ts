/**
 * `o2b brain dream stage|validate|apply|discard|list` CLI surface
 * (t_ae8a8ec0): the staged lifecycle drives the same engine as the
 * inline pass; validate exits 1 on drift so cron and scripts can gate
 * on it; usage errors exit 2; legacy `o2b brain dream` keeps working
 * positional-free.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-dream-stage-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  for (const key of ["OPEN_SECOND_BRAIN_CONFIG", "VAULT_DIR"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function seedCluster(topic: string): void {
  for (const i of [1, 2, 3]) {
    writeSignal(vault, {
      topic,
      signal: "positive",
      agent: "claude",
      principle: `Rule for ${topic}.`,
      created_at: "2026-06-01T10:00:00Z",
      date: "2026-06-01",
      slug: `${topic}-${i}`,
      scope: "writing",
    });
  }
}

test("full stage -> validate -> apply cycle via the CLI", async () => {
  seedCluster("cli-cycle");
  const staged = await runCli([
    "brain",
    "dream",
    "stage",
    "--now",
    "2026-06-05T12:00:00Z",
    "--vault",
    vault,
    "--json",
  ]);
  expect(staged.returncode).toBe(0);
  const stagedOut = JSON.parse(staged.stdout) as { run_id: string; plan: { changed: boolean } };
  expect(stagedOut.plan.changed).toBe(true);

  const validated = await runCli([
    "brain",
    "dream",
    "validate",
    stagedOut.run_id,
    "--now",
    "2026-06-05T12:00:00Z",
    "--vault",
    vault,
    "--json",
  ]);
  expect(validated.returncode).toBe(0);
  expect(JSON.parse(validated.stdout)).toMatchObject({ valid: true, drift: [] });

  const applied = await runCli([
    "brain",
    "dream",
    "apply",
    stagedOut.run_id,
    "--now",
    "2026-06-05T12:00:00Z",
    "--vault",
    vault,
    "--json",
  ]);
  expect(applied.returncode).toBe(0);
  expect(JSON.parse(applied.stdout)).toMatchObject({
    applied: true,
    new_unconfirmed: ["pref-cli-cycle"],
  });
  expect(existsSync(join(vault, "Brain", "preferences", "pref-cli-cycle.md"))).toBe(true);

  const listed = await runCli(["brain", "dream", "list", "--vault", vault, "--json"]);
  const bundles = (JSON.parse(listed.stdout) as { bundles: Array<{ status: string }> }).bundles;
  expect(bundles[0]!.status).toBe("applied");
});

test("validate exits 1 on drift; apply aborts without writes", async () => {
  seedCluster("cli-drift");
  const staged = await runCli([
    "brain",
    "dream",
    "stage",
    "--now",
    "2026-06-05T12:00:00Z",
    "--vault",
    vault,
    "--json",
  ]);
  const runId = (JSON.parse(staged.stdout) as { run_id: string }).run_id;
  seedCluster("cli-newcomer");

  const validated = await runCli(["brain", "dream", "validate", runId, "--vault", vault, "--json"]);
  expect(validated.returncode).toBe(1);
  expect(JSON.parse(validated.stdout)).toMatchObject({ valid: false });

  const applied = await runCli(["brain", "dream", "apply", runId, "--vault", vault, "--json"]);
  expect(applied.returncode).toBe(1);
  expect(JSON.parse(applied.stdout)).toMatchObject({ applied: false });
  expect(existsSync(join(vault, "Brain", "preferences", "pref-cli-drift.md"))).toBe(false);
});

test("discard removes the bundle; usage errors exit 2", async () => {
  seedCluster("cli-discard");
  const staged = await runCli([
    "brain",
    "dream",
    "stage",
    "--now",
    "2026-06-05T12:00:00Z",
    "--vault",
    vault,
    "--json",
  ]);
  const runId = (JSON.parse(staged.stdout) as { run_id: string }).run_id;
  const discarded = await runCli(["brain", "dream", "discard", runId, "--vault", vault, "--json"]);
  expect(JSON.parse(discarded.stdout)).toMatchObject({ removed: true });

  const badAction = await runCli(["brain", "dream", "snooze", "--vault", vault]);
  expect(badAction.returncode).toBe(2);
  const missingId = await runCli(["brain", "dream", "apply", "--vault", vault]);
  expect(missingId.returncode).toBe(2);
});

test("legacy positional-free dream run still works", async () => {
  seedCluster("cli-legacy");
  const r = await runCli([
    "brain",
    "dream",
    "--now",
    "2026-06-05T12:00:00Z",
    "--vault",
    vault,
    "--json",
  ]);
  expect(r.returncode).toBe(0);
  const summary = JSON.parse(r.stdout) as { new_unconfirmed: string[] };
  expect(summary.new_unconfirmed).toEqual(["pref-cli-legacy"]);
});
