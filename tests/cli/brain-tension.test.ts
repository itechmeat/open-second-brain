/**
 * Tests for `o2b brain tension <action>` CLI verb (Belief lifecycle
 * suite, S2, t_0e3f2bee).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { persistTension } from "../../src/core/brain/tensions.ts";
import type { NoteContradictionFinding } from "../../src/core/brain/health/contradiction.ts";

let tmp: string;
let configDir: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-tension-cli-"));
  configDir = mkdtempSync(join(tmpdir(), "o2b-brain-tension-cli-cfg-"));
  vault = join(tmp, "vault");
  configPath = join(configDir, "config.yaml");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(configPath, `vault: ${vault}\nagent_name: tester\n`, "utf8");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

const env = { OPEN_SECOND_BRAIN_CONFIG: "", VAULT_AGENT_NAME: "" } as const;

function seed(): string {
  const finding: NoteContradictionFinding = {
    aId: "pref-tabs",
    bId: "pref-spaces",
    subject: "tabs use",
    jaccard: 0.6,
    aSign: "positive",
    bSign: "negative",
    aQuote: "Always use tabs.",
    bQuote: "Never use tabs.",
    action: "ask_user",
  };
  return persistTension(vault, finding, { agent: "tester" }).record.slug;
}

describe("o2b brain tension detect", () => {
  test("scans the note corpus and persists a tension", async () => {
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\nnotes:\n  read_paths:\n    - Notes\n",
      "utf8",
    );
    mkdirSync(join(vault, "Notes"), { recursive: true });
    writeFileSync(
      join(vault, "Notes", "tabs.md"),
      "---\nid: note-tabs\n---\nAlways use tabs for indentation in source files.\n",
      "utf8",
    );
    writeFileSync(
      join(vault, "Notes", "spaces.md"),
      "---\nid: note-spaces\n---\nNever use tabs for indentation in source files.\n",
      "utf8",
    );
    const r = await runCli(["brain", "tension", "detect", "--config", configPath, "--json"], {
      env,
    });
    expect(r.returncode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.scanned_files).toBe(2);
    expect(out.created).toBe(1);
    expect(out.tensions.length).toBe(1);
    expect(out.tensions[0].status).toBe("open");
  });

  test("rejects an out-of-range --jaccard", async () => {
    const r = await runCli(
      ["brain", "tension", "detect", "--config", configPath, "--jaccard", "2"],
      { env },
    );
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("--jaccard must be a number in (0, 1]");
  });
});

describe("o2b brain tension", () => {
  test("list surfaces a persisted open tension", async () => {
    seed();
    const r = await runCli(["brain", "tension", "list", "--config", configPath, "--json"], { env });
    expect(r.returncode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.tensions.length).toBe(1);
    expect(out.tensions[0].status).toBe("open");
  });

  test("confirm transitions open -> confirmed", async () => {
    const slug = seed();
    const r = await runCli(
      ["brain", "tension", "confirm", slug, "--config", configPath, "--json"],
      { env },
    );
    expect(r.returncode).toBe(0);
    expect(JSON.parse(r.stdout).status).toBe("confirmed");
  });

  test("resolve then confirm is rejected as an invalid transition", async () => {
    const slug = seed();
    await runCli(["brain", "tension", "resolve", slug, "--config", configPath], { env });
    const bad = await runCli(["brain", "tension", "confirm", slug, "--config", configPath], {
      env,
    });
    expect(bad.returncode).toBe(1);
    expect(bad.stderr).toContain("invalid tension transition");
  });

  test("dismiss records a reason and drops it from --unresolved", async () => {
    const slug = seed();
    await runCli(
      ["brain", "tension", "dismiss", slug, "--config", configPath, "--reason", "false alarm"],
      { env },
    );
    const r = await runCli(
      ["brain", "tension", "list", "--config", configPath, "--unresolved", "--json"],
      { env },
    );
    expect(JSON.parse(r.stdout).tensions.length).toBe(0);
  });
});
