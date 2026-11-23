/**
 * The partition of a dual-written record that names pages rather than
 * being one: a Brain log event names preferences and other pages through
 * ids and wikilinks, and a truth claim names the page it was taken from.
 * A record that names a private page goes to `private` only. On a machine
 * without that partition the appender refuses it and the refusal is
 * counted, so a private page's id, principle or facts never reach
 * `shared`, the partition every machine syncs.
 *
 * Every page is judged by {@link isPrivatePageFile}, the rule every other
 * brain dual-write site uses: a page that exists but cannot be read counts
 * as private. A reference that can only mean a page fails closed when it
 * resolves to none, because a page that is not there cannot be judged:
 *
 *  - a preference id (`pref-<slug>` or `ret-<slug>`, bare or as a link)
 *    with neither its active nor its retired page on disk;
 *  - a claim source written as a wikilink or a `.md` path that names no
 *    file in the vault.
 *
 * Any other string a log event carries (an artifact such as
 * `[[src/cli/main.ts:120-145]]`, a log shard link, free text) is resolved
 * by the reference reader the log's per-reader views use
 * (`brain/artifact-ref-resolve.ts`): when it names a page, that page is
 * judged, and when it names none it names nothing private. A claim source
 * that is neither a wikilink nor a `.md` path (a URL, free text) is judged
 * only when it names a file.
 *
 * Store-only machines (design D14 item 18, `store-privacy.ts`): once a
 * machine writes to the store only, a preference or signal reference is
 * judged from the store's folds, never from the legacy pages, and one the
 * folds cannot resolve is private. With no vault at all (`null`), a
 * reference that can only name a page (a wikilink or a `.md` path) cannot
 * be judged and is private; free text names nothing.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  type ArtifactRefScope,
  artifactRefScope,
  resolveArtifactRef,
} from "../brain/artifact-ref-resolve.ts";
import { resolveNotePath } from "../brain/note-path.ts";
import { BRAIN_PREFERENCES_REL, BRAIN_RETIRED_REL } from "../brain/path-constants.ts";
import {
  preferencePath,
  preferencePathUnder,
  retiredPath,
  retiredPathUnder,
} from "../brain/paths.ts";
import { extractId } from "../brain/temporal/period-common.ts";
import { pathIsInside } from "../path-safety.ts";
import { extractWikilinks } from "../vault.ts";
import {
  ANCHORED_WIKILINK_RE,
  stripBrainIdPrefix,
  stripWikilinkDecoration,
} from "../brain/wikilink.ts";
import { isPrivatePageFile } from "./dual-write-records.ts";
import { rowStrings, textCarriesPrivateRegion } from "./private-region.ts";
import {
  judgesFromStore,
  signalIdOf,
  storePreferenceIdIsKnownPrivate,
  storePreferenceIdIsPrivate,
  storeSignalIdIsPrivate,
} from "./store-privacy.ts";

/** Extension of a vault page. */
const PAGE_EXTENSION = ".md";

/** Whether `ref` can only name a page: a wikilink, or a `.md` path. */
function namesAPage(ref: string): boolean {
  const trimmed = ref.trim();
  return ANCHORED_WIKILINK_RE.test(trimmed) || trimmed.endsWith(PAGE_EXTENSION);
}

/**
 * Whether the preference `id` names is private: its active or retired page
 * is, or neither page is on disk (it cannot be judged).
 */
function preferenceIdIsPrivate(
  vault: string | null,
  id: string,
  fromStore: boolean,
  scope?: ArtifactRefScope,
  configPath?: string,
): boolean {
  if (fromStore || vault === null) return storePreferenceIdIsPrivate(id, configPath);
  let paths: string[];
  try {
    const slug = stripBrainIdPrefix(id);
    // With a scope, the Brain folders are the ones it resolved once.
    const pages =
      scope === undefined
        ? [preferencePath(vault, slug), retiredPath(vault, slug)]
        : [
            preferencePathUnder(scope.dirs(), vault, slug),
            retiredPathUnder(scope.dirs(), vault, slug),
          ];
    paths = pages.filter((p) => existsSync(p));
  } catch {
    return true; // a slug no page can carry: nothing to judge
  }
  return paths.length === 0 || paths.some((p) => isPrivatePageFile(p));
}

/** The folders a preference page lives in, vault-relative. */
const PREFERENCE_DIRS: ReadonlySet<string> = new Set([BRAIN_PREFERENCES_REL, BRAIN_RETIRED_REL]);

/**
 * The preference id a path-shaped reference names on a store-only machine
 * (`Brain/preferences/pref-x.md`, `[[Brain/retired/ret-x]]`), or
 * `undefined`. Only a path in a preference folder counts: a note that
 * happens to be called `pref-x` elsewhere is judged as the page it is.
 */
