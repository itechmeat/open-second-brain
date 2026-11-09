/**
 * Decision-record note-family MCP tool (Belief lifecycle suite, Track B
 * anchor, t_ac03214d; open-decision vault added by the write-side-trust
 * wave, Task 10).
 *
 * One tool, `brain_decision`, dispatching on `action`:
 *   - `record`   capture a `type: decision` note + open a review obligation
 *   - `outcome`  backfill the hindsight outcome of an existing decision
 *   - `show`     read one decision
 *   - `list`     list every decision
 *   - `similar`  historically similar decisions with their outcomes
 *   - `open`        park a question with enumerated options
 *   - `list_open`   list parked questions by status, unreadable named
 *   - `show_open`   read one parked question
 *   - `resolve`     choose an option: mints the real decision page
 *   - `discard`     close a parked question without deciding
 *
 * MCP mirror of the `o2b brain decision` CLI verb; both delegate to the
 * core decision module so the on-disk shape cannot drift.
 */

import {
  backfillOutcome,
  compareDecisions,
  findSimilarDecisions,
  listDecisions,
  listRatedDecisions,
  recordDecision,
  showDecision,
  updateRating,
  DecisionError,
} from "../../core/brain/decisions/record.ts";
import {
  discardOpenDecision,
  isOpenDecisionStatus,
  listOpenDecisions,
  OPEN_DECISION_STATUSES,
  OPEN_DECISION_STATUS,
  OpenDecisionError,
  openDecision,
  resolveOpenDecision,
  showOpenDecision,
} from "../../core/brain/decisions/open-store.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import {
  coerceBool,
  coerceInt,
  coerceStr,
  coerceStrList,
  unknownOperationError,
} from "../coerce.ts";
import { wrapToolErrors } from "./shared.ts";
import { DECISION_RATING_MAX, DECISION_RATING_MIN } from "../../core/brain/decisions/record.ts";
import { BRAIN_COMMITMENT_TIER, type BrainCommitmentTier } from "../../core/brain/types.ts";
import {
  queryDecisionChangeHistory,
  ReceiptError,
  DECISION_HISTORY_DEFAULT_LIMIT,
} from "../../core/brain/decisions/receipts.ts";
import { recallRatedDecisions } from "../../core/brain/decisions/recall.ts";
import { everyArtifactRefView } from "../../core/brain/artifact-ref-view.ts";
import { gatedOwnerScopeView } from "../../core/brain/owner-scope-view.ts";
import { reachView } from "../../core/brain/reach-view.ts";
import { contextReach } from "../tool-contract.ts";
import { readableAtContextReachOrUndefined } from "./reach-readable.ts";
import { BRAIN_DECISIONS_REL } from "../../core/brain/path-constants.ts";
import { deliveryView } from "./reach-events.ts";
import { laneVault } from "./lane-vault.ts";

const TOOL = "brain_decision";

/**
 * The vault-relative page one decision or open-decision record was parsed
 * from - the probe target whose provenance governs the delivery of the
 * record's page-derived text (delivery-trust, lane A).
 */
function decisionDeliveryRel(id: string): string {
  return `${BRAIN_DECISIONS_REL}/${id}.md`;
}

/**
 * Shape one page-derived field through the request's delivery binding
 * (delivery-trust, lane A). Empty text has nothing to fence and stays
 * byte-identical to an absent value; at local reach the binding's shape
 * is the identity, so the pre-wave bytes pass through untouched.
 */
function shapeField(
  delivery: ReturnType<typeof deliveryView>,
  rel: string,
  value: unknown,
): unknown {
  if (typeof value !== "string" || value.length === 0) return value;
  return delivery.shape(value, rel);
}

