/**
 * The session tools of the recall family (task 3.19):
 * `brain_session_grep`, its coverage view, `brain_session_describe` and
 * `brain_session_expand`, each answering at the caller's reach. Split
 * from `recall-tools.ts`; registration happens through that module's
 * registry, which preserves the public RECALL_TOOLS surface.
 */

import {
  coverageSessionRecall,
  DEFAULT_LIMIT as SESSION_RECALL_DEFAULT_LIMIT,
  decorateSessionRecallHits,
  describeSessionRecall,
  expandSessionRecall,
  searchSessionRecall,
  SessionCoverageEntityUnknownError,
  SessionCoverageInfeasibleError,
} from "../../core/brain/session-recall.ts";
import { MINED_KEY_MAX_LENGTH } from "../../core/brain/link-graph/session-mining.ts";
import { resolveTimeBounds } from "./time-bounds.ts";
import { isPayloadRemotelyReadable } from "../../core/brain/payload-inventory.ts";
import { pageSlice } from "../../core/brain/offset-cursor.ts";
import {
  DEFAULT_PAYLOAD_PAGE_CHARS,
  PayloadNotFoundError,
  PayloadRefError,
  PayloadRegistry,
  payloadIdFromRef,
} from "../../core/brain/payload-registry.ts";
import { TRANSPORT_REACH } from "../../core/graph/transport-reach.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { contextReach } from "../tool-contract.ts";
import type { ServerContext } from "../tool-contract.ts";
import { coercePositiveInteger, optionalStringArg, requiredStringArg } from "./shared.ts";
import { cursorOffsetArg } from "./pagination.ts";
import { unknownOperationError } from "../coerce.ts";

// ----- brain_context_presets ----------------------------------------------

export async function toolBrainSessionGrep(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Coverage-first selection (t_2c2a883c) rides this tool as an explicit
  // operation; omitted (the default) is the historical grep, byte-identical.
  const operation = args["operation"] ?? "match";
  if (operation === "coverage") return toolBrainSessionGrepCoverage(ctx, args);
  if (operation !== "match") {
    // The dispatch contract (surface-error-codes census): every tool whose
    // schema declares a dispatch enum answers an unknown value with the
    // shared `unknown_operation` code, message unchanged.
    throw unknownOperationError("brain_session_grep: operation must be 'match' or 'coverage'");
  }
  if (args["char_budget"] !== undefined) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_session_grep: char_budget is not applicable to operation 'match'; it sizes the coverage selection",
    );
  }
  if (args["entity_key"] !== undefined) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_session_grep: entity_key is not applicable to operation 'match'; it seeds the coverage fan-out",
    );
  }
  const limit = coercePositiveInteger("brain_session_grep", "limit", args["limit"]);
  const snippetChars = coercePositiveInteger(
    "brain_session_grep",
    "snippet_chars",
    args["snippet_chars"],
  );
  // Conversation-chronology bounds (S1): `since` / `before` parse through
  // the shared time-range grammar (ISO date/datetime, today/yesterday,
  // <n>h/<n>d/<n>w) via the shared time-bounds wrapper. `before` maps
  // onto the range's inclusive upper edge.
  const since = optionalStringArg("brain_session_grep", args, "since");
  const before = optionalStringArg("brain_session_grep", args, "before");
  const bounds = resolveTimeBounds(since, before);
  // Inline-raw disclosure (C2): opt-in flag inlines the raw captures beside
  // each derived record and stamps an extracted discriminator. Omitted, the
  // response stays byte-identical.
  const includeRaw = args["include_raw"] === true;
  const rawBudgetChars = coercePositiveInteger(
    "brain_session_grep",
    "raw_budget_chars",
    args["raw_budget_chars"],
  );
  // The matches are a deterministic ranked walk (score, then id), so the
  // page is cut here over the full hit set: `total` counts every match
  // across pages and `next_cursor` continues the walk (null when
  // exhausted). Absent `limit`, the page is the historical bounded
  // default (DEFAULT_LIMIT in session-recall.ts) - an unpaginated call
  // used to answer 10 hits, not every hit in the vault.
  //
  // The search below NEVER runs with includeRaw: decoration reads the
  // record set once per hit decorated, so decorating the full match set
  // on every page made a cursor walk O(N^2). The page is cut first and
  // only its items are decorated.
  const offset = cursorOffsetArg("brain_session_grep", args);
  const sessionIdArg = optionalStringArg("brain_session_grep", args, "session_id");
  const hits = searchSessionRecall(ctx.vault, {
    query: requiredStringArg("brain_session_grep", args, "query"),
    ...withheldAtRemoteReach(ctx),
    ...(sessionIdArg !== undefined ? { sessionId: sessionIdArg } : {}),
    limit: Number.MAX_SAFE_INTEGER,
    ...(snippetChars !== undefined ? { snippetChars } : {}),
    ...(bounds.sinceMs !== null ? { sinceMs: bounds.sinceMs } : {}),
    ...(bounds.untilMs !== null ? { untilMs: bounds.untilMs } : {}),
    ...(rawBudgetChars !== undefined ? { rawBudgetChars } : {}),
  });
  const page = pageSlice(hits.hits, offset, limit ?? SESSION_RECALL_DEFAULT_LIMIT);
  if (!includeRaw) {
    return { hits: page.items, total: page.total, next_cursor: page.next_cursor };
  }
  return {
    hits: decorateSessionRecallHits(ctx.vault, page.items, {
      ...withheldAtRemoteReach(ctx),
      ...(sessionIdArg !== undefined ? { sessionId: sessionIdArg } : {}),
      ...(rawBudgetChars !== undefined ? { rawBudgetChars } : {}),
    }),
    total: page.total,
    next_cursor: page.next_cursor,
  };
}

