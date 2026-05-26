/**
 * v0.11.0 migration: move Pay Memory content from the legacy
 * `<vault>/AI Wiki/` subtree into the new `<vault>/Brain/payments/`
 * layout, and remove Open-Second-Brain-managed scaffolding files
 * from `AI Wiki/`. Idempotent: re-running on an already-migrated
 * vault produces zero moves and zero removals.
 *
 * The migration only touches files Open Second Brain owned in
 * v0.10.x. User-authored content under `<vault>/AI Wiki/` outside
 * the OSB-managed paths is preserved (including the `AI Wiki/`
 * directory itself when it is not empty after the migration).
 */

import {
  cpSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";

import {
  PAY_MEMORY_ASSETS_REL,
  PAY_MEMORY_DRAFTS_REL,
  PAY_MEMORY_POLICIES_REL,
  PAY_MEMORY_REPORTS_REL,
  PAY_MEMORY_ROOT_REL,
} from "../../pay-memory/paths.ts";

/** Vault-relative root of the legacy `AI Wiki/` layout. */
export const LEGACY_AIWIKI_REL = "AI Wiki";

/**
 * Map from legacy `AI Wiki/<sub>` directory to the v0.11.0 target
 * under `Brain/payments/`. Order matters: `payments/_pending/` is
 * a child of `payments/` in v0.10, so the parent is moved first
 * and the `_pending/` sub comes along inside it.
 */
const PAY_MEMORY_DIRECTORY_MAPPING: ReadonlyArray<readonly [string, string]> =
  Object.freeze([
    [posix.join(LEGACY_AIWIKI_REL, "payments"), PAY_MEMORY_ROOT_REL],
    [posix.join(LEGACY_AIWIKI_REL, "policies"), PAY_MEMORY_POLICIES_REL],
    [posix.join(LEGACY_AIWIKI_REL, "assets"), PAY_MEMORY_ASSETS_REL],
    [posix.join(LEGACY_AIWIKI_REL, "drafts"), PAY_MEMORY_DRAFTS_REL],
    [posix.join(LEGACY_AIWIKI_REL, "reports"), PAY_MEMORY_REPORTS_REL],
  ] as const);

/**
 * Open-Second-Brain-managed scaffolding files at the root of
 * `<vault>/AI Wiki/` in v0.10.x. Removed verbatim; user-authored
 * `.md` files in the same directory stay put.
 */
const LEGACY_AIWIKI_SCAFFOLDING_FILES: ReadonlyArray<string> = Object.freeze([
  "_OPEN_SECOND_BRAIN.md",
  "_open-second-brain.yaml",
  "index.md",
  "hot.md",
  "log.md",
  posix.join("identity", "user.md"),
  posix.join("identity", "agents.md"),
]);

export interface LegacyAiwikiMigrationResult {
  /** Vault-relative path pairs: every file actually moved this run. */
  readonly moved: ReadonlyArray<readonly [string, string]>;
  /** Vault-relative paths of OSB scaffolding files removed this run. */
  readonly removed: ReadonlyArray<string>;
  /** Whether this was a dry-run (planning) only. */
  readonly dryRun: boolean;
}

export interface MigrateLegacyAiwikiOptions {
  /** When true, plan-only; report what would happen without touching disk. */
  readonly dryRun?: boolean;
}

/**
 * Migrate `<vault>/AI Wiki/` content to the v0.11.0 layout.
 *
 * Strategy:
 *   1. For each (legacy, target) pair in `PAY_MEMORY_DIRECTORY_MAPPING`:
 *      walk the legacy directory; for every file inside, move it to
 *      the matching relative path under `target`. We do per-file
 *      moves (not a top-level rename) so a partial v0.11 layout
 *      already present at the target (e.g. an operator who ran
 *      Pay Memory under v0.11 against the same vault by mistake)
 *      is merged without clobbering existing files.
 *   2. Remove `LEGACY_AIWIKI_SCAFFOLDING_FILES`. Missing files are
 *      no-ops.
 *   3. Leave the `AI Wiki/` directory itself in place (it may still
 *      hold user content the migration does not own).
 */
export function migrateLegacyAiwiki(
  vault: string,
  opts: MigrateLegacyAiwikiOptions = {},
): LegacyAiwikiMigrationResult {
  const dryRun = opts.dryRun === true;
  const moved: Array<readonly [string, string]> = [];
  const removed: string[] = [];

  for (const [legacyRel, targetRel] of PAY_MEMORY_DIRECTORY_MAPPING) {
    const legacyAbs = join(vault, legacyRel);
    if (!existsSync(legacyAbs)) continue;
    const stat = statSync(legacyAbs);
    if (!stat.isDirectory()) continue;
    walkAndMove(vault, legacyAbs, legacyRel, targetRel, dryRun, moved);
  }

  for (const rel of LEGACY_AIWIKI_SCAFFOLDING_FILES) {
    const abs = join(vault, LEGACY_AIWIKI_REL, rel);
    if (!existsSync(abs)) continue;
    if (!dryRun) {
      rmSync(abs, { force: true });
    }
    removed.push(posix.join(LEGACY_AIWIKI_REL, rel));
  }

  return Object.freeze({
    moved: Object.freeze(moved) as ReadonlyArray<readonly [string, string]>,
    removed: Object.freeze(removed) as ReadonlyArray<string>,
    dryRun,
  });
}

function walkAndMove(
  vault: string,
  legacyAbs: string,
  legacyRelPrefix: string,
  targetRelPrefix: string,
  dryRun: boolean,
  moved: Array<readonly [string, string]>,
): void {
  const stack: Array<readonly [string, string]> = [[legacyAbs, ""]];
  while (stack.length > 0) {
    const [dir, relUnderRoot] = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const childAbs = join(dir, entry.name);
      const childRelUnderRoot = relUnderRoot === ""
        ? entry.name
        : posix.join(relUnderRoot, entry.name);
      if (entry.isDirectory()) {
        stack.push([childAbs, childRelUnderRoot]);
        continue;
      }
      if (!entry.isFile()) continue;
      const targetAbs = join(vault, targetRelPrefix, childRelUnderRoot);
      const legacyRel = posix.join(legacyRelPrefix, childRelUnderRoot);
      const targetRel = posix.join(targetRelPrefix, childRelUnderRoot);
      // Merge semantics: never clobber an existing target file.
      if (existsSync(targetAbs)) continue;
      if (!dryRun) {
        const targetDir = dirname(targetAbs);
        try {
          renameSync(childAbs, targetAbs);
        } catch {
          // Cross-device or directory-creation race: fall back to
          // copy-then-remove so the migration succeeds across mount
          // boundaries (Syncthing-synced vault on a different fs).
          cpSync(childAbs, targetAbs, { recursive: false });
          rmSync(childAbs, { force: true });
        }
        // Best-effort prune of the now-empty source dir on the way
        // out — only remove `<dir>` itself, never recursively.
        try {
          if (readdirSync(dir).length === 0) {
            rmSync(dir, { recursive: false, force: true });
          }
        } catch {
          // Non-fatal: leftover empty dir does not affect the new
          // layout's correctness.
        }
        void targetDir;
      }
      moved.push([legacyRel, targetRel] as const);
    }
  }
  // Prune the legacy root if it ended up empty (no user files left
  // alongside the OSB-managed content).
  try {
    if (!dryRun && existsSync(legacyAbs) && readdirSync(legacyAbs).length === 0) {
      rmSync(legacyAbs, { recursive: false, force: true });
    }
  } catch {
    // ignore
  }
}