async function toolBrainDecision(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return wrapToolErrors(TOOL, [DecisionError, ReceiptError, OpenDecisionError], async () => {
    const action = coerceStr(args, "action", true)!;
    // A record-lane tool works with no vault: its pages are store records then.
    const vault = laneVault(ctx);
    const agent = coerceStr(args, "agent", false) ?? undefined;
    // A decision page the caller cannot read at its reach is answered as
    // an absent one by every action: skipped by the lists, refused by the
    // single-slug reads and writes with the absent slug's error.
    const readable = readableAtContextReachOrUndefined(ctx);
    const reads = readable !== undefined ? { readable } : {};
    // The delivery binding (delivery-trust, lane A): one reach resolution
    // and one frontmatter cache for every page-derived field this response
    // carries. Local reach shapes nothing; remote reach fences the stored
    // free text through the K1 shaper, naming the record page's derived
    // provenance. Write echoes of caller-authored values and the
    // change-history ledger's prefixed state grammar stay untouched.
    const delivery = deliveryView(ctx);

    switch (action) {
      case "record": {
        const title = coerceStr(args, "title", true)!;
        const chosen = coerceStr(args, "chosen", true)!;
        const assumption = coerceStr(args, "assumption", true)!;
        const reviewDate = coerceStr(args, "review_date", true)!;
        const premortem = coerceStr(args, "premortem", false) ?? undefined;
        const notes = coerceStr(args, "notes", false) ?? undefined;
        const rating =
          args["rating"] === undefined
            ? undefined
            : coerceInt(
                args,
                "rating",
                DECISION_RATING_MIN,
                DECISION_RATING_MIN,
                DECISION_RATING_MAX,
              );
        const rationale = coerceStr(args, "rationale", false) ?? undefined;
        const commitment = coerceStr(args, "commitment", false) ?? undefined;
        const res = recordDecision(vault, {
          title,
          chosen,
          assumption,
          reviewDate,
          ...(premortem ? { premortem } : {}),
          ...(notes ? { notes } : {}),
          ...(rating !== undefined ? { rating } : {}),
          ...(rationale ? { rationale } : {}),
          ...(commitment ? { commitment: commitment as BrainCommitmentTier } : {}),
          agent: agent ?? "",
        });
        return {
          action,
          id: res.record.id,
          slug: res.record.slug,
          review_date: res.record.reviewDate,
          review_obligation: res.reviewObligationSlug,
          obligation_created: res.obligationCreated,
        };
      }
      case "rate": {
        const slug = coerceStr(args, "slug", true)!;
        const rating = coerceInt(
          args,
          "rating",
          DECISION_RATING_MIN,
          DECISION_RATING_MIN,
          DECISION_RATING_MAX,
        );
        const rationale = coerceStr(args, "rationale", false) ?? undefined;
        const res = updateRating(vault, {
          ...reads,
          slug,
          rating,
          ...(rationale ? { rationale } : {}),
          ...(agent ? { agent } : {}),
        });
        return { action, id: res.id, slug: res.slug, rating: res.rating, rationale: res.rationale };
      }
      case "compare": {
        const slugs = coerceStrList(args, "slugs");
        const rows = compareDecisions(vault, slugs, reads);
        return {
          action,
          decisions: rows.map((d) => {
            const rel = decisionDeliveryRel(d.id);
            return {
              id: d.id,
              slug: d.slug,
              title: d.title,
              chosen: d.chosen,
              rating: d.rating,
              rationale: shapeField(delivery, rel, d.rationale),
              outcome: shapeField(delivery, rel, d.outcome),
            };
          }),
        };
      }
      case "outcome": {
        const slug = coerceStr(args, "slug", true)!;
        const outcome = coerceStr(args, "outcome", true)!;
        const res = backfillOutcome(vault, {
          ...reads,
          slug,
          outcome,
          ...(agent ? { agent } : {}),
        });
        return { action, id: res.id, slug: res.slug, outcome: res.outcome };
      }
      case "show": {
        const slug = coerceStr(args, "slug", true)!;
        const res = showDecision(vault, slug, reads);
        if (res === null) throw new DecisionError(`no decision: ${slug}`);
        const rel = decisionDeliveryRel(res.id);
        return {
          action,
          id: res.id,
          slug: res.slug,
          title: res.title,
          chosen: res.chosen,
          assumption: shapeField(delivery, rel, res.assumption),
          review_date: res.reviewDate,
          outcome: shapeField(delivery, rel, res.outcome),
          premortem: shapeField(delivery, rel, res.premortem),
          // Commitment tier (B3): emitted only when set so an unset
          // decision stays byte-identical to a pre-B3 response.
          ...(res.commitment !== null ? { commitment: res.commitment } : {}),
        };
      }
      case "list": {
        const ratedOnly = coerceBool(args, "rated");
        const all = ratedOnly ? listRatedDecisions(vault, reads) : listDecisions(vault, reads);
        return {
          action,
          decisions: all.map((d) => ({
            id: d.id,
            slug: d.slug,
            title: d.title,
            chosen: d.chosen,
            rating: d.rating,
            review_date: d.reviewDate,
            outcome: shapeField(delivery, decisionDeliveryRel(d.id), d.outcome),
            ...(d.commitment !== null ? { commitment: d.commitment } : {}),
          })),
        };
      }
      case "recall": {
        const prompt = coerceStr(args, "prompt", true)!;
        const turn = args["turn"] === undefined ? 0 : coerceInt(args, "turn", 0, 0, 1_000_000);
        const count = args["count"] === undefined ? 0 : coerceInt(args, "count", 0, 0, 1_000_000);
        const lastTurnRaw = args["last_turn"];
        const lastTurn =
          lastTurnRaw === undefined || lastTurnRaw === null
            ? null
            : coerceInt(args, "last_turn", 0, 0, 1_000_000);
        const surfacedIds = coerceStrList(args, "surfaced_ids");
        const res = recallRatedDecisions(vault, {
          ...reads,
          prompt,
          turn,
          state: {
            surfacedIds,
            lastTurn,
            count: count || surfacedIds.length,
          },
        });
        return {
          action,
          enabled: res.enabled,
          surfaced: res.surfaced
            ? { id: res.surfaced.id, slug: res.surfaced.slug, rating: res.surfaced.rating }
            : null,
          // The verbatim recall block renders the surfaced decision page's
          // text, so it fences whole through the surfaced record's page.
          text: shapeField(
            delivery,
            res.surfaced !== null ? decisionDeliveryRel(res.surfaced.id) : "",
            res.text,
          ),
          state: {
            surfaced_ids: res.state.surfacedIds,
            last_turn: res.state.lastTurn,
            count: res.state.count,
          },
        };
      }
      case "history": {
        const subject = coerceStr(args, "subject", false) ?? undefined;
        const cursor = coerceStr(args, "cursor", false) ?? undefined;
        const limit =
          args["limit"] === undefined
            ? DECISION_HISTORY_DEFAULT_LIMIT
            : coerceInt(args, "limit", DECISION_HISTORY_DEFAULT_LIMIT, 1, 500);
        // A receipt names its subject by decision id, page path or record
        // id; one naming a page the caller cannot read is dropped before
        // the total and the page are taken.
        const view = everyArtifactRefView(
          gatedOwnerScopeView(vault, ctx.agentName),
          reachView(vault, contextReach(ctx)),
        );
        const page = queryDecisionChangeHistory(vault, {
          ...(view.filtersNothing ? {} : { keep: (r) => view.visible(r.subject) }),
          ...(subject ? { subject } : {}),
          ...(cursor ? { cursor } : {}),
          limit,
        });
        return {
          action,
          total: page.total,
          next_cursor: page.nextCursor,
          receipts: page.receipts.map((r) => ({
            ts: r.ts,
            subject: r.subject,
            before: r.before,
            after: r.after,
            confidence_delta: r.confidence_delta,
            reason_code: r.reason_code,
            actor: r.actor,
            idempotency_key: r.idempotency_key,
          })),
        };
      }
      case "similar": {
        const title = coerceStr(args, "title", true)!;
        const chosen = coerceStr(args, "chosen", false) ?? undefined;
        const hits = findSimilarDecisions(
          vault,
          {
            title,
            ...(chosen ? { chosen } : {}),
          },
          reads,
        );
        return {
          action,
          similar: hits.map((h) => ({
            id: h.id,
            slug: h.slug,
            title: h.title,
            outcome: shapeField(delivery, decisionDeliveryRel(h.id), h.outcome),
            jaccard: h.jaccard,
          })),
        };
      }
      case "open": {
        const title = coerceStr(args, "title", true)!;
        const question = coerceStr(args, "question", true)!;
        const options = coerceStrList(args, "options");
        const context = coerceStr(args, "context", false) ?? undefined;
        const res = openDecision(vault, {
          title,
          question,
          options,
          ...(context ? { context } : {}),
          ...(agent ? { agent } : {}),
        });
        return {
          action,
          id: res.id,
          slug: res.slug,
          status: res.status,
          options: res.options.length,
        };
      }
      case "list_open": {
        const statusRaw = coerceStr(args, "status", false) ?? undefined;
        if (statusRaw !== undefined && !isOpenDecisionStatus(statusRaw)) {
          throw new OpenDecisionError(
            `brain_decision: 'status' must be one of ${OPEN_DECISION_STATUSES.join(", ")}`,
          );
        }
        const listed = listOpenDecisions(vault, {
          ...(statusRaw !== undefined ? { status: statusRaw } : {}),
          ...reads,
        });
        return {
          action,
          open_decisions: listed.records.map((r) => ({
            id: r.id,
            slug: r.slug,
            title: r.title,
            question: shapeField(delivery, decisionDeliveryRel(r.id), r.question),
            status: r.status,
            options: [...r.options],
            created_at: r.createdAt,
          })),
          unreadable: listed.unreadable,
        };
      }
      case "show_open": {
        const id = coerceStr(args, "id", true)!;
        const res = showOpenDecision(vault, id, reads);
        if (res === null) throw new OpenDecisionError(`no open decision: ${id}`);
        const rel = decisionDeliveryRel(res.id);
        return {
          action,
          id: res.id,
          slug: res.slug,
          title: res.title,
          question: shapeField(delivery, rel, res.question),
          options: [...res.options],
          context: shapeField(delivery, rel, res.context),
          status: res.status,
          created_at: res.createdAt,
          resolved_at: res.resolvedAt,
          discarded_at: res.discardedAt,
          choice: res.choice,
          decision: res.decision,
          discard_reason: shapeField(delivery, rel, res.discardReason),
        };
      }
      case "resolve": {
        const id = coerceStr(args, "id", true)!;
        const choice = coerceStr(args, "choice", true)!;
        const rationale = coerceStr(args, "rationale", false) ?? undefined;
        // Reach boundary: a record below the caller's reach is answered
        // exactly like an absent one, before anything is written - the
        // same predicate rate and outcome answer their reads with.
        if (showOpenDecision(vault, id, reads) === null) {
          throw new OpenDecisionError(`no open decision: ${id}`);
        }
        const res = resolveOpenDecision(vault, id, {
          choice,
          ...(rationale ? { rationale } : {}),
          ...(agent ? { actor: agent } : {}),
        });
        return { action, id, decision: res.decision };
      }
      case "discard": {
        const id = coerceStr(args, "id", true)!;
        const reason = coerceStr(args, "reason", true)!;
        // Reach boundary: same as resolve - a below-reach id is an
        // absent id, with no existence leak.
        if (showOpenDecision(vault, id, reads) === null) {
          throw new OpenDecisionError(`no open decision: ${id}`);
        }
        discardOpenDecision(vault, id, {
          reason,
          ...(agent ? { actor: agent } : {}),
        });
        return { action, id, status: OPEN_DECISION_STATUS.discarded };
      }
      default:
        throw unknownOperationError(
          `${TOOL}: 'action' must be one of record, outcome, rate, show, list, compare, similar, history, recall, open, list_open, show_open, resolve, discard`,
        );
    }
  });
}

