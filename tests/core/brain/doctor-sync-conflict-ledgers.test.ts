/**
 * `sync-conflict-log` covers every ledger directory (who-wrote-what,
 * Task B / t_1814b9bf; extended by t_774dea61).
 *
 * The per-device shard layout means no reader merges a Syncthing
 * conflict copy - not under `Brain/log/`, not under its audit
 * subdirectories, and not under any other append-only ledger directory
 * that now shards the same way. One exit, one meaning: "a sync conflict
 * copy exists that no reader merges", with the directory named in the
 * detail so an operator knows where to do the union+dedup merge.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HYGIENE_AUDIT_DIR,
  SECRET_CUSTODY_AUDIT_DIR,
  SESSION_LIFECYCLE_AUDIT_DIR,
  WATCHDOG_AUDIT_DIR,
} from "../../../src/core/brain/audit-dirs.ts";
import { continuityLogDir } from "../../../src/core/brain/continuity/store.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { idempotencyLogDir } from "../../../src/core/brain/idempotency-ledger.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { gitStoreDir } from "../../../src/core/brain/git/store.ts";
import { brainStateDirPath } from "../../../src/core/brain/lineage/ledger.ts";
import { metricsDir } from "../../../src/core/brain/metrics.ts";
import { BRAIN_SKILL_PROPOSALS_REL } from "../../../src/core/brain/path-constants.ts";
import { brainDirs, hookAuditDir, prefAuditDir } from "../../../src/core/brain/paths.ts";
import { schemaMutationAuditDir } from "../../../src/core/brain/schema-integrity.ts";
import { watchdogFallbackAuditDir } from "../../../src/core/brain/watchdog.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-conflict-sweep-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-conflict-sweep-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** The conflict-copy name Syncthing writes, for an arbitrary stem. */
function conflictName(stem: string): string {
  return `${stem}.sync-conflict-20260610-120000-ABCDEFG.jsonl`;
}

function plant(dir: string, stem: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, conflictName(stem));
  writeFileSync(path, "{}\n", "utf8");
  return path;
}

function conflictFindings(): ReadonlyArray<{ message: string; path?: string }> {
  return runDoctor(vault).warnings.filter((i) => i.code === "sync-conflict-log");
}

describe("sync-conflict sweep across every ledger directory", () => {
  const LEDGERS: ReadonlyArray<readonly [string, (v: string) => string, string]> = [
    ["Brain log", (v) => brainDirs(v).log, "2026-06-10"],
    ["continuity", continuityLogDir, "2026-06"],
    ["idempotency", idempotencyLogDir, "2026-06"],
    ["preference audit", prefAuditDir, "pref-alpha"],
    ["metrics", metricsDir, "index"],
    ["Brain state", brainStateDirPath, "session-lineage"],
    [
      "session-lifecycle audit",
      (v) => join(brainDirs(v).log, SESSION_LIFECYCLE_AUDIT_DIR),
      "2026-W24",
    ],
    ["hygiene audit", (v) => join(brainDirs(v).log, HYGIENE_AUDIT_DIR), "2026-W24"],
    ["schema-mutation audit", schemaMutationAuditDir, "2026-W24"],
    ["secret-custody audit", (v) => join(brainDirs(v).log, SECRET_CUSTODY_AUDIT_DIR), "2026-W24"],
    ["watchdog audit", (v) => join(brainDirs(v).log, WATCHDOG_AUDIT_DIR), "2026-W24"],
    ["watchdog audit fallback", watchdogFallbackAuditDir, "2026-W24"],
    ["hook audit", hookAuditDir, "2026-W24"],
    ["skill-proposal ledger", (v) => join(v, BRAIN_SKILL_PROPOSALS_REL), "verifier-rejections"],
    ["preferences", (v) => brainDirs(v).preferences, "pref-alpha.history"],
  ];

  test.each(LEDGERS)("%s: a conflict copy is reported with its directory", (_label, dir, stem) => {
    const path = plant(dir(vault), stem);
    const findings = conflictFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0]!.path).toBe(path);
    expect(findings[0]!.message).toContain("sync-conflict");
  });

  test("a clean vault reports nothing", () => {
    expect(conflictFindings()).toHaveLength(0);
  });

  test("every ledger directory is swept in one pass", () => {
    for (const [, dir, stem] of LEDGERS) plant(dir(vault), stem);
    expect(conflictFindings()).toHaveLength(LEDGERS.length);
  });

  test("the swept directories are distinct, so no one of them is swept twice", () => {
    const dirs = LEDGERS.map(([, dir]) => dir(vault));
    expect(new Set(dirs).size).toBe(LEDGERS.length);
  });

  /**
   * The preference audit is the one ledger whose shards live a level
   * down - one directory per preference - so sweeping only its parent
   * would report a clean ledger while a copy nobody merges sat inside.
   */
  test("a conflict copy inside a per-preference directory is reported too", () => {
    const path = plant(join(prefAuditDir(vault), "pref-alpha"), "device");
    const findings = conflictFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0]!.path).toBe(path);
  });

  /**
   * The git store keeps one directory per repository
   * (`Brain/projects/git/<repo>/`), so the sweep discovers them from the
   * tree rather than from a fixed list.
   */
  test("a conflict copy inside every per-repo git store directory is reported", () => {
    const planted = ["alpha", "beta"].map((repo) => plant(gitStoreDir(vault, repo), "commits"));
    const findings = conflictFindings();
    expect(findings.map((f) => f.path).toSorted()).toEqual(planted.toSorted());
  });

  /**
   * Three swept directories also hold files that are not ledgers: the
   * preference notes, the proposal files at the proposals root and each
   * repository's state.json. A conflict copy of one of those is still
   * reported, but never with the row-merge remedy, which is wrong advice
   * for a note or an atomically replaced JSON file.
   */
  const NON_LEDGER: ReadonlyArray<readonly [string, (v: string) => string, string]> = [
    [
      "preference note",
      (v) => brainDirs(v).preferences,
      "pref-alpha.sync-conflict-20260610-120000-ABCDEFG.md",
    ],
    [
      "proposal file",
      (v) => join(v, BRAIN_SKILL_PROPOSALS_REL),
      "proposal-watermark.sync-conflict-20260610-120000-ABCDEFG.json",
    ],
    [
      "git store state",
      (v) => gitStoreDir(v, "alpha"),
      "state.sync-conflict-20260610-120000-ABCDEFG.json",
    ],
  ];

  test.each(NON_LEDGER)(
    "%s: a conflict copy is reported without the ledger merge remedy",
    (_label, dir, name) => {
      mkdirSync(dir(vault), { recursive: true });
      const path = join(dir(vault), name);
      writeFileSync(path, "{}\n", "utf8");
      const findings = conflictFindings();
      expect(findings).toHaveLength(1);
      expect(findings[0]!.path).toBe(path);
      expect(findings[0]!.message).not.toContain("Merge its rows");
      expect(findings[0]!.message).toContain("not a ledger shard");
    },
  );
});
