/**
 * The agent-attribution and provenance tools of the query family (task
 * 3.19): `brain_agent_diff`, `brain_backlinks`, `brain_audit` and
 * `brain_sources`, with the contribution-kind and diff-mode coercion
 * they share. Split from `query-tools.ts`; registration happens through
 * that module's registry, which preserves the public QUERY_TOOLS
 * surface.
 */

import { buildBacklinkIndex } from "../../core/brain/backlinks.ts";
import { gatedOwnerScopeView } from "../../core/brain/owner-scope-view.ts";
import { readPrefAudit } from "../../core/brain/pref-audit.ts";
import { aggregateSources } from "../../core/brain/portability/sources.ts";
import { brainArtifactSlug, normaliseWikilinkTarget } from "../../core/brain/wikilink.ts";
import { diffAgentSources, type AgentSourceDiffMode } from "../../core/brain/agent-source/diff.ts";
import {
  AGENT_SOURCE_CONTRIBUTION_KINDS,
  isAgentSourceContributionKind,
  type AgentSourceContributionKind,
} from "../../core/brain/agent-source/types.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { contextReach } from "../tool-contract.ts";
import type { ServerContext } from "../tool-contract.ts";
import { coerceStr, coerceStrList, coerceInt } from "../coerce.ts";
import { reachView } from "../../core/brain/reach-view.ts";
import { recordRefs } from "../../core/brain/log-events-at-reach.ts";
import { pageSlice } from "../../core/brain/offset-cursor.ts";
import { deliveryView, recordReadable, requestRefView } from "./reach-events.ts";
import { TRANSPORT_REACH } from "../../core/graph/transport-reach.ts";
import { cursorOffsetArg } from "./pagination.ts";
import { shapeContribution } from "./query-serialize.ts";

export async function toolBrainAgentDiff(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const mode = coerceAgentDiffMode(args, "mode");
  const topic = coerceStr(args, "topic", false);
  const query = coerceStr(args, "query", false);
  const kind = coerceAgentContributionKind(args, "kind");
  // The twin of `brain_agent_query` over the same provenance fold, and
  // it returns the same contribution rows - ids, topics and the record
  // text. `brain_agent_query` honours an explicit `agent_scope`; this
  // tool declares no such argument, so it takes the GATED server
  // identity, which is `null` unless the operator set
  // `integrity.owner_scope_delivery: fail` (a-label-is-not-a-boundary, U3).
  const ownerScope = gatedOwnerScopeView(ctx.vault, ctx.agentName).scope;
  const limit = coerceInt(args, "limit", 50, 1, 500);
  const offset = cursorOffsetArg("brain_agent_diff", args);
  // Like `brain_agent_query`, the page is cut at this layer: the core
  // fold slices from the first match, so the full matched set is fetched
  // and one offset window is taken. The aggregates (per-agent rollup,
  // topic map, shared/unique topics) are computed over the whole matched
  // set, so they do not move between pages: the limit bounds the
  // returned contributions and the paging, never the comparison.
  const result = diffAgentSources(ctx.vault, {
    ...(mode !== null ? { mode } : {}),
    ...(ownerScope !== null ? { ownerScope } : {}),
    view: reachView(ctx.vault, contextReach(ctx)),
    agents: coerceStrList(args, "agents"),
    ...(topic !== null ? { topic } : {}),
    ...(query !== null ? { query } : {}),
    ...(kind !== null ? { kind } : {}),
    limit: Number.MAX_SAFE_INTEGER,
  });
  const page = pageSlice(result.contributions, offset, limit);
  // Delivery shaping (delivery-trust, lane A): the same rule the twin
  // query tool applies, through the request's one binding.
  const delivery = deliveryView(ctx);
  return {
    mode: result.mode,
    diff_mode: result.diff_mode,
    agents: result.agents,
    unknown_agents: result.unknown_agents,
    per_agent: result.per_agent,
    shared_topics: result.shared_topics,
    unique_topics: result.unique_topics,
    topic_map: result.topic_map,
    total_matched: result.total_matched,
    returned: page.items.length,
    contributions: page.items.map((c) => shapeContribution(delivery, ctx.vault, c)),
    summary: result.summary,
    next_cursor: page.next_cursor,
  };
}

export function coerceAgentContributionKind(
  args: Record<string, unknown>,
  key: string,
): AgentSourceContributionKind | null {
  const raw = coerceStr(args, key, false);
  if (raw === null) return null;
  if (!isAgentSourceContributionKind(raw)) {
    throw new MCPError(
      INVALID_PARAMS,
      `argument '${key}' must be one of ${AGENT_SOURCE_CONTRIBUTION_KINDS.join(", ")}`,
    );
  }
  return raw;
}