function preferenceIdOfPath(ref: string): string | undefined {
  const trimmed = ref.trim();
  const anchored = ANCHORED_WIKILINK_RE.exec(trimmed);
  const target = stripWikilinkDecoration(anchored !== null ? anchored[1]! : trimmed)
    .replaceAll("\\", "/")
    .replace(/\.md$/, "");
  const slash = target.lastIndexOf("/");
  if (slash === -1 || !PREFERENCE_DIRS.has(target.slice(0, slash))) return undefined;
  return extractId(target.slice(slash + 1));
}

/**
 * Whether a Brain log event names a private page, given the references it
 * carries (`logEntryArtifactRefs` in `brain/log.ts`, which passes them so
 * this module needs no import of the log). `guessed` is the preference a
 * reconcile event's topic would be: a guess from the topic name, not a
 * reference the event carries, so it is judged only when its page exists.
 * Read only when dual writes are on; see the module docblock for the rule.
 */
export function logRefsNamePrivatePage(
  vault: string | null,
  refs: ReadonlyArray<string | undefined>,
  guessed?: string,
  configPath?: string,
): boolean {
  if (judgingOff) return false;
  if (batch === null) {
    return refsNamePrivatePage(
      vault,
      refs,
      guessed,
      vault === null || judgesFromStore(vault, configPath),
      undefined,
      configPath,
    );
  }
  const fromStore = batchFromStore(batch, vault, configPath);
  return refsNamePrivatePage(
    vault,
    refs,
    guessed,
    fromStore,
    batchScope(batch, vault, fromStore, configPath),
    configPath,
  );
}

/** What one batch of many rows ({@link withPrivacyBatch}) works out once per vault. */
interface PrivacyBatch {
  readonly fromStore: Map<string, boolean>;
  readonly scopes: Map<string, ArtifactRefScope>;
  readonly judges: Map<string, RowPrivacyJudge>;
}

let batch: PrivacyBatch | null = null;

function privacyContextKey(vault: string | null, configPath?: string): string {
  return JSON.stringify([vault, configPath]);
}

function batchFromStore(b: PrivacyBatch, vault: string | null, configPath?: string): boolean {
  const key = privacyContextKey(vault, configPath);
  let fromStore = b.fromStore.get(key);
  if (fromStore === undefined) {
    fromStore = vault === null || judgesFromStore(vault, configPath);
    b.fromStore.set(key, fromStore);
  }
  return fromStore;
}

function batchScope(
  b: PrivacyBatch,
  vault: string | null,
  fromStore: boolean,
  configPath?: string,
): ArtifactRefScope | undefined {
  if (vault === null) return undefined;
  const key = privacyContextKey(vault, configPath);
  let scope = b.scopes.get(key);
  if (scope === undefined) {
    scope = artifactRefScope(vault, fromStore, configPath);
    b.scopes.set(key, scope);
  }
  return scope;
}

/**
 * Run `fn`, a synchronous read of many legacy rows that is one operation
 * (a migration dry run, one import pass of the migration), with the
 * judges of this module shared across its rows: the store-only verdict
 * and the Brain folders are worked out once per vault, and on a machine
 * that still judges by the legacy pages every distinct reference string a
 * row judge meets is judged once ({@link rowPrivacyJudge}), so the
 * verdicts are those of the moment the operation ran. Without it, every row re-reads the configuration and
 * re-resolves every Brain folder, which on a vault of several hundred
 * thousand log rows is most of a migration's time. A call inside another
 * batch joins it.
 */
export function withPrivacyBatch<T>(fn: () => T): T {
  return runPrivacyBatch(fn);
}

/**
 * Run `fn` with every reference judge of this module answering "names
 * nothing private" at once, without reading a page, the store or the
 * configuration: for a caller that builds legacy items' records only for
 * their content (their keys and checksums), never for the partition they
 * would go to. The rollback's match of the restored tree against the
 * store is one: a partition plays no part in it.
 */
export function withoutReferenceJudging<T>(fn: () => T): T {
  if (judgingOff) return fn();
  judgingOff = true;
  try {
    return fn();
  } finally {
    judgingOff = false;
  }
}

let judgingOff = false;

/**
 * End one chunk of a {@link withPrivacyBatch} operation: the per-reference
 * verdicts are forgotten, so a page that changed (a preference made
 * private on another machine and delivered by sync) is judged afresh by
 * the rows after it. The store-only verdict and the folder scope stay for
 * the whole operation. The migration ends a chunk after every import
 * batch it writes, and the dry run after as many rows, so a verdict is
 * never older than one batch. Outside a batch it does nothing.
 */
