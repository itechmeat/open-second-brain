/**
 * The claim-ledger surface of the knowledge family (task 3.19):
 * `brain_claims` over the entity claim ledger, with the graph
 * resolution, node rendering, provenance and visibility helpers it
 * answers through, and the two exports the CLI truth subcommand shares
 * (`statedClaimEntities`, `claimEventsReport`). Split from
 * `knowledge-tools.ts`; registration happens through that module's
 * registry, which preserves the public KNOWLEDGE_TOOLS surface.
 */

import { reachView } from "../../core/brain/reach-view.ts";
import { everyArtifactRefView, type ArtifactRefView } from "../../core/brain/artifact-ref-view.ts";
import { gatedOwnerScopeView } from "../../core/brain/owner-scope-view.ts";
import { recordRefs } from "../../core/brain/log-events-at-reach.ts";
import { deliveryView } from "./reach-events.ts";
import { normalizeEntityName } from "../../core/brain/entities/canonical.ts";
import { listEntities } from "../../core/brain/entities/registry.ts";
import {
  ENTITY_STATUS_SCOPE,
  entityStatusInScope,
} from "../../core/brain/entities/status-scope.ts";
import { readClaimEvents } from "../../core/brain/truth/store.ts";
import { matchClaimEvents } from "../../core/brain/truth/events-window.ts";
import {
  loadClaimProvenanceIndex,
  resolveClaimProvenanceFromIndex,
  type ClaimProvenance,
  type ClaimProvenanceOptions,
} from "../../core/brain/truth/claim-provenance.ts";
import type { ClaimEvent } from "../../core/brain/truth/types.ts";
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
} from "../../core/brain/claim-graph.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { contextReach } from "../tool-contract.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../core/graph/transport-reach.ts";
import type { ServerContext } from "../tool-contract.ts";
import { coerceStr, unknownOperationError } from "../coerce.ts";
import { isOperatorRuleItem, isRuleOnlyInjection } from "./pack-tools.ts";

// ----- brain_claims (Belief lifecycle suite, A3) -----------------------------

export function renderClaimNode(
  delivery: ReturnType<typeof deliveryView>,
  n: ClaimNode,
): Record<string, unknown> {
  return {
    id: n.id,
    path: n.path,
    topic: n.topic,
    // The principle is the record's own stored text (delivery-trust,
    // lane A): shaped through the request's delivery binding at the
    // claim's own page - the same text brain_query fences inside the
    // preference payloads - so the graph view is not the unfenced copy.
    principle: delivery.shape(n.principle, n.path),
    valid_from: n.valid_from,
    valid_until: n.valid_until,
    superseded_by: n.superseded_by,
    contradicts: n.contradicts,
    provenance: n.provenance,
    tombstoned: n.tombstoned,
  };
}

export const CLAIMS_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Load the persisted claim graph, or build a fresh in-memory one. */
export function resolveClaimGraph(vault: string): ClaimGraph {
  return loadClaimGraph(vault) ?? buildClaimGraph(vault);
}

/**
 * Claim-graph query surface: current truth (default), truth at an
 * instant, history, what replaced X, what contests X, or rebuild.
 */
