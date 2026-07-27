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
import { buildEntityIndex } from "../entities/index-builder.ts";
import { findMalformedEntityLabels } from "../entities/label-hygiene.ts";
import type { DoctorCheck } from "./check.ts";

/**
 * `duplicate-entity` / `broken-entity-relation`: duplicates come
 * straight from the index builder's conflict report; broken relations
 * are edges whose target resolves to no entity id in the registry.
 */
export const entityRegistryCheck: DoctorCheck = {
  failSoft: true,
  run({ vault }, { issues }) {
    const index = buildEntityIndex(vault);
    if (index.entities.length === 0 && index.conflicts.length === 0) return;

    for (const conflict of index.conflicts) {
      issues.push({
        severity: "warning",
        code: "duplicate-entity",
        message:
          `${conflict.kind === "duplicate-name" ? "identity" : "alias"} '${conflict.key}' is ` +
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
