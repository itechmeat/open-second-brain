/**
 * What a sync tool leaves in the legacy tree, and where each file goes
 * (change migration-sync-conflict-copies). The names are recognised in
 * one place (`brain/ledger-shards.ts`: `isSyncConflictName`,
 * `syncConflictOriginalName`, `isSyncTempName`); this module only finds
 * them beside the files the migration catalogue reads.
 *
 *  - An in-flight temp file (`.syncthing.<name>.tmp` and the like) holds
 *    no data of its own: it is ignored and counted. Once it becomes the
 *    real file, the next delta pass reads that file.
 *  - A conflict copy takes the destination of the file it is a copy of
 *    (its marker removed), by the rule of that surface:
 *      - `rows`: a JSONL ledger or log shard. Its rows are imported like
 *        the original's; a row whose records the original (or an earlier
 *        copy of it) already holds is stored once (`convert.ts`).
 *      - `file`: a one-item-per-file record surface (a signal page, a
 *        preference page, a lane entry). A copy equal to its original adds
 *        nothing; a copy that differs is a second version of one record,
 *        never a second record: it is kept in the migration backup and
 *        named in the report as kept, not imported. A copy whose original
 *        is gone is the only version, and is imported as the original's
 *        item.
 *      - `document`: a single-document surface (pinned context, the
 *        settings file, the vault identity, a backup-class file). The
 *        original goes as it always did; a differing copy is kept in the
 *        backup and named, never merged.
 *      - `dropped`: a device-local, derived or dropped surface (freshen
 *        state, a lock, a cache, a log day page). The copy goes with its
 *        original's rule: it is not carried over, and never moved into
 *        device-local state where it would stand beside the real file.
 *
 * Read-only: directory listings, and an `lstat` only for the leftovers.
 */

import { readdirSync, type Dirent } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import {
  isSyncConflictName,
  isSyncTempName,
  syncConflictOriginalName,
} from "../brain/ledger-shards.ts";
import type { CatalogueEntry } from "./catalogue.ts";
import { DESTINATION_KIND, makesRecords, type Locator } from "./destinations.ts";
import { claimOfOriginal, claims } from "./legacy-claims.ts";

/** What becomes of a conflict copy, by the surface of its original. */
export const SYNC_COPY_RULE = Object.freeze({
  rows: "rows",
  file: "file",
  document: "document",
  dropped: "dropped",
} as const);

export type SyncCopyRule = (typeof SYNC_COPY_RULE)[keyof typeof SYNC_COPY_RULE];

/** One conflict copy in the legacy tree whose original a mapping claims. */
export interface SyncConflictCopy {
  /** Absolute path of the copy. */
  readonly path: string;
  /** Absolute path of the file it is a version of. */
  readonly original: string;
  /** Vault-relative, `/`-separated. */
  readonly rel: string;
  readonly originalRel: string;
  /** The catalogue entry of the original's surface. */
  readonly entry: CatalogueEntry;
  /** The locator that reads the original. */
  readonly locator: Locator;
  readonly rule: SyncCopyRule;
}

/**
 * A conflict copy inside a folder a mapping takes whole (a `tree` surface:
 * the hook state, the secrets folder, a cache): it is no item of its own
 * and goes with its folder, wherever the folder goes.
 */
export interface SyncCopyInFolder {
  /** Vault-relative path of the copy. */
  readonly path: string;
  /** The surface whose folder holds it. */
  readonly surface: string;
  /** Where the folder goes: device-local state, the backup, the vault's own files, or nowhere (dropped). */
  readonly goes: "device-local" | "backup" | "vault-files" | "dropped";
}

export interface SyncLeftovers {
  /** Sorted by path. */
  readonly copies: ReadonlyArray<SyncConflictCopy>;
  /** Copies inside folders a mapping takes whole, sorted by path. */
  readonly inFolders: ReadonlyArray<SyncCopyInFolder>;
  /** Vault-relative paths of the sync temp files no mapping reads, sorted. */
  readonly temps: ReadonlyArray<string>;
}

