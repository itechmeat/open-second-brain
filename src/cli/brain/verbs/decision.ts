/**
 * `o2b brain decision <action>` - decision-record note family CLI
 * (Belief lifecycle suite, Track B anchor, t_ac03214d).
 *
 * Actions:
 *   - `record --title <t> --chosen <c> --assumption <a> --review-date <d>
 *              [--premortem <p>] [--notes <n>]`
 *   - `outcome <slug> --outcome <text>`   backfill the hindsight outcome
 *   - `show <slug>`
 *   - `list`
 *   - `similar --title <t> [--chosen <c>]`  historically similar decisions
 *   - `recall --prompt <t> [--turn <n>] [--count <n>] [--last-turn <n>]
 *              [--surfaced-ids <id> ...]`  resurface a rated decision,
 *              threading the per-session cap and spacing state
 *
 * CLI mirror of the `brain_decision` MCP tool; both delegate to the core
 * decision module so the on-disk shape cannot drift.
 */

import { defaultConfigPath } from "../../../core/config.ts";
import {
  backfillOutcome,
  compareDecisions,
  findSimilarDecisions,
  listDecisions,
  listRatedDecisions,
  recordDecision,
  showDecision,
  updateRating,
} from "../../../core/brain/decisions/record.ts";
import type { BrainCommitmentTier } from "../../../core/brain/types.ts";
import { queryDecisionChangeHistory } from "../../../core/brain/decisions/receipts.ts";
import { recallRatedDecisions } from "../../../core/brain/decisions/recall.ts";
import { normalizeFlagString, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

const USAGE_ERROR_EXIT = 2;

function usageError(message: string): number {
  process.stderr.write(`error: ${message}\n`);
  return USAGE_ERROR_EXIT;
}

export async function cmdBrainDecision(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    agent: { type: "string" },
    title: { type: "string" },
    chosen: { type: "string" },
    assumption: { type: "string" },
    "review-date": { type: "string" },
    premortem: { type: "string" },
    notes: { type: "string" },
    outcome: { type: "string" },
    rating: { type: "string" },
    rationale: { type: "string" },
    commitment: { type: "string" },
    rated: { type: "boolean" },
    subject: { type: "string" },
    cursor: { type: "string" },
    limit: { type: "string" },
    prompt: { type: "string" },
    turn: { type: "string" },
    count: { type: "string" },
    "last-turn": { type: "string" },
    "surfaced-ids": { type: "string-array" },
    json: { type: "boolean" },
  });

  const action = positional[0];
  if (action === undefined) {
    return usageError(
      "brain decision requires an action: record | outcome | rate | show | list | compare | similar | history | recall",
    );
  }

  const config = (flags["config"] as string | undefined) ?? defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const explicitAgent = normalizeFlagString(flags["agent"]);
  const wantsJson = flags["json"] === true;

  try {
    switch (action) {
      case "record": {
        const title = normalizeFlagString(flags["title"]);
        const chosen = normalizeFlagString(flags["chosen"]);
        const assumption = normalizeFlagString(flags["assumption"]);
        const reviewDate = normalizeFlagString(flags["review-date"]);
        if (!title || !chosen || !assumption || !reviewDate) {
          return usageError(
            "brain decision record requires --title, --chosen, --assumption, --review-date",
          );
        }
        const premortem = normalizeFlagString(flags["premortem"]);
        const notes = normalizeFlagString(flags["notes"]);
        const ratingRaw = normalizeFlagString(flags["rating"]);
        const rating = ratingRaw === null ? undefined : Number(ratingRaw);
        if (rating !== undefined && !Number.isFinite(rating)) {
          return usageError("brain decision record --rating must be a number");
        }
        const rationale = normalizeFlagString(flags["rationale"]);
        const commitment = normalizeFlagString(flags["commitment"]);
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
          agent: explicitAgent ?? "",
          configPath: config,
        });
        if (wantsJson) {
          okJson({
            id: res.record.id,
            slug: res.record.slug,
            review_date: res.record.reviewDate,
            review_obligation: res.reviewObligationSlug,
            obligation_created: res.obligationCreated,
          });
        } else {
          ok(`recorded ${res.record.id} (review obligation: ${res.reviewObligationSlug})`);
        }
        return 0;
      }
      case "outcome": {
        const slug = positional[1];
        const outcome = normalizeFlagString(flags["outcome"]);
        if (slug === undefined || !outcome) {
          return usageError("brain decision outcome requires <slug> --outcome <text>");
        }
        const res = backfillOutcome(vault, {
          slug,
          outcome,
          ...(explicitAgent ? { agent: explicitAgent } : {}),
          configPath: config,
        });
        if (wantsJson) {
          okJson({ id: res.id, slug: res.slug, outcome: res.outcome });
        } else {
          ok(`outcome recorded for ${res.id}`);
        }
        return 0;
      }
      case "rate": {
        const slug = positional[1];
        const ratingRaw = normalizeFlagString(flags["rating"]);
        if (slug === undefined || ratingRaw === null) {
          return usageError("brain decision rate requires <slug> --rating <n>");
        }
        const rating = Number(ratingRaw);
        if (!Number.isFinite(rating)) {
          return usageError("brain decision rate --rating must be a number");
        }
        const rationale = normalizeFlagString(flags["rationale"]);
        const res = updateRating(vault, {
          slug,
          rating,
          ...(rationale ? { rationale } : {}),
          ...(explicitAgent ? { agent: explicitAgent } : {}),
          configPath: config,
        });
        if (wantsJson) {
          okJson({ id: res.id, slug: res.slug, rating: res.rating, rationale: res.rationale });
        } else {
          ok(`rated ${res.id}: ${res.rating}`);
        }
        return 0;
      }
      case "compare": {
        const slugs = positional.slice(1);
        if (slugs.length === 0) {
          return usageError("brain decision compare requires one or more slugs");
        }
        const rows = compareDecisions(vault, slugs);
        if (wantsJson) {
          okJson({
            decisions: rows.map((d) => ({
              id: d.id,
              slug: d.slug,
              title: d.title,
              chosen: d.chosen,
              rating: d.rating,
              rationale: d.rationale,
              outcome: d.outcome,
            })),
          });
        } else if (rows.length === 0) {
          ok("no matching decisions");
        } else {
          for (const d of rows) {
            ok(`${d.id}: ${d.chosen} (rating ${d.rating ?? "none"})`);
          }
        }
        return 0;
      }
      case "show": {
        const slug = positional[1];
        if (slug === undefined) return usageError("brain decision show requires a slug");
        const res = showDecision(vault, slug);
        if (res === null) {
          process.stderr.write(`error: no decision: ${slug}\n`);
          return 1;
        }
        if (wantsJson) {
          okJson({
            id: res.id,
            slug: res.slug,
            title: res.title,
            chosen: res.chosen,
            assumption: res.assumption,
            review_date: res.reviewDate,
            outcome: res.outcome,
            premortem: res.premortem,
            rating: res.rating,
            rationale: res.rationale,
            // Commitment tier (B3): emitted only when set so an unset
            // decision stays byte-identical to a pre-B3 response.
            ...(res.commitment !== null ? { commitment: res.commitment } : {}),
          });
        } else {
          ok(`${res.id}: chose "${res.chosen}" (review ${res.reviewDate ?? "none"})`);
        }
        return 0;
      }
      case "list": {
        const ratedOnly = flags["rated"] === true;
        const all = ratedOnly ? listRatedDecisions(vault) : listDecisions(vault);
        if (wantsJson) {
          okJson({
            decisions: all.map((d) => ({
              id: d.id,
              slug: d.slug,
              title: d.title,
              chosen: d.chosen,
              rating: d.rating,
              review_date: d.reviewDate,
              outcome: d.outcome,
              ...(d.commitment !== null ? { commitment: d.commitment } : {}),
            })),
          });
        } else if (all.length === 0) {
          ok(ratedOnly ? "no rated decisions" : "no decisions");
        } else {
          for (const d of all) {
            const rt = d.rating !== null ? ` [${d.rating}]` : "";
            ok(`${d.id}${rt}: ${d.chosen}${d.outcome ? ` -> ${d.outcome}` : ""}`);
          }
        }
        return 0;
      }
      case "similar": {
        const title = normalizeFlagString(flags["title"]);
        if (!title) return usageError("brain decision similar requires --title <text>");
        const chosen = normalizeFlagString(flags["chosen"]);
        const hits = findSimilarDecisions(vault, {
          title,
          ...(chosen ? { chosen } : {}),
        });
        if (wantsJson) {
          okJson({
            similar: hits.map((h) => ({
              id: h.id,
              slug: h.slug,
              title: h.title,
              outcome: h.outcome,
              jaccard: h.jaccard,
            })),
          });
        } else if (hits.length === 0) {
          ok("no similar decisions");
        } else {
          for (const h of hits) {
            ok(`${h.id} (${h.jaccard.toFixed(2)})${h.outcome ? ` -> ${h.outcome}` : ""}`);
          }
        }
        return 0;
      }
      case "history": {
        const subject = normalizeFlagString(flags["subject"]);
        const cursor = normalizeFlagString(flags["cursor"]);
        const limitRaw = normalizeFlagString(flags["limit"]);
        const limit = limitRaw === null ? undefined : Number(limitRaw);
        if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
          return usageError("brain decision history --limit must be a positive integer");
        }
        const page = queryDecisionChangeHistory(vault, {
          ...(subject ? { subject } : {}),
          ...(cursor ? { cursor } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        if (wantsJson) {
          okJson({
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
          });
        } else if (page.receipts.length === 0) {
          ok("no decision-change receipts");
        } else {
          for (const r of page.receipts) {
            ok(`${r.ts} ${r.subject}: ${r.before} -> ${r.after} (${r.reason_code})`);
          }
          if (page.nextCursor) ok(`-- more: --cursor ${page.nextCursor}`);
        }
        return 0;
      }
      case "recall": {
        const prompt = normalizeFlagString(flags["prompt"]);
        if (!prompt) return usageError("brain decision recall requires --prompt <text>");
        const turnRaw = normalizeFlagString(flags["turn"]);
        const turn = turnRaw === null ? 0 : Number(turnRaw);
        if (!Number.isInteger(turn) || turn < 0) {
          return usageError("brain decision recall --turn must be a non-negative integer");
        }
        // Governor state passthrough (B5): let the CLI exercise the same
        // per-session cap and spacing the MCP recall action accepts.
        const countRaw = normalizeFlagString(flags["count"]);
        const count = countRaw === null ? 0 : Number(countRaw);
        if (!Number.isInteger(count) || count < 0) {
          return usageError("brain decision recall --count must be a non-negative integer");
        }
        const lastTurnRaw = normalizeFlagString(flags["last-turn"]);
        let lastTurn: number | null = null;
        if (lastTurnRaw !== null) {
          lastTurn = Number(lastTurnRaw);
          if (!Number.isInteger(lastTurn) || lastTurn < 0) {
            return usageError("brain decision recall --last-turn must be a non-negative integer");
          }
        }
        const surfacedIds = Array.isArray(flags["surfaced-ids"])
          ? (flags["surfaced-ids"] as string[])
          : [];
        const res = recallRatedDecisions(vault, {
          prompt,
          turn,
          state: {
            surfacedIds,
            lastTurn,
            count: count || surfacedIds.length,
          },
          configPath: config,
        });
        if (wantsJson) {
          okJson({
            enabled: res.enabled,
            surfaced: res.surfaced
              ? { id: res.surfaced.id, slug: res.surfaced.slug, rating: res.surfaced.rating }
              : null,
            text: res.text,
            state: {
              surfaced_ids: res.state.surfacedIds,
              last_turn: res.state.lastTurn,
              count: res.state.count,
            },
          });
        } else if (!res.enabled) {
          ok("decision recall not configured");
        } else if (res.surfaced === null) {
          ok("no decision recalled");
        } else {
          ok(res.text);
        }
        return 0;
      }
      default:
        return usageError(`unknown decision action: ${action}`);
    }
  } catch (exc) {
    process.stderr.write(`error: ${(exc as Error).message ?? String(exc)}\n`);
    return 1;
  }
}
