/**
 * Pledge tools (dated-commitments wave): direct CRUD over the one-off
 * pledge family (`brain_pledge`) and the agent-executed extraction
 * intake (`brain_intake_pledges`).
 *
 * `brain_pledge` mirrors `brain_obligation`'s operation shape - add,
 * fulfill, list, show, remove - and answers every operation at the
 * caller's reach: a pledge the caller may not read is shown as absent,
 * dropped from `list`, and refused for `fulfill`/`remove` with the same
 * `no pledge` error an absent slug gets, so neither its text nor its
 * existence crosses, and it is never written. Below local reach the
 * `remove` answer names no archive path at all, so a withheld page
 * already sitting in `archive/` stays unlisted.
 *
 * `brain_intake_pledges` wraps the intake primitive: the agent posts
 * typed pledge extractions read from a vault page, the kernel validates
 * the whole payload before any write, anchors counterparty NAMES against
 * the canonical entity registry server-side, and reports the names it
 * could not anchor. This server runs no model.
 */

import { resolveAgentName } from "../../core/config.ts";
import {
  addPledge,
  fulfillPledge,
  listPledges,
  noPledgeError,
  pledgeRel,
  removePledge,
  showPledge,
  PledgeError,
  type PledgeListItem,
  type PledgePage,
} from "../../core/brain/pledges.ts";
import {
  intakePledges,
  PledgeIntakeError,
  type PledgeIntakeItem,
} from "../../core/brain/pledge-intake.ts";
import { slugify } from "../../core/vault.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import { coerceStr, coerceStrList, unknownOperationError } from "../coerce.ts";
import { readableAtContextReach, readableAtContextReachOrUndefined } from "./reach-readable.ts";
import { wrapToolErrors } from "./shared.ts";
import { isRecord } from "./intake-args.ts";

const INTAKE_TOOL = "brain_intake_pledges";

function pageJson(page: PledgePage): Record<string, unknown> {
  return {
    slug: page.slug,
    title: page.title,
    text: page.text,
    due: page.due,
    created_at: page.createdAt,
    source: page.source,
    evidence: [...page.evidence],
    promised_to: [...page.counterparties],
    fulfilled: page.fulfilled,
    agent: page.agent,
    notes: page.notes,
    path: page.path,
  };
}

function listItemJson(item: PledgeListItem): Record<string, unknown> {
  return {
    slug: item.slug,
    title: item.title,
    due: item.due,
    overdue: item.overdue,
    days_until_due: item.daysUntilDue,
    promised_to: [...item.counterparties],
    fulfilled: item.fulfilled,
    source: item.source,
    path: item.path,
  };
}

/** The agent identity a page is stamped with: the override or the server's. */
function agentFor(ctx: ServerContext, override: string | null): string {
  return override !== null && override.trim().length > 0
    ? override
    : resolveAgentName(ctx.configPath ?? undefined);
}