function list(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** The folders a locator's files, and so their copies, sit in. */
function foldersOf(locator: Locator, out: Set<string>): void {
  switch (locator.shape) {
    case "jsonl":
      out.add(locator.dir);
      if (locator.subdirs) {
        for (const e of list(locator.dir)) if (e.isDirectory()) out.add(join(locator.dir, e.name));
      }
      return;
    case "pages":
    case "json-files":
      out.add(locator.dir);
      return;
    case "text":
      out.add(dirname(locator.path));
      return;
    case "tree":
      out.add(locator.grammar === undefined ? dirname(locator.path) : locator.path);
      return;
    case "entries": {
      const walk = (dir: string): void => {
        out.add(dir);
        for (const e of list(dir)) if (e.isDirectory()) walk(join(dir, e.name));
      };
      out.add(dirname(locator.root));
      walk(locator.root);
      return;
    }
  }
}

function ruleOf(entry: CatalogueEntry, locator: Locator, lock: boolean): SyncCopyRule {
  const destination = entry.mapping.destination;
  if (lock) return SYNC_COPY_RULE.dropped;
  if (destination.to === DESTINATION_KIND.deviceLocal || destination.to === DESTINATION_KIND.drop) {
    return SYNC_COPY_RULE.dropped;
  }
  if (!makesRecords(destination)) return SYNC_COPY_RULE.document;
  switch (locator.shape) {
    case "jsonl":
      return SYNC_COPY_RULE.rows;
    case "pages":
    case "json-files":
    case "entries":
      return SYNC_COPY_RULE.file;
    default:
      return SYNC_COPY_RULE.document;
  }
}

/**
 * Every sync leftover beside the files `catalogue` reads: the conflict
 * copies whose original a mapping claims, with their rule, and the sync
 * temp files. A leftover inside a folder a mapping takes whole (a `tree`
 * locator) belongs to that folder and is not listed; a copy whose
 * original no mapping claims is not listed either: it stays an unmapped
 * entry (`legacy-claims.ts`).
 */
export function findSyncLeftovers(
  vault: string,
  catalogue: ReadonlyArray<CatalogueEntry>,
): SyncLeftovers {
  const owner = new Map<Locator, CatalogueEntry>();
  const locators: Locator[] = [];
  for (const entry of catalogue) {
    for (const locator of entry.locators) {
      owner.set(locator, entry);
      locators.push(locator);
    }
  }
  const folders = new Set<string>();
  for (const locator of locators) foldersOf(locator, folders);
  const rel = (path: string): string => relative(vault, path).split(sep).join("/");
  const copies: SyncConflictCopy[] = [];
  const temps: string[] = [];
  for (const dir of folders) {
    for (const e of list(dir)) {
      if (e.isDirectory()) continue;
      const temp = isSyncTempName(e.name);
      if (!temp && !isSyncConflictName(e.name)) continue;
      const path = join(dir, e.name);
      // Inside a folder a mapping takes whole: it moves with that folder.
      if (locators.some((l) => claims(l, path, e.name))) continue;
      if (temp) {
        temps.push(rel(path));
        continue;
      }
      const claim = claimOfOriginal(locators, path, e.name);
      if (claim === null) continue;
      const entry = owner.get(claim.locator)!;
      // `claimOfOriginal` proved the name is a copy with an original.
      const original = join(dir, syncConflictOriginalName(e.name)!);
      copies.push({
        path,
        original,
        rel: rel(path),
        originalRel: rel(original),
        entry,
        locator: claim.locator,
        rule: ruleOf(entry, claim.locator, claim.lock),
      });
    }
  }
  copies.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  temps.sort();
  return { copies, temps, inFolders: copiesInWholeFolders(catalogue, rel) };
}

/** Where a folder a mapping takes whole goes, for the report. */
function folderGoes(entry: CatalogueEntry): SyncCopyInFolder["goes"] {
  const to = entry.mapping.destination.to;
  if (to === DESTINATION_KIND.deviceLocal) return "device-local";
  if (to === DESTINATION_KIND.backup) return "backup";
  // The accepted skills: the folder moves to the vault's own skills/ folder.
  if (to === DESTINATION_KIND.vaultFiles) return "vault-files";
  return "dropped";
}

/**
 * The conflict copies inside the folders a `tree` mapping takes whole (no
 * per-file grammar), which the walk above never lists: they go with their
 * folder, and the report names them so its count is the vault's.
 */
function copiesInWholeFolders(
  catalogue: ReadonlyArray<CatalogueEntry>,
  rel: (path: string) => string,
): SyncCopyInFolder[] {
  const out: SyncCopyInFolder[] = [];
  const seen = new Set<string>();
  for (const entry of catalogue) {
    for (const locator of entry.locators) {
      if (locator.shape !== "tree" || locator.grammar !== undefined) continue;
      const walk = (dir: string): void => {
        for (const e of list(dir)) {
          const path = join(dir, e.name);
          if (e.isDirectory()) {
            walk(path);
          } else if (isSyncConflictName(e.name) && !seen.has(path)) {
            seen.add(path);
            out.push({ path: rel(path), surface: entry.id, goes: folderGoes(entry) });
          }
        }
      };
      walk(locator.path);
    }
  }
  return out.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A conflict copy kept in the migration backup and not imported. */
export interface SyncCopyKept {
  /** Vault-relative path of the copy. */
  readonly path: string;
  /** Vault-relative path of the file it is a version of. */
  readonly original: string;
  readonly surface: string;
  readonly reason: string;
}

/** What one surface's conflict copies became. */
export interface SyncCopySurface {
  readonly surface: string;
  /** Conflict copy files of this surface. */
  copies: number;
  /** Items (rows, or a whole copy whose original is gone) imported as records. */
  imported: number;
  /** Items that were already there (in the original or an earlier copy): they add nothing. */
  identical: number;
  /** Copy files kept in the backup, not imported. */
  kept: number;
  /** Copy files not carried over, by their original's rule. */
  dropped: number;
}

/** The conflict-copy section of a dry run or a migration report. */
export interface SyncCopyReport {
  readonly surfaces: ReadonlyArray<SyncCopySurface>;
  readonly kept: ReadonlyArray<SyncCopyKept>;
  /**
   * Vault-relative paths of the copies the pass would have kept that were
   * gone (sync removed them) before the backup could take them; absent
   * before the backup ran.
   */
  readonly kept_gone?: ReadonlyArray<string>;
  readonly temps_ignored: number;
  /** Vault-relative paths of the ignored sync temp files. */
  readonly temps: ReadonlyArray<string>;
  /** Copies inside folders a mapping takes whole: they go with their folder. */
  readonly in_folders?: ReadonlyArray<SyncCopyInFolder>;
}

/** Counts a pass or a dry run keeps while it handles the leftovers. */
export class SyncCopyTally {
  private readonly bySurface = new Map<string, SyncCopySurface>();
  private readonly keptList: SyncCopyKept[] = [];

  constructor(
    private readonly temps: ReadonlyArray<string>,
    private readonly inFolders: ReadonlyArray<SyncCopyInFolder> = [],
  ) {}

  private surface(copy: SyncConflictCopy): SyncCopySurface {
    let row = this.bySurface.get(copy.entry.id);
    if (row === undefined) {
      row = { surface: copy.entry.id, copies: 0, imported: 0, identical: 0, kept: 0, dropped: 0 };
      this.bySurface.set(copy.entry.id, row);
    }
    return row;
  }

  /** One copy file seen. */
  copy(copy: SyncConflictCopy): void {
    this.surface(copy).copies += 1;
  }

  imported(copy: SyncConflictCopy): void {
    this.surface(copy).imported += 1;
  }

  identical(copy: SyncConflictCopy): void {
    this.surface(copy).identical += 1;
  }

  dropped(copy: SyncConflictCopy): void {
    this.surface(copy).dropped += 1;
  }

  kept(copy: SyncConflictCopy, reason: string): void {
    this.surface(copy).kept += 1;
    this.keptList.push({
      path: copy.rel,
      original: copy.originalRel,
      surface: copy.entry.id,
      reason,
    });
  }

  report(): SyncCopyReport {
    return {
      surfaces: [...this.bySurface.values()].toSorted((a, b) =>
        a.surface < b.surface ? -1 : a.surface > b.surface ? 1 : 0,
      ),
      kept: [...this.keptList],
      temps_ignored: this.temps.length,
      temps: [...this.temps],
      in_folders: [...this.inFolders],
    };
  }
}

/** The empty section, for a run that saw no leftovers. */
export function emptySyncCopyReport(): SyncCopyReport {
  return { surfaces: [], kept: [], temps_ignored: 0, temps: [], in_folders: [] };
}

/**
 * The section of a migration report as the backup left it: a copy the
 * pass would have kept but that was gone before the backup took it is
 * named in `kept_gone` and no longer counted as kept, so the report names
 * only copies the archive holds. `archived` is the vault-relative paths
 * the archive holds; null when it holds none.
 */
export function retainedSyncCopies(
  report: SyncCopyReport,
  archived: ReadonlySet<string> | null,
): SyncCopyReport {
  const gone = report.kept.filter((k) => archived === null || !archived.has(k.path));
  if (gone.length === 0) return { ...report, kept_gone: [] };
  const goneBySurface = new Map<string, number>();
  for (const k of gone) goneBySurface.set(k.surface, (goneBySurface.get(k.surface) ?? 0) + 1);
  return {
    ...report,
    surfaces: report.surfaces.map((s) => ({
      ...s,
      kept: s.kept - (goneBySurface.get(s.surface) ?? 0),
    })),
    kept: report.kept.filter((k) => archived !== null && archived.has(k.path)),
    kept_gone: gone.map((k) => k.path),
  };
}
