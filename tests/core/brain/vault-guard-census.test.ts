/**
 * Unit J - the guard's coverage claim, measured rather than asserted.
 *
 * The first cut of the write guard shipped with a docblock describing
 * coverage nobody had counted: a review found roughly two thirds of the
 * write-capable modules under `src/core/brain/` had no guard on any path,
 * including the module behind `brain_create_note`. A prose claim cannot
 * catch that; a census can.
 *
 * This test walks the tree, classifies every module that can put bytes on
 * disk, and compares the unguarded set against an explicit inventory of
 * exclusions - one entry, one reason. Adding a write-capable module
 * without a guard fails here and names the file, so "we forgot" is not a
 * reachable state and the release-note numbers are measured, not
 * estimated.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const BRAIN_ROOT = join(REPO_ROOT, "src", "core", "brain");

/**
 * Calls that can create, replace, move, or delete bytes on disk. A module
 * naming any of them is write-capable and owes an answer to the census.
 */
const WRITE_CALL_RE = new RegExp(
  "\\b(?:" +
    [
      "writeFileSync",
      "appendFileSync",
      "mkdirSync",
      "renameSync",
      "rmSync",
      "unlinkSync",
      "rmdirSync",
      "cpSync",
      "copyFileSync",
      "atomicWriteFileSync",
      "atomicWriteText",
      "atomicCreateFileSyncExclusive",
      "writeFrontmatterAtomic",
      "withTempFile",
      "appendAuditRecord",
      "openSync",
      "createWriteStream",
      "writeSync",
      "utimesSync",
      "chmodSync",
    ].join("|") +
    ")\\s*\\(",
);

/** A module is guarded when it names the assertion or its wrapper. */
const GUARD_RE = /assertVaultIdentityForWrite|brainDirsForWrite/;

/**
 * Every write-capable module that deliberately carries no guard, with the
 * reason it does not. A module may only be here because asserting would
 * be wrong, never because asserting was inconvenient.
 */
const UNGUARDED_WITH_REASON: Readonly<Record<string, string>> = Object.freeze({
  "src/core/brain/init.ts":
    "bootstrap. This is the path that CREATES the tree and stamps the marker; " +
    "gating it on the marker it is about to write would refuse `o2b brain init` " +
    "on the very root it exists to serve.",
  "src/core/brain/inject-failopen.ts":
    "fail-open injection cache. The hook contract is that a degraded injection " +
    "still returns something; a refusal here would turn a cache miss into a " +
    "broken SessionStart.",
  "src/core/brain/maintenance/lease.ts":
    "lock primitive. The lease file is how concurrent maintenance runs " +
    "serialize; the runs it protects are guarded at their own entry points, " +
    "and refusing to take a lock would strand the holder rather than protect " +
    "anything.",
  "src/core/brain/inline-rewrite.ts":
    "takes an absolute file path and no vault, so there is no identity to " +
    "assert against. Its only caller, `applyMarkerWritebacks`, is guarded.",
  "src/core/brain/portability/pointer.ts":
    "writes the project-side pointer that NAMES a vault, outside that vault " +
    "(`assertNotInsideVault`). It cannot be gated on the identity of the store " +
    "it is in the act of selecting.",
  "src/core/brain/portability/profiles.ts":
    "machine-local profile registry under the config directory, not vault " +
    "content. Keyed by `configPath`; no vault is in scope.",
  "src/core/brain/portability/recall-sources.ts":
    "machine-local recall-source registry under the config directory, not " +
    "vault content. Keyed by `configPath`; no vault is in scope.",
  "src/core/brain/secrets/crypto.ts":
    "takes a keyfile path, not a vault. The three public entry points in " +
    "`secrets/store.ts` that reach it are guarded ahead of their first byte.",
  "src/core/brain/sync-lockfile.ts":
    "lock primitive over a caller-supplied path; the writers that acquire it " +
    "are guarded at their own entry points.",
});

interface CensusRow {
  readonly path: string;
  readonly guarded: boolean;
}

function census(): CensusRow[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".ts")) files.push(abs);
    }
  };
  walk(BRAIN_ROOT);
  files.sort();

  const rows: CensusRow[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (!WRITE_CALL_RE.test(text)) continue;
    rows.push({
      path: relative(REPO_ROOT, file).split("\\").join("/"),
      guarded: GUARD_RE.test(text),
    });
  }
  return rows;
}

describe("vault write-guard census", () => {
  test("every write-capable Brain module is guarded or excluded with a reason", () => {
    const rows = census();
    const unguarded = rows.filter((row) => !row.guarded).map((row) => row.path);
    const excluded = Object.keys(UNGUARDED_WITH_REASON).toSorted();

    // Named first so the failure message is the file list, not a count.
    expect(unguarded.toSorted()).toEqual(excluded);
  });

  test("no exclusion outlives the module it excuses", () => {
    const paths = new Set(census().map((row) => row.path));
    for (const excluded of Object.keys(UNGUARDED_WITH_REASON)) {
      expect(paths.has(excluded)).toBe(true);
    }
  });

  test("the census is not vacuous", () => {
    const rows = census();
    // A regex that stopped matching would report a clean sweep over an
    // empty set. Pin the shape of the measurement, not just its verdict.
    expect(rows.length).toBeGreaterThan(90);
    expect(rows.filter((row) => row.guarded).length).toBeGreaterThan(90);
  });
});
