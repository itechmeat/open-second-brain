/**
 * The closed registry of error codes the MCP boundary answers with.
 *
 * Open Second Brain answers a failed tool call on one of two channels: a
 * JSON-RPC error (`error.data.code`) or an `isError` result
 * (`_meta["open-second-brain/error"].code`). Both carry one member of
 * {@link TOOL_ERROR_CODES}, so a client branches on a token instead of
 * matching English prose.
 *
 * The registry does not rename anything already on the wire. It imports
 * the core vocabularies verbatim - kebab, snake and UPPER spellings stay
 * as their owners chose them - and adds lower snake_case tokens
 * ({@link TOOL_ERROR_CODE}) only for the failures that had no code at all.
 *
 * Core vocabularies that exist only as a TypeScript union are listed here
 * through {@link exhaustiveMembers}, which fails `tsc` both when an entry
 * is not a member of the union and when a union member is missing, so a
 * code added in the core cannot reach the wire unregistered.
 *
 * {@link codeForError} classifies a thrown value by `instanceof` over a
 * closed table and never reads a `.code` structurally: a Node fs error
 * carries `ENOENT`, which is no member of this registry. Anything the
 * table does not know is the explicit {@link TOOL_ERROR_CODE.internalError}
 * and is named on stderr by its class name only, never by its message, so
 * no vault path reaches a log at remote reach.
 */

import { BrainPreferenceNotFoundError } from "../core/brain/apply-evidence.ts";
import { CountGuardError } from "../core/brain/count-guard.ts";
import { QuoteCheckError } from "../core/brain/distill/quote-verdict.ts";
import type { ExactStateErrorCode } from "../core/brain/exact-state.ts";
import { ExactStateError } from "../core/brain/exact-state.ts";
import {
  EXPIRATION_REFUSAL_CODE,
  EXPIRATION_REFUSAL_CODES,
  ExpirationTargetNotFoundError,
  ExpirationValueError,
  InvalidExpirationTargetError,
} from "../core/brain/expiration-set.ts";
import { VaultFrozenError } from "../core/brain/freeze-marker.ts";
import type { HostMemoryWriteErrorCode } from "../core/brain/host-memory-write.ts";
import { HostMemoryWriteError } from "../core/brain/host-memory-write.ts";
import type { CreateNoteErrorCode } from "../core/brain/notes/create-note.ts";
import { CreateNoteError } from "../core/brain/notes/create-note.ts";
import type { NoteLifecycleErrorCode } from "../core/brain/notes/lifecycle.ts";
import { NoteLifecycleError } from "../core/brain/notes/lifecycle.ts";
import type { NoteTemplateErrorCode } from "../core/brain/notes/note-template.ts";
import { NoteTemplateError } from "../core/brain/notes/note-template.ts";
import type { NoteTitleResolutionErrorCode } from "../core/brain/notes/note-title-resolver.ts";
import { NoteTitleResolutionError } from "../core/brain/notes/note-title-resolver.ts";
import { NOTE_REVERT_ERROR, NoteRevertError } from "../core/brain/notes/revert.ts";
import type { ScaffoldStubErrorCode } from "../core/brain/notes/scaffold-stub.ts";
import { ScaffoldStubError } from "../core/brain/notes/scaffold-stub.ts";
import { BrainParseError } from "../core/brain/parse-error.ts";
import type { PinnedBatchErrorCode } from "../core/brain/pinned.ts";
import { PinnedBatchError } from "../core/brain/pinned.ts";
import { BrainConfigError } from "../core/brain/policy/errors.ts";
import { ResponseCheckError, SEMANTIC_VIOLATION_CODES } from "../core/brain/response-checks.ts";
import { ResponseShapeError, SHAPE_VIOLATION_CODES } from "../core/brain/response-shape.ts";
import { SafeguardAbortError, SafeguardTimeoutError } from "../core/brain/safeguard.ts";
import type { WriteBatchErrorCode } from "../core/brain/write-batch.ts";
import { WriteBatchError } from "../core/brain/write-batch.ts";
import { ConfigReadError } from "../core/config.ts";
import { SEARCH_ERROR_CODES, SearchError } from "../core/search/search-error.ts";
import { WRITE_BINDING_REFUSED_CODE } from "../core/write-binding/index.ts";
import { VAULT_FROZEN_REFUSAL } from "./frozen-refusal.ts";
import { OWNER_SCOPE_REFUSALS } from "./owner-scope-refusal.ts";
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  type JsonRpcErrorCode,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
} from "./protocol.ts";
import { OutputContractError } from "./output-contract.ts";
import { REACH_REFUSAL } from "./reach-refusal.ts";

/** The `_meta` key an `isError` result carries its code under. */
export const TOOL_ERROR_META_KEY = "open-second-brain/error";

