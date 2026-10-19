/**
 * Page-link to entity resolver (note-change truth maintenance, F4/C1).
 *
 * A source page that cites an entity page carries more than its prose:
 * its outbound wikilinks name the records the page is about. This module
 * turns those links into the ordered list of canonical entity ids the
 * page links to, so an extraction caller can resolve them server-side
 * and hand the ids to the anchoring kernel - link-derived attachment
 * without pulling the link graph into the kernel itself.
 *
 * ## The accessor is injected, and it owns withholding
 *
 * The pure half ({@link pageEntityLinks}) knows nothing about vaults or
 * indexes: it extracts the wikilinks in first-occurrence order
 * (`extractWikilinks`, which masks code regions and skips media) and maps
 * each target through the injected accessor. A target the accessor leaves
 * unresolved contributes nothing, and a target it refuses is IDENTICAL TO
 * ABSENT - the link-candidates convention, applied before the list is
 * returned, so a withheld entity page is never leaked as an id and never
 * even counts. Which pages are withheld is the caller's question, not this
 * module's: the accessor is where a reach rule or an owner scope binds.
 *
 * {@link entityLinkResolver} is the production accessor over a vault's
 * entity index. It resolves through the spellings a wikilink to an entity
 * page can actually carry, in ladder order:
 *
 *   1. the entity id itself, with or without the `.md` suffix
 *      (`[[ent-people-ada-lovelace]]`, `[[ent-people-ada-lovelace.md]]`);
 *   2. the page's own vault path, with or without `.md`
 *      (`[[Brain/entities/people/...]]`) - a spelling that carries a
 *      directory prefix answers ONLY as that path, never by basename
 *      alone, because the vault's own link resolution dangles on a
 *      prefixed spelling that names no page and so must this resolver;
 *   3. the slug-prefixed spelling `[[people/ada-lovelace]]` - each path
 *      segment lowercased and its separator runs folded the way the
 *      anchoring kernel's separator-tolerant spelling folds them, so
 *      what the matcher admits and what the resolver maps agree on one
 *      rule. The fold is the matcher's, not the full id-minting
 *      slugify: a character only slugify folds (a period, an
 *      apostrophe) stays as written and the spelling dangles, exactly
 *      as the vault's own link resolution dangles on it. The rung is
 *      defined on the category/slug form a directory prefix carries -
 *      a spelling without one never reaches it;
 *   4. a frontmatter alias, through the index's own alias vocabulary -
 *      except an alias more than one visible canonical entity claims:
 *      the index records that claim as a duplicate-alias conflict and
 *      answers it to no one, and a resolver that picked a first winner
 *      would turn an ambiguous link into a confident wrong anchor.
 *
 * Every rung answers the TRIMMED target: the shared wikilink extractor
 * captures the text between the brackets untrimmed, so the whitespace a
 * link carries is not part of the spelling the author wrote. The `.md`
 * suffix is the one tolerance beyond that: entity ids and paths are
 * answered case-sensitively, because a link is matched by its exact
 * stored spelling the same way every other link read in this codebase
 * matches, and a case-insensitive id map would resolve spellings the
 * vault's own link resolution refuses.
 *
 * A bare entity NAME is deliberately not a rung: name-in-text matching is
 * the anchoring kernel's job, and a link spelling the vault's own link
 * resolution would dangle on stays dangling here too. Records outside the
 * canonical scope (archived, quarantined, unparsable) resolve to nothing,
 * exactly like absent pages, and a page the `visible` predicate refuses is
 * dropped before any of its spellings can answer. An index that cannot
 * build resolves nothing and never throws - a broken registry must not
 * turn every page into a failed read, and it must not invent anchors
 * either.
 */

import { relative, sep } from "node:path";

import { extractWikilinks } from "../../vault.ts";
import { normalizeEntityName } from "../entities/canonical.ts";
import { buildEntityIndex } from "../entities/index-builder.ts";
import { ENTITY_STATUS_SCOPE, entityStatusInScope } from "../entities/status-scope.ts";

/**
 * May this wikilink target be attached as a canonical entity id? Answers
 * the id, or `undefined` when the target does not resolve to an entity
 * page the caller may attach - absent, non-entity, out of canonical
 * scope, or withheld by the caller's reach rule.
 */
export type EntityLinkAccessor = (target: string) => string | undefined;

/**
 * The ordered canonical entity ids `content` links to, in
 * `extractWikilinks` first-occurrence order, deduped across spellings
 * that resolve to one id. A target that resolves to nothing contributes
 * nothing - including one whose accessor raises, because a link the
 * resolver cannot answer is an unresolved link, not a failed page. Never
 * throws; nothing to resolve answers an empty list.
 */
