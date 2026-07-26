/**
 * The one directory walk behind every preference-backed context-DELIVERY
 * surface (context-integrity-gates, Unit A).
 *
 * Five surfaces on the delivery path - `active.ts`, `context-pack.ts`,
 * `pre-compress-pack.ts`, `morning-brief.ts` and `digest.ts` - each grew
 * its own `readdirSync(dirs.preferences)` loop. Five copies of one walk
 * is five places an isolation predicate would have to be added, and five
 * places it could be forgotten. This module is that walk, once, so the
 * owner predicate has exactly one place to attach.
 *
 * ## What belongs here, and what does not
 *
 * Here: locating candidate files and turning each into a parsed value,
 * plus (from Unit A's enforcement step) the ownership predicate.
 *
 * NOT here: every DOMAIN filter the surfaces apply after the walk -
 * tombstone exclusion, `status === confirmed`, recency windows. Those
 * differ per surface by design and folding them in would make the
 * collector a switch over its callers rather than a shared walk.
 *
 * ## Two parse modes, one walk
 *
 * The surfaces split on how they read a file, and the split is real
 * rather than incidental: four want a validated {@link BrainPreference}
 * and skip whatever fails to parse, while the context pack wants raw
 * frontmatter plus the body (it injects the body, and it walks the
 * retired directory alongside the preferences directory, where the
 * preference schema does not apply). Both modes share
 * {@link listPreferenceFiles}; neither reimplements the listing.
 *
 * ## Listing differences are parameters, not erasures
 *
 * The digest scan lists with `withFileTypes` and keeps only regular
 * files, and only those named `pref-*`; the other four list bare names.
 * Those are pre-existing, observable differences (a symlinked
 * preference file is visible to four surfaces and not to the digest), so
 * they are expressed as options rather than unified away - unifying them
 * would be a behaviour change wearing a refactor's clothes.
 *
 * Entries are returned in `readdirSync` order, never re-sorted: each
 * caller owns its own ordering, and imposing one here would change
 * output the callers currently derive from disk order.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { DEGRADATION_CODE } from "../integrity/degradation.ts";
import type { FrontmatterMap } from "../types.ts";
import { parseFrontmatterWithNotices } from "../vault.ts";
import { parsePreference } from "./preference.ts";
import type { BrainPreference } from "./types.ts";

/** Attribution recorded on the notices this module's reads produce. */
const COLLECT_SITE = "brain.preferences-collect";

/** Extension every Brain memory file on the delivery path carries. */
export const PREFERENCE_FILE_EXT = ".md";

/**
 * Filename prefix of a preference note. The digest scan requires it so a
 * hand-dropped file in the preferences directory is not mistaken for a
 * preference; named here so the literal is not respelled per surface.
 */
export const PREFERENCE_ID_PREFIX = "pref-";

/** A candidate file the walk found, before any parse. */
export interface PreferenceFile {
  /** Basename, including {@link PREFERENCE_FILE_EXT}. */
  readonly name: string;
  /** Absolute path, `join(dir, name)`. */
  readonly path: string;
}

/** Per-caller listing rules; both default to the loosest form. */
export interface PreferenceScanOptions {
  /**
   * Required filename prefix. Omitted accepts every `.md` name, which is
   * what four of the five delivery surfaces do.
   */
  readonly namePrefix?: string;
  /**
   * Keep only regular files (`Dirent.isFile()`). Omitted lists bare
   * names, so a directory or symlink whose name ends in `.md` is a
   * candidate and is rejected later by the parse, exactly as before.
   */
  readonly regularFilesOnly?: boolean;
}

/** A preference file parsed through the preference schema. */
export interface CollectedPreference extends PreferenceFile {
  readonly pref: BrainPreference;
}

/** A memory file read as raw frontmatter plus body. */
export interface CollectedPage extends PreferenceFile {
  readonly meta: FrontmatterMap;
  readonly body: string;
  /**
   * True when the file could not be read at all, so nothing about it -
   * including its owner - is known. `parseFrontmatter` resolves an
   * unreadable file to empty metadata, which is indistinguishable from a
   * genuinely ownerless page; this flag keeps the two apart so a caller
   * enforcing isolation can fail closed instead of leaking.
   */
  readonly unreadable: boolean;
}

/**
 * List the candidate memory files in `dir`, or nothing when the
 * directory is absent. The only `readdirSync` of a preferences directory
 * on the delivery path.
 */
export function listPreferenceFiles(
  dir: string,
  opts: PreferenceScanOptions = {},
): ReadonlyArray<PreferenceFile> {
  if (!existsSync(dir)) return [];
  const out: PreferenceFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (opts.regularFilesOnly === true && !entry.isFile()) continue;
    const name = entry.name;
    if (!name.endsWith(PREFERENCE_FILE_EXT)) continue;
    if (opts.namePrefix !== undefined && !name.startsWith(opts.namePrefix)) continue;
    out.push({ name, path: join(dir, name) });
  }
  return out;
}

/**
 * Parse every candidate through the preference schema, omitting the ones
 * that fail. A corrupt or mis-filed note is the doctor's finding to
 * report, not the delivery path's to raise - see each caller's docblock.
 */
export function collectPreferences(
  dir: string,
  opts: PreferenceScanOptions = {},
): ReadonlyArray<CollectedPreference> {
  const out: CollectedPreference[] = [];
  for (const file of listPreferenceFiles(dir, opts)) {
    let pref: BrainPreference;
    try {
      pref = parsePreference(file.path);
    } catch {
      continue;
    }
    out.push({ ...file, pref });
  }
  return out;
}

/**
 * Read every candidate as raw frontmatter plus body. Never throws and
 * never skips: `parseFrontmatterWithNotices` resolves an unreadable file
 * to empty metadata, and the entry records that fact in
 * {@link CollectedPage.unreadable} rather than dropping it, so the
 * caller decides.
 */
export function collectPreferencePages(
  dir: string,
  opts: PreferenceScanOptions = {},
): ReadonlyArray<CollectedPage> {
  const out: CollectedPage[] = [];
  for (const file of listPreferenceFiles(dir, opts)) {
    const [meta, body, notices] = parseFrontmatterWithNotices(file.path, { site: COLLECT_SITE });
    const unreadable = notices.some((n) => n.code === DEGRADATION_CODE.frontmatterUnreadable);
    out.push({ ...file, meta, body, unreadable });
  }
  return out;
}
