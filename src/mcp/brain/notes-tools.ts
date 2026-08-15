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

import type { FrontmatterMap, FrontmatterValue } from "../../core/types.ts";
import {
  createNote,
  CreateNoteError,
  CREATE_NOTE_IF_EXISTS,
  NOTE_CONFIG_INVALID_CODE,
  type CreateNoteIfExists,
} from "../../core/brain/notes/create-note.ts";
import {
  applyWriteBatch,
  WriteBatchError,
  type AppendNoteOperation,
  type UpdateNoteOperation,
  type WriteBatchOpResult,
} from "../../core/brain/write-batch.ts";
import { nextCommandField } from "../../core/brain/next-step.ts";
import { lintWrittenPages, pageLintField, type PageLintField } from "../../core/brain/page-lint.ts";
import { WRITE_BINDING_REFUSED_CODE } from "../../core/write-binding/index.ts";
import { isFrontmatterKey } from "../../core/vault.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { coerceBoolOptional, coerceStr, coerceStringOptional } from "../coerce.ts";

/**
 * The two vocabularies a refused write speaks, and the bridge between
 * them.
 *
 * A refusal has always carried TWO names for one concept: the surface
 * code in `data.code` (`write_binding`), which is snake_case because it
 * sits in the same enumeration as `invalid_path` and `excluded` and is
 * what a client branches on; and the advisory registry code
 * (`write-binding-refused`), which is kebab-case because that is the
 * registry's spelling and is what resolves the next command. Renaming
 * either would break the convention of the other, so instead the
 * relationship is made explicit: every refusal that HAS a registered
 * code reports it as `data.diagnostic_code` beside `data.code`, together
 * with the `next_command` it resolves to. An agent that received a code
 * can now find it, and `docs/mcp.md` documents both spellings.
 *
 * A surface code absent from this map has no registered advisory code -
 * stated by leaving it out, never by inventing one.
 */
const DIAGNOSTIC_CODE_FOR_SURFACE_CODE: Readonly<Record<string, string>> = Object.freeze({
  write_binding: WRITE_BINDING_REFUSED_CODE,
  config_invalid: NOTE_CONFIG_INVALID_CODE,
});

/** Key under which a refusal reports the registry spelling of its code. */
const DIAGNOSTIC_CODE_KEY = "diagnostic_code";

/**
 * The advisory fields a surface `code` contributes to an MCP error's
 * `data`, or nothing at all when the code has no registered exit.
 */
export function advisoryFields(code: string): Readonly<Record<string, unknown>> {
  const diagnosticCode = DIAGNOSTIC_CODE_FOR_SURFACE_CODE[code];
  if (diagnosticCode === undefined) return {};
  return Object.freeze({
    [DIAGNOSTIC_CODE_KEY]: diagnosticCode,
    ...nextCommandField(diagnosticCode),
  });
}

/**
 * Surface codes that are NOT the caller's fault. A malformed
 * `Brain/_brain.yaml` refuses every write on this surface no matter what
 * arguments arrive, so reporting it as INVALID_PARAMS would send the
 * agent looking at its own request forever. It is reported as an
 * INTERNAL_ERROR that is nonetheless typed and carries its exit.
 */
const OPERATOR_FAULT_CODES: ReadonlySet<string> = new Set(["config_invalid"]);

/** JSON-RPC code for a refusal, split on whose fault the refusal is. */
function rpcCodeFor(surfaceCode: string): number {
  return OPERATOR_FAULT_CODES.has(surfaceCode) ? INTERNAL_ERROR : INVALID_PARAMS;
}

/**
 * Template variable names are NOT frontmatter keys, and holding them to
 * the frontmatter key grammar would narrow a surface this change has no
 * business narrowing: a variable name never becomes a line of a file,
 * the template parser has its own name grammar, and an unmatched
 * placeholder is deliberately left intact so a typo surfaces in the
 * rendered note. Passing this keeps that arm byte-identical - only the
 * shared VALUE domain was ever meant to be shared.
 */
