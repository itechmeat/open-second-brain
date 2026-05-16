/**
 * Opt-in helper that rewrites legacy-shape Group C frontmatter keys
 * (`status:`, `applied_count:`, ...) to the `_`-prefixed form (§24)
 * across `Brain/preferences/` and `Brain/retired/`.
 *
 * Two-phase contract:
 *
 *   - {@link planMigration} (pure scan) — walks the directories,
 *     reports per-file classification: already-new, to-migrate, or
 *     collision (both shapes present in the same file). Read-only.
 *
 *   - {@link applyMigration} (rewriting) — runs `planMigration` first,
 *     aborts if collisions are present, optionally takes a `Brain/`
 *     snapshot (so `o2b brain rollback migrate-...` works), then
 *     atomically rewrites every to-migrate file.
 *
 * The migration is deliberately non-default: dream-driven natural
 * rewrites also migrate files lazily on every refresh pass, which
 * keeps the upgrade painless. `migrate-frontmatter` exists for users
 * who want immediate, snapshot-fenced migration.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { FrontmatterMap } from "../types.ts";
import { parseFrontmatter, writeFrontmatterAtomic } from "../vault.ts";
import { brainDirs } from "./paths.ts";
import { DERIVED_FIELDS } from "./preference.ts";
import { createSnapshot } from "./snapshot.ts";
import { isoSecond } from "./time.ts";

/**
 * On `brain-retired` files, `status` is identity (the literal
 * `"retired"`), not derived. Filter the shared Group C list
 * accordingly so migration leaves retired-file `status:` exactly
 * where it is.
 */
function derivedFieldsForKind(kind: unknown): ReadonlyArray<string> {
  if (kind === "brain-retired") {
    return DERIVED_FIELDS.filter((f) => f !== "status");
  }
  return DERIVED_FIELDS;
}

export class MigrationError extends Error {
  readonly code: "COLLISION" | "PARSE" | "IO";
  readonly collisions?: ReadonlyArray<{ path: string; field: string }>;

  constructor(
    code: "COLLISION" | "PARSE" | "IO",
    message: string,
    collisions?: ReadonlyArray<{ path: string; field: string }>,
  ) {
    super(message);
    this.name = "MigrationError";
    this.code = code;
    if (collisions !== undefined) this.collisions = collisions;
  }
}

export interface MigrationPlan {
  readonly files_scanned: number;
  readonly files_to_migrate: ReadonlyArray<string>;
  readonly files_already_new: ReadonlyArray<string>;
  readonly collisions: ReadonlyArray<{ path: string; field: string }>;
}

export interface MigrationResult {
  readonly run_id: string;
  /** `null` when `snapshot: false`, otherwise the .tar.zst path. */
  readonly snapshot_path: string | null;
  readonly plan: MigrationPlan;
  readonly files_migrated: ReadonlyArray<string>;
}

export interface ApplyMigrationOptions {
  /** Take a pre-run `Brain/` snapshot before rewriting. */
  readonly snapshot: boolean;
  /** Wall clock used to build the `run_id`. Tests pin this. */
  readonly now?: Date;
}

// ----- Internal helpers -----------------------------------------------------

/**
 * Classify a single file's frontmatter against the dual-shape policy.
 * Returns `'new'` if every Group C key present is already `_`-prefixed,
 * `'legacy'` if at least one is in legacy form (and no collisions),
 * `'collision'` if any key has BOTH shapes (caller surfaces).
 *
 * Files that fail to parse are classified as `'parse-error'`. Doctor
 * is the surface that reports parse errors to the operator — migration
 * skips them silently.
 */
function classifyFile(
  path: string,
): { kind: "new" | "legacy" | "collision" | "parse-error"; conflictField?: string } {
  let meta: Record<string, unknown>;
  try {
    [meta] = parseFrontmatter(path);
  } catch {
    return { kind: "parse-error" };
  }
  let sawLegacy = false;
  const derived = derivedFieldsForKind(meta["kind"]);
  for (const name of derived) {
    const hasLegacy = name in meta && meta[name] !== undefined;
    const hasModern = `_${name}` in meta && meta[`_${name}`] !== undefined;
    if (hasLegacy && hasModern) {
      return { kind: "collision", conflictField: name };
    }
    if (hasLegacy) sawLegacy = true;
  }
  return { kind: sawLegacy ? "legacy" : "new" };
}