/** Payload schema tag, versioned like `o2b.progress.v1`. */
export const TOOL_ERROR_SCHEMA = "o2b.error.v1";

/**
 * The generic tokens this registry adds: one per failure that reaches the
 * boundary with no code of its own. Each has a producer in this release.
 */
export const TOOL_ERROR_CODE = Object.freeze({
  /** The five JSON-RPC defaults, one per {@link JsonRpcErrorCode}. */
  parseError: "parse_error",
  invalidRequest: "invalid_request",
  methodNotFound: "method_not_found",
  invalidParams: "invalid_params",
  /** A throw the classifier does not know; logged by name on stderr. */
  internalError: "internal_error",
  /** A safeguard deadline aborted the operation at a checkpoint. */
  safeguardTimeout: "safeguard_timeout",
  /** The operation's abort signal fired on demand. */
  safeguardAborted: "safeguard_aborted",
  /** A tool's result did not match its declared output schema. */
  outputContractFailed: "output_contract_failed",
  /** The plugin config file exists and could not be read. */
  configUnreadable: "config_unreadable",
  /** A `SkillError` of kind `NOT_FOUND`. */
  skillNotFound: "skill_not_found",
  /** A `SkillError` of kind `INVALID_PATH`. */
  skillInvalidPath: "skill_invalid_path",
  /** A skill name the registry does not hold. */
  unknownSkill: "unknown_skill",
  /** An `operation` argument outside the tool's closed set. */
  unknownOperation: "unknown_operation",
  /** A `status` argument outside the tool's closed set. */
  invalidStatus: "invalid_status",
  /** A trigger transition refused; absent and not-visible share it. */
  triggerTransitionRefused: "trigger_transition_refused",
  /** A `session_id` that names no write session. */
  writeSessionUnknown: "write_session_unknown",
  /** A write session that is already committed or aborted. */
  writeSessionTerminal: "write_session_terminal",
  /** An operation that needs a write session was sent without one. */
  sessionIdRequired: "session_id_required",
  /** An argument the tool's input schema does not declare. */
  unknownArgument: "unknown_argument",
  /** A Brain artifact file could not be parsed (`BrainParseError`). */
  brainArtifactUnparseable: "brain_artifact_unparseable",
  /** An argument that belongs to another action of the same tool. */
  argumentForbidden: "argument_forbidden",
  /** A strict distillation refused a quoted span it could not verify. */
  quoteUnverified: "quote_unverified",
} as const);

/** Closed union over {@link TOOL_ERROR_CODE}. */
export type GenericToolErrorCode = (typeof TOOL_ERROR_CODE)[keyof typeof TOOL_ERROR_CODE];

/** Membership list of the generic tokens alone. */
export const GENERIC_TOOL_ERROR_CODES: ReadonlyArray<GenericToolErrorCode> = Object.freeze(
  Object.values(TOOL_ERROR_CODE),
);

const GENERIC_TOOL_ERROR_CODE_SET: ReadonlySet<string> = new Set(GENERIC_TOOL_ERROR_CODES);

/** Narrow a value to one of the generic tokens this registry adds. */
export function isGenericToolErrorCode(value: unknown): value is GenericToolErrorCode {
  return typeof value === "string" && GENERIC_TOOL_ERROR_CODE_SET.has(value);
}

/**
 * The members `Union` lacks from `List`, or `never` when `List` names them
 * all. A non-`never` result is what makes {@link exhaustiveMembers} fail.
 */
type MissingMembers<Union, List extends ReadonlyArray<Union>> = Exclude<Union, List[number]>;

/**
 * Freeze the member list of a type-only core vocabulary, checked by `tsc`
 * in both directions: an entry outside `Union` is rejected by the element
 * type, and a member of `Union` absent from the list turns the argument
 * type into an object naming it, which no array literal satisfies.
 */
function exhaustiveMembers<Union extends string>() {
  return <const List extends ReadonlyArray<Union>>(
    list: List &
      ([MissingMembers<Union, List>] extends [never]
        ? unknown
        : { readonly missingMembers: MissingMembers<Union, List> }),
  ): List => Object.freeze([...list]) as unknown as List;
}

const WRITE_BATCH_CODES = exhaustiveMembers<WriteBatchErrorCode>()([
  "invalid_operation",
  "invalid_path",
  "excluded",
  "outside_vault",
  "exists",
  "target_missing",
  "target_unreadable",
  "target_frontmatter_lossy",
  "blank_overwrite_refused",
  "reserved_frontmatter_key",
  "duplicate_target",
  "too_many_operations",
  "preference_not_found",
  "write_binding",
  "invalid_document",
  "invalid_template",
  "config_invalid",
]);

