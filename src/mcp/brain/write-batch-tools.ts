/**
 * Brain general atomic batch write surface: `brain_write_batch`.
 *
 * The second consumer of the atomic write-batch core (kernel 2). One
 * ordered list of typed operations is committed all-or-nothing: the first
 * invalid operation aborts with a typed error naming the operation index
 * and no disk write happens. The operation vocabulary is create note,
 * update note (body and/or frontmatter), append note, apply evidence, and
 * append log line - each mapped onto an existing core writer.
 *
 * This layer only maps request params onto the core's typed operations
 * (no MCP shapes reach the core) and maps the typed WriteBatchError onto a
 * structured INVALID_PARAMS. Single-operation batches here produce the
 * same result as the dedicated brain_create_note / brain_update_note /
 * brain_append_note tools.
 */

import { resolveAgentName } from "../../core/config.ts";
import { normalizeAgentArgument } from "../../core/agent-identity.ts";
import { BRAIN_ROLES } from "../../core/brain/trust/role.ts";
import type { BrainApplyOutcome, BrainApplyResult } from "../../core/brain/types.ts";
import {
  applyWriteBatch,
  MAX_BATCH_OPERATIONS,
  type WriteBatchResult,
  type WriteOperation,
} from "../../core/brain/write-batch.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { parseFrontmatterArg, writeBatchErrorToMcp } from "./notes-tools.ts";
import { vaultRelativeSafe } from "./shared.ts";

/** Recognised batch operation discriminators. */
const OP_KINDS = [
  "create_note",
  "update_note",
  "append_note",
  "apply_evidence",
  "append_log_line",
] as const;

function requireStr(raw: Record<string, unknown>, key: string, opLabel: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new MCPError(INVALID_PARAMS, `brain_write_batch: ${opLabel} requires a string '${key}'`);
  }
  return value;
}

function optionalStr(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new MCPError(INVALID_PARAMS, `brain_write_batch: '${key}' must be a string`);
  }
  return value;
}

/**
 * Map one untrusted request operation object onto a typed
 * {@link WriteOperation}. `resolveAgent` supplies the caller identity for
 * the log-writing operations (apply_evidence, append_log_line).
 */
