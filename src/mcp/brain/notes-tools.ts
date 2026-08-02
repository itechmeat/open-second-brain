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
import {
  createNote,
  CreateNoteError,
  CREATE_NOTE_IF_EXISTS,
  type CreateNoteIfExists,
} from "../../core/brain/notes/create-note.ts";
import {
  applyWriteBatch,
  WriteBatchError,
  type WriteOperation,
} from "../../core/brain/write-batch.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { coerceBoolOptional, coerceStr, coerceStringOptional } from "../coerce.ts";

/**
 * Longest accepted body template. A template is a note skeleton, not a
 * payload; the rendered note is bounded separately by the artifact cap
 * that `strict` enforces.
 */
const TEMPLATE_MAX_LEN = 32_768;

/**
 * Narrow an untrusted argument to a {@link FrontmatterMap}. Accepts a
 * plain object whose values are strings, numbers, booleans, or string
 * arrays (the frontmatter value domain); rejects anything else with
 * INVALID_PARAMS rather than silently dropping it. `tool` names the
 * calling surface and `field` the argument, so the rejection points at
 * the exact thing the caller got wrong - template variables share this
 * value domain deliberately rather than growing a second one.
 */
export function parseFrontmatterArg(
  value: unknown,
  tool: string,
  field = "frontmatter",
): FrontmatterMap | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new MCPError(INVALID_PARAMS, `${tool}: ${field} must be an object`);
  }
  // Prototype-free target + explicit rejection of prototype-mutating keys:
  // `frontmatter` is untrusted, and a `__proto__`/`constructor`/`prototype`
  // key with an array value would otherwise pollute the object prototype.
  const out: FrontmatterMap = Object.create(null) as FrontmatterMap;
  for (const [key, raw] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new MCPError(INVALID_PARAMS, `${tool}: invalid ${field} key "${key}"`);
    }
    let coerced: FrontmatterValue;
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      coerced = raw;
    } else if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) {
      coerced = raw.filter((item): item is string => typeof item === "string");
    } else {
      throw new MCPError(
        INVALID_PARAMS,
        `${tool}: ${field}.${key} must be a string, number, boolean, or string array`,
      );
    }
    out[key] = coerced;
  }
  return out;
}

/**
 * Map a core {@link WriteBatchError} onto a structured INVALID_PARAMS so
 * the agent gets a machine-readable rejection (`code`, offending `index`)
 * instead of opaque prose. `tool` prefixes the message. Any other error is
 * a genuine I/O fault; wrap it in an INTERNAL_ERROR MCPError (mirroring the
 * fallback in {@link toolBrainCreateNote}) so every write surface returns a
 * consistent structured MCPError rather than an opaque throw.
 */
export function writeBatchErrorToMcp(err: unknown, tool: string): MCPError {
  if (err instanceof WriteBatchError) {
    return new MCPError(INVALID_PARAMS, `${tool}: ${err.message}`, {
      code: err.code,
      index: err.index,
      ...err.details,
    });
  }
  return new MCPError(INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
}

/**
 * Read the occupied-target policy. An unrecognised value is refused
 * rather than falling back to the default: a caller that asked for a
 * disposition this tool does not have must not be told its write
 * succeeded under a different one.
 */
function coerceIfExists(args: Record<string, unknown>): CreateNoteIfExists | undefined {
  const raw = coerceStringOptional(args, "if_exists", 16);
  if (raw === undefined) return undefined;
  const match = CREATE_NOTE_IF_EXISTS.find((policy) => policy === raw);
  if (match === undefined) {
    throw new MCPError(
      INVALID_PARAMS,
      `brain_create_note: if_exists must be one of ${CREATE_NOTE_IF_EXISTS.join(", ")}`,
    );
  }
  return match;
}

async function toolBrainCreateNote(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const path = coerceStr(args, "path", true)!;
  const content = coerceStr(args, "content", false);
  const frontmatter = parseFrontmatterArg(args["frontmatter"], "brain_create_note");
  const ifExists = coerceIfExists(args);
  const strict = coerceBoolOptional(args, "strict");
  const template = coerceStringOptional(args, "template", TEMPLATE_MAX_LEN);
  const templateVariables = parseFrontmatterArg(
    args["template_variables"],
    "brain_create_note",
    "template_variables",
  );

  try {
    const res = createNote(ctx.vault, {
      path,
      ...(frontmatter !== undefined ? { frontmatter } : {}),
      ...(content !== null && content !== undefined ? { content } : {}),
      ...(ifExists !== undefined ? { ifExists } : {}),
      ...(strict !== undefined ? { strict } : {}),
      ...(template !== undefined ? { template } : {}),
      ...(templateVariables !== undefined ? { templateVariables } : {}),
    });
    // `outcome` is the discriminant; `created` is the boolean this tool
    // has always returned and stays in lockstep with it, so a skip can
    // never be read as a create by either field.
    return { created: res.created, outcome: res.outcome, path: res.path };
  } catch (err) {
    // Every CreateNoteError is a client-input fault (bad path, excluded
    // location, an existing target, an invalid document, or a malformed
    // template); report it as INVALID_PARAMS with the typed code, and
    // attach the validator's fix list when there is one. Anything else
    // is a genuine I/O fault.
    if (err instanceof CreateNoteError) {
      throw new MCPError(INVALID_PARAMS, `brain_create_note: ${err.message}`, {
        code: err.code,
        ...(err.violations.length > 0 ? { violations: err.violations } : {}),
      });
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
      "Create an actual vault note file (path + frontmatter + content), written atomically inside the vault. Distinct from brain_note, which only appends a log line. Refuses path traversal, the Brain machinery root, vault-scope-excluded paths, and by default overwriting an existing note.",
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
          description:
            "Optional Markdown body written below the frontmatter. Mutually exclusive with template.",
        },
        if_exists: {
          type: "string",
          enum: [...CREATE_NOTE_IF_EXISTS],
          description:
            "Occupied-target policy. Default refuse. skip leaves the note untouched and returns outcome=skipped, never created.",
        },
        strict: {
          type: "boolean",
          description:
            "Validate the document before writing (frontmatter present, size, control chars, declared type in page_types) and refuse with coded violations.",
        },
        template: {
          type: "string",
          description:
            "Body template instead of content. Two constructs: {{name}} substitution, and {{#name}}..{{/name}} presence sections / list iteration where {{.}} is the item.",
        },
        template_variables: {
          type: "object",
          description:
            "Values the template references; same domain as frontmatter. Unknown placeholders are left intact so a typo surfaces.",
          additionalProperties: { type: ["string", "number", "boolean", "array"] },
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
