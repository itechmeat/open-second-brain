import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { stagePendingSignal } from "../../src/core/brain/pending.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-pending-cli-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test-agent\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

function stage(slug: string): string {
  const res = stagePendingSignal(vault, {
    topic: slug,
    signal: "positive",
    agent: "test-agent",
    principle: `https://${slug}.dev`,
    created_at: "2026-07-18T12:00:00Z",
    date: "2026-07-18",
    slug,
    source_type: "extracted",
    dedup_hash: `hash-${slug}`,
  });
  return res.id;
}

function inboxNames(): string[] {
  return readdirSync(brainDirs(vault).inbox).filter((f) => f.startsWith("sig-"));
}

describe("o2b brain pending", () => {
  test("list --json reports the staged queue", async () => {
    const id = stage("fact-url");
    const out = await runCli(["brain", "pending", "list", "--json"], { env: env() });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as { pending: Array<{ id: string }>; total: number };
    expect(payload.total).toBe(1);
    expect(payload.pending[0]!.id).toBe(id);
  });

  test("apply moves a staged signal into the inbox", async () => {
    const id = stage("fact-url");
    const out = await runCli(["brain", "pending", "apply", id], { env: env() });
    expect(out.returncode).toBe(0);
    expect(out.stdout).toContain(`applied: ${id}`);
    expect(inboxNames()).toContain(`${id}.md`);
    expect(existsSync(join(brainDirs(vault).pending, `${id}.md`))).toBe(false);
  });

  test("reject moves a staged signal to retired with a reason", async () => {
    const id = stage("fact-url");
    const out = await runCli(
      ["brain", "pending", "reject", id, "--reason", "not useful", "--json"],
      { env: env() },
    );
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as { status: string; reason: string };
    expect(payload.status).toBe("rejected");
    expect(payload.reason).toBe("not useful");
    expect(existsSync(join(brainDirs(vault).retired, `${id}.md`))).toBe(true);
  });

  test("apply of a missing id exits 2 (typed error, not a no-op)", async () => {
    const out = await runCli(["brain", "pending", "apply", "sig-2026-07-18-nope"], {
      env: env(),
    });
    expect(out.returncode).toBe(2);
    expect(out.stderr).toContain("pending signal not found");
  });

  test("reject without --reason is a usage error", async () => {
    const id = stage("fact-url");
    const out = await runCli(["brain", "pending", "reject", id], { env: env() });
    expect(out.returncode).not.toBe(0);
  });

  test("list on an empty queue reports nothing", async () => {
    const out = await runCli(["brain", "pending", "list"], { env: env() });
    expect(out.returncode).toBe(0);
    expect(out.stdout).toContain("no pending signals");
  });
});
