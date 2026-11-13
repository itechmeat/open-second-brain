/**
 * The write plumbing the note tools share (task 3.19): the two
 * vocabularies a refused write speaks and the bridge between them, the
 * RPC code a surfaced fault maps to, the frontmatter argument's parser
 * with its template limits, and the fallback that turns a write-batch
 * failure into an MCP error. Split from `notes-tools.ts`.
 */

import type { FrontmatterMap, FrontmatterValue } from "../../core/types.ts";
import { NOTE_CONFIG_INVALID_CODE } from "../../core/brain/notes/create-note.ts";
import { WriteBatchError } from "../../core/brain/write-batch.ts";
import { nextCommandField } from "../../core/brain/next-step.ts";
import {
  PendingStageConflictError,
  WriteRefusedError,
} from "../../core/brain/pending/pending-lanes.ts";
import { WRITE_BINDING_REFUSED_CODE } from "../../core/write-binding/index.ts";
import { isFrontmatterKey } from "../../core/vault.ts";
import { rethrowVaultFrozen } from "../frozen-refusal.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, type JsonRpcErrorCode, MCPError } from "../protocol.ts";

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
export const DIAGNOSTIC_CODE_FOR_SURFACE_CODE: Readonly<Record<string, string>> = Object.freeze({
  write_binding: WRITE_BINDING_REFUSED_CODE,
  config_invalid: NOTE_CONFIG_INVALID_CODE,
});

/** Key under which a refusal reports the registry spelling of its code. */
export const DIAGNOSTIC_CODE_KEY = "diagnostic_code";

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
 * arguments arrive, and a target the process cannot read refuses this
 * one no matter how the request is rephrased - the path is right and the
 * host is what is broken. Reporting either as INVALID_PARAMS would send
 * the agent looking at its own request forever. Both are reported as an
 * INTERNAL_ERROR that is nonetheless typed and carries its details.
 * Frontmatter the scanner cannot round-trip joins them for the same
 * reason: the note on disk is what needs fixing, not the request.
 */
export const OPERATOR_FAULT_CODES: ReadonlySet<string> = new Set([
  "config_invalid",
  "target_unreadable",
  "target_frontmatter_lossy",
]);

/** JSON-RPC code for a refusal, split on whose fault the refusal is. */
export function rpcCodeFor(surfaceCode: string): JsonRpcErrorCode {
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
export const ANY_TEMPLATE_VARIABLE_NAME = (): boolean => true;

/**
 * Longest accepted body template. A template is a note skeleton, not a
 * payload; the rendered note is bounded separately by the artifact cap
 * that `strict` enforces.
 */
export const TEMPLATE_MAX_LEN = 32_768;

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
  rethrowVaultFrozen(err);
  if (err instanceof WriteBatchError) {
    return new MCPError(rpcCodeFor(err.code), `${tool}: ${err.message}`, {
      code: err.code,
      index: err.index,
      ...advisoryFields(err.code),
      ...err.details,
    });
  }
  // Write-side trust (Task 12): a permissions document rule denied one of
  // the batch's ops. Named code, the rule that decided, and the operator
  // exit - the batch aborted before any commit, so the refusal is the
  // whole answer.
  if (err instanceof WriteRefusedError) {
    return new MCPError(INVALID_PARAMS, `${tool}: ${err.message}`, {
      code: err.code,
      rule: err.rule,
      agent: err.agent,
      next_command: err.nextCommand,
    });
  }
  // A staged op retried while its first run is still pending: the queue
  // refuses by name, so the answer names the queue entry holding the
  // target instead of an internal error a caller would retry into.
  if (err instanceof PendingStageConflictError) {
    return new MCPError(INVALID_PARAMS, `${tool}: ${err.message}`, {
      code: err.code,
      existing_id: err.existingId,
      target: err.target,
    });
  }
  // An answer already shaped for the wire keeps its code.
  if (err instanceof MCPError) return err;
  return new MCPError(INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
}
