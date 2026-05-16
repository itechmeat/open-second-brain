/**
 * Tests for `migrate-frontmatter` — the opt-in helper that rewrites
 * legacy-shape Group C frontmatter keys (`status:`, `applied_count:`,
 * ...) to the `_`-prefixed form (§24) across `Brain/preferences/`
 * and `Brain/retired/`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  brainDirs,
  preferencePath,
  retiredPath,
} from "../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../src/core/brain/policy.ts";
import {
  applyMigration,
  MigrationError,
  planMigration,
} from "../../src/core/brain/migrate-frontmatter.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { listSnapshots } from "../../src/core/brain/snapshot.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-migrate-"));
  const dirs = brainDirs(tmp);
  for (const d of [
    dirs.brain,
    dirs.inbox,
    dirs.processed,
    dirs.preferences,
    dirs.retired,
    dirs.log,
    dirs.snapshots,
  ]) {
    mkdirSync(d, { recursive: true });
  }
  // Required for createSnapshot's config-load step
  atomicWriteFileSync(
    join(dirs.brain, "_brain.yaml"),
    DEFAULT_BRAIN_CONFIG_YAML,
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeLegacyPref(slug: string): string {
  const path = preferencePath(tmp, slug);
  const content = [
    "---",
    "kind: brain-preference",
    `id: pref-${slug}`,
    "created_at: 2026-05-14T10:42:00Z",
    "unconfirmed_until: 2026-05-28T10:42:00Z",
    `tags: [brain, brain/preference, brain/topic/${slug}]`,
    `topic: ${slug}`,
    "principle: Some rule",
    "pinned: false",
    "status: confirmed",
    "confirmed_at: 2026-05-15T10:00:00Z",
    "evidenced_by: []",
    "applied_count: 1",
    "violated_count: 0",
    "last_evidence_at: null",
    "confidence: low",
    "---",
    "",
  ].join("\n");
  writeFileSync(path, content, "utf8");
  return path;
}

function writeNewPref(slug: string): string {
  const path = preferencePath(tmp, slug);
  const content = [
    "---",
    "kind: brain-preference",
    `id: pref-${slug}`,
    "created_at: 2026-05-14T10:42:00Z",
    "unconfirmed_until: 2026-05-28T10:42:00Z",
    `tags: [brain, brain/preference, brain/topic/${slug}]`,
    `topic: ${slug}`,
    "principle: Some rule",
    "pinned: false",
    "_status: confirmed",
    "_confirmed_at: 2026-05-15T10:00:00Z",
    "_evidenced_by: []",
    "_applied_count: 1",
    "_violated_count: 0",
    "_last_evidence_at: null",
    "_confidence: low",
    "---",
    "",
  ].join("\n");
  writeFileSync(path, content, "utf8");
  return path;
}

function writeCollisionPref(slug: string): string {
  const path = preferencePath(tmp, slug);
  const content = [
    "---",
    "kind: brain-preference",
    `id: pref-${slug}`,
    "created_at: 2026-05-14T10:42:00Z",
    "unconfirmed_until: 2026-05-28T10:42:00Z",
    `tags: [brain, brain/preference, brain/topic/${slug}]`,
    `topic: ${slug}`,
    "principle: Some rule",
    "pinned: false",
    "status: confirmed",
    "_status: confirmed",
    "evidenced_by: []",
    "---",
    "",
  ].join("\n");
  writeFileSync(path, content, "utf8");
  return path;
}

function writeLegacyRetired(slug: string): string {
  const path = retiredPath(tmp, slug);
  const content = [
    "---",
    "kind: brain-retired",
    `id: ret-${slug}`,
    "created_at: 2026-05-14T10:42:00Z",
    "retired_at: 2026-08-12T05:00:00Z",
    "retired_reason: stale-no-evidence",
    "retired_by: '[[Brain/log/2026-08-12]]'",
    `tags: [brain, brain/retired, brain/topic/${slug}]`,
    `topic: ${slug}`,
    "principle: Some rule",
    "status: retired",
    "pinned: false",
    "evidenced_by: []",
    "applied_count: 4",
    "violated_count: 1",
    "last_evidence_at: 2026-05-20T10:00:00Z",
    "confidence: medium",
    "---",
    "",
  ].join("\n");
  writeFileSync(path, content, "utf8");
  return path;
}

describe("planMigration", () => {
  test("counts legacy / new / collision files", () => {
    writeLegacyPref("legacy-a");
    writeNewPref("new-a");
    writeCollisionPref("collision-a");
    writeLegacyRetired("legacy-r");

    const plan = planMigration(tmp);

    expect(plan.files_scanned).toBe(4);
    expect(plan.files_to_migrate.length).toBe(2); // legacy pref + legacy retired
    expect(plan.files_already_new.length).toBe(1);
    expect(plan.collisions.length).toBe(1);
    expect(plan.collisions[0]!.field).toBe("status");
  });

  test("returns zero counts on an empty vault", () => {
    const plan = planMigration(tmp);
    expect(plan.files_scanned).toBe(0);
    expect(plan.files_to_migrate.length).toBe(0);
    expect(plan.files_already_new.length).toBe(0);
    expect(plan.collisions.length).toBe(0);
  });
});

describe("applyMigration", () => {
  test("rewrites legacy keys to _-prefixed", async () => {
    const path = writeLegacyPref("alpha");
    const result = await applyMigration(tmp, {
      snapshot: false,
      now: new Date("2026-05-16T10:15:22Z"),
    });

    expect(result.files_migrated.length).toBe(1);

    const raw = readFileSync(path, "utf8");
    expect(raw).toMatch(/^_status: confirmed$/m);
    expect(raw).toMatch(/^_applied_count: 1$/m);
    expect(raw).toMatch(/^_confidence: low$/m);
    expect(raw).not.toMatch(/^status: /m);
    expect(raw).not.toMatch(/^applied_count: /m);
  });

  test("preserves identity fields and body", async () => {
    const path = writeLegacyPref("beta");
    const original = readFileSync(path, "utf8");
    expect(original).toMatch(/^principle: Some rule$/m);

    await applyMigration(tmp, { snapshot: false, now: new Date() });
    const after = readFileSync(path, "utf8");
    expect(after).toMatch(/^principle: Some rule$/m);
    expect(after).toMatch(/^topic: beta$/m);
    expect(after).toMatch(/^kind: brain-preference$/m);
    expect(after).toMatch(/^id: pref-beta$/m);
  });

  test("is idempotent (second run is a no-op)", async () => {
    writeLegacyPref("gamma");
    const first = await applyMigration(tmp, { snapshot: false, now: new Date() });
    const second = await applyMigration(tmp, { snapshot: false, now: new Date() });
    expect(first.files_migrated.length).toBe(1);
    expect(second.files_migrated.length).toBe(0);
  });

  test("takes a snapshot when snapshot: true", async () => {
    writeLegacyPref("delta");
    const result = await applyMigration(tmp, {
      snapshot: true,
      now: new Date("2026-05-16T10:15:22Z"),
    });
    expect(result.snapshot_path).toBeTruthy();
    expect(existsSync(result.snapshot_path!)).toBe(true);
    const snaps = listSnapshots(tmp);
    expect(snaps.length).toBe(1);
    expect(snaps[0]!.run_id).toMatch(/^migrate-/);
  });

  test("aborts with MigrationError when a collision file is present", async () => {
    writeLegacyPref("ok");
    writeCollisionPref("bad");
    await expect(
      applyMigration(tmp, { snapshot: false, now: new Date() }),
    ).rejects.toThrow(MigrationError);
  });

  test("collision check runs BEFORE any rewrite (atomic-ish abort)", async () => {
    const okPath = writeLegacyPref("ok");
    writeCollisionPref("bad");
    const before = readFileSync(okPath, "utf8");
    try {
      await applyMigration(tmp, { snapshot: false, now: new Date() });
    } catch {
      /* expected */
    }
    const after = readFileSync(okPath, "utf8");
    expect(after).toBe(before);
  });

  test("processes retired/ as well as preferences/", async () => {
    const retPath = writeLegacyRetired("epsilon");
    await applyMigration(tmp, { snapshot: false, now: new Date() });
    const raw = readFileSync(retPath, "utf8");
    expect(raw).toMatch(/^_applied_count: 4$/m);
    expect(raw).not.toMatch(/^applied_count: /m);
    // `status: retired` is identity on retired files, must stay unprefixed.
    expect(raw).toMatch(/^status: retired$/m);
  });
});
