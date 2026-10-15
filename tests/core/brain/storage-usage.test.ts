/**
 * The storage usage meter (`measureStorageUsage`).
 *
 * Claims pinned here:
 *
 *   1. Per-surface byte totals match a hand-computed fixture: the Brain
 *      tree (pages, ledgers, config), the derived store plus its WAL and
 *      SHM sidecars, and every dot-directory the meter names - artifacts,
 *      archives, payloads and internal state are all counted, never
 *      skipped by the dot-prefix rule that keeps them out of the index.
 *   2. Tiers split on recoverability, mirroring the state catalogue:
 *      `vault-content` for bytes whose loss is permanent, `derived` for
 *      bytes whose loss costs a recomputation.
 *   3. A surface that cannot be read is named in `unmeasured` with its
 *      reason and never reported as zero bytes - a chmod-denied
 *      directory is not an empty one.
 *   4. A surface that is genuinely absent reads as measured-empty: no
 *      bytes is a true answer there, and it is not a refusal.
 *   5. The meter is deterministic through the injected `now` alone, and
 *      never follows symlinks out of the vault.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveIndexPath } from "../../../src/core/search/paths.ts";
import {
  STORAGE_SURFACE,
  STORAGE_TIER,
  STORAGE_UNMEASURED_REASON,
  measureStorageUsage,
  type StorageUsage,
} from "../../../src/core/brain/storage/usage.ts";
import { CHMOD_CANNOT_DENY, IS_WINDOWS } from "../../helpers/platform.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-storage-usage-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const NOW = new Date("2026-10-15T12:00:00Z");

/** The exact byte length of a fixture file's content. */
function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

const PAGE_TEXT = "# AA page\n\nsome body text for the meter to count\n";
const LEDGER_LINE = '{"schema":"o2b.metrics.v1","surface":"storage_usage"}\n';
const ARTIFACT_TEXT = '{"ok":true}\n';
const SNAPSHOT_TEXT = "tar-ish archive bytes\n";
const ARCHIVE_TEXT = "redacted source archive bytes\n";
const PAYLOAD_TEXT = "externalized session turn bytes\n";
const INTERNAL_TEXT = '{"lineage":"row"}\n';
const CONFIG_TEXT = "schema_version: 1\n";

/** The derived store fixture: one sqlite file plus its two sidecars. */
const STORE_MAIN = Buffer.alloc(4096, 0x61);
const STORE_WAL = Buffer.alloc(512, 0x62);
const STORE_SHM = Buffer.alloc(128, 0x63);

/** Hand-computed fixture totals, per surface. */
const FIXTURE_BYTES = {
  page: bytes(PAGE_TEXT),
  config: bytes(CONFIG_TEXT),
  ledger: bytes(LEDGER_LINE),
  artifact: bytes(ARTIFACT_TEXT),
  snapshot: bytes(SNAPSHOT_TEXT),
  archive: bytes(ARCHIVE_TEXT),
  payload: bytes(PAYLOAD_TEXT),
  internal: bytes(INTERNAL_TEXT),
  store: STORE_MAIN.length + STORE_WAL.length + STORE_SHM.length,
};

function writeText(rel: string, text: string): void {
  const full = join(vault, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text, "utf8");
}

function writeStore(): void {
  const dir = join(vault, ".open-second-brain");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolveIndexPath(vault, null), STORE_MAIN);
  writeFileSync(`${resolveIndexPath(vault, null)}-wal`, STORE_WAL);
  writeFileSync(`${resolveIndexPath(vault, null)}-shm`, STORE_SHM);
}

function buildFixtureVault(): void {
  writeText("Brain/_brain.yaml", CONFIG_TEXT);
  writeText("Brain/sources/AA-page.md", PAGE_TEXT);
  writeText("Brain/log/continuity/2026-01.jsonl", LEDGER_LINE);
  writeText("Brain/.artifacts/run-1/AA-artifact.json", ARTIFACT_TEXT);
  writeText("Brain/.snapshots/AA-run.tar.zst", SNAPSHOT_TEXT);
  writeText("Brain/.archives/aa1b2c3d.txt", ARCHIVE_TEXT);
  writeText("Brain/.payloads/aabbccdd.txt", PAYLOAD_TEXT);
  writeText("Brain/.state/AA-lineage.jsonl", INTERNAL_TEXT);
  writeStore();
}

function surfaceBytes(usage: StorageUsage, name: string): number {
  const entry = usage.surfaces.find((s) => s.surface === name);
  expect(entry).toBeDefined();
  return entry!.bytes;
}