export function endPrivacyBatchChunk(): void {
  batch?.judges.clear();
  // The folder scope also holds the store's memory entities a store-only
  // machine resolves references through: a fresh scope reads them again,
  // so a page that arrived in the folds is seen by the next chunk.
  batch?.scopes.clear();
}

function runPrivacyBatch<T>(fn: () => T): T {
  if (batch !== null) return fn();
  batch = { fromStore: new Map(), scopes: new Map(), judges: new Map() };
  try {
    return fn();
  } finally {
    batch = null;
  }
}

/** {@link logRefsNamePrivatePage} with the store-only verdict worked out once by the caller. */
function refsNamePrivatePage(
  vault: string | null,
  refs: ReadonlyArray<string | undefined>,
  guessed: string | undefined,
  fromStore: boolean,
  scope?: ArtifactRefScope,
  configPath?: string,
): boolean {
  // Only the guess itself is spared the missing-page rule: the same id
  // written into the event's body is a reference it carries, judged like
  // any other.
  let guessSpared = guessed === undefined;
  for (const ref of refs) {
    if (ref === undefined || ref === "") continue;
    const isGuess = !guessSpared && ref === guessed;
    if (isGuess) guessSpared = true;
    // On a store-only machine a path to a preference page is the
    // preference too: the fold judges it, never the legacy page.
    const id = extractId(ref) ?? (fromStore ? preferenceIdOfPath(ref) : undefined);
    if (
      id !== undefined &&
      !isGuess &&
      preferenceIdIsPrivate(vault, id, fromStore, scope, configPath)
    ) {
      return true;
    }
    if (fromStore) {
      // The folds, not the legacy pages, say what a preference or a signal is.
      const signal = signalIdOf(ref);
      if (signal !== undefined) {
        if (storeSignalIdIsPrivate(signal, configPath)) return true;
        continue;
      }
      if (id !== undefined) {
        if (isGuess && storePreferenceIdIsKnownPrivate(id, configPath)) return true;
        continue;
      }
    }
    if (vault === null) {
      if (namesAPage(ref)) return true;
      continue;
    }
    const rel = resolveArtifactRef(
      vault,
      ref,
      scope ?? artifactRefScope(vault, fromStore, configPath),
    );
    if (rel === null) continue;
    // A path outside the vault names no page anyone may be shown. `resolve`,
    // not `join`: a relative path stays under the vault either way, and an
    // absolute one is judged where it is rather than glued onto the vault.
    const abs = resolve(vault, rel);
    if (!pathIsInside(abs, vault) || (existsSync(abs) && isPrivatePageFile(abs))) return true;
  }
  return false;
}

/**
 * Whether a truth claim's source is a private page. The source resolves
 * the way the claim ledger resolves it for its validity window
 * (`brain/truth/store.ts`): the wikilink body or the string as given,
 * tried as is and then with `.md`, inside the vault only.
 */
export function claimSourceIsPrivate(
  vault: string | null,
  source: string,
  configPath?: string,
): boolean {
  if (judgingOff) return false;
  const trimmed = source.trim();
  const anchored = ANCHORED_WIKILINK_RE.exec(trimmed);
  const target = stripWikilinkDecoration(anchored !== null ? anchored[1]! : trimmed);
  if (target === "") return false;
  const pageRef = anchored !== null || target.endsWith(PAGE_EXTENSION);
  const fromStore =
    batch === null
      ? vault === null || judgesFromStore(vault, configPath)
      : batchFromStore(batch, vault, configPath);
  const id = extractId(target) ?? (fromStore ? preferenceIdOfPath(target) : undefined);
  if (id !== undefined) return preferenceIdIsPrivate(vault, id, fromStore, undefined, configPath);
  if (fromStore) {
    const signal = signalIdOf(target);
    if (signal !== undefined) return storeSignalIdIsPrivate(signal, configPath);
  }
  if (vault === null) return pageRef;
  const candidates = target.endsWith(PAGE_EXTENSION) ? [target] : [target, target + PAGE_EXTENSION];
  for (const candidate of candidates) {
    let path: string;
    try {
      path = resolveNotePath(vault, candidate, { mustExist: false });
    } catch {
      // Outside the vault: no page anyone may be shown.
      return pageRef;
    }
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    return isPrivatePageFile(path);
  }
  return pageRef;
}

/**
 * Whether a pinned-context text must stay out of `shared`: it carries a
 * `<private>` region or the placeholder a stripped one leaves (the pinned
 * writer strips regions before it writes, as continuity does), or one of
 * its wikilinks names a private page (judged as a log event's references
 * are, {@link logRefsNamePrivatePage}).
 */
