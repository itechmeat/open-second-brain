/**
 * CLI surface tests for `o2b vault status` and `o2b vault inspect`
 * (v0.10.9). Each test bootstraps a fresh vault via `o2b init` and
 * `o2b brain init` (the same scaffold pattern as the existing
 * brain CLI tests).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-vault-cli-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function bootstrap(): Promise<void> {
  let r = await runCli(["init", "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(r.returncode).toBe(0);
  r = await runCli(["brain", "init", "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(r.returncode).toBe(0);
}

describe("o2b vault status", () => {
  test("prints counts and the active source on a fresh vault", async () => {
    await bootstrap();
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    writeFileSync(join(vault, ".obsidian", "app.json"), "{}");
    writeFileSync(join(vault, "Notes.md"), "x");
    const r = await runCli(["vault", "status", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("ignore source: _brain.yaml");
    expect(r.stdout).toMatch(/\.obsidian\s+rule \.obsidian \(name\)/);
  });

  test("--json output has stable shape", async () => {
    await bootstrap();
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    const r = await runCli(["vault", "status", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.ignore_source).toBe("_brain.yaml");
    expect(typeof payload.included.files).toBe("number");
    expect(typeof payload.included.dirs).toBe("number");
    expect(Array.isArray(payload.excluded.dirs)).toBe(true);
    expect(payload.excluded.dirs.some(
      (d: { rel_path: string }) => d.rel_path === ".obsidian",
    )).toBe(true);
    expect(Array.isArray(payload.rules)).toBe(true);
  });
});

describe("o2b vault inspect", () => {
  test("reports an included path that exists on disk (no suffix)", async () => {
    await bootstrap();
    writeFileSync(join(vault, "idea.md"), "x");
    const r = await runCli(
      ["vault", "inspect", "idea.md", "--vault", vault],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("status:       included");
    expect(r.stdout).not.toContain("(not found on disk)");
  });

  test("reports an included path missing from disk with (not found on disk) suffix", async () => {
    await bootstrap();
    const r = await runCli(
      ["vault", "inspect", "hypothetical.md", "--vault", vault],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("status:       included (not found on disk)");
  });

  test("reports an excluded path with matched rule, source, and (not found) suffix when file is hypothetical", async () => {
    await bootstrap();
    const r = await runCli(
      [
        "vault",
        "inspect",
        ".obsidian/plugins/foo/note.md",
        "--vault",
        vault,
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("status:       excluded (not found on disk)");
    expect(r.stdout).toContain("matched rule: .obsidian (name)");
    expect(r.stdout).toContain("matched at:   .obsidian");
    expect(r.stdout).toContain("source:       _brain.yaml");
  });

  test("missing relpath exits 2 with usage hint", async () => {
    await bootstrap();
    const r = await runCli(["vault", "inspect", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("usage:");
  });

  test("path traversal exits 2", async () => {
    await bootstrap();
    const r = await runCli(
      ["vault", "inspect", "../outside", "--vault", vault],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("traverse");
  });

  test("--json shape exposes matched_rule, matched_at, exists_on_disk", async () => {
    await bootstrap();
    const r = await runCli(
      [
        "vault",
        "inspect",
        ".obsidian/plugins/foo/note.md",
        "--vault",
        vault,
        "--json",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.status).toBe("excluded");
    expect(payload.exists_on_disk).toBe(false);
    expect(payload.matched_rule.raw).toBe(".obsidian");
    expect(payload.matched_rule.kind).toBe("name");
    expect(payload.matched_at).toBe(".obsidian");
    expect(payload.source).toBe("_brain.yaml");
  });

  test("--json on included path has matched_rule=null and exists_on_disk=true when file present", async () => {
    await bootstrap();
    writeFileSync(join(vault, "idea.md"), "x");
    const r = await runCli(
      ["vault", "inspect", "idea.md", "--vault", vault, "--json"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    const payload = JSON.parse(r.stdout);
    expect(payload.status).toBe("included");
    expect(payload.exists_on_disk).toBe(true);
    expect(payload.matched_rule).toBeNull();
  });
});

describe("o2b vault dispatcher", () => {
  test("no verb prints help and exits 2", async () => {
    const r = await runCli(["vault"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(2);
    expect(r.stdout).toContain("usage: o2b vault");
  });

  test("unknown verb exits 2", async () => {
    const r = await runCli(["vault", "explode"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("unknown vault verb");
  });
});
