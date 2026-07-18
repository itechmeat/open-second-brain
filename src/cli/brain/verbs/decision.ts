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
 *
 * CLI mirror of the `brain_decision` MCP tool; both delegate to the core
 * decision module so the on-disk shape cannot drift.
 */

import { defaultConfigPath } from "../../../core/config.ts";
import {
  backfillOutcome,
  findSimilarDecisions,
  listDecisions,
  recordDecision,
  showDecision,
} from "../../../core/brain/decisions/record.ts";
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
    json: { type: "boolean" },
  });

  const action = positional[0];
  if (action === undefined) {
    return usageError(
      "brain decision requires an action: record | outcome | show | list | similar",
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
        const res = recordDecision(vault, {
          title,
          chosen,
          assumption,
          reviewDate,
          ...(premortem ? { premortem } : {}),
          ...(notes ? { notes } : {}),
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
          });
        } else {
          ok(`${res.id}: chose "${res.chosen}" (review ${res.reviewDate ?? "none"})`);
        }
        return 0;
      }
      case "list": {
        const all = listDecisions(vault);
        if (wantsJson) {
          okJson({
            decisions: all.map((d) => ({
              id: d.id,
              slug: d.slug,
              title: d.title,
              chosen: d.chosen,
              review_date: d.reviewDate,
              outcome: d.outcome,
            })),
          });
        } else if (all.length === 0) {
          ok("no decisions");
        } else {
          for (const d of all) ok(`${d.id}: ${d.chosen}${d.outcome ? ` -> ${d.outcome}` : ""}`);
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
      default:
        return usageError(`unknown decision action: ${action}`);
    }
  } catch (exc) {
    process.stderr.write(`error: ${(exc as Error).message ?? String(exc)}\n`);
    return 1;
  }
}
