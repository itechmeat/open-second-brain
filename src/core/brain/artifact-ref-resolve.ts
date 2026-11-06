/**
 * Resolve a reference a report row or a log event carries to the
 * vault-relative path of the page it names, or `null` when it names none
 * on disk.
 *
 * Extracted from `./artifact-ref-view.ts` so a writer below the search
 * layer can resolve references the same way: the brain store's partition
 * rule for log events (`store/reference-privacy.ts`) is reached from the
 * log appender, and the view module imports a search type the log must
 * not depend on. This module imports nothing above `brain/paths.ts`.
 */

import { isAbsolute, join } from "node:path";
import { existsSync, statSync } from "node:fs";

import { pathIsInside, posixRel, vaultRelative } from "../path-safety.ts";
import { BRAIN_DECISIONS_REL, BRAIN_SOURCES_REL, brainDirs } from "./paths.ts";
import { ANCHORED_WIKILINK_RE, stripWikilinkDecoration } from "./wikilink.ts";

/** The `.md` extension every Brain artifact id resolves through. */
const MARKDOWN_EXT = ".md";

/**
 * Strip the wikilink brackets a report row may have kept around its
 * reference, leaving the target verbatim.
 *
 * The brackets are SYNTAX, not part of the reference: a retirement's
 * `retired_by`, a dream transition's `link` and an evidence row's
 * `artifact` all carry `[[…]]` straight out of frontmatter or a log
 * body, and `[[Brain/preferences/pref-x.md]]` names exactly the page
 * `Brain/preferences/pref-x.md`. Before this, such a reference matched
 * neither branch below and the row failed OPEN.
 *
 * Deliberately NOT `parseWikilinkRich`: that normaliser collapses folder
 * segments and drops `.md`, which turns a path-shaped link into a bare
 * basename that resolves to no artifact - the same fail-open by a longer
 * route.
 *
 * The alias and anchor DO come off, through the decoration-only half of
 * that normaliser. Leaving them on was a fail-open with a comment on it:
 * `pref-x|alias`, `pref-x#Raw` and
 * `Brain/preferences/pref-x.md|the rule` end in neither `.md` nor an id
 * any directory holds, so they resolved to nothing and their rows passed
 * unconditionally - and these are not hypothetical spellings, they are
 * what `brain_apply_evidence` documents for its own `artifact` argument.
 * Cutting decoration can only ever SHORTEN the target, so a reference
 * that resolved before still resolves and one that did not may now.
 */
function unbracket(ref: string): string {
  const match = ANCHORED_WIKILINK_RE.exec(ref.trim());
  return stripWikilinkDecoration(match === null ? ref : match[1]!);
}

/**
 * Resolve a bare Brain artifact id to its vault-relative path, or `null`
 * when no artifact of that id is on disk.
 *
 * ## Why the directory list is the whole boundary
 *
 * `visible()` reads an id that resolves to no file as "this row names
 * nothing that could be hidden" and lets the row through. That reading is
 * true only for ids this function would have FOUND had the artifact
 * existed - so every directory omitted here is a directory whose pages
 * are silently unclassifiable, and every binding's fail-closed promise
 * turns into a fail-open one for exactly those pages. The list is
 * therefore every `Brain/` directory holding id-addressable Markdown:
 *
 *   - `preferences` / `retired` carry `owner:` through the preference
 *     writer, and carry `visibility:` wherever an operator wrote one;
 *   - `inbox` / `processed` / `pending` carry whatever an operator or an
 *     importer wrote into a signal's frontmatter;
 *   - `sources` (`src-<slug>.md`) and `entities` are taggable the same
 *     way, and `brain_search_by_source` already filters the first of them
 *     on the search side - so an id-shaped reference to one reaching a
 *     view here and passing was the two halves disagreeing;
 *   - `decisions` (`decision-<slug>.md`) is named by id in the
 *     decision-change receipts (`[[decision-<slug>]]`).
 *
 * `log` is deliberately absent - a log shard is named by date, is shared
 * by construction, and carries no per-page claim to read. `bases` holds
 * `.base` view definitions rather than Markdown pages, and `snapshots`
 * holds dated copies addressed by path rather than by id.
 */
