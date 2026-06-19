/**
 * Calendar-aware Brain tools (t_f7b82ba4): recurring obligations
 * (`brain_obligation`) and deterministic agenda synthesis
 * (`brain_agenda`). The kernel never reaches a calendar API - the host
 * runtime fetches events and passes them in; these tools are pure
 * vault-native bookkeeping and pure analysis respectively.
 */

import { resolveAgentName } from "../../core/config.ts";
import {
  addObligation,
  completeObligation,
  listObligations,
  removeObligation,
  showObligation,
  type ObligationListItem,
  type ObligationPage,
} from "../../core/brain/obligations.ts";
import {
  synthesizeAgenda,
  type AgendaEventInput,
  type AgendaSnapshot,
} from "../../core/brain/agenda.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tools.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import { coerceStr, coerceStrList } from "../coerce.ts";

function pageJson(page: ObligationPage): Record<string, unknown> {
  return {
    slug: page.slug,
    title: page.title,
    cadence: page.cadence,
    created_at: page.createdAt,
    anchor: page.anchor,
    last_done: page.lastDone,
    next_due: page.nextDue,
    completions: page.completions,
    path: page.path,
  };
}

function listItemJson(item: ObligationListItem): Record<string, unknown> {
  return {
    slug: item.slug,
    title: item.title,
    cadence: item.cadence,
    next_due: item.nextDue,
    last_done: item.lastDone,
    overdue: item.overdue,
    days_until_due: item.daysUntilDue,
  };
}

function toolBrainObligation(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const operation = coerceStr(args, "operation", true)!;
  try {
    if (operation === "list") {
      const items = listObligations(ctx.vault, { overdueOnly: args["overdue"] === true });
      return { operation, obligations: items.map(listItemJson) };
    }
    if (operation === "add") {
      const title = coerceStr(args, "title", true)!;
      const cadence = coerceStr(args, "cadence", true)!;
      const anchor = coerceStr(args, "anchor", false);
      const notes = coerceStr(args, "notes", false);
      const page = addObligation(ctx.vault, {
        title,
        cadence,
        agent: resolveAgentName(ctx.configPath ?? undefined),
        ...(anchor ? { anchor } : {}),
        ...(notes ? { notes } : {}),
      });
      return { operation, obligation: pageJson(page) };
    }
    const slug = coerceStr(args, "slug", true)!;
    if (operation === "show") {
      const page = showObligation(ctx.vault, slug);
      if (page === null) return { operation, slug, present: false };
      return { operation, present: true, obligation: pageJson(page) };
    }
    if (operation === "done") {
      const date = coerceStr(args, "date", false);
      const page = completeObligation(ctx.vault, { slug, ...(date ? { date } : {}) });
      return { operation, obligation: pageJson(page) };
    }
    if (operation === "remove") {
      const removed = removeObligation(ctx.vault, slug);
      return { operation, slug: removed.slug, archive_path: removed.archivePath };
    }
  } catch (err) {
    throw new MCPError(INVALID_PARAMS, `brain_obligation: ${(err as Error).message}`);
  }
  throw new MCPError(
    INVALID_PARAMS,
    "brain_obligation operation must be one of: add, done, list, show, remove",
  );
}

