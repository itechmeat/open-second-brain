/**
 * Ingested-source registry (Brain Portability & Interop suite, Unit C
 * support).
 *
 * Read/list/delete over the per-source summary pages the ingest pipeline
 * writes under `Brain/sources` with `kind: brain-source`. These are the
 * "sources" the in-process SDK's source CRUD operates on (`ingestSource`
 * is the write; this module is the read + delete half).
 *
 * Every read or delete addresses a source by its vault-relative summary
 * path (the id `ingestSource` returns). An id that resolves outside
 * `Brain/sources` is treated as not-found - never read as a source and
 * never deleted - so the delete cannot be turned into an arbitrary
 * unlink.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, relative, posix, sep } from "node:path";

import type { FrontmatterMap, FrontmatterValue } from "../../types.ts";
import { ensureInsideVault } from "../../path-safety.ts";
import { parseFrontmatter } from "../../vault.ts";
import { BRAIN_SOURCES_REL } from "../paths.ts";
import { BRAIN_SOURCE_KIND } from "./ingest.ts";

export interface IngestedSource {
  /** Vault-relative POSIX path of the summary page - the id for get/delete. */
  readonly path: string;
  readonly sourcePath: string | null;
  readonly sourceHash: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface IngestedSourceDetail extends IngestedSource {
  /** Markdown body of the summary page. */
  readonly body: string;
}

function sourcesDir(vault: string): string {
  return join(vault, BRAIN_SOURCES_REL);
}

function stringField(meta: FrontmatterMap, key: string): string | null {
  const value: FrontmatterValue | undefined = meta[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toPosixRel(vault: string, abs: string): string {
  return relative(vault, abs).split(/[\\/]/).join(posix.sep);
}

function summary(vault: string, abs: string, meta: FrontmatterMap): IngestedSource {
  return {
    path: toPosixRel(vault, abs),
    sourcePath: stringField(meta, "source_path"),
    sourceHash: stringField(meta, "source_hash"),
    createdAt: stringField(meta, "created_at"),
    updatedAt: stringField(meta, "updated_at"),
  };
}

/**
 * Resolve an untrusted source id to an absolute path that is guaranteed
 * to live inside `Brain/sources`. Returns null when the id escapes the
 * vault or lands outside the sources dir.
 */
function resolveSourceAbs(vault: string, id: string): string | null {
  let abs: string;
  try {
    abs = ensureInsideVault(join(vault, id), vault);
  } catch {
    return null;
  }
  const dir = sourcesDir(vault);
  if (abs !== dir && !abs.startsWith(dir + sep)) return null;
  return abs;
}

/** List every ingested-source summary page, sorted by path. Read-only. */
export function listIngestedSources(vault: string): ReadonlyArray<IngestedSource> {
  const dir = sourcesDir(vault);
  if (!existsSync(dir)) return [];
  let entries: ReadonlyArray<string>;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: IngestedSource[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const abs = join(dir, name);
    let meta: FrontmatterMap;
    try {
      [meta] = parseFrontmatter(abs);
    } catch {
      continue;
    }
    if (meta["kind"] !== BRAIN_SOURCE_KIND) continue;
    out.push(summary(vault, abs, meta));
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * Read one ingested source by its vault-relative summary path. Returns
 * null when the id is outside `Brain/sources`, the file is missing, or
 * the page is not a `brain-source`.
 */
export function getIngestedSource(vault: string, id: string): IngestedSourceDetail | null {
  const abs = resolveSourceAbs(vault, id);
  if (abs === null || !existsSync(abs)) return null;
  let meta: FrontmatterMap;
  let body: string;
  try {
    [meta, body] = parseFrontmatter(abs);
  } catch {
    return null;
  }
  if (meta["kind"] !== BRAIN_SOURCE_KIND) return null;
  return { ...summary(vault, abs, meta), body };
}

/**
 * Delete one ingested-source summary page. Returns true when a
 * `brain-source` page existed and was removed, false otherwise. An id
 * outside `Brain/sources` or a non-source page is never deleted.
 */
export function deleteIngestedSource(vault: string, id: string): boolean {
  const abs = resolveSourceAbs(vault, id);
  if (abs === null || !existsSync(abs)) return false;
  let meta: FrontmatterMap;
  try {
    [meta] = parseFrontmatter(abs);
  } catch {
    return false;
  }
  if (meta["kind"] !== BRAIN_SOURCE_KIND) return false;
  try {
    rmSync(abs);
  } catch (err) {
    // A concurrent delete (ENOENT after the existence check) means the page
    // is already gone - honestly report "not removed by us". Any other error
    // (permissions, I/O) is a real fault and must surface, not be hidden.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw err;
  }
  return true;
}
