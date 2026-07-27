/**
 * Research-report tool (Knowledge Provenance suite).
 *
 * The agent pulls N sources and synthesizes findings; it submits the title,
 * the consulted sources, and the findings (each citing the source that flagged
 * it). OSB runs no model - it validates the citation contract and writes a
 * dated, cited report page into the vault. A finding with no source, or one
 * citing an unconsulted source, is rejected as INVALID_PARAMS.
 */

import {
  writeResearchReport,
  ResearchValidationError,
  parseResearchReportInput,
} from "../../core/brain/research/research.ts";
import { ResponseShapeError } from "../../core/brain/response-shape.ts";
import { resolveAgentName } from "../../core/config.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { coerceStr } from "../coerce.ts";
import { wrapToolErrors } from "./shared.ts";

const TOOL = "brain_research_report";

async function toolBrainResearchReport(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const agentArg = coerceStr(args, "agent", false);
  const agent =
    agentArg && agentArg.trim().length > 0
      ? agentArg
      : resolveAgentName(ctx.configPath ?? undefined);

  return wrapToolErrors(TOOL, [ResearchValidationError, ResponseShapeError], async () => {
    // Shape first: the payload is validated before the citation contract is
    // evaluated, so a malformed finding aborts the report unwritten.
    const input = parseResearchReportInput(args);
    const res = writeResearchReport(ctx.vault, input, { agent, now: new Date() });
    return {
      report_path: res.reportPath,
      created: res.created,
      finding_count: res.findingCount,
    };
  });
}

export const RESEARCH_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: TOOL,
    description:
      "Write a dated, cited research report. Supply `title`, consulted `sources`, and `findings` (each citing its source). OSB rejects uncited findings, then writes one report page per date+title (idempotent). OSB runs no model.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Report title (also the page slug)." },
        sources: {
          type: "array",
          items: { type: "string" },
          description: "Every source consulted (identifiers or wikilinks).",
        },
        findings: {
          type: "array",
          description: "Findings, each citing the source(s) that flagged it.",
          items: {
            type: "object",
            properties: {
              statement: { type: "string", description: "The finding text." },
              sources: {
                type: "array",
                items: { type: "string" },
                description: "Sources (a subset of `sources`) that flagged this finding.",
              },
            },
            required: ["statement", "sources"],
            additionalProperties: false,
          },
        },
        agent: {
          type: "string",
          description: "Optional agent identity override; defaults to the server-resolved name.",
        },
      },
      required: ["title", "sources", "findings"],
      additionalProperties: false,
    },
    handler: toolBrainResearchReport,
  },
]);