/**
 * The coverage operation of `brain_session_grep` (t_2c2a883c): the
 * coverage-first thread selection over the lineage-scoped record set,
 * fanning out under the adaptive topic budget and the caller's
 * `char_budget`, returning the selected turns chronologically beside the
 * selection diagnostics. The typed floor-violation infeasibility maps to
 * INVALID_PARAMS - a budget that cannot hold the floor-weighted
 * selection is a caller error, named so it can be retried, never a
 * silent truncation.
 */
export function toolBrainSessionGrepCoverage(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (args["query"] !== undefined) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_session_grep: operation 'coverage' selects whole topics; it takes no `query`",
    );
  }
  for (const inapplicable of [
    "since",
    "before",
    "limit",
    "snippet_chars",
    "include_raw",
    "raw_budget_chars",
    "cursor",
  ] as const) {
    if (args[inapplicable] !== undefined) {
      throw new MCPError(
        INVALID_PARAMS,
        `brain_session_grep: ${inapplicable} is not applicable to operation 'coverage'; it pages, sizes or filters the match operation`,
      );
    }
  }
  const charBudget = coercePositiveInteger(
    "brain_session_grep",
    "char_budget",
    args["char_budget"],
  );
  if (charBudget === undefined) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_session_grep: char_budget is required for the coverage operation",
    );
  }
  const sessionId = optionalStringArg("brain_session_grep", args, "session_id");
  // The miner's own cap: mined keys run to MINED_KEY_MAX_LENGTH, so a
  // 129-200 character URL or path key must be able to seed coverage here.
  const entityKey = optionalStringArg(
    "brain_session_grep",
    args,
    "entity_key",
    MINED_KEY_MAX_LENGTH,
  );
  let result;
  try {
    result = coverageSessionRecall(ctx.vault, {
      ...withheldAtRemoteReach(ctx),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(entityKey !== undefined ? { entityKey } : {}),
      charBudget,
    });
  } catch (err) {
    if (err instanceof SessionCoverageInfeasibleError) {
      throw new MCPError(INVALID_PARAMS, err.message);
    }
    if (err instanceof SessionCoverageEntityUnknownError) {
      throw new MCPError(INVALID_PARAMS, err.message);
    }
    throw err;
  }
  return { ...result };
}

/**
 * Private continuity rows are session data a remote caller does not get:
 * the recall tools answer about them exactly as about a row that does not
 * exist. A local caller keeps every row.
 */
