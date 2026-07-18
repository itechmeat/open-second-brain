import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeSignal } from "../../src/core/brain/signal.ts";
import { parseFrontmatter } from "../../src/core/vault.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-authored-at-cli-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function bootstrap(): Promise<void> {
  const init = await runCli(["init", "--vault", vault, "--name", "Test"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(init.returncode).toBe(0);
  const brainInit = await runCli(["brain", "init", "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(brainInit.returncode).toBe(0);
}

/** A pre-feature session signal: turn instant preserved, no authored_at. */
function oldSessionSignal(): string {
  const { path } = writeSignal(vault, {
    topic: "alpha",
    signal: "positive",
    agent: "test",
    principle: "pre-feature session turn",
    created_at: "2026-05-20T10:00:00Z",
    date: "2026-05-20",
    slug: "alpha",
    source_type: "session",
    valid_from: "2026-05-20T10:00:00Z",
    recorded_at: "2026-05-20T10:00:00Z",
  });
  return path;
}

test("authored-at-backfill dry-run reports candidates without writing", async () => {
  await bootstrap();
  const path = oldSessionSignal();

  const result = await runCli(["brain", "authored-at-backfill", "--vault", vault, "--json"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(result.returncode).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.ok).toBe(true);
  expect(payload.dry_run).toBe(true);
  expect(payload.updated).toBe(0);
  expect(payload.candidates).toHaveLength(1);
  expect(parseFrontmatter(path)[0]["authored_at"]).toBeUndefined();
});

test("authored-at-backfill --apply stamps the field and is idempotent", async () => {
  await bootstrap();
  const path = oldSessionSignal();

  const applied = await runCli(
    ["brain", "authored-at-backfill", "--vault", vault, "--apply", "--json"],
    { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
  );
  expect(applied.returncode).toBe(0);
  expect(JSON.parse(applied.stdout).updated).toBe(1);
  expect(parseFrontmatter(path)[0]["authored_at"]).toBe("2026-05-20T10:00:00Z");

  const rerun = await runCli(
    ["brain", "authored-at-backfill", "--vault", vault, "--apply", "--json"],
    { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
  );
  expect(rerun.returncode).toBe(0);
  expect(JSON.parse(rerun.stdout).updated).toBe(0);
});
