/**
 * Brain note-authoring surface: `brain_create_note`.
 *
 * Distinct from `brain_note` (which appends one narrative line to the
 * daily log), this tool writes an actual vault note file - path,
 * frontmatter, and body - through the shared `createNote` primitive.
 * The primitive enforces the vault-scope, path-traversal, Brain-root,
 * write-binding, and no-clobber guards; this handler only coerces
 * arguments and maps the typed `CreateNoteError` onto an MCPError.
 *
 * That mapping splits on WHOSE fault the refusal is, not on which error
 * class arrived: a caller-input fault is an INVALID_PARAMS the caller can
 * act on, while a vault whose own config does not load is an
 * INTERNAL_ERROR, because no argument would have succeeded. Both carry
 * the typed `code`, and both carry the advisory registry spelling of that
 * code plus its next command when one is registered - see
 * {@link advisoryFields}.
 *
 * This module also hosts {@link noteWriteResult}, the ONE write-result
 * envelope all four note-write tools return through - the three here plus
 * `brain_write_batch`, which already imports this module's argument
 * parser and error mapper. It attaches the write-time page lint
 * (`core/brain/page-lint.ts`) as an additive key that is absent entirely
 * when the pages the call committed are clean.
 */

import { CREATE_NOTE_IF_EXISTS } from "../../core/brain/notes/create-note.ts";
import type { ToolDefinition } from "../tool-contract.ts";
import {
  toolBrainAppendNote,
  toolBrainCreateNote,
  toolBrainUpdateNote,
} from "./notes-write-tools.ts";

export { advisoryFields, parseFrontmatterArg, writeBatchErrorToMcp } from "./notes-shared.ts";
export { noteWriteResult } from "./notes-write-tools.ts";

export const NOTES_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_create_note",
    kind: "write",
    description:
      "Create an actual vault note file (path + frontmatter + content), written atomically inside the vault. Distinct from brain_note, which only appends a log line. Refuses traversal, the Brain root, excluded paths, bad write bindings, default clobbering. An applied create claims a detached index refresh.",
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
    kind: "write",
    description:
      "Update an existing vault note: merge frontmatter keys and/or replace the body, atomically; a missing target is refused. Reuses the create-note safety envelope: traversal, the Brain root, excluded paths, bad write bindings. An applied update claims a detached index refresh.",
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
        allow_empty: {
          type: "boolean",
          description:
            "Allow empty or whitespace-only content to clear the note. Default false: a blank body over a note that has text is refused as an accidental clear.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: toolBrainUpdateNote,
  },
  {
    name: "brain_append_note",
    kind: "write",
    description:
      "Append Markdown text to an existing vault note's body, written atomically. A missing target is refused. Reuses the create-note safety envelope: traversal, the Brain root, excluded paths, and writes outside the declared write binding are refused. An applied append claims a detached index refresh.",
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
