/**
 * Help text for the write-honesty surfaces (F4, t_fb442a24; F1 restamp).
 *
 * `o2b brain <verb> --help` prints `VERB_HELP[verb]` and exits 0; a verb
 * with no entry dumps the whole `BRAIN_HELP` and exits 2, which reads as a
 * usage error. Both defects pinned here were discoverability dead ends:
 * the claims surface said nothing about the `undated-quantity` finding it
 * is the exit for, and `privacy-marker-restamp` had no entry at all.
 *
 * The restamp describe also pins its forward pointer: the local-search
 * consequence of a stamp travels as prose beside the advisory rail's
 * structural line (`restamp-local-visibility`), never as a hand-written
 * invocation literal - the forward-pointer rail's own test is the ratchet
 * for that, this is the migrated verb's behaviour pin.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { runCli } from "../helpers/run-cli.ts";

describe("o2b brain claims --help", () => {
  test("names the undated-quantity finding class and its structural hatches", async () => {
    const res = await runCli(["brain", "claims", "--help"]);
    expect(res.returncode).toBe(0);
    expect(res.stdout.startsWith("usage:")).toBe(true);
    expect(res.stdout).toContain("undated-quantity");
    expect(res.stdout).toContain("valid_from");
    expect(res.stdout).toContain("[Source:");
    expect(res.stdout).not.toContain("!");
  });
});

describe("o2b brain privacy-marker-restamp --help", () => {
  test("has its own entry rather than the whole brain help", async () => {
    const res = await runCli(["brain", "privacy-marker-restamp", "--help"]);
    expect(res.returncode).toBe(0);
    expect(res.stdout.startsWith("usage: o2b brain privacy-marker-restamp")).toBe(true);
    // Dry-run default, the applying flag, and the reserve token contract.
    expect(res.stdout).toContain("--apply");
    expect(res.stdout).toContain("dry-run");
    expect(res.stdout).toContain("visibility:");
    expect(res.stdout).toContain("idempotent");
    expect(res.stdout).toContain("never removes");
    // The three informal markers the verb looks for, named factually.
    expect(res.stdout).toContain("access");
    expect(res.stdout).toContain("confidentiality");
    expect(res.stdout).toContain("sensitivity");
    expect(res.stdout).not.toContain("!");
  });

  test("o2b brain --help lists the verb", async () => {
    const res = await runCli(["brain", "--help"]);
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("privacy-marker-restamp");
  });
});

describe("o2b brain privacy-marker-restamp emits through the advisory rail", () => {
  let tmp: string;
  let vault: string;
  let configPath: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "o2b-restamp-rail-"));
    vault = join(tmp, "vault");
    configPath = join(tmp, "config.yaml");
    for (const key of ["VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG", "VAULT_AGENT_NAME"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
    bootstrapBrain(vault, { configPath });
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, "marked.md"), "---\naccess: private\n---\n\nMarked.\n");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("the dry run states the consequence and defers the command to the rail", async () => {
    const res = await runCli(["brain", "privacy-marker-restamp", "--vault", vault]);
    expect(res.returncode).toBe(0);
    // The consequence is prose; the command is the rail's structural line.
    expect(res.stdout).toContain(
      "note: after --apply each stamped page is also excluded from default-scope local search",
    );
    expect(res.stdout).toContain("next: o2b search --visibility=private\n");
    // No hand-written invocation beside the rail.
    expect(res.stdout).not.toContain("reach it again with");
  });

  test("--apply names the same exit through the rail", async () => {
    const res = await runCli(["brain", "privacy-marker-restamp", "--vault", vault, "--apply"]);
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("updated 1 of 1 candidate(s)");
    expect(res.stdout).toContain(
      "note: each stamped page is now also excluded from default-scope local search",
    );
    expect(res.stdout).toContain("next: o2b search --visibility=private\n");
  });

  test("the rail line stays off the machine stream", async () => {
    const res = await runCli(["brain", "privacy-marker-restamp", "--vault", vault, "--json"]);
    expect(res.returncode).toBe(0);
    expect(res.stdout).not.toContain("next: ");
    expect(() => JSON.parse(res.stdout)).not.toThrow();
  });

  test("a vault with no marker pages names no exit", async () => {
    rmSync(join(vault, "marked.md"));
    const res = await runCli(["brain", "privacy-marker-restamp", "--vault", vault]);
    expect(res.returncode).toBe(0);
    expect(res.stdout).not.toContain("next: ");
    expect(res.stdout).not.toContain("excluded from default-scope local search");
  });
});
