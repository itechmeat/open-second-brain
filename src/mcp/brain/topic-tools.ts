/**
 * `brain_topic` (design D9, spec `topics` "Topics on request"; task 3.5):
 * the MCP twin of `o2b topic`. Agents change a topic only through this
 * tool, by recording topic events; topic pages in the human view are
 * rendered from them by the view writer and are never written by a note
 * tool.
 *
 * Reads (`list`, `show`, `review`) and every write answer at the caller's
 * reach: the server runs a remote call with the `private` partition
 * withheld, so a private topic is absent from every list, its id answers
 * "no topic" to `show` and to every write that names it, and no count or
 * proposal mentions it. The work lives in `core/topics/actions.ts`.
 */

import { StoreWriteError } from "../../core/store/store-write.ts";
import {
  runTopicAction,
  TOPIC_ACTIONS,
  TOPIC_RECORD_ACTION_KINDS,
  TopicActionError,
  type TopicActionInput,
} from "../../core/topics/actions.ts";
import { TOPIC_STATUSES } from "../../core/topics/constants.ts";
import { TopicWriteError } from "../../core/topics/write.ts";
import { coerceStr, unknownOperationError } from "../coerce.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";

const TOOL = "brain_topic";

function optString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string")
    throw new MCPError(INVALID_PARAMS, `${TOOL}: '${key}' must be a string`);
  return value;
}

function optNullable(args: Record<string, unknown>, key: string): string | null | undefined {
  return args[key] === null ? null : optString(args, key);
}

function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  // Never dropped: a `private: "true"` that fell away would write to `shared`.
  if (typeof value !== "boolean")
    throw new MCPError(INVALID_PARAMS, `${TOOL}: '${key}' must be a boolean`);
  return value;
}

function optList(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new MCPError(INVALID_PARAMS, `${TOOL}: '${key}' must be a list of strings`);
  }
  return value as string[];
}

function inputOf(args: Record<string, unknown>, action: string): TopicActionInput {
  const fields = args["fields"];
  if (
    fields !== undefined &&
    (typeof fields !== "object" || fields === null || Array.isArray(fields))
  ) {
    throw new MCPError(INVALID_PARAMS, `${TOOL}: 'fields' must be an object`);
  }
  const strings = [
    "topic",
    "title",
    "scope",
    "status",
    "resolved",
    "record",
    "into",
    "to",
    "authority",
    "kind",
    "owner",
  ];
  const input: Record<string, unknown> = { action };
  for (const key of strings) {
    const value = optString(args, key);
    if (value !== undefined) input[key] = value;
  }
  for (const key of ["description", "goal"]) {
    const value = optNullable(args, key);
    if (value !== undefined) input[key] = value;
  }
  for (const key of ["items", "records"]) {
    const value = optList(args, key);
    if (value !== undefined) input[key] = value;
  }
  for (const key of ["removed", "private"]) {
    const value = optBool(args, key);
    if (value !== undefined) input[key] = value;
  }
  if (fields !== undefined) input["fields"] = fields;
  const listScope = optString(args, "list_scope");
  if (listScope !== undefined) input["listScope"] = listScope;
  return input as unknown as TopicActionInput;
}

/** The agent a record is written under: the token's agent, else the server's. */
function agentOf(ctx: ServerContext): string | undefined {
  return ctx.requestIdentity?.via === "token" ? ctx.requestIdentity.agent : ctx.agentName;
}

function toolBrainTopic(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const action = coerceStr(args, "action", true)!;
  if (!(TOPIC_ACTIONS as ReadonlyArray<string>).includes(action)) {
    throw unknownOperationError(`${TOOL}: 'action' must be one of ${TOPIC_ACTIONS.join(", ")}`);
  }
  try {
    return runTopicAction(inputOf(args, action), {
      ...(ctx.configPath !== null ? { configPath: ctx.configPath } : {}),
      ...(agentOf(ctx) !== undefined ? { agent: agentOf(ctx)! } : {}),
    });
  } catch (err) {
    if (err instanceof TopicActionError || err instanceof TopicWriteError) {
      throw new MCPError(INVALID_PARAMS, `${TOOL}: ${err.message}`, {
        code: err instanceof TopicWriteError ? `topic_${err.reason}` : "topic_invalid",
      });
    }
    if (err instanceof StoreWriteError) {
      throw new MCPError(INVALID_PARAMS, `${TOOL}: ${err.message}`, {
        code: `store_${err.reason}`,
      });
    }
    throw err;
  }
}

export const TOPIC_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: TOOL,
    kind: "write",
    description:
      "Topics: list, show, review; create, rename, status, goal, assign, unassign, merge, split, link, archive, undo; record adds your decision, question, log entry or milestone. Writes are yours (agent); pass authority human when the user asked (local only). Undo blocks re-routing. Never edit topic pages.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...TOPIC_ACTIONS], description: "Action to perform." },
        topic: {
          type: "string",
          description: "Topic id (a ULID) for every action but list, review and create.",
        },
        title: { type: "string", maxLength: 200, description: "Title for create and rename." },
        description: {
          type: ["string", "null"],
          description: "One-line description for create and rename (null clears it).",
        },
        goal: {
          type: ["string", "null"],
          description: "Goal for create and goal (null clears it).",
        },
        scope: {
          type: "string",
          description:
            "create: `project:<project>` or `personal` (default). A personal topic is private unless private is false.",
        },
        list_scope: { type: "string", description: "list: only topics of this scope." },
        status: {
          type: "string",
          enum: [...TOPIC_STATUSES],
          description: "status: the new status.",
        },
        resolved: { type: "string", description: "status done: the resolved day (YYYY-MM-DD)." },
        record: {
          type: "string",
          description: "assign, unassign: a record id; undo: the topic record to undo.",
        },
        into: { type: "string", description: "merge, split: the target topic id." },
        to: { type: "string", description: "link: the other topic id." },
        items: {
          type: "array",
          items: { type: "string" },
          description: "split: item ids to move.",
        },
        records: {
          type: "array",
          items: { type: "string" },
          description: "split: record ids to move.",
        },
        removed: { type: "boolean", description: "link: remove the link." },
        private: {
          type: "boolean",
          description: "Write to the private partition (true) or shared (false).",
        },
        authority: {
          type: "string",
          enum: ["human", "agent"],
          description:
            "human: the user explicitly asked for this (refused from a remote transport, where a request stays an agent record). Default agent.",
        },
        owner: {
          type: "string",
          description:
            "record, split: the topic that owns the named item, when merged topics share its id.",
        },
        kind: {
          type: "string",
          enum: [...TOPIC_RECORD_ACTION_KINDS],
          description: "record: the kind of event.",
        },
        fields: {
          type: "object",
          description:
            "record: the event's fields, as FORMAT.md documents them (for example { text, class } for a log-entry, { milestone, evidence } for milestone-done).",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainTopic,
  },
]);
