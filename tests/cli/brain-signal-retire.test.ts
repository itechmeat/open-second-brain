/**
 * A5 (t_66c12a67): CLI surface for the fact signal retire lifecycle.
 *
 * `o2b brain signal retire <id> --reason <text> [--superseded-by <id>]`
 * moves an inbox signal into Brain/retired/. A missing / already-retired /
 * non-signal id exits 2 (never a silent no-op).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-signal-retire-cli-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test-agent\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

function seed(slug: string): string {
  const res = writeSignal(vault, {
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

describe("o2b brain signal retire", () => {
  test("retire moves an inbox signal into retired/", async () => {
    const id = seed("fact-url");
    const out = await runCli(
      ["brain", "signal", "retire", id, "--reason", "no longer relevant", "--json"],
      { env: env() },
    );
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as { id: string; path: string; status: string };
    expect(payload.id).toBe(id);
    expect(payload.status).toBe("retired");
    expect(existsSync(join(brainDirs(vault).inbox, `${id}.md`))).toBe(false);
    expect(existsSync(join(brainDirs(vault).retired, `${id}.md`))).toBe(true);
  });

  test("missing --reason exits non-zero without moving anything", async () => {
    const id = seed("fact-url");
    const out = await runCli(["brain", "signal", "retire", id], { env: env() });
    expect(out.returncode).not.toBe(0);
    expect(existsSync(join(brainDirs(vault).inbox, `${id}.md`))).toBe(true);
    expect(existsSync(join(brainDirs(vault).retired, `${id}.md`))).toBe(false);
  });

  test("a missing id exits 2", async () => {
    const out = await runCli(
      ["brain", "signal", "retire", "sig-2026-07-18-absent", "--reason", "x"],
      { env: env() },
    );
    expect(out.returncode).toBe(2);
  });
});