export function toolBrainClaims(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const operation = coerceStr(args, "operation", false) ?? "current";
  // A claim row carries the artifact's id, its vault-relative path, its
  // topic AND its full principle text - the sharpest counter-example in
  // recon C6 to the "this bucket is metadata" label. Every row-returning
  // operation is filtered, and so is the rebuild count: a count the
  // caller cannot decompose still says how many claims exist.
  // At the caller's reach a row is asked over every record it names: its
  // page, its id under the pref- and ret- spellings, and the records that
  // superseded or contest it.
  const owner = gatedOwnerScopeView(ctx.vault, ctx.agentName);
  const reach = reachView(ctx.vault, contextReach(ctx));
  // The delivery binding (delivery-trust, lane A): one reach resolution
  // and one frontmatter cache for every principle this tool returns.
  const delivery = deliveryView(ctx);
  const shown = (n: ClaimNode): boolean =>
    owner.row(n.path, n.id) &&
    reach.row(
      n.path,
      ...recordRefs(n.id),
      ...recordRefs(n.superseded_by ?? undefined),
      ...n.contradicts.flatMap((id) => recordRefs(id)),
    );
  const visible = (rows: ReadonlyArray<ClaimNode>): ReadonlyArray<ClaimNode> => rows.filter(shown);
  switch (operation) {
    case "rebuild": {
      const graph = rebuildClaimGraph(ctx.vault);
      return {
        operation,
        rebuilt: true,
        node_count: visible(allClaims(graph)).length,
        truncated: graph.truncated,
      };
    }
    case "replaced": {
      const id = coerceStr(args, "id", true)!;
      const tip = whatReplaced(resolveClaimGraph(ctx.vault), id);
      return {
        operation,
        id,
        tip: tip !== null && shown(tip) ? renderClaimNode(delivery, tip) : null,
      };
    }
    case "contests": {
      const id = coerceStr(args, "id", true)!;
      const rows = visible(whatContests(resolveClaimGraph(ctx.vault), id));
      return { operation, id, claims: rows.map((n) => renderClaimNode(delivery, n)) };
    }
    case "at": {
      const at = coerceStr(args, "at", true)!;
      const iso = CLAIMS_DATE_ONLY_RE.test(at) ? `${at}T00:00:00Z` : at;
      const probe = Date.parse(iso);
      if (Number.isNaN(probe)) {
        throw new MCPError(
          INVALID_PARAMS,
          `brain_claims: 'at' must be an ISO instant or YYYY-MM-DD date; got ${at}`,
        );
      }
      const rows = visible(truthAt(resolveClaimGraph(ctx.vault), probe));
      return {
        operation,
        at,
        count: rows.length,
        claims: rows.map((n) => renderClaimNode(delivery, n)),
      };
    }
    case "history": {
      const rows = visible(allClaims(resolveClaimGraph(ctx.vault)));
      return {
        operation,
        count: rows.length,
        claims: rows.map((n) => renderClaimNode(delivery, n)),
      };
    }
    case "current": {
      const rows = visible(currentTruth(resolveClaimGraph(ctx.vault)));
      return {
        operation,
        count: rows.length,
        claims: rows.map((n) => renderClaimNode(delivery, n)),
      };
    }
    default:
      throw unknownOperationError(
        "brain_claims: 'operation' must be one of current, at, history, replaced, contests, rebuild",
      );
  }
}

// ----- brain_truth (Entity Truth & Self-Improving Dream Suite) ---------------

/**
 * The registry slice the stated-claims anchoring consumes: canonical-
 * scope entities only (the anchoring kernel's status discipline,
 * applied where the registry is read), narrowed to AtomicEntityLike.
 * Shared by the MCP `state` operation and the CLI `brain truth state`
 * subcommand so the two surfaces anchor identically.
 */
export function statedClaimEntities(vault: string): ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
  readonly status: string;
}> {
  return listEntities(vault)
    .filter((entity) => entityStatusInScope(entity.status, ENTITY_STATUS_SCOPE.canonical))
    .map(({ id, name, aliases, status }) => ({ id, name, aliases, status }));
}

/**
 * One windowed events query, shared by the MCP `events` operation and
 * the CLI `brain truth events` subcommand so the two surfaces cannot
 * drift on shape, ordering, gating or paging. Bounds arrive already
 * resolved (unix-ms); the page size must already be validated.
 *
 * Windowed recall (truth-correctable-time-aware, Tasks 8-9):
 * `sinceMs`/`untilMs` filter ASSERTION `ts` only; the per-claim
 * validity windows ride on the rows verbatim and are never consulted
 * here (contract item 1 keeps the two temporal vocabularies separate).
 * Every matched row passes the same per-row owner/reach gate
 * `brain_claims` asks, and the account covers ONLY the rows that pass
 * it: a withheld row is dropped and nothing counts it (the views'
 * identical-to-absent convention - a dropped-but-counted row would tell
 * the caller that a claim it may not see exists, and per entity or
 * window would let it measure the hidden population). A filtered answer
 * is therefore byte-identical to the answer over a vault that never
 * held the withheld rows. The same reach governs the provenance join
 * (see {@link claimProvenanceForPage}).
 */
