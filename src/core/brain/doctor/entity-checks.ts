/**
 * Canonical entity registry hygiene (Memory Integrity Suite).
 *
 * Write seams refuse duplicates, so anything reported here arrived
 * through hand edits or sync merges - observable, never auto-deleted.
 */

import {
  entityLexicalAliasCandidates,
  resolveEntitySemanticDedupConfig,
} from "../entities/semantic-dedup.ts";
import {
  anyDiffersOnlyByQuoteVariant,
  ENTITY_QUOTE_VARIANT_CAUSE,
  ENTITY_QUOTE_VARIANT_COLLISION_CODE,
  normalizeEntityName,
} from "../entities/canonical.ts";
import {
  buildEntityIndex,
  conflictClaimants,
  ENTITY_CONFLICT_KIND,
  type EntityIndex,
} from "../entities/index-builder.ts";
import { findMalformedEntityLabels } from "../entities/label-hygiene.ts";
import type { BrainEntity, EntityConflict } from "../entities/types.ts";
import type { DoctorCheck } from "./check.ts";

/**
 * The label each claimant contributed to the contested key: its canonical
 * name for a name conflict, and the alias that matched for an alias one.
 *
 * `EntityConflict` carries `{kind, key, paths}` and not the raw labels,
 * which is the right shape for a finding about FILES - and it is also why
 * the cause has to be re-derived here. The alternative, widening the
 * shared record with the claimed forms, would put presentation data on a
 * type the index builder, the registry's write refusal and both doctor
 * surfaces all pass around, to serve one message. The paths are already
 * in the conflict and the index already holds the records, so this costs
 * a lookup instead.
 */
function claimedForms(index: EntityIndex, conflict: EntityConflict): string[] {
  const claimants: ReadonlyArray<BrainEntity> = conflictClaimants(index, conflict);
  if (conflict.kind === ENTITY_CONFLICT_KIND.duplicateName) {
    return claimants.map((c) => c.name);
  }
  return claimants.map(
    (c) => c.aliases.find((a) => normalizeEntityName(a) === conflict.key) ?? c.name,
  );
}

/** `ent-a (path-a), ent-b (path-b)` - the records, not just their files. */
function describeClaimants(index: EntityIndex, conflict: EntityConflict): string {
  return conflictClaimants(index, conflict)
    .map((c) => `${c.id} (${c.path})`)
    .join(", ");
}

/**
 * `duplicate-entity` / `entity-quote-variant-collision` /
 * `broken-entity-relation`: duplicates come straight from the index
 * builder's conflict report; broken relations are edges whose target
 * resolves to no entity id in the registry.
 *
 * The duplicate report is split by CAUSE, because the two halves have
 * different exits and `doctor-exits.ts` may only publish one answer per
 * code. A duplicate that arrived by hand edit or sync merge has no single
 * command - which of the two files keeps the identity is a reading of
 * both - and is written up that way. A duplicate the quote fold created
 * has one: the records were distinct identities under the previous
 * binary, nothing the operator did merged them, and archiving either one
 * ends the collision. That is the code registered in `DIAGNOSTIC_SIGNALS`,
 * and this is what produces it - every doctor surface resolves a finding's
 * code through the advisory rail, so the command reaches the operator from
 * the registry rather than from a sentence spelled here.
 */
export const entityRegistryCheck: DoctorCheck = {
  failSoft: true,
  run({ vault }, { issues }) {
    const index = buildEntityIndex(vault);
    if (index.entities.length === 0 && index.conflicts.length === 0) return;

    for (const conflict of index.conflicts) {
      const subject = conflict.kind === ENTITY_CONFLICT_KIND.duplicateName ? "identity" : "alias";
      if (anyDiffersOnlyByQuoteVariant(claimedForms(index, conflict))) {
        issues.push({
          severity: "warning",
          code: ENTITY_QUOTE_VARIANT_COLLISION_CODE,
          message:
            `${subject} '${conflict.key}' is claimed by ${conflict.paths.length} entity ` +
            `records: ${describeClaimants(index, conflict)}. They were distinct identities ` +
            `before the identity kernel folded typographic quote variants - ` +
            `${ENTITY_QUOTE_VARIANT_CAUSE}. Archive the record you do not keep.`,
        });
        continue;
      }
      issues.push({
        severity: "warning",
        code: "duplicate-entity",
        message:
          `${subject} '${conflict.key}' is ` +
          `claimed by ${conflict.paths.length} entity files: ${conflict.paths.join(", ")}. ` +
          "Merge them or archive the duplicates - lookups resolve to the first claimant only.",
      });
    }

    const knownIds = new Set(index.entities.map((e) => e.id));
    for (const entity of index.entities) {
      for (const edge of entity.relations) {
        if (knownIds.has(edge.target)) continue;
        issues.push({
          severity: "warning",
          code: "broken-entity-relation",
          path: entity.path,
          message:
            `${entity.id} declares '${edge.relation}: [[${edge.target}]]' but no entity ` +
            "with that id exists in the registry.",
        });
      }
    }

    // A1 (t_657b365e): surface stored nodes whose labels fail the quality
    // gate (structurally junk after decoration stripping, or operator-
    // denylisted) as prune candidates. Warning severity - the operator runs
    // `o2b brain entity prune` (dry-run default) to review and remove them.
    for (const malformed of findMalformedEntityLabels(vault)) {
      issues.push({
        severity: "warning",
        code: "entity-label-malformed",
        path: malformed.path,
        message:
          `${malformed.id} has a malformed label ${JSON.stringify(malformed.name)} ` +
          `(${malformed.reason}). Review with 'o2b brain entity prune' and re-run with ` +
          "--confirm to remove the node and its edges behind a snapshot.",
      });
    }

    // semantic-retrieval-precision (t_47fd9523): opt-in, proposal-only
    // alias-merge candidates. Off by default → this block is a no-op and
    // the report is byte-identical to the baseline. The doctor is
    // synchronous and embeds nothing, so it uses the deterministic lexical
    // (jaccard-over-names) layer; the embedding layer lives on the CLI/MCP
    // reader. Candidates are NOMINATIONS — never an auto-merge.
    const dedupCfg = resolveEntitySemanticDedupConfig();
    if (dedupCfg.enabled) {
      for (const c of entityLexicalAliasCandidates(vault, {
        threshold: dedupCfg.lexicalThreshold,
      })) {
        issues.push({
          severity: "warning",
          code: "entity-alias-candidate",
          message:
            `possible alias-merge: '${c.name_a}' (${c.a}) ~ '${c.name_b}' (${c.b}) ` +
            `[${c.method} ${c.similarity}]. Review and add an alias to merge — never auto-merged.`,
        });
      }
    }
  },
};