function mapOperation(
  raw: unknown,
  index: number,
  resolveAgent: (override?: string) => string,
): WriteOperation {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MCPError(INVALID_PARAMS, `brain_write_batch: operations[${index}] must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const op = obj["op"];
  switch (op) {
    case "create_note":
      return {
        kind: "create_note",
        path: requireStr(obj, "path", "create_note"),
        ...(obj["frontmatter"] !== undefined
          ? { frontmatter: parseFrontmatterArg(obj["frontmatter"], "brain_write_batch")! }
          : {}),
        ...(optionalStr(obj, "content") !== undefined
          ? { content: optionalStr(obj, "content")! }
          : {}),
      };
    case "update_note": {
      const frontmatter = parseFrontmatterArg(obj["frontmatter"], "brain_write_batch");
      const content = optionalStr(obj, "content");
      if (frontmatter === undefined && content === undefined) {
        throw new MCPError(
          INVALID_PARAMS,
          `brain_write_batch: operations[${index}] update_note requires frontmatter or content`,
        );
      }
      return {
        kind: "update_note",
        path: requireStr(obj, "path", "update_note"),
        ...(frontmatter !== undefined ? { frontmatter } : {}),
        ...(content !== undefined ? { body: content } : {}),
      };
    }
    case "append_note":
      return {
        kind: "append_note",
        path: requireStr(obj, "path", "append_note"),
        content: requireStr(obj, "content", "append_note"),
      };
    case "apply_evidence": {
      const outcome = optionalStr(obj, "outcome");
      const note = optionalStr(obj, "note");
      return {
        kind: "apply_evidence",
        input: {
          pref_id: requireStr(obj, "pref_id", "apply_evidence"),
          artifact: requireStr(obj, "artifact", "apply_evidence"),
          result: requireStr(obj, "result", "apply_evidence") as BrainApplyResult,
          agent: resolveAgent(optionalStr(obj, "agent")),
          ...(outcome !== undefined ? { outcome: outcome as BrainApplyOutcome } : {}),
          ...(note !== undefined ? { note } : {}),
        },
        options: { role: BRAIN_ROLES.applier },
      };
    }
    case "append_log_line":
      return {
        kind: "append_log_line",
        input: {
          text: requireStr(obj, "text", "append_log_line"),
          agent: resolveAgent(optionalStr(obj, "agent")),
        },
      };
    default:
      throw new MCPError(
        INVALID_PARAMS,
        `brain_write_batch: operations[${index}].op must be one of ${OP_KINDS.join(", ")}`,
      );
  }
}

/**
 * Serialize one core op result, mapping absolute log paths to
 * vault-relative form so the response never leaks the machine root.
 */
function serializeResult(
  ctx: ServerContext,
  result: WriteBatchResult["results"][number],
): Record<string, unknown> {
  if (result.kind === "apply_evidence" || result.kind === "append_log_line") {
    return {
      kind: result.kind,
      logged_at: result.logged_at,
      log_path: vaultRelativeSafe(ctx.vault, result.log_path),
    };
  }
  return { ...result };
}

async function toolBrainWriteBatch(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const rawOps = args["operations"];
  if (!Array.isArray(rawOps)) {
    throw new MCPError(INVALID_PARAMS, "brain_write_batch: 'operations' must be an array");
  }
  const resolveAgent = (override?: string): string =>
    normalizeAgentArgument(override ?? null) ?? resolveAgentName(ctx.configPath ?? undefined);
  const operations = rawOps.map((raw, index) => mapOperation(raw, index, resolveAgent));

  let batch: WriteBatchResult;
  try {
    batch = applyWriteBatch(ctx.vault, operations);
  } catch (err) {
    throw writeBatchErrorToMcp(err, "brain_write_batch");
  }
  return {
    applied: batch.applied,
    results: batch.results.map((r) => serializeResult(ctx, r)),
    done: true,
  };
}

export const WRITE_BATCH_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_write_batch",
    description:
      "Apply an ordered batch of Brain write operations atomically. Ops: create_note, update_note, append_note, apply_evidence, append_log_line. Validated and projected in memory first; the first invalid op aborts with a typed error naming its index and nothing is written.",
    inputSchema: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          maxItems: MAX_BATCH_OPERATIONS,
          description:
            "Ordered operations; each has an `op` discriminator plus that op's params. Committed all-or-nothing.",
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: [...OP_KINDS],
                description: "Operation kind.",
              },
              path: {
                type: "string",
                description: "Vault-relative .md path (create_note, update_note, append_note).",
              },
              frontmatter: {
                type: "object",
                description:
                  "Frontmatter map to write or merge (create_note, update_note). Values: string, number, boolean, or string array.",
                additionalProperties: { type: ["string", "number", "boolean", "array"] },
              },
              content: {
                type: "string",
                description:
                  "Note body: create_note/update_note replacement, or append_note appended text.",
              },
              pref_id: { type: "string", description: "Preference id for apply_evidence." },
              artifact: { type: "string", description: "Artifact wikilink for apply_evidence." },
              result: {
                type: "string",
                enum: ["applied", "violated", "outdated"],
                description: "Evidence result for apply_evidence.",
              },
              outcome: {
                type: "string",
                enum: ["success", "failure", "unknown"],
                description: "Optional downstream outcome for apply_evidence.",
              },
              note: { type: "string", description: "Optional one-line note for apply_evidence." },
              text: { type: "string", description: "Narrative line for append_log_line." },
              agent: {
                type: "string",
                description: "Optional identity override for apply_evidence / append_log_line.",
              },
            },
            required: ["op"],
            additionalProperties: false,
          },
        },
      },
      required: ["operations"],
      additionalProperties: false,
    },
    handler: toolBrainWriteBatch,
  },
]);