const ANY_TEMPLATE_VARIABLE_NAME = (): boolean => true;

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
  isKeyLegal: (key: string) => boolean = isFrontmatterKey,
): FrontmatterMap | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new MCPError(INVALID_PARAMS, `${tool}: ${field} must be an object`);
  }
  // Prototype-free target + explicit rejection of prototype-mutating keys:
  // `frontmatter` is untrusted, and a `__proto__`/`constructor`/`prototype`
  // key with an array value would otherwise pollute the object prototype.
  //
  // The prototype triad is not the whole check. A key is also a line of
  // the file the emitter writes, so it is held to the grammar the
  // frontmatter scanner can read back - the same rule
  // `formatFrontmatter` enforces, applied here so the caller learns
  // WHICH argument was wrong instead of receiving the emitter's fault.
  // `FrontmatterKeyError` rejects the prototype triad too (none matches
  // the key grammar); the triad stays named because prototype pollution
  // and an unreadable key are different reasons to say no.
  const out: FrontmatterMap = Object.create(null) as FrontmatterMap;
  for (const [key, raw] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new MCPError(INVALID_PARAMS, `${tool}: invalid ${field} key "${key}"`);
    }
    if (!isKeyLegal(key)) {
      throw new MCPError(
        INVALID_PARAMS,
        `${tool}: ${field} key ${JSON.stringify(key)} is not a key this format can ` +
          "round-trip; use a letter or underscore followed by letters, digits, '_' or '-'",
      );
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
 * Map a core {@link WriteBatchError} onto a structured MCPError so the
 * agent gets a machine-readable rejection (`code`, offending `index`,
 * and the advisory code / next command when the state has one) instead
 * of opaque prose. `tool` prefixes the message. The JSON-RPC code splits
 * exactly as it does for a single note write - see {@link rpcCodeFor} -
 * so a batch and a one-shot report the same state the same way. Any
 * other error is a genuine I/O fault; wrap it in an INTERNAL_ERROR
 * MCPError (mirroring the fallback in {@link toolBrainCreateNote}) so
 * every write surface returns a consistent structured MCPError rather
 * than an opaque throw.
 */
export function writeBatchErrorToMcp(err: unknown, tool: string): MCPError {
  if (err instanceof WriteBatchError) {
    return new MCPError(rpcCodeFor(err.code), `${tool}: ${err.message}`, {
      code: err.code,
      index: err.index,
      ...advisoryFields(err.code),
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
    ANY_TEMPLATE_VARIABLE_NAME,
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
    // never be read as a create by either field. A skip authored no
    // bytes, so it names no page for the lint.
    return noteWriteResult(ctx, res.created ? [res.path] : [], {
      created: res.created,
      outcome: res.outcome,
      path: res.path,
    });
  } catch (err) {
    // Almost every CreateNoteError is a client-input fault (bad path,
    // excluded location, an existing target, an invalid document, a
    // malformed template, a destination outside the declared binding);
    // report it with the typed code, its registry spelling and exit, and
    // the validator's fix list when there is one. `config_invalid` is
    // the exception the split in `rpcCodeFor` exists for: no argument
    // the caller could send would succeed. Anything else is a genuine
    // I/O fault.
    if (err instanceof CreateNoteError) {
      throw new MCPError(rpcCodeFor(err.code), `brain_create_note: ${err.message}`, {
        code: err.code,
        ...advisoryFields(err.code),
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
  const op: UpdateNoteOperation = {
    kind: "update_note",
    path,
    ...(frontmatter !== undefined ? { frontmatter } : {}),
    ...(content !== null ? { body: content } : {}),
  };
  const result = runSingleWrite(ctx, op, "brain_update_note");
  // The flag comes off the kernel result rather than being restated here:
  // one fact, one source.
  return noteWriteResult(ctx, [result.path], { updated: result.updated, path: result.path });
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
  const op: AppendNoteOperation = { kind: "append_note", path, content };
  const result = runSingleWrite(ctx, op, "brain_append_note");
  return noteWriteResult(ctx, [result.path], { appended: result.appended, path: result.path });
}

/** The kernel results that name a note file: exactly the three note ops. */
type NoteOpResult = Extract<WriteBatchOpResult, { readonly path: string }>;

/** The single-note operations these two handlers submit. */
type SingleNoteOperation = UpdateNoteOperation | AppendNoteOperation;

/**
 * Run a single-operation write batch and unwrap its one result, mapping
 * a typed {@link WriteBatchError} to a structured INVALID_PARAMS.
 *
 * The result kind is tied to the operation kind, so the caller reads the
 * kernel's own success flag back without restating it. This used to
 * return `path: "path" in only ? only.path : ""` - an unreachable arm
 * that, had it ever been reached, would have reported a successful write
 * at no path at all. A result whose kind does not match the operation is
 * a broken contract between this layer and the kernel, so it is raised as
 * one rather than papered over with an empty string.
 */
function runSingleWrite<K extends SingleNoteOperation["kind"]>(
  ctx: ServerContext,
  op: Extract<SingleNoteOperation, { readonly kind: K }>,
  tool: string,
): Extract<NoteOpResult, { readonly kind: K }> {
  let batch;
  try {
    batch = applyWriteBatch(ctx.vault, [op]);
  } catch (err) {
    throw writeBatchErrorToMcp(err, tool);
  }
  const only = batch.results[0]!;
  if (only.kind !== op.kind) {
    throw new MCPError(
      INTERNAL_ERROR,
      `${tool}: the write kernel returned a '${only.kind}' result for a '${op.kind}' operation`,
    );
  }
  return only as Extract<NoteOpResult, { readonly kind: K }>;
}

/**
 * The one write-result envelope, adopted by all four note-write tools
 * (evidence-at-the-boundary, task A4).
 *
 * Before this there was no shared envelope at all: four handlers
 * hand-built four shapes, two of them hardcoding a success flag the
 * kernel result already carried. This composes the tool's own receipt
 * with the write-time page lint over exactly the pages the call
 * committed.
 *
 * The lint runs AFTER the commit and reads what is on disk, because the
 * batch kernel wrote the bytes and the handler never composed them. It
 * never gates the write, and it contributes NO key when there is nothing
 * to say - so a receipt for a clean write is byte-identical to the one
 * that shipped before. `pages` empty (a skipped create, a log-only batch)
 * means no bytes were authored, so there is nothing to lint.
 */
export function noteWriteResult<T extends Record<string, unknown>>(
  ctx: ServerContext,
  pages: ReadonlyArray<string>,
  receipt: T,
): T & PageLintField {
  if (pages.length === 0) return receipt;
  return { ...receipt, ...pageLintField(lintWrittenPages(ctx.vault, pages)) };
}

export const NOTES_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_create_note",
    description:
      "Create an actual vault note file (path + frontmatter + content), written atomically inside the vault. Distinct from brain_note, which only appends a log line. Refuses path traversal, the Brain root, vault-scope-excluded paths, writes outside the declared write binding, and by default clobbering.",
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
      "Update an existing vault note: merge frontmatter keys and/or replace the body, written atomically. A missing target is refused. Reuses the create-note safety envelope: path traversal, the Brain root, vault-scope-excluded paths, and writes outside the declared write binding are refused.",
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
      "Append Markdown text to the body of an existing vault note, written atomically. A missing target is refused. Reuses the create-note safety envelope: path traversal, the Brain root, vault-scope-excluded paths, and writes outside the declared write binding are refused.",
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
