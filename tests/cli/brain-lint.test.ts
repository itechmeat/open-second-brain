/**
 * `o2b brain lint` at the CLI level (no-dead-ends, task 23).
 *
 * The verb is write-capable and had no CLI-level test of any kind: the
 * consolidation pass underneath it was covered, but nothing exercised the
 * flag parsing, the non-interactive `--yes` gate, the JSON surface, or
 * the claim that a dry run writes nothing. This release touches the pass
 * (task 10 moved its write guard), so the tier is established here.
 *
 * The two load-bearing assertions:
 *
 *   - a dry run leaves the vault tree digest UNCHANGED - measured over
 *     every file, not over the ones the report happened to name;
 *   - an apply changes EXACTLY the set the dry run reported - the set is
 *     compared, not merely its size or the fact that something moved.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { resetVaultIdentityPins } from "../../src/core/brain/vault-identity.ts";
import { runCli } from "../helpers/run-cli.ts";
import { changedPaths, digestVaultFiles, digestVaultTree } from "../helpers/vault-digest.ts";

let tmp: string;
let vault: string;
let configPath: string;

/** A lint report as the `--json` surface renders it. */
interface LintJson {
  readonly scanned: number;
  readonly applied: boolean;
  readonly files_written: number;
  readonly fixes: ReadonlyArray<{ path: string; from: string; to: string }>;
  readonly demotions: ReadonlyArray<{ id: string; path: string }>;
}

beforeEach(() => {
  resetVaultIdentityPins();
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-lint-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: test-agent\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  resetVaultIdentityPins();
  rmSync(tmp, { recursive: true, force: true });
});

function pref(id: string, extra = ""): string {
  return `---\nid: ${id}\ntopic: t\nprinciple: p\n${extra}---\n\nbody\n`;
}

/**
 * A merged secondary plus two log days still naming it: the lint has two
 * distinct files to rewrite, so "exactly the reported set" is a real
 * claim rather than a one-element coincidence.
 */
function seedMergedLinks(): void {
  const dirs = brainDirs(vault);
  writeFileSync(join(dirs.preferences, "pref-canon.md"), pref("pref-canon"));
  writeFileSync(
    join(dirs.preferences, "pref-dup.md"),
    pref("pref-dup", "merged_into: pref-canon\n"),
  );
  writeFileSync(join(dirs.log, "2026-05-25.md"), "saw [[pref-dup]] today\n");
  writeFileSync(join(dirs.log, "2026-05-26.md"), "still [[pref-dup]] here\n");
}

function env(): Record<string, string> {
  return { OPEN_SECOND_BRAIN_CONFIG: configPath };
}

function toRel(absolute: string): string {
  return relative(vault, absolute).split(sep).join("/");
}

describe("o2b brain lint --consolidate", () => {
  test("the JSON surface parses and reports the drift", async () => {
    seedMergedLinks();

    const out = await runCli(["brain", "lint", "--consolidate", "--vault", vault, "--json"], {
      env: env(),
    });

    expect(out.returncode).toBe(0);
    const report = JSON.parse(out.stdout) as LintJson;
    expect(report.applied).toBe(false);
    expect(report.files_written).toBe(0);
    expect(report.scanned).toBeGreaterThan(0);
    expect(report.fixes.map((f) => f.from)).toEqual(["pref-dup", "pref-dup"]);
    expect(report.fixes.map((f) => f.to)).toEqual(["pref-canon", "pref-canon"]);
  });

  test("a dry run leaves the vault tree digest unchanged", async () => {
    seedMergedLinks();
    const before = digestVaultTree(vault);

    const human = await runCli(["brain", "lint", "--consolidate", "--vault", vault], {
      env: env(),
    });
    expect(human.returncode).toBe(0);
    expect(human.stdout).toContain("dry-run");
    expect(human.stdout).toContain("re-run with --apply --yes to write changes.");

    expect(digestVaultTree(vault)).toBe(before);
  });

  test("an apply changes exactly the set the dry run reported", async () => {
    seedMergedLinks();

    const preview = JSON.parse(
      (await runCli(["brain", "lint", "--consolidate", "--vault", vault, "--json"], { env: env() }))
        .stdout,
    ) as LintJson;
    const reported = [...new Set(preview.fixes.map((f) => toRel(f.path)))].toSorted();
    expect(reported).toEqual(["Brain/log/2026-05-25.md", "Brain/log/2026-05-26.md"]);

    const before = digestVaultFiles(vault);
    const applied = await runCli(
      ["brain", "lint", "--consolidate", "--apply", "--yes", "--vault", vault, "--json"],
      { env: env() },
    );
    expect(applied.returncode).toBe(0);
    const result = JSON.parse(applied.stdout) as LintJson;
    expect(result.applied).toBe(true);
    expect(result.files_written).toBe(reported.length);

    expect(changedPaths(before, digestVaultFiles(vault))).toEqual(reported);
  });

  test("a clean vault reports nothing and writes nothing", async () => {
    const before = digestVaultTree(vault);
    const out = await runCli(["brain", "lint", "--consolidate", "--vault", vault, "--json"], {
      env: env(),
    });
    const report = JSON.parse(out.stdout) as LintJson;
    expect(report.fixes).toEqual([]);
    expect(report.demotions).toEqual([]);
    expect(digestVaultTree(vault)).toBe(before);
  });
});

describe("o2b brain lint - refusals", () => {
  test("--apply without --yes is refused on the JSON path and writes nothing", async () => {
    seedMergedLinks();
    const before = digestVaultTree(vault);

    const out = await runCli(
      ["brain", "lint", "--consolidate", "--apply", "--vault", vault, "--json"],
      { env: env() },
    );

    expect(out.returncode).not.toBe(0);
    expect(digestVaultTree(vault)).toBe(before);
  });

  test("no mode flag is a named refusal, not a silent success", async () => {
    const out = await runCli(["brain", "lint", "--vault", vault], { env: env() });
    expect(out.returncode).not.toBe(0);
    expect(out.stderr).toContain("--consolidate");
  });
});
