/**
 * One-shot design-note tool (salience-lifecycle-enrichment, unit 7,
 * t_c87644b4).
 *
 * The one-shot sibling of `brain_write_session`'s panel lane. Called with
 * a topic alone it grounds that topic in the vault's tensions, decisions
 * and truth projections and returns one needs-llm-step envelope; called
 * with a `note` it validates the answer - shape, then the
 * exactly-one-recommended rule - and commits under `Brain/decisions/`.
 * OSB runs no model on either path.
 */

import { commitDesignNote, DesignNoteError, planDesignNote } from "../../core/brain/design-note.ts";
import { ResponseCheckError } from "../../core/brain/response-checks.ts";
import { ResponseShapeError } from "../../core/brain/response-shape.ts";
import { resolveAgentName } from "../../core/config.ts";
import { coerceStr } from "../coerce.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { wrapToolErrors } from "./shared.ts";

const TOOL = "brain_design_note";

/** The refusal classes this tool reports as caller errors, not server faults. */
const NAMED_REFUSALS = [DesignNoteError, ResponseShapeError, ResponseCheckError];

async function toolBrainDesignNote(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const topic = coerceStr(args, "topic", true)!;
  const agentArg = coerceStr(args, "agent", false);
  const agent =
    agentArg && agentArg.trim().length > 0
      ? agentArg
      : resolveAgentName(ctx.configPath ?? undefined);

  return wrapToolErrors(TOOL, NAMED_REFUSALS, async () => {
    if (args["note"] === undefined) {
      const report = planDesignNote(ctx.vault, topic, { now: new Date() });
      const g = report.grounding;
      return {
        phase: "plan",
        topic: report.topic,
        slug: report.slug,
        generated_at: report.generatedAt,
        target_path: report.targetPath,
        grounding: {
          tensions: g.tensions,
          decisions: g.decisions,
          truth_slots: g.truthSlots,
          conflicts: g.conflicts,
          counts: g.counts,
          // Named, not implied: a store this vault has nothing in is a
          // different answer from a store that matched nothing.
          empty_stores: g.emptyStores,
        },
        llm_step: report.llmStep,
      };
    }
    const res = commitDesignNote(ctx.vault, topic, args["note"], { agent, now: new Date() });
    return {
      phase: "commit",
      topic: res.topic,
      slug: res.slug,
      path: res.path,
      recommended: res.recommended,
      alternative_count: res.alternativeCount,
    };
  });
}

export const DESIGN_NOTE_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: TOOL,
    description:
      "One-shot design note; runs no model. Without `note` it grounds the topic in the vault's tensions, decisions and truth projections and returns one needs-llm-step envelope, naming any store the vault holds nothing in. With `note` it commits under Brain/decisions/; not one recommendation refuses.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "What the design note is about; also the grounding query.",
        },
        note: {
          type: "object",
          description: "The written note; omit to get the grounding and the envelope instead.",
          properties: {
            title: { type: "string", description: "Title of the design note." },
            summary: {
              type: "string",
              description: "Optional one-paragraph summary placed above the alternatives.",
            },
            alternatives: {
              type: "array",
              description: "Named alternatives; exactly one may set recommended.",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Short name of the alternative." },
                  approach: { type: "string", description: "What this alternative does." },
                  tradeoffs: { type: "string", description: "What it costs and what it buys." },
                  recommended: {
                    type: "boolean",
                    description: "True on exactly one alternative; zero or two refuses the note.",
                  },
                },
                required: ["name", "approach", "tradeoffs", "recommended"],
                additionalProperties: false,
              },
            },
          },
          required: ["title", "alternatives"],
          additionalProperties: false,
        },
        agent: {
          type: "string",
          description: "Optional agent identity override; defaults to the server-resolved name.",
        },
      },
      required: ["topic"],
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainDesignNote,
  },
]);