function coerceEvents(args: Record<string, unknown>): AgendaEventInput[] {
  const raw = args["events"];
  if (!Array.isArray(raw)) {
    throw new MCPError(INVALID_PARAMS, "brain_agenda: 'events' must be an array");
  }
  return raw.map((entry, index) => {
    if (entry === null || typeof entry !== "object") {
      throw new MCPError(INVALID_PARAMS, `brain_agenda: event ${index} must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    const start = obj["start"];
    const end = obj["end"];
    if (typeof start !== "string" || typeof end !== "string") {
      throw new MCPError(
        INVALID_PARAMS,
        `brain_agenda: event ${index} requires string 'start' and 'end'`,
      );
    }
    return {
      start,
      end,
      ...(typeof obj["id"] === "string" ? { id: obj["id"] } : {}),
      ...(typeof obj["title"] === "string" ? { title: obj["title"] } : {}),
      ...(typeof obj["organizer"] === "string" ? { organizer: obj["organizer"] } : {}),
    };
  });
}

function snapshotJson(snapshot: AgendaSnapshot): Record<string, unknown> {
  return {
    counts: {
      events: snapshot.counts.events,
      conflicts: snapshot.counts.conflicts,
      focus_blocks: snapshot.counts.focusBlocks,
      external_organizers: snapshot.counts.externalOrganizers,
    },
    conflicts: snapshot.conflicts,
    focus_blocks: snapshot.focusBlocks,
    external_organizers: snapshot.externalOrganizers,
    events: snapshot.events.map((e) => ({
      id: e.id,
      title: e.title,
      start: e.start,
      end: e.end,
      organizer: e.organizer,
    })),
  };
}

function toolBrainAgenda(
  _ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const events = coerceEvents(args);
  const focusRaw = args["focus_min_minutes"];
  const focusMinMinutes = focusRaw === undefined || focusRaw === null ? 60 : Number(focusRaw);
  const workdayStart = coerceStr(args, "workday_start", false);
  const workdayEnd = coerceStr(args, "workday_end", false);
  if ((workdayStart === null) !== (workdayEnd === null)) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_agenda: workday_start and workday_end must be given together",
    );
  }
  try {
    const snapshot = synthesizeAgenda(events, {
      focusMinMinutes,
      ownerDomains: coerceStrList(args, "owner_domains"),
      ...(workdayStart !== null ? { workdayStart, workdayEnd: workdayEnd! } : {}),
    });
    return snapshotJson(snapshot);
  } catch (err) {
    throw new MCPError(INVALID_PARAMS, `brain_agenda: ${(err as Error).message}`);
  }
}

export const CALENDAR_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_obligation",
    description:
      "Recurring obligations under Brain/obligations/ with a deterministic cadence-driven next-due date: add, done (advances next_due one interval), list (optionally overdue-only), show, remove. Cadences: daily/weekly/biweekly/monthly/quarterly/yearly/every-<N>-days.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["add", "done", "list", "show", "remove"],
          description: "Operation to perform.",
        },
        title: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Obligation title (slugified into the page id) for add.",
        },
        cadence: {
          type: "string",
          description:
            "Cadence for add: daily | weekly | biweekly | monthly | quarterly | yearly | every-<N>-days.",
        },
        slug: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "Obligation id for done/show/remove (a title is also accepted and slugified).",
        },
        anchor: {
          type: "string",
          description: "First due date (YYYY-MM-DD) for add; defaults to today (UTC).",
        },
        date: {
          type: "string",
          description: "Completion date (YYYY-MM-DD) for done; defaults to today (UTC).",
        },
        notes: { type: "string", maxLength: 4000, description: "Optional page body for add." },
        overdue: { type: "boolean", description: "list only: restrict to overdue obligations." },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainObligation,
  },
  {
    name: "brain_agenda",
    description:
      "Deterministic agenda synthesis over caller-provided calendar events (the Brain never calls a calendar API): overlap conflicts, free focus blocks (optionally clipped to a workday window), and events organised outside the operator's email domain(s). Pure analysis, no vault writes.",
    inputSchema: {
      type: "object",
      properties: {
        events: {
          type: "array",
          description: "Calendar events to analyse.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              start: { type: "string", description: "ISO-8601 start timestamp." },
              end: { type: "string", description: "ISO-8601 end timestamp." },
              organizer: { type: "string", description: "Organiser email." },
            },
            required: ["start", "end"],
          },
        },
        focus_min_minutes: {
          type: "number",
          description: "Minimum free gap (minutes) that counts as a focus block. Default 60.",
        },
        owner_domains: {
          type: "array",
          items: { type: "string" },
          description: "Operator email domain(s); organisers outside these are flagged external.",
        },
        workday_start: { type: "string", description: "Workday window start HH:MM (24h, UTC)." },
        workday_end: { type: "string", description: "Workday window end HH:MM (24h, UTC)." },
      },
      required: ["events"],
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainAgenda,
  },
]);