function toolBrainPledge(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const operation = coerceStr(args, "operation", true)!;
  // Every operation answers at the caller's reach, exactly as
  // `brain_obligation` does; `undefined` at local reach with the owner
  // gate off, so an unfiltered read skips the per-page check entirely.
  const readable = readableAtContextReachOrUndefined(ctx);
  const withheld = (slug: string): boolean => readable !== undefined && !readable(pledgeRel(slug));
  try {
    if (operation === "list") {
      const items = listPledges(ctx.vault, {
        now: new Date(),
        ...(readable !== undefined ? { readable } : {}),
      });
      const kept = args["overdue"] === true ? items.filter((item) => item.overdue) : items;
      return { operation, pledges: kept.map(listItemJson) };
    }
    if (operation === "add") {
      const title = coerceStr(args, "title", true)!;
      const due = coerceStr(args, "due", true)!;
      const source = coerceStr(args, "source", true)!;
      const evidence = coerceStrList(args, "evidence");
      const counterparties = coerceStrList(args, "counterparties");
      const text = coerceStr(args, "text", false);
      const notes = coerceStr(args, "notes", false);
      // `addPledge` refuses a taken slug and never overwrites it; the
      // refusal is the one answer that cannot match an absent page's,
      // because creating the page would replace the withheld one.
      const page = addPledge(ctx.vault, {
        title,
        due,
        source,
        evidence,
        agent: agentFor(ctx, coerceStr(args, "agent", false)),
        ...(text !== null ? { text } : {}),
        ...(notes !== null ? { notes } : {}),
        ...(counterparties.length > 0 ? { counterparties } : {}),
      });
      return { operation, pledge: pageJson(page) };
    }
    const slug = coerceStr(args, "slug", true)!;
    if (withheld(slug)) {
      if (operation === "show") return { operation, slug, present: false };
      if (operation === "fulfill" || operation === "remove") {
        throw noPledgeError(slugify(slug));
      }
    }
    if (operation === "show") {
      const page = showPledge(ctx.vault, {
        slug,
        ...(readable !== undefined ? { readable } : {}),
      });
      if (page === null) return { operation, slug, present: false };
      return { operation, present: true, pledge: pageJson(page) };
    }
    if (operation === "fulfill") {
      const date = coerceStr(args, "date", false);
      const page = fulfillPledge(ctx.vault, { slug, ...(date !== null ? { date } : {}) });
      return { operation, pledge: pageJson(page) };
    }
    if (operation === "remove") {
      const removed = removePledge(ctx.vault, { slug });
      // The archive name steps past every name already taken in archive/,
      // readable or not, so below local reach it is left out of the answer.
      if (readable !== undefined) return { operation, slug: removed.slug };
      return { operation, slug: removed.slug, archive_path: removed.archivePath };
    }
  } catch (err) {
    // Preserve an already-typed MCPError (e.g. from coerceStr) instead of
    // re-wrapping it with a doubled "brain_pledge: " prefix and flattening
    // its code. Only wrap unexpected thrown values.
    if (err instanceof MCPError) throw err;
    throw new MCPError(INVALID_PARAMS, `brain_pledge: ${(err as Error).message}`);
  }
  throw unknownOperationError(
    "brain_pledge operation must be one of: add, fulfill, list, show, remove",
  );
}

/**
 * Structural validation of one posted pledge item. Validation is
 * shape-only here - the kernel owns the content rules (quote
 * containment, source readability, calendar dates) and refuses with its
 * own named errors, which surface as INVALID_PARAMS unchanged.
 */
function coercePledgeItem(value: unknown, index: number): PledgeIntakeItem {
  if (!isRecord(value)) {
    throw new MCPError(INVALID_PARAMS, `${INTAKE_TOOL}: pledges[${index}] must be an object`);
  }
  const title = value["title"];
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new MCPError(
      INVALID_PARAMS,
      `${INTAKE_TOOL}: pledges[${index}].title must be a non-empty string`,
    );
  }
  const due = value["due"];
  if (typeof due !== "string" || due.trim().length === 0) {
    throw new MCPError(
      INVALID_PARAMS,
      `${INTAKE_TOOL}: pledges[${index}].due must be a non-empty string`,
    );
  }
  const evidence = value["evidence"];
  if (
    !Array.isArray(evidence) ||
    evidence.length === 0 ||
    !evidence.every((quote) => typeof quote === "string")
  ) {
    throw new MCPError(
      INVALID_PARAMS,
      `${INTAKE_TOOL}: pledges[${index}].evidence must be a non-empty array of strings`,
    );
  }
  const text = value["text"];
  if (text !== undefined && typeof text !== "string") {
    throw new MCPError(INVALID_PARAMS, `${INTAKE_TOOL}: pledges[${index}].text must be a string`);
  }
  const counterparties = value["counterparties"];
  if (
    counterparties !== undefined &&
    (!Array.isArray(counterparties) || !counterparties.every((name) => typeof name === "string"))
  ) {
    throw new MCPError(
      INVALID_PARAMS,
      `${INTAKE_TOOL}: pledges[${index}].counterparties must be an array of strings`,
    );
  }
  return {
    title,
    due,
    evidence: evidence as string[],
    ...(typeof text === "string" ? { text } : {}),
    ...(counterparties !== undefined ? { counterparties: counterparties as string[] } : {}),
  };
}

function parseIntakeArgs(args: Record<string, unknown>): {
  source: string;
  pledges: PledgeIntakeItem[];
  agent: string | null;
} {
  const source = coerceStr(args, "source", true)!;
  const rawPledges = args["pledges"];
  if (!Array.isArray(rawPledges) || rawPledges.length === 0) {
    throw new MCPError(INVALID_PARAMS, `${INTAKE_TOOL}: 'pledges' must be a non-empty array`);
  }
  return {
    source,
    pledges: rawPledges.map((item, index) => coercePledgeItem(item, index)),
    agent: coerceStr(args, "agent", false),
  };
}