function artifactPath(vault: string, id: string): string | null {
  const dirs = brainDirs(vault);
  for (const dir of [
    dirs.preferences,
    dirs.retired,
    dirs.inbox,
    dirs.processed,
    dirs.archived,
    dirs.pending,
    join(vault, BRAIN_SOURCES_REL),
    dirs.entities,
    join(vault, BRAIN_DECISIONS_REL),
  ]) {
    const abs = join(dir, `${id}${MARKDOWN_EXT}`);
    // The visibility predicate speaks vault-relative POSIX paths - the
    // form a path-shaped reference already carries. Handing it the native
    // `Brain\preferences\...` spelling on Windows would match no rule and
    // let a hidden artifact through, the fail-open this view exists to
    // prevent. Slicing the vault's length off `abs` has the same failure
    // for a vault spelled `/v/` or `/v/x/..` (`join` normalizes `abs`, not
    // `vault`), so the path is taken relative to the resolved vault.
    if (existsSync(abs)) return vaultRelative(abs, vault);
  }
  return null;
}

/**
 * The candidate an extensionless vault-page reference denotes: the bare
 * spelling when that file exists, else its `.md` twin when the twin
 * exists - the same first-existing rule the claim ledger's write side
 * applies to an extensionless source, so the read-side gate cannot drift
 * from the spelling the writer used. When neither file exists the
 * reference names nothing here (`null` reads as visible): a convention
 * like `Notes/<slug>-applied` in a log payload is not a page, and
 * judging it as a missing `.md` page would drop every row carrying it.
 * Both candidates are probed only inside the vault, so a
 * traversal-shaped reference never reaches the filesystem outside it.
 */
function pageCandidate(vault: string, bare: string): string | null {
  if (isVaultFile(vault, bare)) return bare;
  const twin = bare + MARKDOWN_EXT;
  if (isVaultFile(vault, twin)) return twin;
  return null;
}

/** The vault-relative path names a regular file, so it can name a page. */
function isVaultFile(vault: string, rel: string): boolean {
  if (!pathIsInside(join(vault, rel), vault)) return false;
  try {
    return statSync(join(vault, rel)).isFile();
  } catch {
    return false;
  }
}

/**
 * The vault-relative path `ref` names, or `null` when it names nothing on
 * disk. A reference that names a path is resolved as one, including its
 * extensionless spelling, whose .md twin is the page an Obsidian writer
 * named (a gate that resolved only the .md form failed OPEN for exactly
 * that spelling). A bare id is a Brain artifact id ({@link artifactPath}).
 * A `.md` path is returned as written, even outside the vault: the caller
 * decides what a path outside the vault means.
 *
 * Two spellings are brought to the vault-relative POSIX form first, since
 * the visibility rules and the callers' join speak only that form:
 *
 *  - on Windows a `\` is a separator (`posixRel`), so
 *    `Brain\preferences\pref-x` is the path it spells rather than a bare
 *    id that resolves to nothing;
 *  - an absolute path is made relative to the vault: one inside the vault
 *    names its page, one outside comes back climbing out of it (or
 *    absolute, on another Windows drive), which every caller refuses.
 */
export function resolveArtifactRef(vault: string, ref: string): string | null {
  const spelled = posixRel(unbracket(ref));
  if (spelled.length === 0) return null;
  const bare = isAbsolute(spelled) ? vaultRelative(spelled, vault) : spelled;
  if (bare.length === 0) return null;
  if (bare.endsWith(MARKDOWN_EXT)) return bare;
  return bare.includes("/") ? pageCandidate(vault, bare) : artifactPath(vault, bare);
}
