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
 * ## The ownership predicate lives here, once
 *
 * {@link isOwnerVisible} is the vault's single isolation rule; this
 * module is where the delivery path consults it. The predicate never
 * engages on its own: a caller must pass the verdict of
 * {@link resolveOwnerScopeDelivery}, which reads
 * `integrity.owner_scope_delivery` and only grants narrowing under
 * `fail`. With the gate on its shipped `off` default every surface here
 * is byte-for-byte what it was before the gate existed, which is the
 * contract `agent-scope.ts`, `search/types.ts` and `result-filters.ts`
 * all state: a null scope is byte-identical to today.
 *
 * ## What belongs here, and what does not
 *
 * Here: locating candidate files, turning each into a parsed value, and
 * the ownership predicate.
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

import { isOwnerVisible, normalizeAgentScope, pageOwner } from "../graph/agent-scope.ts";
import { DEGRADATION_CODE } from "../integrity/degradation.ts";
import { GATE_MODE, type GateMode } from "../integrity/stamp.ts";
import type { FrontmatterMap } from "../types.ts";
import { parseFrontmatterWithNotices } from "../vault.ts";
import { isPreferenceVisible } from "./owner-scoped-facts.ts";
import { loadIntegrityConfigSafe } from "./policy.ts";
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
  /**
   * The gate's verdict on ownership isolation, from
   * {@link resolveOwnerScopeDelivery}. Omitted / `null` applies no
   * ownership filtering at all, which is the shipped default and the
   * reason an existing vault stays byte-identical.
   *
   * A bare scope string is deliberately NOT accepted: passing the gate's
   * verdict is the only way to filter, so no delivery surface can narrow
   * a vault without the operator having asked for it.
   *
   * The rule itself is {@link isOwnerVisible}, reused rather than
   * restated: an ownerless memory is shared and always kept, an owned
   * one is kept only for its own scope, and a memory whose owner cannot
   * be determined is DROPPED - see {@link CollectedPage.unreadable}.
   */
  readonly ownerScope?: OwnerScopeDelivery | null;
}

/**
 * What a collect call returned, plus the evidence that the ownership
 * predicate fired.
 *
 * The count is what keeps `warn` from being a mode that does nothing:
 * under `warn` the predicate is still evaluated and the count is still
 * reported, but nothing is withheld, so an operator can watch the gate
 * take effect before tightening it to `fail`.
 */
export interface PreferenceCollection<T> {
  readonly entries: ReadonlyArray<T>;
  /**
   * How many entries the ownership predicate rejected. Non-zero only
   * when a scope was requested under `warn` or `fail`; under `fail`
   * those entries are absent from {@link entries}, under `warn` they are
   * still present and the count is the only trace.
   */
  readonly hiddenByOwnerScope: number;
}

/**
 * The delivery path's reading of `integrity.owner_scope_delivery`.
 *
 * `enforcedScope` and `requestedScope` are deliberately separate: the
 * gate decides whether a requested scope may NARROW delivery, and only
 * `fail` grants that. Under `warn` the caller still knows what was asked
 * for, so it can report; under `off` it knows nothing at all, so a
 * consumer wired to this struct structurally cannot emit a new field or
 * warning while the gate is off - the same property
 * {@link checkStamp} gives the stamp consumers.
 */
export interface OwnerScopeDelivery {
  /** The operator-chosen mode, echoed so a report can name it. */
  readonly mode: GateMode;
  /** Scope that narrows the result. Non-null only under `fail`. */
  readonly enforcedScope: string | null;
  /** Scope the caller asked for. Null under `off`, and when none was asked. */
  readonly requestedScope: string | null;
}

/**
 * Resolve a caller-requested agent scope against the vault's
 * `integrity.owner_scope_delivery` gate.
 *
 * The config load is the SAFE form: these surfaces must keep working on
 * a vault that has never run `o2b brain init`, and an unreadable config
 * is not a reason to change what a delivery surface returns.
 */