/**
 * In-place rename of legacy Group C keys to their `_`-prefixed form.
 * Returns a new `FrontmatterMap` — the input is left untouched. Order
 * is preserved (Object.entries iteration order survives rename).
 */
function rewriteLegacyKeys(meta: Record<string, unknown>): FrontmatterMap {
  const out: FrontmatterMap = {};
  const derived = new Set(derivedFieldsForKind(meta["kind"]));
  for (const [k, v] of Object.entries(meta)) {
    if (derived.has(k)) {
      out[`_${k}`] = v as never;
    } else {
      out[k] = v as never;
    }
  }
  return out;
}

function listMarkdown(dir: string, prefix: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    if (!name.startsWith(prefix)) continue;
    out.push(join(dir, name));
  }
  out.sort();
  return out;
}

// ----- Public API -----------------------------------------------------------

export function planMigration(vault: string): MigrationPlan {
  const dirs = brainDirs(vault);
  const files = [
    ...listMarkdown(dirs.preferences, "pref-"),
    ...listMarkdown(dirs.retired, "ret-"),
  ];
  const toMigrate: string[] = [];
  const alreadyNew: string[] = [];
  const collisions: { path: string; field: string }[] = [];
  let scanned = 0;
  for (const path of files) {
    scanned++;
    const c = classifyFile(path);
    if (c.kind === "collision") {
      collisions.push({ path, field: c.conflictField! });
    } else if (c.kind === "legacy") {
      toMigrate.push(path);
    } else if (c.kind === "new") {
      alreadyNew.push(path);
    }
    // 'parse-error': silently skipped; doctor reports separately
  }
  return Object.freeze({
    files_scanned: scanned,
    files_to_migrate: Object.freeze(toMigrate),
    files_already_new: Object.freeze(alreadyNew),
    collisions: Object.freeze(collisions),
  });
}

export async function applyMigration(
  vault: string,
  opts: ApplyMigrationOptions,
): Promise<MigrationResult> {
  const now = opts.now ?? new Date();
  const plan = planMigration(vault);

  if (plan.collisions.length > 0) {
    const first = plan.collisions[0]!;
    throw new MigrationError(
      "COLLISION",
      `migration aborted: ${plan.collisions.length} file(s) carry both legacy ` +
        `and '_'-prefixed shape for the same field. ` +
        `First: ${first.path} (field '${first.field}'). ` +
        `Hand-edit the file(s) to keep one form, then re-run.`,
      plan.collisions,
    );
  }

  // run_id uses isoSecond with `:` replaced — same shape dream uses,
  // accepted by validateRunId.
  const runId = `migrate-${isoSecond(now).replace(/:/g, "-")}`;
  let snapshotPath: string | null = null;
  if (opts.snapshot) {
    const snap = createSnapshot(vault, runId);
    snapshotPath = snap.path;
  }

  const migrated: string[] = [];
  for (const path of plan.files_to_migrate) {
    let raw: Record<string, unknown>;
    let body: string;
    try {
      [raw, body] = parseFrontmatter(path);
    } catch (err) {
      throw new MigrationError(
        "PARSE",
        `failed to parse ${path}: ${(err as Error).message ?? String(err)}`,
      );
    }
    const renamed = rewriteLegacyKeys(raw);
    writeFrontmatterAtomic(path, renamed, body, {
      overwrite: true,
      existsErrorKind: "preference",
      vaultForRelativePath: vault,
    });
    migrated.push(path);
  }

  return Object.freeze({
    run_id: runId,
    snapshot_path: snapshotPath,
    plan,
    files_migrated: Object.freeze(migrated),
  });
}