async function toolBrainIntakePledges(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const parsed = parseIntakeArgs(args);
  // A malformed payload is a client-resolvable input problem, not a
  // server fault - surface every kernel refusal as INVALID_PARAMS with
  // the typed error's message preserved under exactly one prefix.
  return wrapToolErrors(INTAKE_TOOL, [PledgeError, PledgeIntakeError], async () => {
    const result = intakePledges(
      ctx.vault,
      { source: parsed.source, pledges: parsed.pledges },
      {
        agent: agentFor(ctx, parsed.agent),
        now: new Date(),
        // A source page the caller may not read at its reach refuses the
        // whole intake: identical-to-absent.
        readable: readableAtContextReach(ctx),
      },
    );
    return {
      created: [...result.created],
      duplicates: [...result.duplicates],
      reanchored: [...result.reanchored],
      unanchored_counterparties: [...result.unanchoredCounterparties],
    };
  });
}

export const PLEDGE_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_pledge",
    description:
      "One-off pledges under Brain/pledges/ - a promise made in prose, with a due date, a cited source page and evidence quotes verified against that source at write time: add, fulfill (stamps the date), list (optionally overdue-only), show, remove (archives the page).",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["add", "fulfill", "list", "show", "remove"],
          description: "Operation to perform.",
        },
        title: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Pledge title (slugified into the page id) for add.",
        },
        due: {
          type: "string",
          description: "Due date (YYYY-MM-DD) for add.",
        },
        source: {
          type: "string",
          description:
            "Vault-relative path (or [[wikilink]]) of the source page the promise was read from, for add. Every evidence quote must occur in it.",
        },
        evidence: {
          type: "array",
          items: { type: "string" },
          description:
            "Quotes from the source page that evidence the pledge (at least one, for add); verified against the source at write time.",
        },
        slug: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "Pledge id for fulfill/show/remove (a title is also accepted and slugified).",
        },
        date: {
          type: "string",
          description: "Fulfillment date (YYYY-MM-DD) for fulfill; defaults to today (UTC).",
        },
        text: {
          type: "string",
          maxLength: 4000,
          description: "Optional promise text for add (the page body).",
        },
        notes: {
          type: "string",
          maxLength: 4000,
          description: "Optional notes section for add.",
        },
        agent: {
          type: "string",
          description:
            "Agent identity stamped on the page; defaults to the server-resolved agent name.",
        },
        counterparties: {
          type: "array",
          items: { type: "string" },
          description:
            "Anchored counterparty entity ids for add (the promised_to relation targets); names are anchored by brain_intake_pledges instead.",
        },
        overdue: {
          type: "boolean",
          description: "list only: restrict to overdue pledges.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainPledge,
  },
  {
    name: INTAKE_TOOL,
    description:
      "Intake pledges the agent extracted from a vault page (this server runs no model). Supply the `source` page and the typed `pledges` (title, due, evidence quotes from that page, optional text and counterparty NAMES). Everything is validated before any write; counterparty names are anchored against the canonical entity registry server-side, and names that anchor nowhere are reported instead of stored. A repeat with the same payload is a reported no-op.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description:
            "Vault-relative path (or [[wikilink]]) of the page the pledges were extracted from; every evidence quote must occur in it.",
        },
        pledges: {
          type: "array",
          description: "Extracted pledges (non-empty).",
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                minLength: 1,
                maxLength: 200,
                description: "Pledge title (slugified into the page id).",
              },
              due: {
                type: "string",
                description: "Due date (YYYY-MM-DD).",
              },
              evidence: {
                type: "array",
                items: { type: "string" },
                description: "Quotes from the source page (at least one).",
              },
              text: {
                type: "string",
                maxLength: 4000,
                description: "Optional promise text.",
              },
              counterparties: {
                type: "array",
                items: { type: "string" },
                description: "Counterparty NAMES to anchor against the entity registry.",
              },
            },
            required: ["title", "due", "evidence"],
            additionalProperties: false,
          },
        },
        agent: {
          type: "string",
          description:
            "Agent identity stamped on the pages; defaults to the server-resolved agent name.",
        },
      },
      required: ["source", "pledges"],
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainIntakePledges,
  },
]);