const CREATE_NOTE_CODES = exhaustiveMembers<CreateNoteErrorCode>()([
  "invalid_path",
  "excluded",
  "exists",
  "outside_vault",
  "invalid_document",
  "invalid_template",
  "write_binding",
  "config_invalid",
]);

const NOTE_LIFECYCLE_CODES = exhaustiveMembers<NoteLifecycleErrorCode>()([
  "source_missing",
  "destination_required",
  "destination_forbidden",
  "destination_occupied",
  "destination_unchanged",
  "wrong_action",
  "not_confirmed",
  "already_archived",
  "cascade_forbidden",
]);

const SCAFFOLD_STUB_CODES = exhaustiveMembers<ScaffoldStubErrorCode>()([
  "empty_target",
  "target_resolves",
  "target_ambiguous",
  "unknown_source",
]);

const NOTE_TITLE_RESOLUTION_CODES = exhaustiveMembers<NoteTitleResolutionErrorCode>()([
  "empty_target",
  "path_not_found",
  "not_found",
  "ambiguous",
]);

const NOTE_TEMPLATE_CODES = exhaustiveMembers<NoteTemplateErrorCode>()([
  "unbalanced_section",
  "section_too_deep",
  "invalid_variable",
]);

const PINNED_BATCH_CODES = exhaustiveMembers<PinnedBatchErrorCode>()([
  "invalid_operation",
  "replace_target_missing",
  "budget_exceeded",
]);

const EXACT_STATE_CODES = exhaustiveMembers<ExactStateErrorCode>()([
  "budget_exceeded",
  "invalid_aspect",
]);

const HOST_MEMORY_WRITE_CODES = exhaustiveMembers<HostMemoryWriteErrorCode>()([
  "invalid_action",
  "invalid_target",
  "empty_content",
]);

/**
 * The token a count-guard refusal is reported under on the wire. The core
 * `CountGuardError` carries `COUNT_GUARD`; `brain_note_lifecycle` has
 * always answered it as this lower-case token, and this registry keeps the
 * wire spelling rather than the class field. `brain_note_lifecycle` imports
 * it, so the spelling has one definition.
 */
export const COUNT_GUARD_WIRE_CODE = "count_guard";

/**
 * Every code the MCP boundary may answer with: the generic tokens plus
 * each imported vocabulary, de-duplicated (several core vocabularies share
 * a token such as `invalid_path`, and it means the same thing in each).
 */
export const TOOL_ERROR_CODES = Object.freeze([
  ...new Set([
    ...GENERIC_TOOL_ERROR_CODES,
    ...SEARCH_ERROR_CODES,
    ...Object.values(SHAPE_VIOLATION_CODES),
    ...Object.values(SEMANTIC_VIOLATION_CODES),
    VAULT_FROZEN_REFUSAL,
    WRITE_BINDING_REFUSED_CODE,
    REACH_REFUSAL,
    ...OWNER_SCOPE_REFUSALS,
    ...WRITE_BATCH_CODES,
    ...CREATE_NOTE_CODES,
    ...NOTE_LIFECYCLE_CODES,
    ...Object.values(NOTE_REVERT_ERROR),
    ...SCAFFOLD_STUB_CODES,
    ...NOTE_TITLE_RESOLUTION_CODES,
    ...NOTE_TEMPLATE_CODES,
    ...PINNED_BATCH_CODES,
    ...EXACT_STATE_CODES,
    ...HOST_MEMORY_WRITE_CODES,
    COUNT_GUARD_WIRE_CODE,
    ...EXPIRATION_REFUSAL_CODES,
  ] as const),
]);

/** Closed union over {@link TOOL_ERROR_CODES}. */
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

const TOOL_ERROR_CODE_SET: ReadonlySet<string> = new Set(TOOL_ERROR_CODES);

/** Narrow a value read back off the wire to a registered code. */
export function isToolErrorCode(value: unknown): value is ToolErrorCode {
  return typeof value === "string" && TOOL_ERROR_CODE_SET.has(value);
}

/** The `_meta` payload an `isError` result carries. */
export interface ToolErrorMeta {
  readonly schema: typeof TOOL_ERROR_SCHEMA;
  readonly code: ToolErrorCode;
}

/** Build the `_meta["open-second-brain/error"]` payload for `code`. */
export function toolErrorMeta(code: ToolErrorCode): ToolErrorMeta {
  return { schema: TOOL_ERROR_SCHEMA, code };
}

/** Total map from each JSON-RPC error code to its string default. */
const RPC_DEFAULT_CODE: Readonly<Record<JsonRpcErrorCode, GenericToolErrorCode>> = Object.freeze({
  [PARSE_ERROR]: TOOL_ERROR_CODE.parseError,
  [INVALID_REQUEST]: TOOL_ERROR_CODE.invalidRequest,
  [METHOD_NOT_FOUND]: TOOL_ERROR_CODE.methodNotFound,
  [INVALID_PARAMS]: TOOL_ERROR_CODE.invalidParams,
  [INTERNAL_ERROR]: TOOL_ERROR_CODE.internalError,
});

