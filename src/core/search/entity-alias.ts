/**
 * Registry-aware query entity expansion (Memory Integrity Suite).
 *
 * `extractEntities` pulls entity strings out of the raw query; this
 * module folds the canonical entity registry over that set so a query
 * naming an ALIAS also matches chunks naming the CANONICAL entity and
 * vice versa. Expansion is additive and fail-soft: no registry (or an
 * unreadable one) leaves the query entity set untouched, so vaults
 * without `Brain/entities/` rank bit-identically to pre-registry
 * behaviour.
 *
 * Person-category entities additionally derive PERSON-NAME VARIANTS
 * (write-honesty-egress-consent, F3) - first-initial-plus-surname,
 * reversed word order, and operator-supplied nicknames - which join the
 * participation test and the expanded set beside the declared forms.
 * Derived forms are tracked in their own `derived` array so attribution
 * can tell a declared-form match from a derived-variant match; the
 * derivation kernel is the leaf module `person-variants.ts`, and the
 * nickname data is operator-supplied only (`person-nicknames.json` in
 * the vault, resolved below - never a shipped word list).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildEntityIndex } from "../brain/entities/index-builder.ts";
import { normalizeEntityName } from "../brain/entities/canonical.ts";
import {
  derivePersonNameVariants,
  EMPTY_PERSON_NICKNAME_MAP,
  isPersonCategory,
  type PersonNicknameMap,
} from "../brain/entities/person-variants.ts";
import { ENTITY_STATUS_SCOPE, entityStatusInScope } from "../brain/entities/status-scope.ts";

export interface QueryEntityExpansion {
  /** Original query entities plus every form added by the registry. */
  readonly expanded: ReadonlyArray<string>;
  /** Only the forms the registry added (for canonical-hop attribution). */
  readonly added: ReadonlyArray<string>;
  /**
   * Only the forms PERSON-VARIANT DERIVATION added, beside the declared
   * {@link added} - so attribution can tell a declared-form match from
   * a derived-variant match. Empty unless a person-category entity
   * participated through a derived form the query did not already
   * carry.
   */
  readonly derived: ReadonlyArray<string>;
  /** Ids of the canonical entities whose forms were added, sorted. */
  readonly sourceIds: ReadonlyArray<string>;
}

// ----- Operator nickname data -------------------------------------------------

/**
 * Vault-relative home of the operator-supplied nickname map: a JSON
 * object keyed by nickname, whose values are the full person names the
 * nickname can stand for. Same `Brain/entities/` neighbourhood as the
 * derived lexicon artifact, but this file is OPERATOR data, never
 * machine-derived, so there is no schema-version/freshness envelope -
 * the whole document is the map.
 */
export const PERSON_NICKNAMES_ARTIFACT_REL = join("Brain", "entities", "person-nicknames.json");

/**
 * Raised when `person-nicknames.json` exists but cannot be used. A
 * MISSING file is not an error - it means the vault declares no
 * nickname data - but a present file that fails to parse or violates
 * the shape is an operator-data fault, and it surfaces by name; every
 * consumer decides its own posture toward it (search expansion degrades
 * to the identity expansion, read resolution degrades to exact-only).
 */
export class PersonNicknameConfigError extends Error {
  readonly path: string;
  readonly detail: string;
  constructor(path: string, detail: string) {
    super(`unreadable person nickname config at ${path}: ${detail}`);
    this.name = "PersonNicknameConfigError";
    this.path = path;
    this.detail = detail;
  }
}

/** True for the ENOENT family: the artifact is simply not there. */
function isMissingFileError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

/**
 * Fold one parsed JSON document into the normalized nickname map the
 * derivation kernel consumes: keys and values are run through
 * `normalizeEntityName` (the comparison is post-normalization, exactly
 * like the label denylist), empty normalized forms are dropped, and
 * value lists are deduplicated. Malformed shapes surface through
 * {@link PersonNicknameConfigError}.
 */
