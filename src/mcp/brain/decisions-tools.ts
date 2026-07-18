/**
 * Decision-record note-family MCP tool (Belief lifecycle suite, Track B
 * anchor, t_ac03214d).
 *
 * One tool, `brain_decision`, dispatching on `action`:
 *   - `record`   capture a `type: decision` note + open a review obligation
 *   - `outcome`  backfill the hindsight outcome of an existing decision
 *   - `show`     read one decision
 *   - `list`     list every decision
 *   - `similar`  historically similar decisions with their outcomes
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
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { coerceBool, coerceInt, coerceStr, coerceStrList } from "../coerce.ts";
import { wrapToolErrors } from "./shared.ts";
import { DECISION_RATING_MAX, DECISION_RATING_MIN } from "../../core/brain/decisions/record.ts";
import { BRAIN_COMMITMENT_TIER, type BrainCommitmentTier } from "../../core/brain/types.ts";

const TOOL = "brain_decision";

async function toolBrainDecision(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return wrapToolErrors(TOOL, [DecisionError], async () => {
    const action = coerceStr(args, "action", true)!;
    const agent = coerceStr(args, "agent", false) ?? undefined;

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
        const res = recordDecision(ctx.vault, {
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
        const res = updateRating(ctx.vault, {
          slug,
          rating,
          ...(rationale ? { rationale } : {}),
          ...(agent ? { agent } : {}),
        });
        return { action, id: res.id, slug: res.slug, rating: res.rating, rationale: res.rationale };
      }
      case "compare": {
        const slugs = coerceStrList(args, "slugs");
        const rows = compareDecisions(ctx.vault, slugs);
        return {
          action,
          decisions: rows.map((d) => ({
            id: d.id,
            slug: d.slug,
            title: d.title,
            chosen: d.chosen,
            rating: d.rating,
            rationale: d.rationale,
            outcome: d.outcome,
          })),
        };
      }
      case "outcome": {
        const slug = coerceStr(args, "slug", true)!;
        const outcome = coerceStr(args, "outcome", true)!;
        const res = backfillOutcome(ctx.vault, {
          slug,
          outcome,
          ...(agent ? { agent } : {}),
        });
        return { action, id: res.id, slug: res.slug, outcome: res.outcome };
      }
      case "show": {
        const slug = coerceStr(args, "slug", true)!;
        const res = showDecision(ctx.vault, slug);
        if (res === null) throw new DecisionError(`no decision: ${slug}`);
        return {
          action,
          id: res.id,
          slug: res.slug,
          title: res.title,
          chosen: res.chosen,
          assumption: res.assumption,
          review_date: res.reviewDate,
          outcome: res.outcome,
          premortem: res.premortem,
        };
      }
      case "list": {
        const ratedOnly = coerceBool(args, "rated");
        const all = ratedOnly ? listRatedDecisions(ctx.vault) : listDecisions(ctx.vault);
        return {
          action,
          decisions: all.map((d) => ({
            id: d.id,
            slug: d.slug,
            title: d.title,
            chosen: d.chosen,
            rating: d.rating,
            review_date: d.reviewDate,
            outcome: d.outcome,
          })),
        };
      }
      case "similar": {
        const title = coerceStr(args, "title", true)!;
        const chosen = coerceStr(args, "chosen", false) ?? undefined;
        const hits = findSimilarDecisions(ctx.vault, {
          title,
          ...(chosen ? { chosen } : {}),
        });
        return {
          action,
          similar: hits.map((h) => ({
            id: h.id,
            slug: h.slug,
            title: h.title,
            outcome: h.outcome,
            jaccard: h.jaccard,
          })),
        };
      }
      default:
        throw new MCPError(
          INVALID_PARAMS,
          `${TOOL}: 'action' must be one of record, outcome, rate, show, list, compare, similar`,
        );
    }
  });
}

export const DECISIONS_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: TOOL,
    description:
      "Decision-record note family. action: record captures a `type: decision` note (chosen, assumption, review_date, optional premortem/rating) + opens a review obligation; outcome backfills hindsight; rate sets a rating; show/list (rated sorts by rating)/compare read; similar finds past decisions.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["record", "outcome", "rate", "show", "list", "compare", "similar"],
          description: "Which decision operation to run.",
        },
        title: {
          type: "string",
          description: "record/similar: the decision question / statement.",
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