export function pageEntityLinks(content: string, resolve: EntityLinkAccessor): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const target of extractWikilinks(content)) {
    let id: string | undefined;
    try {
      id = resolve(target);
    } catch {
      id = undefined;
    }
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export interface EntityLinkResolverOptions {
  /**
   * May the caller read the entity page at this VAULT-RELATIVE path?
   * REQUIRED, with no default: a predicate nobody wrote must not read as
   * "everything is visible", because the resolver indexes every
   * canonical-scope entity it can see, and the anchor list naming an
   * entity page the reader cannot read IS the disclosure. A caller
   * already running at the vault's own reach (a local maintenance lane,
   * the local CLI) passes `() => true` - the decision stays visible at
   * the call site, and a caller deriving the list for a narrower reader
   * binds its rule here. A refused page is dropped before the list is
   * returned, so the refused id is not merely hidden but absent.
   */
  readonly visible: (rel: string) => boolean;
}

/**
 * The production {@link EntityLinkAccessor} over `vault`'s entity index,
 * built once per call. Canonical-scope records only; a page the caller's
 * `visible` predicate refuses is dropped before answering, under every
 * spelling it answers to - and before counting as an alias claimant,
 * since a refused page is identical to absent and cannot make a visible
 * entity's alias ambiguous. An alias two visible entities claim is
 * dropped for both, the index's own duplicate-alias rule mirrored over
 * the population this accessor may name. Never throws: an index that
 * cannot build answers `undefined` for every target, which is the one
 * answer that cannot leak a record a broken walk cannot see.
 */
export function entityLinkResolver(
  vault: string,
  opts: EntityLinkResolverOptions,
): EntityLinkAccessor {
  let index: ReturnType<typeof buildEntityIndex>;
  try {
    index = buildEntityIndex(vault);
  } catch {
    return () => undefined;
  }
  const byId = new Map<string, string>();
  const byPath = new Map<string, string>();
  const aliasClaims = new Map<string, Set<string>>();
  for (const entity of index.entities) {
    if (!entityStatusInScope(entity.status, ENTITY_STATUS_SCOPE.canonical)) continue;
    const rel = relative(vault, entity.path).split(sep).join("/");
    if (!opts.visible(rel)) continue;
    byId.set(entity.id, entity.id);
    // The page's own vault path, with and without the `.md` suffix: the
    // only directory-prefixed spellings that answer (rung 2).
    byPath.set(rel, entity.id);
    byPath.set(rel.replace(/\.md$/i, ""), entity.id);
    for (const alias of entity.aliases) {
      const normalized = normalizeEntityName(alias);
      if (!normalized) continue;
      const claimants = aliasClaims.get(normalized) ?? new Set<string>();
      claimants.add(entity.id);
      aliasClaims.set(normalized, claimants);
    }
  }
  // Contested aliases answer no one; uncontested ones answer their one
  // claimant, deterministically.
  const byAlias = new Map<string, string>();
  for (const [normalized, claimants] of aliasClaims) {
    if (claimants.size !== 1) continue;
    byAlias.set(normalized, claimants.values().next().value!);
  }
  return (target) => {
    const trimmed = target.trim();
    if (byId.has(trimmed)) return trimmed;
    const stripped = trimmed.replace(/\.md$/i, "");
    const asPath = byPath.get(stripped);
    if (asPath !== undefined) return asPath;
    if (!stripped.includes("/") && byId.has(stripped)) return stripped;
    // A bare spelling's rungs end here. The fold below is the
    // slug-prefixed spelling's rung, defined on the category/slug form
    // a directory prefix carries; folded over a bare name it would
    // mint the id's own slug out of "People Ada Lovelace" or
    // "people_ada_lovelace" - bare entity NAMEs, which are deliberately
    // not a rung - and resolve spellings the vault's own link
    // resolution dangles on. Case-varying a bare id stays unresolved
    // for the same reason: ids are answered case-sensitively.
    if (!stripped.includes("/")) return byAlias.get(normalizeEntityName(trimmed));
    const slugPrefixed = `ent-${stripped
      .split("/")
      .map((segment) => segment.toLowerCase().replace(/[-_ ]+/g, "-"))
      .join("-")}`;
    if (byId.has(slugPrefixed)) return slugPrefixed;
    return byAlias.get(normalizeEntityName(trimmed));
  };
}