describe("measureStorageUsage", () => {
  test("per-surface totals match a hand-computed fixture", () => {
    buildFixtureVault();
    const usage = measureStorageUsage(vault, { now: NOW });

    expect(surfaceBytes(usage, STORAGE_SURFACE.brainTree)).toBe(
      FIXTURE_BYTES.page + FIXTURE_BYTES.config + FIXTURE_BYTES.ledger,
    );
    expect(surfaceBytes(usage, STORAGE_SURFACE.artifacts)).toBe(FIXTURE_BYTES.artifact);
    expect(surfaceBytes(usage, STORAGE_SURFACE.snapshots)).toBe(FIXTURE_BYTES.snapshot);
    expect(surfaceBytes(usage, STORAGE_SURFACE.archives)).toBe(FIXTURE_BYTES.archive);
    expect(surfaceBytes(usage, STORAGE_SURFACE.payloads)).toBe(FIXTURE_BYTES.payload);
    expect(surfaceBytes(usage, STORAGE_SURFACE.internalState)).toBe(FIXTURE_BYTES.internal);
    expect(surfaceBytes(usage, STORAGE_SURFACE.derivedStore)).toBe(FIXTURE_BYTES.store);
  });

  test("tier totals split on recoverability and fold into the total", () => {
    buildFixtureVault();
    const usage = measureStorageUsage(vault, { now: NOW });

    const derived = FIXTURE_BYTES.artifact + FIXTURE_BYTES.store;
    const vaultContent =
      FIXTURE_BYTES.page +
      FIXTURE_BYTES.config +
      FIXTURE_BYTES.ledger +
      FIXTURE_BYTES.snapshot +
      FIXTURE_BYTES.archive +
      FIXTURE_BYTES.payload +
      FIXTURE_BYTES.internal;

    expect(usage.bytesByTier[STORAGE_TIER.derived]).toBe(derived);
    expect(usage.bytesByTier[STORAGE_TIER.vaultContent]).toBe(vaultContent);
    expect(usage.totalBytes).toBe(derived + vaultContent);
    expect(usage.complete).toBe(true);
    expect(usage.unmeasured).toEqual([]);
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "an unreadable surface is named in unmeasured and never reported as zero bytes",
    () => {
      buildFixtureVault();
      chmodSync(join(vault, "Brain", ".artifacts"), 0o000);
      try {
        const usage = measureStorageUsage(vault, { now: NOW });
        const refused = usage.unmeasured.find((u) => u.surface === STORAGE_SURFACE.artifacts);
        expect(refused).toEqual({
          surface: STORAGE_SURFACE.artifacts,
          reason: STORAGE_UNMEASURED_REASON.surfaceUnreadable,
        });
        // No byte claim: the artifacts reading is absent from the measured
        // set entirely, not flattened to a lying zero.
        expect(usage.surfaces.find((s) => s.surface === STORAGE_SURFACE.artifacts)).toBeUndefined();
        expect(usage.complete).toBe(false);
        // The surfaces that could be read keep their measured bytes.
        expect(surfaceBytes(usage, STORAGE_SURFACE.brainTree)).toBe(
          FIXTURE_BYTES.page + FIXTURE_BYTES.config + FIXTURE_BYTES.ledger,
        );
      } finally {
        chmodSync(join(vault, "Brain", ".artifacts"), 0o755);
      }
    },
  );

  test("an absent surface reads as measured-empty, not as a refusal", () => {
    // No Brain tree, no store: a vault that has never been initialized.
    const usage = measureStorageUsage(vault, { now: NOW });
    expect(usage.totalBytes).toBe(0);
    expect(usage.unmeasured).toEqual([]);
    expect(usage.complete).toBe(true);
    expect(surfaceBytes(usage, STORAGE_SURFACE.brainTree)).toBe(0);
    expect(surfaceBytes(usage, STORAGE_SURFACE.derivedStore)).toBe(0);
  });

  test("the injected now alone decides the timestamp", () => {
    buildFixtureVault();
    const a = measureStorageUsage(vault, { now: NOW });
    const b = measureStorageUsage(vault, { now: NOW });
    expect(a.measuredAt).toBe("2026-10-15T12:00:00.000Z");
    expect(b).toEqual(a);
  });

  test("symlinks are never followed out of the vault", () => {
    if (IS_WINDOWS) return; // symlink creation needs privileges there
    buildFixtureVault();
    const outside = join(vault, "outside.md");
    writeFileSync(outside, "external bytes".repeat(100), "utf8");
    symlinkSync(outside, join(vault, "Brain", "AA-link.md"));
    const usage = measureStorageUsage(vault, { now: NOW });
    expect(surfaceBytes(usage, STORAGE_SURFACE.brainTree)).toBe(
      FIXTURE_BYTES.page + FIXTURE_BYTES.config + FIXTURE_BYTES.ledger,
    );
  });
});