export function claimEventsReport(
  vault: string,
  agentName: string | undefined,
  reach: TransportReach,
  query: {
    readonly entity?: string;
    readonly sinceMs: number | null;
    readonly untilMs: number | null;
    readonly limit: number;
  },
): Record<string, unknown> {
  const entityFilter =
    query.entity !== undefined && query.entity.trim() !== "" ? query.entity : undefined;
  const view = everyArtifactRefView(gatedOwnerScopeView(vault, agentName), reachView(vault, reach));
  const matched = matchClaimEvents(readClaimEvents(vault).events, {
    ...(entityFilter !== undefined ? { entity: entityFilter } : {}),
    sinceMs: query.sinceMs,
    untilMs: query.untilMs,
  });
  const gated = view.filtersNothing ? matched : matched.filter((event) => view.row(event.source));
  const page = gated.slice(0, query.limit);
  const provenance = claimProvenanceForPage(vault, reach, view, page);
  return {
    ok: true,
    operation: "events",
    entity: entityFilter === undefined ? null : normalizeEntityName(entityFilter),
    events: page.map((event, position) =>
      event.sample_id === undefined || provenance === null
        ? // A claim without a sample id renders exactly as today: no
          // provenance key, byte-identical row.
          event
        : {
            ...event,
            // Answer-trust (task B4): the claim's sample id resolves to
            // its receipt and outcome halves at read time. A missing
            // outcome half is null - "receipt known, outcome unknown" -
            // never a fabricated verdict.
            provenance: provenance[position]!,
          },
    ),
    total: gated.length,
    truncated: gated.length > query.limit,
  };
}

/**
 * The provenance half of one events page, resolved at the CALLER's
 * reach over ONE read per ledger.
 *
 * The resolutions come back aligned with the page by POSITION, one per
 * row: the inversion flag compares each claim's OWN assertion ts
 * against the claimed receipt, so two claims sharing one `sample_id`
 * (one stated before the receipt it names, one after) must resolve
 * independently - a per-id cache would hand both rows the last
 * claim's flag. Resolution from the prebuilt index is map lookups, so
 * resolving per event keeps the one-read-per-ledger bound the scans
 * suite pins.
 *
 * The receipts surface withholds the operator's rule injections below
 * local reach (list excludes them, show refuses them, receipts are
 * stripped of their items); this join answers for the same records, so
 * it binds the same rules here instead of leaking through a claim's
 * `sample_id` what `brain_context_receipts` refuses to say directly. A
 * rule-only receipt renders as the unknown-id answer; a mixed receipt
 * keeps its non-rule items; and a receipt item whose recorded path
 * names a page the caller may not read at its reach leaves the items
 * under the same visibility rule the event rows of this report are
 * gated by.
 *
 * Null when no row on the page carries a sample id: the ledgers are
 * never read and every row renders byte-identically to the
 * pre-attribution answer. Otherwise the array holds one entry per page
 * row, null at the unsampled positions.
 */
export function claimProvenanceForPage(
  vault: string,
  reach: TransportReach,
  view: ArtifactRefView,
  page: ReadonlyArray<ClaimEvent>,
): ReadonlyArray<ClaimProvenance | null> | null {
  if (!page.some((event) => event.sample_id !== undefined)) return null;
  const local = reach === TRANSPORT_REACH.local;
  const options: ClaimProvenanceOptions = {
    ...(local ? {} : { exclude: isRuleOnlyInjection }),
    ...(view.filtersNothing
      ? {}
      : {
          excludeItem: (item: unknown): boolean =>
            (!local && isOperatorRuleItem(item)) || itemPathHidden(item, view),
        }),
  };
  const index = loadClaimProvenanceIndex(vault);
  return page.map((event) =>
    event.sample_id === undefined
      ? null
      : resolveClaimProvenanceFromIndex(index, event.sample_id, event.ts, options),
  );
}

/**
 * A receipt item whose recorded path names a page the caller may not
 * read at its reach. An item with no path names no page and stays; an
 * extensionless or wikilink spelling resolves through the same
 * reference grammar the event-row gate uses.
 */
export function itemPathHidden(item: unknown, view: ArtifactRefView): boolean {
  const path = (item as { path?: unknown } | null)?.path;
  return typeof path === "string" && path !== "" && !view.visible(path);
}
