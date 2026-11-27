/**
 * The reach pre-check of an extraction intake (change `lane-reach-residuals`,
 * package 6, design R7): below local reach every write the intake would
 * make is judged on the fold of every partition before the first of them,
 * so a refusal never leaves the earlier entities of the batch behind.
 *
 * The checks, in order:
 *
 *  - the identity decision of every entity (`assertUpsertsAtReach`): an
 *    entity held in `private` that an upsert would update, or be refused
 *    for, refuses the batch;
 *  - the open review entries the pages a staged batch creates would meet;
 *  - the pages the batch writes, judged by the rule every entity write
 *    applies (`assertEntryShareableAtReach`): a created page whose text or
 *    aliases name a private page, or an update adding such an alias, would
 *    be refused at its own write;
 *  - the endpoints of every relation: one that resolves to an entity held
 *    in `private` (an entity outside the batch, named through another
 *    category or an alias) would be linked by a local caller and is not
 *    found by this one.
 *
 * `extract-intake.ts` builds the plan (it owns the origin, the lane
 * neutralization and the provenance body) and calls this before any write;
 * `ingest.ts` calls the same check through `assertIntakeAtReach` before it
 * records its disposition row. A second call on an unchanged fold refuses
 * nothing new. Outside that scope nothing is read.
 */

import { relative } from "node:path";

import { canonicalNotePath } from "../../path-safety.ts";
import { privateWithheld } from "../../store/caller-reach.ts";
import { isPrivateEntry, lanePagesInStore } from "../../store/lane-entry-store.ts";
import { assertCreateMatchAtReach, LaneEntryWithheldError } from "../../store/lane-reach-guard.ts";
import {
  entityIdentityKey,
  normalizeEntityName,
  validateEntityCategory,
} from "../entities/canonical.ts";
import { buildEntityIndex } from "../entities/index-builder.ts";
import { assertUpsertsAtReach, resolveWriteTarget } from "../entities/registry.ts";
import { assertStagedTargetsAtReach } from "../pending/pending-lanes.ts";
import { REVIEW_LANE } from "../write-gate.ts";

/** One entity of the plan, with the aliases its upsert stores (lane-neutralized). */
export interface IntakeReachEntity {
  readonly category: string;
  readonly name: string;
  readonly aliases?: ReadonlyArray<string>;
}

/** One relation of the plan: its two endpoints as the relate resolves them. */
export interface IntakeReachRelation {
  readonly from: string;
  readonly fromCategory?: string;
  readonly to: string;
  readonly toCategory?: string;
}

/** What the intake would write, as its reach pre-check judges it. */
export interface IntakeReachPlan {
  readonly entities: ReadonlyArray<IntakeReachEntity>;
  readonly relations: ReadonlyArray<IntakeReachRelation>;
  readonly agent: string;
  readonly now: Date;
  readonly untrustedOrigin: boolean;
  /** The intake stages the pages it creates (a `stage` disposition). */
  readonly stage: boolean;
  /** The text a created entity page starts with, for the entity's name. */
  readonly bodyOnCreate: (name: string) => string;
}

/**
 * Below local reach, refuse the whole intake `plan` with the fixed answer
 * when any write it would make meets an entry held in `private` (see the
 * module docblock), before any write.
 */
export function assertIntakePlanAtReach(vault: string, plan: IntakeReachPlan): void {
  if (!privateWithheld()) return;
  const createPaths = assertUpsertsAtReach(
    vault,
    plan.entities.map((entity) => ({
      category: entity.category,
      name: entity.name,
      ...(entity.aliases !== undefined ? { aliases: entity.aliases } : {}),
      agent: plan.agent,
      now: plan.now,
      ...(plan.untrustedOrigin ? { untrustedOrigin: true } : {}),
    })),
  );
  if (plan.stage) {
    assertStagedTargetsAtReach(
      vault,
      REVIEW_LANE.notes,
      createPaths.map((path) => canonicalNotePath(relative(vault, path))),
    );
  }
  assertPagesShareable(vault, plan);
  assertRelationEndpointsAtReach(vault, plan);
}

/**
 * The text each entity write of `plan` adds, judged as a lane write judges
 * a page (`isPrivateEntry`): a created page's name, aliases and opening
 * text, an updated page's new aliases. The batch's own earlier create of
 * the same identity is an update for a later item, as the writes decide.
 * Only where the entity pages are store entries, as the write's own check.
 */
function assertPagesShareable(vault: string, plan: IntakeReachPlan): void {
  if (!lanePagesInStore(vault)) return;
  const index = buildEntityIndex(vault);
  const created = new Set<string>();
  for (const entity of plan.entities) {
    let category: string;
    try {
      category = validateEntityCategory(entity.category);
    } catch {
      continue;
    }
    const name = entity.name.trim();
    if (!normalizeEntityName(name)) continue;
    const key = entityIdentityKey(category, name);
    let target;
    try {
      target = resolveWriteTarget(index, { category, query: name }, plan.untrustedOrigin);
    } catch {
      continue;
    }
    const creates = target === null && !created.has(key);
    if (creates) created.add(key);
    const aliases = [...(entity.aliases ?? [])];
    const fields = creates ? { name, ...(aliases.length > 0 ? { aliases } : {}) } : { aliases };
    if (!creates && aliases.length === 0) continue;
    if (isPrivateEntry(vault, fields, creates ? plan.bodyOnCreate(name) : "")) {
      throw new LaneEntryWithheldError();
    }
  }
}

/**
 * The endpoints of every relation of `plan`, resolved on the fold of every
 * partition in the relation's own lane: one held in `private` refuses the
 * intake. An endpoint that resolves to nothing there is one of the batch's
 * own creates, left to the write; one whose resolution fails is left to the
 * relate, which reports it.
 */
function assertRelationEndpointsAtReach(vault: string, plan: IntakeReachPlan): void {
  if (plan.relations.length === 0) return;
  assertCreateMatchAtReach(vault, () => {
    const index = buildEntityIndex(vault);
    return plan.relations.flatMap((rel) =>
      [
        {
          query: rel.from,
          ...(rel.fromCategory !== undefined ? { category: rel.fromCategory } : {}),
        },
        { query: rel.to, ...(rel.toCategory !== undefined ? { category: rel.toCategory } : {}) },
      ].flatMap((ref) => {
        try {
          const found = resolveWriteTarget(index, ref, plan.untrustedOrigin);
          return found !== null ? [found.path] : [];
        } catch {
          return [];
        }
      }),
    );
  });
}
