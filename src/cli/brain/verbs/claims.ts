/**
 * `o2b brain claims` - claim-graph query surface (Belief lifecycle
 * suite, A3, t_6916369f).
 *
 * Reads the persisted `Brain/claim-graph.json` projection (building an
 * in-memory one when none exists) and answers point-in-time and history
 * questions. Current-truth is the default; history is opt-in.
 *
 *   o2b brain claims                 current truth (default)
 *   o2b brain claims --at <instant>  truth at instant T
 *   o2b brain claims --history       every claim, tombstoned included
 *   o2b brain claims --replaced <id> the claim that replaced X
 *   o2b brain claims --contests <id> claims that contest X
 *   o2b brain claims --rebuild       rebuild + persist the projection
 */

import { defaultConfigPath } from "../../../core/config.ts";
import {
  allClaims,
  buildClaimGraph,
  currentTruth,
  loadClaimGraph,
  rebuildClaimGraph,
  truthAt,
  whatContests,
  whatReplaced,
  type ClaimGraph,
  type ClaimNode,
} from "../../../core/brain/claim-graph.ts";
import { normalizeFlagString, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

const USAGE_ERROR_EXIT = 2;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function usageError(message: string): number {
  process.stderr.write(`error: ${message}\n`);
  return USAGE_ERROR_EXIT;
}

function renderNode(n: ClaimNode): Record<string, unknown> {
  return {
    id: n.id,
    path: n.path,
    topic: n.topic,
    principle: n.principle,
    valid_from: n.valid_from,
    valid_until: n.valid_until,
    superseded_by: n.superseded_by,
    contradicts: n.contradicts,
    provenance: n.provenance,
    tombstoned: n.tombstoned,
  };
}

/** Load the persisted projection, or build a fresh in-memory one. */
function resolveGraph(vault: string): ClaimGraph {
  return loadClaimGraph(vault) ?? buildClaimGraph(vault);
}

export async function cmdBrainClaims(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    at: { type: "string" },
    history: { type: "boolean" },
    replaced: { type: "string" },
    contests: { type: "string" },
    rebuild: { type: "boolean" },
    json: { type: "boolean" },
  });

  const config = (flags["config"] as string | undefined) ?? defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const wantsJson = flags["json"] === true;

  try {
    if (flags["rebuild"]) {
      const graph = rebuildClaimGraph(vault);
      if (wantsJson) {
        okJson({ rebuilt: true, node_count: graph.node_count, truncated: graph.truncated });
      } else {
        ok(
          `rebuilt claim graph: ${graph.node_count} claims${graph.truncated ? " (truncated)" : ""}`,
        );
      }
      return 0;
    }

    const replaced = normalizeFlagString(flags["replaced"]);
    if (replaced) {
      const tip = whatReplaced(resolveGraph(vault), replaced);
      if (wantsJson) {
        okJson({ replaced, tip: tip ? renderNode(tip) : null });
      } else {
        ok(tip ? `${replaced} -> ${tip.id}` : `no replacement found for ${replaced}`);
      }
      return 0;
    }

    const contests = normalizeFlagString(flags["contests"]);
    if (contests) {
      const rows = whatContests(resolveGraph(vault), contests);
      if (wantsJson) {
        okJson({ contests, claims: rows.map(renderNode) });
      } else {
        ok(`${rows.length} claim(s) contest ${contests}`);
      }
      return 0;
    }

    const at = normalizeFlagString(flags["at"]);
    let rows: ClaimNode[];
    if (at) {
      const iso = DATE_ONLY_RE.test(at) ? `${at}T00:00:00Z` : at;
      const probe = Date.parse(iso);
      if (Number.isNaN(probe)) {
        return usageError(`brain claims --at must be an ISO instant or YYYY-MM-DD date; got ${at}`);
      }
      rows = truthAt(resolveGraph(vault), probe);
    } else if (flags["history"]) {
      rows = allClaims(resolveGraph(vault));
    } else {
      rows = currentTruth(resolveGraph(vault));
    }

    if (wantsJson) {
      okJson({ count: rows.length, claims: rows.map(renderNode) });
    } else {
      ok(`${rows.length} claim(s)`);
      for (const n of rows) ok(`  ${n.id}: ${n.principle}`);
    }
    return 0;
  } catch (exc) {
    process.stderr.write(`error: ${(exc as Error).message ?? String(exc)}\n`);
    return 1;
  }
}
