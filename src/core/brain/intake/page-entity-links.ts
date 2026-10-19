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
 *   1. the entity id itself (`[[ent-people-ada-lovelace]]`);
 *   2. the page basename or full vault path, with or without `.md`
 *      (`[[ent-people-ada-lovelace.md]]`, `[[Brain/entities/people/...]]`);
 *   3. the slug-prefixed spelling `[[people/ada-lovelace]]` - the same
 *      separator-tolerant spelling the anchoring kernel matches at a
 *      path-segment boundary, so what the matcher admits and what the
 *      resolver maps agree on one rule;
 *   4. a frontmatter alias, through the index's own alias vocabulary.
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
 * spelling it answers to. Never throws: an index that cannot build
 * answers `undefined` for every target, which is the one answer that
 * cannot leak a record a broken walk cannot see.
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
  const byAlias = new Map<string, string>();
  for (const entity of index.entities) {
    if (!entityStatusInScope(entity.status, ENTITY_STATUS_SCOPE.canonical)) continue;
    const rel = relative(vault, entity.path).split(sep).join("/");
    if (!opts.visible(rel)) continue;
    byId.set(entity.id, entity.id);
    for (const alias of entity.aliases) {
      const normalized = normalizeEntityName(alias);
      if (normalized && !byAlias.has(normalized)) byAlias.set(normalized, entity.id);
    }
  }
  return (target) => {
    if (byId.has(target)) return target;
    const stripped = target.replace(/\.md$/i, "");
    const basename = stripped.includes("/")
      ? stripped.slice(stripped.lastIndexOf("/") + 1)
      : stripped;
    if (byId.has(basename)) return basename;
    const slugPrefixed = `ent-${stripped.split("/").join("-")}`;
    if (byId.has(slugPrefixed)) return slugPrefixed;
    return byAlias.get(normalizeEntityName(target));
  };
}