export function pinnedTextIsPrivate(
  vault: string | null,
  text: string,
  configPath?: string,
): boolean {
  if (textCarriesPrivateRegion(text)) return true;
  return logRefsNamePrivatePage(
    vault,
    extractWikilinks(text).map((target) => `[[${target}]]`),
    undefined,
    configPath,
  );
}

/**
 * Whether a ledger row names a private page, so its store copy goes to
 * `private` only. Every string the row carries, at any depth, is checked
 * for a `<private>` region or the placeholder a stripped one leaves. Every
 * string outside an `opaque` field is also judged as a reference: a
 * wikilink inside free text, and the string itself as a preference id, a
 * page path or an artifact id, by the rules of {@link pinnedTextIsPrivate}
 * and {@link logRefsNamePrivatePage}. A preference id whose page is not on
 * disk cannot be judged and counts as private, as does a path outside the
 * vault.
 *
 * `opaque` names the fields whose values are not references at any depth:
 * a client's idempotency key, a payload hash, a timestamp, an allocated
 * id. Such a value is chosen by a client or a hash function, not written
 * to name a page, so a key spelled `pref-unused` names no preference and
 * cannot make an open item's row private. Read only when dual writes are
 * on.
 */
export function rowNamesPrivatePage(
  vault: string | null,
  row: unknown,
  opaque: ReadonlySet<string> = new Set(),
  configPath?: string,
): boolean {
  if (judgingOff) return false;
  if (batch === null) return rowPrivacyJudge(vault, configPath)(row, opaque);
  const key = privacyContextKey(vault, configPath);
  let judge = batch.judges.get(key);
  if (judge === undefined) {
    const fromStore = batchFromStore(batch, vault, configPath);
    // A store-only machine judges a reference by the store's folds, which
    // the operation itself may be writing to: each row is judged afresh.
    // A legacy machine judges by the pages on disk, which a migration
    // only reads: each distinct reference is judged once.
    judge = makeRowJudge(
      vault,
      fromStore,
      batchScope(batch, vault, fromStore, configPath),
      !fromStore,
      configPath,
    );
    batch.judges.set(key, judge);
  }
  return judge(row, opaque);
}

/** Judges rows by {@link rowNamesPrivatePage}; see {@link rowPrivacyJudge}. */
export type RowPrivacyJudge = (row: unknown, opaque?: ReadonlySet<string>) => boolean;

/**
 * A judge of many rows of one operation by {@link rowNamesPrivatePage}:
 * the machine's store-only verdict is worked out once, when the judge is
 * made, and every distinct reference string is judged once however many
 * rows carry it. A batch append (a session's turns, a sweep of imports)
 * repeats the same roles, kinds, session ids and timestamps on every row;
 * judging each again, with the switch state and the Brain folders
 * re-read from disk each time, cost milliseconds per record. A judge lives for one operation only, so
 * the verdicts it remembers are those of the moment the operation ran.
 */
export function rowPrivacyJudge(vault: string | null, configPath?: string): RowPrivacyJudge {
  return makeRowJudge(vault, undefined, undefined, true, configPath);
}

/**
 * {@link rowPrivacyJudge} with the store-only verdict and the folder scope
 * given, and the per-reference memory on or off.
 */
function makeRowJudge(
  vault: string | null,
  knownFromStore: boolean | undefined,
  knownScope: ArtifactRefScope | undefined,
  remember: boolean,
  configPath?: string,
): RowPrivacyJudge {
  let fromStore: boolean | undefined = knownFromStore;
  let scope: ArtifactRefScope | undefined = knownScope;
  const verdicts = new Map<string, boolean>();
  const refIsPrivate = (ref: string): boolean => {
    let verdict = verdicts.get(ref);
    if (verdict === undefined) {
      fromStore ??= vault === null || judgesFromStore(vault, configPath);
      if (vault !== null) scope ??= artifactRefScope(vault, fromStore, configPath);
      verdict = refsNamePrivatePage(vault, [ref], undefined, fromStore, scope, configPath);
      if (remember) verdicts.set(ref, verdict);
    }
    return verdict;
  };
  return (row, opaque = new Set()) => {
    const strings = rowStrings(row, opaque);
    if (strings === null) return true;
    if (strings.texts.some(textCarriesPrivateRegion)) return true;
    if (strings.references.length === 0) return false;
    if (strings.references.some(textCarriesPrivateRegion)) return true;
    const linked = strings.references.flatMap((text) =>
      extractWikilinks(text).map((target) => `[[${target}]]`),
    );
    return linked.some(refIsPrivate) || strings.references.some(refIsPrivate);
  };
}
