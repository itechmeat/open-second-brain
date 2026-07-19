/**
 * Brain note-authoring surface: `brain_create_note`.
 *
 * Distinct from `brain_note` (which appends one narrative line to the
 * daily log), this tool writes an actual vault note file - path,
 * frontmatter, and body - through the shared `createNote` primitive.
 * The primitive enforces the vault-scope, path-traversal, Brain-root,
 * and no-clobber guards; this handler only coerces arguments and maps a
 * typed `CreateNoteError` to a client-side INVALID_PARAMS.
 */

import type { FrontmatterMap, FrontmatterValue } from "../../core/types.ts";
import { createNote, CreateNoteError } from "../../core/brain/notes/create-note.ts";
import {
  applyWriteBatch,
  WriteBatchError,
  type WriteOperation,
} from "../../core/brain/write-batch.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { coerceStr } from "../coerce.ts";

/**
 * Narrow an untrusted `frontmatter` argument to a {@link FrontmatterMap}.
 * Accepts a plain object whose values are strings, numbers, booleans, or
 * string arrays (the frontmatter value domain); rejects anything else
 * with INVALID_PARAMS rather than silently dropping it. `tool` names the
 * calling surface so the rejection message points at the right tool.
 */
export function parseFrontmatterArg(value: unknown, tool: string): FrontmatterMap | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new MCPError(INVALID_PARAMS, `${tool}: frontmatter must be an object`);
  }
  // Prototype-free target + explicit rejection of prototype-mutating keys:
  // `frontmatter` is untrusted, and a `__proto__`/`constructor`/`prototype`
  // key with an array value would otherwise pollute the object prototype.
  const out: FrontmatterMap = Object.create(null) as FrontmatterMap;
  for (const [key, raw] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new MCPError(INVALID_PARAMS, `${tool}: invalid frontmatter key "${key}"`);
    }
    let coerced: FrontmatterValue;
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      coerced = raw;
    } else if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) {
      coerced = raw.filter((item): item is string => typeof item === "string");
    } else {
      throw new MCPError(
        INVALID_PARAMS,
        `${tool}: frontmatter.${key} must be a string, number, boolean, or string array`,
      );
    }
    out[key] = coerced;
  }
  return out;
}

/**
 * Map a core {@link WriteBatchError} onto a structured INVALID_PARAMS so
 * the agent gets a machine-readable rejection (`code`, offending `index`)
 * instead of opaque prose. `tool` prefixes the message. Non-batch errors
 * pass through unchanged.
 */
export function writeBatchErrorToMcp(err: unknown, tool: string): unknown {
  if (err instanceof WriteBatchError) {
    return new MCPError(INVALID_PARAMS, `${tool}: ${err.message}`, {
      code: err.code,
      index: err.index,
      ...err.details,
    });
  }
  return err;
}

async function toolBrainCreateNote(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const path = coerceStr(args, "path", true)!;
  const content = coerceStr(args, "content", false);
  const frontmatter = parseFrontmatterArg(args["frontmatter"], "brain_create_note");

  try {
    const res = createNote(ctx.vault, {
      path,
      ...(frontmatter !== undefined ? { frontmatter } : {}),
      ...(content !== null && content !== undefined ? { content } : {}),
    });
    return { created: res.created, path: res.path };
  } catch (err) {
    // Every CreateNoteError is a client-input fault (bad path, excluded
    // location, or an existing target); report it as INVALID_PARAMS with
    // the typed message. Anything else is a genuine I/O fault.
    if (err instanceof CreateNoteError) {
      throw new MCPError(INVALID_PARAMS, `brain_create_note: ${err.message}`);
    }
    throw new MCPError(INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Update an existing note: merge frontmatter keys and/or replace the
 * body. A single-operation batch over kernel 2 so a mid-write failure
 * leaves the target byte-identical. Requires at least one of frontmatter
 * or content; a missing target is a typed error.
 */
async function toolBrainUpdateNote(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const path = coerceStr(args, "path", true)!;
  const frontmatter = parseFrontmatterArg(args["frontmatter"], "brain_update_note");
  const content = coerceStr(args, "content", false);
  if (frontmatter === undefined && content === null) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_update_note: provide 'frontmatter', 'content', or both",
    );
  }
  const op: WriteOperation = {
    kind: "update_note",
    path,
    ...(frontmatter !== undefined ? { frontmatter } : {}),
    ...(content !== null ? { body: content } : {}),
  };
  const result = runSingleWrite(ctx, op, "brain_update_note");
  return { updated: true, path: result.path };
}

/**
 * Append body text to an existing note. A single-operation batch over
 * kernel 2; a missing target is a typed error.
 */
async function toolBrainAppendNote(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const path = coerceStr(args, "path", true)!;
  const content = coerceStr(args, "content", true)!;
  const op: WriteOperation = { kind: "append_note", path, content };
  const result = runSingleWrite(ctx, op, "brain_append_note");
  return { appended: true, path: result.path };
}

/**
 * Run a single-operation write batch and unwrap its one result, mapping
 * a typed {@link WriteBatchError} to a structured INVALID_PARAMS.
 */
function runSingleWrite(
  ctx: ServerContext,
  op: WriteOperation,
  tool: string,
): { readonly path: string } {
  let batch;
  try {
    batch = applyWriteBatch(ctx.vault, [op]);
  } catch (err) {
    throw writeBatchErrorToMcp(err, tool);
  }
  const only = batch.results[0]!;
  return { path: "path" in only ? only.path : "" };
}

export const NOTES_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_create_note",
    description:
      "Create an actual vault note file (path + frontmatter + content), written atomically inside the vault. Distinct from brain_note, which only appends a log line. Refuses path traversal, the Brain machinery root, vault-scope-excluded paths, and overwriting an existing note.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Vault-relative target path; must end in .md and stay inside the vault.",
        },
        frontmatter: {
          type: "object",
          description:
            "Optional frontmatter map; values are strings, numbers, booleans, or string arrays.",
          additionalProperties: { type: ["string", "number", "boolean", "array"] },
        },
        content: {
          type: "string",
          description: "Optional Markdown body written below the frontmatter.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: toolBrainCreateNote,
  },
  {
    name: "brain_update_note",
    description:
      "Update an existing vault note: merge frontmatter keys and/or replace the body, written atomically. A missing target is refused. Reuses the create-note safety envelope: path traversal, the Brain machinery root, and vault-scope-excluded paths are refused.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Vault-relative path of the existing note; must end in .md.",
        },
        frontmatter: {
          type: "object",
          description:
            "Frontmatter keys to merge into the note; values are strings, numbers, booleans, or string arrays.",
          additionalProperties: { type: ["string", "number", "boolean", "array"] },
        },
        content: {
          type: "string",
          description: "Replacement Markdown body. Omit to keep the existing body.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: toolBrainUpdateNote,
  },
  {
    name: "brain_append_note",
    description:
      "Append Markdown text to the body of an existing vault note, written atomically. A missing target is refused. Reuses the create-note safety envelope: path traversal, the Brain machinery root, and vault-scope-excluded paths are refused.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Vault-relative path of the existing note; must end in .md.",
        },
        content: {
          type: "string",
          description: "Markdown text appended below the current body, separated by a blank line.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    handler: toolBrainAppendNote,
  },
]);
