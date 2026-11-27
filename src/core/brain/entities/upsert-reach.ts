/**
 * The identity decision of an entity upsert below local reach (moved out
 * of `registry.ts` by change `lane-reach-residuals`, package 16, design
 * R14; the rules themselves are 2.0.4's): taken on the fold of every
 * partition (the write rule), so an entity held in `private` that a local
 * upsert would update, or be refused for, refuses the call with the fixed
 * answer.
 *
 * The registry's own resolution and id allocation stay in `registry.ts`,
 * handed in as {@link EntityIdentityRules}, so this module imports nothing
 * from that module.
 */

import { privateWithheld } from "../../store/caller-reach.ts";
import { assertCreateMatchAtReach } from "../../store/lane-reach-guard.ts";
import { entityPath } from "../paths.ts";
import { entityBaseId, nextUnallocatedPath } from "./batch-allocation.ts";
import {
  assertValidEntityLabel,
  entityIdentityKey,
  normalizeEntityName,
  validateEntityCategory,
} from "./canonical.ts";
import { buildEntityIndex, type EntityIndex } from "./index-builder.ts";
import { resolveEntityLabelDenylist } from "./label-hygiene.ts";
import { BRAIN_ENTITY_STATUS, type EntityRef } from "./types.ts";

/** The registry's rules the decision below needs, owned by `registry.ts`. */
export interface EntityIdentityRules {
  /** The record a write lands on, in the lane the write belongs to. */
  readonly resolveWriteTarget: (
    index: EntityIndex,
    ref: EntityRef,
    untrustedOrigin: boolean,
  ) => { readonly path: string } | null;
  /** The unused id a new entity of this name takes. */
  readonly allocateEntityId: (index: EntityIndex, category: string, name: string) => string;
}

/** The fields of an upsert (`UpsertEntityInput`) its identity decision reads. */
export interface UpsertIdentityInput {
  readonly category: string;
  readonly name: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly configPath?: string;
  readonly untrustedOrigin?: boolean;
}

/**
 * The identity decision of an upsert, taken on the fold of every partition
 * (the write rule): below local reach an entity held in `private` that a
 * local upsert would update, or be refused for, refuses the call with the
 * fixed answer. Answers the path a create would take (the free id on that
 * fold), or null outside that scope and when a stored record matches.
 */
export function assertUpsertAtReach(
  vault: string,
  category: string,
  name: string,
  input: UpsertIdentityInput,
  rules: EntityIdentityRules,
): string | null {
  let created: string | null = null;
  assertCreateMatchAtReach(
    vault,
    () => {
      const index = buildEntityIndex(vault);
      const untrusted = input.untrustedOrigin === true;
      const found = upsertMatches(index, category, name, untrusted, input.aliases ?? [], rules);
      if (found.length === 0) {
        created = entityPath(vault, category, rules.allocateEntityId(index, category, name));
      }
      return found;
    },
    undefined,
    input.configPath,
  );
  return created;
}

/**
 * Below local reach, the upsert of each of `inputs` judged first, as one
 * call (the write rule): an item that meets an entity held in `private`
 * refuses all of them before any write. An item whose category or label
 * is refused is left to its own upsert. Answers the paths the creates
 * would take.
 */
export function assertUpsertsAtReach(
  vault: string,
  inputs: ReadonlyArray<UpsertIdentityInput>,
  rules: EntityIdentityRules,
): string[] {
  if (!privateWithheld()) return [];
  const out: string[] = [];
  // The identity keys the batch creates before this item: a later item of
  // the same key updates that entity instead of creating one.
  const createdKeys = new Set<string>();
  for (const input of inputs) {
    let category: string;
    let name: string;
    try {
      category = validateEntityCategory(input.category);
      name = assertValidEntityLabel(input.name, {
        denylist: resolveEntityLabelDenylist(input.configPath),
      });
    } catch {
      continue;
    }
    const created = assertUpsertAtReach(vault, category, name, input, rules);
    const key = entityIdentityKey(category, name);
    if (created === null || createdKeys.has(key)) continue;
    createdKeys.add(key);
    out.push(
      nextUnallocatedPath(vault, entityPath(vault, category, entityBaseId(category, name)), out),
    );
  }
  return out;
}

/**
 * The entity records an upsert of `name` would update in place or be
 * refused for, as `upsertEntity` decides: its write target, every record
 * claiming its identity key (an archived one included), and the holders
 * of the aliases it claims.
 */
function upsertMatches(
  index: EntityIndex,
  category: string,
  name: string,
  untrusted: boolean,
  aliases: ReadonlyArray<string>,
  rules: EntityIdentityRules,
): string[] {
  const key = entityIdentityKey(category, name);
  // A trusted write is refused on a contested or archived key and resolves
  // canonical records only: a quarantined namesake is not a match (the
  // write creates beside it, as a local one does). An untrusted one
  // resolves inside its own lane, where every quarantined claimant of the
  // key counts (two make the write ambiguous), and is refused on an
  // archived key like a trusted one.
  const out = index.entities
    .filter(
      (e) =>
        entityIdentityKey(e.category, e.name) === key &&
        (untrusted
          ? e.status === BRAIN_ENTITY_STATUS.archived || e.status === BRAIN_ENTITY_STATUS.quarantine
          : e.status !== BRAIN_ENTITY_STATUS.quarantine),
    )
    .map((e) => e.path);
  try {
    const target = rules.resolveWriteTarget(index, { category, query: name }, untrusted);
    if (target !== null) out.push(target.path);
  } catch {
    // An ambiguous target: every claimant of the key is listed above, and
    // an untrusted write meets every quarantined claimant of the name
    // here, as the resolution that threw did.
    if (untrusted) {
      const query = normalizeEntityName(name);
      if (query) {
        out.push(
          ...index.entities
            .filter(
              (e) =>
                e.status === BRAIN_ENTITY_STATUS.quarantine &&
                e.category === category &&
                (normalizeEntityName(e.name) === query ||
                  e.aliases.some((a) => normalizeEntityName(a) === query)),
            )
            .map((e) => e.path),
        );
      }
    }
  }
  for (const raw of aliases) {
    const normalized = normalizeEntityName(raw.trim());
    if (!normalized) continue;
    // Both claims count: an alias held by one record must not mask the
    // canonical name of another.
    for (const holder of [
      index.byAlias.get(normalized),
      index.byKey.get(`${category}:${normalized}`),
    ]) {
      if (holder !== undefined) out.push(holder.path);
    }
  }
  return out;
}
