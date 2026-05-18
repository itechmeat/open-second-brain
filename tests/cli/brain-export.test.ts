/**
 * CLI tests for `o2b brain export` (§28).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-export-cli-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function bootstrap(): Promise<void> {
  const init = await runCli(["init", "--vault", vault, "--name", "TestExport"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(init.returncode).toBe(0);
  const brainInit = await runCli(["brain", "init", "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(brainInit.returncode).toBe(0);
}

async function seedPreference(slug: string): Promise<void> {
  const r = await runCli(
    [
      "brain",
      "feedback",
      "--vault",
      vault,
      "--topic",
      slug,
      "--signal",
      "positive",
      "--principle",
      `principle ${slug}`,
      "--scope",
      "writing",
      "--force-confirmed",
      "--agent",
      "claude",
    ],
    { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
  );
  expect(r.returncode).toBe(0);
}

describe("brain export", () => {
  test("missing --format → exit 2", async () => {
    await bootstrap();
    const r = await runCli(
      ["brain", "export", "--vault", vault],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("--format");
  });

  test("--format json on empty vault → schema envelope, empty list", async () => {
    await bootstrap();
    const r = await runCli(
      ["brain", "export", "--vault", vault, "--format", "json"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      schema: number;
      generated_at: string;
      vault_basename: string;
      preferences: ReadonlyArray<{ id: string }>;
    };
    expect(payload.schema).toBe(1);
    expect(payload.preferences).toEqual([]);
    expect(payload.vault_basename.length).toBeGreaterThan(0);
  });

  test("--format json carries seeded preference rows", async () => {
    await bootstrap();
    await seedPreference("alpha");
    await seedPreference("beta");
    const r = await runCli(
      ["brain", "export", "--vault", vault, "--format", "json"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      preferences: Array<{ id: string; topic: string; principle: string }>;
    };
    expect(payload.preferences.map((p) => p.id).sort()).toEqual([
      "pref-alpha",
      "pref-beta",
    ]);
  });

  test("--format llms-txt emits H1 + section + bullet", async () => {
    await bootstrap();
    await seedPreference("alpha");
    const r = await runCli(
      ["brain", "export", "--vault", vault, "--format", "llms-txt"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toMatch(/^# .*Brain preferences/);
    expect(r.stdout).toContain("## Confirmed");
    expect(r.stdout).toContain(
      "- pref-alpha (topic: alpha, scope: writing): principle alpha",
    );
  });

  test("--out writes a file (and refuses to overwrite without --force)", async () => {
    await bootstrap();
    await seedPreference("alpha");
    const out = join(tmp, "out.json");
    const r1 = await runCli(
      [
        "brain",
        "export",
        "--vault",
        vault,
        "--format",
        "json",
        "--out",
        out,
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r1.returncode).toBe(0);
    expect(existsSync(out)).toBe(true);
    const parsed = JSON.parse(readFileSync(out, "utf8")) as {
      preferences: ReadonlyArray<unknown>;
    };
    expect(parsed.preferences.length).toBe(1);

    // Second call without --force should refuse.
    const r2 = await runCli(
      [
        "brain",
        "export",
        "--vault",
        vault,
        "--format",
        "json",
        "--out",
        out,
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r2.returncode).toBe(1);
    expect(r2.stderr).toContain("--force");

    // With --force the overwrite goes through.
    writeFileSync(out, "stale");
    const r3 = await runCli(
      [
        "brain",
        "export",
        "--vault",
        vault,
        "--format",
        "json",
        "--out",
        out,
        "--force",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r3.returncode).toBe(0);
    expect(readFileSync(out, "utf8")).not.toBe("stale");
  });

  test("help text mentions export", async () => {
    const r = await runCli(["brain", "--help"]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("export");
  });
});
