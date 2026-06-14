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
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tools.ts";
import { coerceStr } from "../coerce.ts";

/**
 * Narrow an untrusted `frontmatter` argument to a {@link FrontmatterMap}.
 * Accepts a plain object whose values are strings, numbers, booleans, or
 * string arrays (the frontmatter value domain); rejects anything else
 * with INVALID_PARAMS rather than silently dropping it.
 */
function parseFrontmatterArg(value: unknown): FrontmatterMap | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new MCPError(INVALID_PARAMS, "brain_create_note: frontmatter must be an object");
  }
  // Prototype-free target + explicit rejection of prototype-mutating keys:
  // `frontmatter` is untrusted, and a `__proto__`/`constructor`/`prototype`
  // key with an array value would otherwise pollute the object prototype.
  const out: FrontmatterMap = Object.create(null) as FrontmatterMap;
  for (const [key, raw] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new MCPError(INVALID_PARAMS, `brain_create_note: invalid frontmatter key "${key}"`);
    }
    let coerced: FrontmatterValue;
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      coerced = raw;
    } else if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) {
      coerced = raw.filter((item): item is string => typeof item === "string");
    } else {
      throw new MCPError(
        INVALID_PARAMS,
        `brain_create_note: frontmatter.${key} must be a string, number, boolean, or string array`,
      );
    }
    out[key] = coerced;
  }
  return out;
}

async function toolBrainCreateNote(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const path = coerceStr(args, "path", true)!;
  const content = coerceStr(args, "content", false);
  const frontmatter = parseFrontmatterArg(args["frontmatter"]);

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
]);