export function withheldAtRemoteReach(ctx: ServerContext): { withholdPrivate?: true } {
  return contextReach(ctx) === TRANSPORT_REACH.local ? {} : { withholdPrivate: true };
}

export async function toolBrainSessionDescribe(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return {
    ...describeSessionRecall(ctx.vault, {
      sessionId: requiredStringArg("brain_session_describe", args, "session_id"),
      ...withheldAtRemoteReach(ctx),
      ...(args["topics"] === true ? { topics: true } : {}),
    }),
  };
}

export async function toolBrainSessionExpand(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const payloadRef = optionalStringArg("brain_session_expand", args, "payload");
  if (payloadRef !== undefined) return expandPayload(ctx, args, payloadRef);
  const rawLimit = coercePositiveInteger("brain_session_expand", "raw_limit", args["raw_limit"]);
  return {
    ...expandSessionRecall(ctx.vault, {
      id: requiredStringArg("brain_session_expand", args, "id"),
      ...withheldAtRemoteReach(ctx),
      ...(rawLimit !== undefined ? { rawLimit } : {}),
      ...(optionalStringArg("brain_session_expand", args, "cursor") !== undefined
        ? { cursor: optionalStringArg("brain_session_expand", args, "cursor") }
        : {}),
    }),
  };
}

/**
 * Page one externalized payload (t_35440e83) - the `payload` mode of
 * `brain_session_expand`.
 *
 * Payloads only ever come out of session import, so expanding a
 * placeholder found in a recalled turn is the same act as expanding the
 * turn: one more level of "give me the exact source". Riding this tool
 * rather than adding one keeps the tool budget and every profile that
 * already carries the session tools unchanged.
 *
 * Reach: a local caller reads any stored payload. A REMOTE caller reads
 * one only when a non-private session turn references it, directly or
 * through another remotely readable payload (`payload-inventory.ts`).
 * Pages grant nothing: a page can be written by tools a session turn
 * cannot. A payload referenced only from a private row or a page, and an
 * orphan nobody references, answer the same refusal, so a remote caller
 * cannot use the difference to probe what exists.
 */
export function expandPayload(
  ctx: ServerContext,
  args: Record<string, unknown>,
  ref: string,
): Record<string, unknown> {
  if (args["id"] !== undefined || args["raw_limit"] !== undefined) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_session_expand: `payload` pages one payload ref; it cannot be combined with `id` or `raw_limit`",
    );
  }
  let sha256: string;
  try {
    sha256 = payloadIdFromRef(ref);
  } catch (err) {
    if (err instanceof PayloadRefError) throw new MCPError(INVALID_PARAMS, err.message);
    throw err;
  }
  if (
    contextReach(ctx) !== TRANSPORT_REACH.local &&
    !isPayloadRemotelyReadable(ctx.vault, sha256)
  ) {
    throw new MCPError(
      INVALID_PARAMS,
      `brain_session_expand: payload ${ref} is not readable at remote reach - no non-private ` +
        "session turn references it",
    );
  }
  const cursor = optionalStringArg("brain_session_expand", args, "cursor");
  const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
  if (cursor !== undefined && (!/^[0-9]+$/.test(cursor) || !Number.isFinite(offset))) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_session_expand: a payload cursor is the next_cursor of a previous page",
    );
  }
  const limit =
    coercePositiveInteger("brain_session_expand", "payload_chars", args["payload_chars"]) ??
    DEFAULT_PAYLOAD_PAGE_CHARS;
  try {
    const page = new PayloadRegistry({ vault: ctx.vault, maxInlineChars: 1 }).get(ref, {
      offset,
      limit,
    });
    return {
      payload: {
        ref: page.ref,
        offset: page.offset,
        limit: page.limit,
        total_chars: page.totalChars,
        content: page.content,
      },
      next_cursor: page.nextOffset === null ? null : String(page.nextOffset),
    };
  } catch (err) {
    if (err instanceof PayloadNotFoundError) throw new MCPError(INVALID_PARAMS, err.message);
    throw err;
  }
}

// ----- brain_pre_compress_pack (v0.20.0) -----------------------------------