export function resolveOwnerScopeDelivery(
  vault: string,
  requested: string | undefined,
): OwnerScopeDelivery {
  const mode = loadIntegrityConfigSafe(vault).owner_scope_delivery;
  if (mode === GATE_MODE.off) {
    return Object.freeze({ mode, enforcedScope: null, requestedScope: null });
  }
  const requestedScope = normalizeAgentScope(requested);
  return Object.freeze({
    mode,
    enforcedScope: mode === GATE_MODE.fail ? requestedScope : null,
    requestedScope,
  });
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
): PreferenceCollection<CollectedPreference> {
  const gate = ownerGate(opts);
  const entries: CollectedPreference[] = [];
  let hiddenByOwnerScope = 0;
  for (const file of listPreferenceFiles(dir, opts)) {
    let pref: BrainPreference;
    try {
      // An unparseable file is already fail-closed: it is omitted under
      // every scope, so its unknowable owner can never leak.
      pref = parsePreference(file.path);
    } catch {
      continue;
    }
    if (gate !== null && !isPreferenceVisible(pref, gate.scope)) {
      hiddenByOwnerScope += 1;
      if (gate.enforce) continue;
    }
    entries.push({ ...file, pref });
  }
  return { entries, hiddenByOwnerScope };
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
): PreferenceCollection<CollectedPage> {
  const gate = ownerGate(opts);
  const entries: CollectedPage[] = [];
  let hiddenByOwnerScope = 0;
  for (const file of listPreferenceFiles(dir, opts)) {
    const [meta, body, notices] = parseFrontmatterWithNotices(file.path, { site: COLLECT_SITE });
    const unreadable = notices.some((n) => n.code === DEGRADATION_CODE.frontmatterUnreadable);
    if (gate !== null) {
      // Fail CLOSED on an unreadable page, matching `applyAgentScope` on
      // the search side. `parseFrontmatter` resolves an unreadable file
      // to empty metadata, which reads as "ownerless" and would leak an
      // owner-private body under an active scope; an unknowable owner is
      // treated as somebody else's instead.
      const visible = !unreadable && isOwnerVisible(pageOwner(meta), gate.scope);
      if (!visible) {
        hiddenByOwnerScope += 1;
        if (gate.enforce) continue;
      }
    }
    entries.push({ ...file, meta, body, unreadable });
  }
  return { entries, hiddenByOwnerScope };
}

/**
 * The one-line report a delivery surface emits when the ownership gate
 * observed something, or `null` when there is nothing to say.
 *
 * Reported ONLY under `warn`, and deliberately so. `warn` withholds
 * nothing, so naming a count reveals no more than the delivered content
 * already does, and it is the whole point of the mode: an operator can
 * watch what `fail` would remove before tightening the gate. Under
 * `fail` the memories ARE withheld, and a count would tell one agent
 * that another agent's private memories exist - the existence leak the
 * search side avoids by making a hidden chunk indistinguishable from an
 * absent one. So `fail` says nothing at all.
 *
 * A surface with no report channel simply does not call this; it is the
 * mode's meaning that differs, never the delivered bytes.
 */
export function formatOwnerScopeWarning(
  delivery: OwnerScopeDelivery,
  hiddenByOwnerScope: number,
): string | null {
  if (delivery.mode !== GATE_MODE.warn) return null;
  if (delivery.requestedScope === null || hiddenByOwnerScope <= 0) return null;
  return (
    `owner scope ${JSON.stringify(delivery.requestedScope)}: ${hiddenByOwnerScope} ` +
    `memory item(s) owned by another agent were delivered; set ` +
    `integrity.owner_scope_delivery to ${GATE_MODE.fail} to withhold them`
  );
}

/**
 * Reduce the gate verdict to what the walk needs: the scope to evaluate
 * against, and whether a rejection actually withholds the entry.
 * `null` means "do not evaluate at all", which is the `off` default and
 * the no-scope-requested case.
 */
function ownerGate(
  opts: PreferenceScanOptions,
): { readonly scope: string; readonly enforce: boolean } | null {
  const delivery = opts.ownerScope;
  if (delivery === undefined || delivery === null) return null;
  const scope = delivery.requestedScope;
  if (scope === null) return null;
  return { scope, enforce: delivery.enforcedScope !== null };
}
