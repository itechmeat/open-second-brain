/**
 * `sync-conflict-log` covers every ledger directory (who-wrote-what,
 * Task B / t_1814b9bf).
 *
 * The per-device shard layout means no reader merges a Syncthing
 * conflict copy - not under `Brain/log/`, and not under any of the five
 * other append-only ledger directories that now shard the same way. One
 * exit, one meaning: "a sync conflict copy exists that no reader
 * merges", with the directory named in the detail so an operator knows
 * where to do the union+dedup merge.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { continuityLogDir } from "../../../src/core/brain/continuity/store.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { idempotencyLogDir } from "../../../src/core/brain/idempotency-ledger.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainStateDirPath } from "../../../src/core/brain/lineage/ledger.ts";
import { metricsDir } from "../../../src/core/brain/metrics.ts";
import { brainDirs, prefAuditDir } from "../../../src/core/brain/paths.ts";
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

  test("the six directories are distinct, so no one of them is swept twice", () => {
    const dirs = LEDGERS.map(([, dir]) => dir(vault));
    expect(new Set(dirs).size).toBe(LEDGERS.length);
  });
});
