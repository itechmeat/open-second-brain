/**
 * Canonical entity registry hygiene (Memory Integrity Suite).
 *
 * Write seams refuse duplicates, so anything reported here arrived
 * through hand edits or sync merges - observable, never auto-deleted.
 */

import {
  entityLexicalAliasCandidates,
  resolveEntitySemanticDedupConfig,
  type EntityAliasCandidate,
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
import {
  PersonNicknameConfigError,
  resolvePersonNicknameMap,
} from "../entities/person-nicknames.ts";
import {
  derivePersonNameVariants,
  EMPTY_PERSON_NICKNAME_MAP,
  isPersonCategory,
  type PersonNicknameMap,
} from "../entities/person-variants.ts";
import { findMalformedEntityLabels } from "../entities/label-hygiene.ts";
import { ENTITY_STATUS_SCOPE, entityStatusInScope } from "../entities/status-scope.ts";
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

/** Doctor code of an unusable operator nickname map. */
export const PERSON_NICKNAMES_UNREADABLE_CODE = "person-nicknames-unreadable";

/** Doctor code of a proposal-only alias-merge candidate. */
export const ENTITY_ALIAS_CANDIDATE_CODE = "entity-alias-candidate";

/**
 * The one alias-merge sentence both candidate kinds are written with.
 * Kept in a single home so the doctor's findings and the decision-model
 * annotator's message-matching can never drift apart.
 */
function aliasMergeCandidateMessage(
  nameA: string,
  idA: string,
  nameB: string,
  idB: string,
  method: string,
  similarity: number | string,
): string {
  return (
    `possible alias-merge: '${nameA}' (${idA}) ~ '${nameB}' (${idB}) ` +
    `[${method} ${similarity}]. Review and add an alias to merge — never auto-merged.`
  );
}

/**
 * The doctor message of one alias-merge candidate. Shared with the
 * decision-model annotator (`entities/alias-verdicts.ts`), which matches
 * the doctor's issues back to their candidates by this exact text.
 */
export function entityAliasCandidateMessage(c: EntityAliasCandidate): string {
  return aliasMergeCandidateMessage(c.name_a, c.a, c.name_b, c.b, c.method, c.similarity);
}

/**
 * The doctor message of one DERIVED-VARIANT collision
 * (write-honesty-egress-consent, F3/C5): the same alias-merge shape,
 * with a `person-variant` method label. The similarity is 1 because the
 * collision is exact - the derived form equals the other record's
 * declared form byte-for-byte after normalization. The method label
 * differs from every lexical/embedding candidate's, so the annotator's
 * by-message match simply never pairs this finding with one.
 */
export function personVariantCollisionMessage(a: BrainEntity, b: BrainEntity): string {
  const [first, second] = a.id.localeCompare(b.id) <= 0 ? [a, b] : [b, a];
  return aliasMergeCandidateMessage(
    first.name,
    first.id,
    second.name,
    second.id,
    "person-variant",
    1,
  );
}

/**
 * Every pair of canonical PERSON records where a derived variant of one
 * equals a DECLARED form (name or alias) of the other
 * (write-honesty-egress-consent, F3/C5). Lookups stay exact-declared-
 * first, so nothing mis-resolves today - but the registry holds two
 * records answering to one form, and that is the same latent alias-merge
 * the candidates above nominate, so it is reported through the same
 * warning. Exactly one finding per unordered pair, however many variants
 * collide and whichever side derives.
 *
 * A form shared only as a DERIVED form on both sides is not a collision:
 * neither record declared it, so the collision scan has nothing to offer
 * the merge that the ambiguity error at lookup time does not already
 * say better.
 */
function derivedVariantCollisionMessages(
  index: EntityIndex,
  nicknames: PersonNicknameMap,
): string[] {
  const persons = index.entities.filter(
    (e) =>
      entityStatusInScope(e.status, ENTITY_STATUS_SCOPE.canonical) && isPersonCategory(e.category),
  );
  const declared = new Map<string, ReadonlySet<string>>(
    persons.map((p) => [p.id, new Set([p.name, ...p.aliases].map((f) => normalizeEntityName(f)))]),
  );
  const seenPairs = new Set<string>();
  const messages: string[] = [];
  for (const deriver of persons) {
    const variants = new Set<string>();
    for (const form of [deriver.name, ...deriver.aliases]) {
      for (const v of derivePersonNameVariants(normalizeEntityName(form), nicknames)) {
        variants.add(v);
      }
    }
    if (variants.size === 0) continue;
    for (const claimant of persons) {
      if (claimant.id === deriver.id) continue;
      const pairKey = [deriver.id, claimant.id].toSorted().join("\u0000");
      if (seenPairs.has(pairKey)) continue;
      const claimantForms = declared.get(claimant.id)!;
      if (![...variants].some((v) => claimantForms.has(v))) continue;
      seenPairs.add(pairKey);
      messages.push(personVariantCollisionMessage(deriver, claimant));
    }
  }
  return messages;
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

    // write-honesty-egress-consent (F3/C5): a derived person variant of
    // one person that equals another person's declared form. Same
    // warning as the candidates below - it nominates the same remedy -
    // but deterministic and always on, like the lints above. Unlike the
    // conflict findings above, which deliberately read what is STORED
    // (scoping them would stop the doctor reporting on exactly the
    // records a read path hides), this scan and the malformed-label scan
    // resolve through the shared canonical predicate: a quarantined
    // person's variants nominate no merges.
    // An unusable nickname file degrades this scan to no derived
    // collisions rather than discarding the check - the read lanes keep
    // their documented degradations too - but the doctor is the
    // surfacing point: a present-yet-unusable operator file is one
    // warning, naming the path, with the error's own short
    // (position-only) detail.
    let nicknames = EMPTY_PERSON_NICKNAME_MAP;
    try {
      nicknames = resolvePersonNicknameMap(vault);
    } catch (err) {
      if (!(err instanceof PersonNicknameConfigError)) throw err;
      nicknames = EMPTY_PERSON_NICKNAME_MAP;
      issues.push({
        severity: "warning",
        code: PERSON_NICKNAMES_UNREADABLE_CODE,
        path: err.path,
        message:
          `the person nickname map at ${err.path} is unusable and nickname-derived ` +
          `lookups run without it: ${err.detail}`,
      });
    }
    for (const message of derivedVariantCollisionMessages(index, nicknames)) {
      issues.push({
        severity: "warning",
        code: ENTITY_ALIAS_CANDIDATE_CODE,
        message,
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
          code: ENTITY_ALIAS_CANDIDATE_CODE,
          message: entityAliasCandidateMessage(c),
        });
      }
    }
  },
};
