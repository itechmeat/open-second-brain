/**
 * `brain_unlinked_mentions` (task 3.19): the scanner that names vault
 * pages a record's text touches without a link, with the source-page
 * resolution its payload names. Split from `query-tools.ts`;
 * registration happens through that module's registry, which preserves
 * the public QUERY_TOOLS surface.
 */

import { gatedOwnerScopeView } from "../../core/brain/owner-scope-view.ts";
import { findUnlinkedMentions } from "../../core/brain/link-graph/unlinked-mentions.ts";
import { normaliseWikilinkTarget } from "../../core/brain/wikilink.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { contextReach } from "../tool-contract.ts";
import type { ServerContext } from "../tool-contract.ts";
import { vaultPathField } from "../vault-path-field.ts";
import { reachView } from "../../core/brain/reach-view.ts";
import { pageSlice } from "../../core/brain/offset-cursor.ts";
import { BRAIN_PREFERENCES_REL, BRAIN_RETIRED_REL } from "../../core/brain/path-constants.ts";
import { deliveryView, memoryPageRelIn, UNPROBED_DELIVERY_REL } from "./reach-events.ts";
import { cursorOffsetArg } from "./pagination.ts";

// ----- brain_unlinked_mentions ------------------------------------------------

/** Page size when no `limit` is sent: the core scanner's own default. */
export const UNLINKED_MENTIONS_DEFAULT_LIMIT = 100;

/**
 * Raw-text mentions of a target's title / aliases that are NOT
 * already inside `[[...]]` wikilinks. Read-only walker over
 * `Brain/preferences/` and `Brain/retired/`. Match boundary is
 * Unicode-aware (`\p{L}`, `\p{N}`), language-agnostic.
 */
export async function toolBrainUnlinkedMentions(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const idRaw = args["id"];
  if (typeof idRaw !== "string" || idRaw.trim().length === 0) {
    throw new MCPError(INVALID_PARAMS, "brain_unlinked_mentions: id must be a non-empty string");
  }
  const targetId = normaliseWikilinkTarget(idRaw);
  const offset = cursorOffsetArg("brain_unlinked_mentions", args);
  // Limit coercion mirrors the v0.10.16 `brain_operator_summary`
  // precedent: accept either a number or a strict integer-literal
  // string (`"5"` ok; `"abc"`, `"3abc"`, `"2.5"` rejected). This
  // keeps the MCP boundary uniform across new tools.
  const limitRaw = args["limit"];
  let limit: number | undefined;
  if (limitRaw !== undefined && limitRaw !== null) {
    if (typeof limitRaw === "number") {
      if (!Number.isInteger(limitRaw) || limitRaw < 1) {
        throw new MCPError(
          INVALID_PARAMS,
          "brain_unlinked_mentions: limit must be a positive integer",
        );
      }
      limit = limitRaw;
    } else if (typeof limitRaw === "string") {
      const trimmed = limitRaw.trim();
      if (trimmed === "" || !/^[0-9]+$/.test(trimmed)) {
        throw new MCPError(
          INVALID_PARAMS,
          "brain_unlinked_mentions: limit must be a positive integer",
        );
      }
      const parsed = Number.parseInt(trimmed, 10);
      if (parsed < 1) {
        throw new MCPError(
          INVALID_PARAMS,
          "brain_unlinked_mentions: limit must be a positive integer",
        );
      }
      limit = parsed;
    } else {
      throw new MCPError(
        INVALID_PARAMS,
        "brain_unlinked_mentions: limit must be a positive integer",
      );
    }
  }
  // `context` is the source artifact's own line of prose, so an
  // unscoped scan republished an owner-private body (U3, recon C3).
  // The scanner early-exits one mention past the page's reach
  // (`offset + limit + 1`): the lookahead proves whether a next page
  // exists, so `next_cursor` never lies and the full visible set stays
  // reachable by walking, while one page fetch never rescans the
  // directory walk past its own reach. (The cursor rollout replaced the
  // scanner's caller cap with `MAX_SAFE_INTEGER`, which made every page
  // fetch re-walk every preference and retired file - a quadratic walk
  // under forged cursors; the bound restores the early exit without
  // reintroducing silent truncation.) `total` is exact once the walk
  // exhausts; before that it reports the bound the page reached.
  const pageSize = limit ?? UNLINKED_MENTIONS_DEFAULT_LIMIT;
  const mentions = findUnlinkedMentions(ctx.vault, targetId, {
    limit: offset + pageSize + 1,
    ownerScope: gatedOwnerScopeView(ctx.vault, ctx.agentName).scope,
    reachView: reachView(ctx.vault, contextReach(ctx)),
  });
  const page = pageSlice(mentions, offset, pageSize);
  // Each mention's `context` is one line of the source page's own prose
  // (delivery-trust, lane A): shaped through the request's delivery
  // binding at the page the source id was parsed from - asked in the
  // scanner's own walk order (preferences, then retired), so the probe
  // reads the exact page the line came from. An id whose file sits in
  // neither folder probes the guaranteed-absent page: fail closed,
  // never a guessed root page whose stamps could vouch for prose it
  // does not carry. Local reach keeps the bytes.
  const delivery = deliveryView(ctx);
  return {
    vault_path: vaultPathField(ctx),
    target_id: targetId,
    total: page.total,
    mentions: page.items.map((m) => ({
      source: m.source,
      line: m.line,
      term: m.term,
      context: delivery.shape(m.contextSnippet, mentionSourceRel(ctx.vault, m.source)),
    })),
    next_cursor: page.next_cursor,
  };
}

/**
 * The page a mention's source id was parsed from: the scanner walks the
 * preferences folder then the retired one, so the same walk order
 * answers which of the two holds the file, and an id whose file is in
 * neither probes the guaranteed-absent page.
 */
export function mentionSourceRel(vault: string, id: string): string {
  return (
    memoryPageRelIn(vault, id, [BRAIN_PREFERENCES_REL, BRAIN_RETIRED_REL]) ?? UNPROBED_DELIVERY_REL
  );
}

// ----- brain_foresight (t_08a79c81) -----------------------------------------