function parsePersonNicknameDocument(text: string, path: string): PersonNicknameMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new PersonNicknameConfigError(path, `not parseable JSON (${String(err)})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PersonNicknameConfigError(path, "expected a JSON object mapping nickname to names");
  }
  const out = new Map<string, string[]>();
  for (const [rawKey, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
    const key = normalizeEntityName(rawKey);
    if (!key) continue;
    if (!Array.isArray(rawValue)) {
      throw new PersonNicknameConfigError(path, `value of '${rawKey}' must be an array of names`);
    }
    const values: string[] = [];
    for (const entry of rawValue) {
      if (typeof entry !== "string") {
        throw new PersonNicknameConfigError(path, `value of '${rawKey}' must be an array of names`);
      }
      const normalized = normalizeEntityName(entry);
      if (normalized && !values.includes(normalized)) values.push(normalized);
    }
    if (values.length > 0) out.set(key, values);
  }
  return Object.freeze(
    new Map([...out].map(([key, values]) => [key, Object.freeze(values)] as const)),
  );
}

/**
 * Resolve the operator nickname map for `vault`. A missing file yields
 * the empty map (no nickname data declared); a present but unreadable
 * or malformed one throws {@link PersonNicknameConfigError}, so a
 * caller that must not guess can tell "none declared" from "declared
 * but unusable".
 */
export function resolvePersonNicknameMap(vault: string): PersonNicknameMap {
  const path = join(vault, PERSON_NICKNAMES_ARTIFACT_REL);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (isMissingFileError(err)) return EMPTY_PERSON_NICKNAME_MAP;
    throw new PersonNicknameConfigError(path, `not readable (${String(err)})`);
  }
  return parsePersonNicknameDocument(text, path);
}

/**
 * Expand query entities with canonical names and aliases from the
 * registry. A registry entity participates when ANY of its forms
 * (name or alias) appears among the query entities - or, for a
 * person-category entity, when any DERIVED person variant of its forms
 * does - and the entity's other forms (declared and derived) are then
 * added.
 */
export function expandQueryEntities(
  vault: string,
  queryEntities: ReadonlyArray<string>,
): QueryEntityExpansion {
  const identity: QueryEntityExpansion = Object.freeze({
    expanded: queryEntities,
    added: Object.freeze([] as string[]),
    derived: Object.freeze([] as string[]),
    sourceIds: Object.freeze([] as string[]),
  });
  if (queryEntities.length === 0) return identity;

  let index;
  try {
    index = buildEntityIndex(vault);
  } catch {
    return identity; // fail-soft: search never breaks on a bad registry
  }
  if (index.entities.length === 0) return identity;

  let nicknames: PersonNicknameMap;
  try {
    nicknames = resolvePersonNicknameMap(vault);
  } catch {
    return identity; // fail-soft: an unusable nickname file is not a search outage
  }

  const querySet = new Set(queryEntities.map((e) => normalizeEntityName(e)));
  const added: string[] = [];
  const addedSet = new Set<string>();
  const derived: string[] = [];
  const derivedSet = new Set<string>();
  const sourceIds: string[] = [];

  for (const entity of index.entities) {
    if (!entityStatusInScope(entity.status, ENTITY_STATUS_SCOPE.canonical)) continue;
    const forms = [entity.name, ...entity.aliases].map((f) => normalizeEntityName(f));
    // Person-category entities derive variants per declared form; the
    // variants join the PARTICIPATION test (a query naming a derived
    // form picks the entity up) and, below, the expanded set.
    const derivedByForm = isPersonCategory(entity.category)
      ? forms.map((f) => derivePersonNameVariants(f, nicknames))
      : null;
    const participates =
      forms.some((f) => querySet.has(f)) ||
      (derivedByForm !== null &&
        derivedByForm.some((variants) => variants.some((v) => querySet.has(v))));
    if (!participates) continue;
    let contributed = false;
    for (const form of forms) {
      if (querySet.has(form) || addedSet.has(form) || form.length < 2) continue;
      addedSet.add(form);
      added.push(form);
      contributed = true;
    }
    if (derivedByForm !== null) {
      for (const variants of derivedByForm) {
        for (const variant of variants) {
          // A derived form another entity (or this one) already DECLARED
          // is tracked as declared: declared attribution wins.
          if (querySet.has(variant) || addedSet.has(variant) || derivedSet.has(variant)) continue;
          derivedSet.add(variant);
          derived.push(variant);
          contributed = true;
        }
      }
    }
    if (contributed) sourceIds.push(entity.id);
  }

  if (added.length === 0 && derived.length === 0) return identity;
  return Object.freeze({
    expanded: Object.freeze([...queryEntities, ...added, ...derived]),
    added: Object.freeze(added),
    derived: Object.freeze(derived),
    sourceIds: Object.freeze(sourceIds.toSorted()),
  });
}