/** The code a JSON-RPC error carries when its thrower named none. */
export function defaultCodeForRpc(code: JsonRpcErrorCode): ToolErrorCode {
  return RPC_DEFAULT_CODE[code];
}

/** A class constructor, matched by `instanceof`. */
type ErrorClass<E extends Error> = abstract new (...args: never[]) => E;

/** How one known class is classified: a fixed code, or the code it carries. */
interface ClassificationRule {
  readonly matches: (exc: unknown) => boolean;
  readonly code: (exc: Error) => string;
}

function fixed<E extends Error>(ctor: ErrorClass<E>, code: ToolErrorCode): ClassificationRule {
  return { matches: (exc) => exc instanceof ctor, code: () => code };
}

function carried<E extends Error & { readonly code: string }>(
  ctor: ErrorClass<E>,
): ClassificationRule {
  return { matches: (exc) => exc instanceof ctor, code: (exc) => (exc as E).code };
}

/**
 * The closed classification table. A carried code still has to pass
 * {@link isToolErrorCode} before it reaches the wire.
 */
const CLASSIFICATION: ReadonlyArray<ClassificationRule> = Object.freeze([
  carried(WriteBatchError),
  carried(CreateNoteError),
  carried(NoteLifecycleError),
  carried(NoteRevertError),
  carried(ScaffoldStubError),
  carried(NoteTitleResolutionError),
  carried(NoteTemplateError),
  carried(PinnedBatchError),
  carried(ExactStateError),
  carried(HostMemoryWriteError),
  carried(SearchError),
  carried(ResponseShapeError),
  carried(ResponseCheckError),
  fixed(CountGuardError, COUNT_GUARD_WIRE_CODE),
  fixed(VaultFrozenError, VAULT_FROZEN_REFUSAL),
  fixed(SafeguardTimeoutError, TOOL_ERROR_CODE.safeguardTimeout),
  fixed(SafeguardAbortError, TOOL_ERROR_CODE.safeguardAborted),
  fixed(ConfigReadError, TOOL_ERROR_CODE.configUnreadable),
  fixed(OutputContractError, TOOL_ERROR_CODE.outputContractFailed),
  fixed(BrainConfigError, "config_invalid"),
  fixed(BrainPreferenceNotFoundError, "preference_not_found"),
  fixed(BrainParseError, TOOL_ERROR_CODE.brainArtifactUnparseable),
  fixed(ExpirationValueError, EXPIRATION_REFUSAL_CODE.invalidValue),
  fixed(ExpirationTargetNotFoundError, EXPIRATION_REFUSAL_CODE.targetNotFound),
  fixed(InvalidExpirationTargetError, EXPIRATION_REFUSAL_CODE.invalidTarget),
  fixed(QuoteCheckError, TOOL_ERROR_CODE.quoteUnverified),
]);

/**
 * How many `cause` links the classifier follows. A tool that rethrows a
 * typed error as a plain one keeps the original as `cause` (the feedback
 * rethrow does); a bounded walk also stops a cyclic chain.
 */
const MAX_CAUSE_DEPTH = 4;

const UNCLASSIFIED_WARNING = "warning: unclassified tool error mapped to internal_error: ";

function classifyOne(exc: unknown): ToolErrorCode | undefined {
  if (!(exc instanceof Error)) return undefined;
  for (const rule of CLASSIFICATION) {
    if (!rule.matches(exc)) continue;
    const code = rule.code(exc);
    return isToolErrorCode(code) ? code : undefined;
  }
  return undefined;
}

/**
 * The name an unclassified throw is logged under; never its message. The
 * constructor's name comes first because several core error classes never
 * set `this.name`, and would all be logged as `Error`.
 */
function unclassifiedName(exc: unknown): string {
  return exc instanceof Error ? exc.constructor?.name || exc.name : typeof exc;
}

/**
 * The registered code for a thrown value. Walks `cause` up to
 * {@link MAX_CAUSE_DEPTH} links; a throw no rule classifies is
 * `internal_error`, and one stderr line names its class.
 */
export function codeForError(exc: unknown): ToolErrorCode {
  let current: unknown = exc;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current !== undefined; depth += 1) {
    const code = classifyOne(current);
    if (code !== undefined) return code;
    current = current instanceof Error ? current.cause : undefined;
  }
  process.stderr.write(`${UNCLASSIFIED_WARNING}${unclassifiedName(exc)}\n`);
  return TOOL_ERROR_CODE.internalError;
}
