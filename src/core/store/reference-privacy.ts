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
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { resolveArtifactRef } from "../brain/artifact-ref-resolve.ts";
import { resolveNotePath } from "../brain/note-path.ts";
import { preferencePath, retiredPath } from "../brain/paths.ts";
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

/** Extension of a vault page. */
const PAGE_EXTENSION = ".md";

/**
 * Whether the preference `id` names is private: its active or retired page
 * is, or neither page is on disk (it cannot be judged).
 */
function preferenceIdIsPrivate(vault: string, id: string): boolean {
  let paths: string[];
  try {
    const slug = stripBrainIdPrefix(id);
    paths = [preferencePath(vault, slug), retiredPath(vault, slug)].filter((p) => existsSync(p));
  } catch {
    return true; // a slug no page can carry: nothing to judge
  }
  return paths.length === 0 || paths.some((p) => isPrivatePageFile(p));
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
  vault: string,
  refs: ReadonlyArray<string | undefined>,
  guessed?: string,
): boolean {
  // Only the guess itself is spared the missing-page rule: the same id
  // written into the event's body is a reference it carries, judged like
  // any other.
  let guessSpared = guessed === undefined;
  for (const ref of refs) {
    if (ref === undefined || ref === "") continue;
    const isGuess = !guessSpared && ref === guessed;
    if (isGuess) guessSpared = true;
    const id = extractId(ref);
    if (id !== undefined && !isGuess && preferenceIdIsPrivate(vault, id)) return true;
    const rel = resolveArtifactRef(vault, ref);
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
export function claimSourceIsPrivate(vault: string, source: string): boolean {
  const trimmed = source.trim();
  const anchored = ANCHORED_WIKILINK_RE.exec(trimmed);
  const target = stripWikilinkDecoration(anchored !== null ? anchored[1]! : trimmed);
  if (target === "") return false;
  const pageRef = anchored !== null || target.endsWith(PAGE_EXTENSION);
  const id = extractId(target);
  if (id !== undefined) return preferenceIdIsPrivate(vault, id);
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
export function pinnedTextIsPrivate(vault: string, text: string): boolean {
  if (textCarriesPrivateRegion(text)) return true;
  return logRefsNamePrivatePage(
    vault,
    extractWikilinks(text).map((target) => `[[${target}]]`),
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
  vault: string,
  row: unknown,
  opaque: ReadonlySet<string> = new Set(),
): boolean {
  const strings = rowStrings(row, opaque);
  if (strings === null) return true;
  return (
    strings.texts.some(textCarriesPrivateRegion) ||
    strings.references.some((text) => pinnedTextIsPrivate(vault, text)) ||
    logRefsNamePrivatePage(vault, strings.references)
  );
}