export function coerceAgentDiffMode(
  args: Record<string, unknown>,
  key: string,
): AgentSourceDiffMode | null {
  const raw = coerceStr(args, key, false);
  if (raw === null) return null;
  if (raw !== "browse" && raw !== "search" && raw !== "diff" && raw !== "map") {
    throw new MCPError(
      INVALID_PARAMS,
      `argument '${key}' must be 'browse', 'search', 'diff', or 'map'`,
    );
  }
  return raw;
}

// ----- brain_backlinks -----------------------------------------------------

export async function toolBrainBacklinks(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = coerceStr(args, "id", true)!;
  // The index is keyed by normalised wikilink targets. Run callers'
  // input through the same normaliser so `pref-foo`, `[[pref-foo]]`,
  // `[[pref-foo|Alias]]`, and `Brain/preferences/pref-foo.md` all
  // resolve to the same lookup.
  const target = normaliseWikilinkTarget(id);
  // The refs name the artifacts that WROTE them, so an unscoped index
  // published another owner's preference and retired ids to any caller
  // (a-label-is-not-a-boundary, U3). The scope is the gated one: no
  // argument exists on this tool, and under `off` the view hides nothing.
  const index = buildBacklinkIndex(ctx.vault, gatedOwnerScopeView(ctx.vault, ctx.agentName).scope, {
    withholdsPrivate: contextReach(ctx) !== TRANSPORT_REACH.local,
  });
  // The same reasoning one rule over: a ref names the artifact that WROTE
  // it, so an index unfiltered by reach publishes the id of a page
  // reserved against remote reads. A withheld TARGET answers as an absent
  // one - the empty backlink document - rather than refusing, because an
  // unknown target is a legitimate zero here and a refusal would be the
  // one response shape that proves the page exists.
  //
  // The target is asked under every spelling its record answers to, so a
  // retired record (on disk only as `ret-x`) asked for as `pref-x` is the
  // reserved page it is, not an absent one whose log backlinks are listed.
  const view = reachView(ctx.vault, contextReach(ctx));
  const refs = view.row(...recordRefs(target))
    ? (index.get(target) ?? []).filter((r) => view.visible(r.source))
    : [];
  const unparsed = index.unparsed
    .filter((u) => view.visible(u.source))
    .map((u) => ({ source: u.source, source_kind: u.sourceKind, reason: u.reason }));
  return {
    id: target,
    count: refs.length,
    refs: refs.map((r) => ({
      source: r.source,
      source_kind: r.sourceKind,
      field: r.field,
      ...(r.timestamp !== undefined ? { timestamp: r.timestamp } : {}),
    })),
    // A `count` beside a non-empty `unparsed` is not a measurement: the
    // walk skipped artifacts whose references it could not read, and a
    // caller told only the count would read a legacy vault's zero as a
    // genuine zero. Omitted entirely when the walk is clean, so a healthy
    // vault's payload is byte-identical.
    //
    // Filtered by the same rule the refs are. Each entry NAMES its source
    // artifact by id, so an unfiltered list disclosed a reserved page's id
    // through a call that never mentioned it - and the honesty this field
    // exists for does not extend to being honest about pages the caller
    // may not know exist.
    ...(unparsed.length > 0 ? { unparsed } : {}),
  };
}

export async function toolBrainAudit(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const raw = coerceStr(args, "pref_id", true)!;
  // The trail is keyed by the original `pref-<slug>` id, and the shared
  // fold in `wikilink.ts` is what reduces every spelling of a reference
  // (`[[id]]`, `[[id|Alias]]`, `Brain/.../id.md`, and the pre- or
  // post-retirement prefix) onto that one key.
  const slug = brainArtifactSlug(raw);
  if (slug.length === 0) {
    throw new Error(`brain_audit: empty preference slug after normalising '${raw}'`);
  }
  const prefId = `pref-${slug}`;
  // The mutation history is the trail of a private page and is private
  // with it, so it is read only when the preference's page is one this
  // caller may see: the same view every sibling reader asks, over every
  // spelling the record answers to. A withheld trail answers as an absent
  // one - the empty history - never as a refusal that would prove the id.
  if (!recordReadable(requestRefView(ctx), prefId)) {
    return { pref_id: prefId, count: 0, records: [], warnings: [] };
  }
  const { records, warnings } = readPrefAudit(ctx.vault, prefId);
  return {
    pref_id: prefId,
    count: records.length,
    records,
    warnings: warnings.map((w) => w.message),
  };
}

export async function toolBrainSources(
  ctx: ServerContext,
  _args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  void _args;
  const report = aggregateSources(ctx.vault);
  return {
    sources: report.sources,
    total_active: report.total_active,
    total_processed: report.total_processed,
    total_archived: report.total_archived,
  };
}
