/**
 * A read-only verb must not fail with a write-path error
 * (no-dead-ends, task 10).
 *
 * `lintConsolidate` asserted vault identity unconditionally, at its entry
 * and ahead of its `apply` branch. The read-only `o2b brain actions`
 * ranking verb calls it in report mode, so a root the write guard refuses
 * took down a command that never intended to write a byte - which is the
 * guard's own contract inverted, since it exists to gate writes.
 *
 * The assertion now follows the one rule the appliers share: at the entry
 * point, before any other work, and only when the call will write.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { lintConsolidate } from "../../../src/core/brain/lint-consolidate.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import {
  VaultIdentityMismatchError,
  assertVaultIdentityForWrite,
  resetVaultIdentityPins,
  vaultIdentityPath,
  writeVaultIdentity,
} from "../../../src/core/brain/vault-identity.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { runCli } from "../../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  resetVaultIdentityPins();
  tmp = mkdtempSync(join(tmpdir(), "o2b-lint-read-path-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test-agent\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  resetVaultIdentityPins();
  rmSync(tmp, { recursive: true, force: true });
});

function frontmatter(id: string, extra = ""): string {
  return `---\nid: ${id}\ntopic: t\nprinciple: p\n${extra}---\n\nbody\n`;
}

/** A page whose merged_into pointer gives the lint something to report. */
function seedMergedPair(): string {
  const prefs = brainDirs(vault).preferences;
  writeFileSync(join(prefs, "pref-canon.md"), frontmatter("pref-canon"));
  writeFileSync(join(prefs, "pref-dup.md"), frontmatter("pref-dup", "merged_into: pref-canon\n"));
  const log = join(brainDirs(vault).log, "2026-05-25.md");
  writeFileSync(log, "saw [[pref-dup]] today\n");
  return log;
}

/**
 * Put the resolved root into the ONE state the guard refuses: a marker
 * this process already pinned, replaced by a different one.
 */
function makeVaultIdentityMismatch(): void {
  writeVaultIdentity(vault);
  assertVaultIdentityForWrite(vault);
  atomicWriteFileSync(
    vaultIdentityPath(vault),
    `${JSON.stringify(
      { schema_version: 1, vault_id: "e".repeat(32), created_at: "2026-01-01T00:00:00.000Z" },
      null,
      2,
    )}\n`,
  );
}

describe("lintConsolidate in report mode is a pure read", () => {
  test("a root the write guard refuses still returns its report", () => {
    const log = seedMergedPair();
    const before = readFileSync(log, "utf8");
    makeVaultIdentityMismatch();

    const report = lintConsolidate(vault, { apply: false });

    expect(report.applied).toBe(false);
    expect(report.fixes).toHaveLength(1);
    expect(report.fixes[0]!.from).toBe("pref-dup");
    expect(report.filesWritten).toBe(0);
    expect(readFileSync(log, "utf8")).toBe(before);
  });

  test("apply mode against the same root still refuses", () => {
    const log = seedMergedPair();
    const before = readFileSync(log, "utf8");
    makeVaultIdentityMismatch();

    expect(() => lintConsolidate(vault, { apply: true })).toThrow(VaultIdentityMismatchError);
    // The refusal lands before the first byte, which is the placement rule.
    expect(readFileSync(log, "utf8")).toBe(before);
  });

  test("apply mode on a healthy root writes, so the guard did not become a no-op", () => {
    const log = seedMergedPair();
    const report = lintConsolidate(vault, { apply: true });
    expect(report.filesWritten).toBeGreaterThan(0);
    expect(readFileSync(log, "utf8")).toContain("[[pref-canon]]");
  });
});

describe("o2b brain actions - the verb the defect took down", () => {
  test("the read-only ranking verb succeeds on a root the write guard refuses", async () => {
    seedMergedPair();
    makeVaultIdentityMismatch();

    const result = await runCli(["brain", "actions", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });

    expect(result.returncode).toBe(0);
    expect(() => JSON.parse(result.stdout) as unknown).not.toThrow();
  });
});
