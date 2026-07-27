/**
 * `o2b brain scan-inline --strict` and the routed marker kinds.
 *
 * `--strict` means "a scan that could not process everything it found is
 * a failure". It used to key on `malformed` alone, so a marker whose
 * DESTINATION refused it printed an error and still exited 0 - an
 * unattended run reading only the exit code saw a clean scan while a
 * fact never reached the preferences. The refusal is unprocessed work,
 * exactly as a malformed marker is, so both gate the exit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainConfigPath } from "../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../src/core/brain/config-template.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-scan-inline-strict-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test-agent\n`);
  bootstrapBrain(vault, { configPath });
  atomicWriteFileSync(
    brainConfigPath(vault),
    `${DEFAULT_BRAIN_CONFIG_YAML}\nnotes:\n  read_paths:\n    - Daily\n`,
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

function writeNote(rel: string, content: string): void {
  const path = join(vault, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  atomicWriteFileSync(path, content);
}

describe("--strict and a marker its destination refused", () => {
  test("an unresolvable premise exits non-zero instead of reporting a clean scan", async () => {
    writeNote("Daily/2026-07-27.md", "@osb fact topic=t principle=p premise=nope level=deduced\n");

    const strict = await runCli(["brain", "scan-inline", "--strict"], { env: env() });
    expect(strict.stdout).toContain("was refused");
    expect(strict.returncode).toBe(2);
  });

  test("without --strict the same scan still reports the refusal and exits 0", async () => {
    writeNote("Daily/2026-07-27.md", "@osb fact topic=t principle=p premise=nope level=deduced\n");

    const lenient = await runCli(["brain", "scan-inline"], { env: env() });
    expect(lenient.stdout).toContain("was refused");
    expect(lenient.returncode).toBe(0);
  });

  test("a scan with nothing to refuse still exits 0 under --strict", async () => {
    writeNote("Daily/2026-07-27.md", "@osb feedback positive topic=t principle=p\n");

    const strict = await runCli(["brain", "scan-inline", "--strict"], { env: env() });
    expect(strict.returncode).toBe(0);
    expect(strict.stdout).toContain("created: 1");
  });

  test("--dry-run --json reports the routed work it would do", async () => {
    writeNote(
      "Daily/2026-07-27.md",
      ['@osb skill name="release check" body="run the suite"', ""].join("\n"),
    );

    const dry = await runCli(["brain", "scan-inline", "--dry-run", "--json"], { env: env() });
    expect(dry.returncode).toBe(0);
    const payload = JSON.parse(dry.stdout) as Record<string, number>;
    expect(payload["skills"]).toBe(1);
    expect(payload["found"]).toBe(1);
    expect(payload["suppressed"]).toBe(0);
  });
});