export const DECISIONS_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: TOOL,
    kind: "write",
    description:
      "Decision tool. record captures a decision note (chosen, assumption, review date); outcome backfills it; rate rates it; show, list, compare and similar read past ones; history reads receipts; recall resurfaces a rated one; open parks a question with its options; resolve picks one; discard closes it.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "record",
            "outcome",
            "rate",
            "show",
            "list",
            "compare",
            "similar",
            "history",
            "recall",
            "open",
            "list_open",
            "show_open",
            "resolve",
            "discard",
          ],
          description: "Which decision operation to run.",
        },
        title: {
          type: "string",
          description:
            "record/similar: the decision question / statement. open: short label driving " +
            "the open-decision id; non-ASCII titles hash to unnamed-<hash>.",
        },
        chosen: {
          type: "string",
          description: "record: the chosen option. similar: optional chosen-option hint.",
        },
        assumption: {
          type: "string",
          description: "record: the key assumption the decision rides on.",
        },
        review_date: {
          type: "string",
          description: "record: review date (YYYY-MM-DD); opens one review obligation.",
        },
        premortem: {
          type: "string",
          description: "record: optional pre-mortem (how could this go wrong).",
        },
        notes: { type: "string", description: "record: optional free-form body notes." },
        slug: { type: "string", description: "outcome/rate/show: decision slug." },
        outcome: { type: "string", description: "outcome: hindsight outcome to backfill." },
        rating: {
          type: "integer",
          minimum: DECISION_RATING_MIN,
          maximum: DECISION_RATING_MAX,
          description: `record/rate: quality rating in [${DECISION_RATING_MIN}, ${DECISION_RATING_MAX}].`,
        },
        rationale: { type: "string", description: "record/rate: justification for the rating." },
        commitment: {
          type: "string",
          enum: Object.values(BRAIN_COMMITMENT_TIER),
          description: "record: optional commitment tier (exploring|leaning|decided|locked).",
        },
        rated: {
          type: "boolean",
          description: "list: return only rated decisions, sorted by rating.",
        },
        slugs: {
          type: "array",
          items: { type: "string" },
          description: "compare: decision slugs to read side by side.",
        },
        subject: {
          type: "string",
          description: "history: filter decision-change receipts to one subject id.",
        },
        cursor: { type: "string", description: "history: opaque cursor from a prior page." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "history: page size (default 50).",
        },
        prompt: { type: "string", description: "recall: the incoming prompt to match." },
        question: {
          type: "string",
          description:
            "open: the full question being parked. Dedup key: a twin with an open record " +
            "refuses; the same wording may re-park after it resolves or discards.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "open: the enumerated options to choose between at resolve time.",
        },
        context: {
          type: "string",
          description: "open: optional background prose stored with the question.",
        },
        status: {
          type: "string",
          enum: Object.values(OPEN_DECISION_STATUS),
          description: "list_open: filter by lifecycle status.",
        },
        id: {
          type: "string",
          description: "show_open/resolve/discard: the open-decision id (open-<slug>).",
        },
        choice: {
          type: "string",
          description: "resolve: the chosen option; must be one of the record's options.",
        },
        reason: {
          type: "string",
          description: "discard: why the question is closed without a decision.",
        },
        turn: {
          type: "integer",
          minimum: 0,
          description: "recall: monotonic turn index (spacing).",
        },
        surfaced_ids: {
          type: "array",
          items: { type: "string" },
          description: "recall: decision ids already surfaced this session.",
        },
        last_turn: {
          type: "integer",
          minimum: 0,
          description: "recall: turn of the last recall (spacing state).",
        },
        count: { type: "integer", minimum: 0, description: "recall: recalls surfaced so far." },
        agent: {
          type: "string",
          description: "Optional agent identity override; defaults to the server-resolved name.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainDecision,
  },
]);
