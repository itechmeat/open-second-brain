/**
 * The closed MCP-boundary error registry.
 *
 * Every tool failure the server answers carries one code from
 * `TOOL_ERROR_CODES`. The registry imports the core vocabularies verbatim
 * and adds lower snake_case tokens for the uncoded remainder, so these
 * tests pin three things: the list is closed and complete, the tokens the
 * wire already carries are members unchanged, and the classifier never
 * invents a code - an error it does not know is `internal_error`, named on
 * stderr by its class name only.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";

import { BrainPreferenceNotFoundError } from "../../src/core/brain/apply-evidence.ts";
import { CountGuardError } from "../../src/core/brain/count-guard.ts";
import {
  ExpirationTargetNotFoundError,
  ExpirationValueError,
  InvalidExpirationTargetError,
} from "../../src/core/brain/expiration-set.ts";
import { BrainParseError } from "../../src/core/brain/parse-error.ts";
import { BrainStatusFolderMismatchError } from "../../src/core/brain/preference.ts";
import { PinnedBatchError } from "../../src/core/brain/pinned.ts";
import { BrainConfigError } from "../../src/core/brain/policy/errors.ts";
import { SHAPE_VIOLATION_CODES } from "../../src/core/brain/response-shape.ts";
import { SEMANTIC_VIOLATION_CODES } from "../../src/core/brain/response-checks.ts";
import { SafeguardAbortError, SafeguardTimeoutError } from "../../src/core/brain/safeguard.ts";
import { WriteBatchError } from "../../src/core/brain/write-batch.ts";
import { ConfigReadError } from "../../src/core/config.ts";
import { SEARCH_ERROR_CODES, SearchError } from "../../src/core/search/search-error.ts";
import { WRITE_BINDING_REFUSED_CODE } from "../../src/core/write-binding/index.ts";
import { VAULT_FROZEN_REFUSAL } from "../../src/mcp/frozen-refusal.ts";
import { OutputContractError } from "../../src/mcp/output-contract.ts";
import { OWNER_SCOPE_REFUSALS } from "../../src/mcp/owner-scope-refusal.ts";
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
} from "../../src/mcp/protocol.ts";
import { REACH_REFUSAL } from "../../src/mcp/reach-refusal.ts";
import {
  GENERIC_TOOL_ERROR_CODES,
  TOOL_ERROR_CODE,
  TOOL_ERROR_CODES,
  TOOL_ERROR_META_KEY,
  TOOL_ERROR_SCHEMA,
  codeForError,
  defaultCodeForRpc,
  isGenericToolErrorCode,
  isToolErrorCode,
  toolErrorMeta,
} from "../../src/mcp/tool-error-codes.ts";

/**
 * Decision 5 of the design plus `brain_artifact_unparseable` and
 * `argument_forbidden` (on the wire before the registry existed): the generic
 * tokens this release adds.
 */
const NEW_TOKENS = [
  "parse_error",
  "invalid_request",
  "method_not_found",
  "invalid_params",
  "internal_error",
  "safeguard_timeout",
  "safeguard_aborted",
  "output_contract_failed",
  "config_unreadable",
  "skill_not_found",
  "skill_invalid_path",
  "unknown_skill",
  "unknown_operation",
  "invalid_status",
  "trigger_transition_refused",
  "write_session_unknown",
  "write_session_terminal",
  "session_id_required",
  "unknown_argument",
  "brain_artifact_unparseable",
  "argument_forbidden",
] as const;

/**
 * Members of the type-only core vocabularies, spelled out here as the
 * independent oracle: the registry's own arrays are checked against the
 * core unions by `tsc`, and against this list by the test.
 */
const TYPE_ONLY_MEMBERS = [
  // write batch
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
  // note lifecycle
  "source_missing",
  "destination_required",
  "destination_forbidden",
  "destination_occupied",
  "destination_unchanged",
  "wrong_action",
  "not_confirmed",
  "already_archived",
  "cascade_forbidden",
  // note revert
  "unbounded_selector",
  "digest_mismatch",
  "nothing_to_apply",
  // scaffold stub
  "empty_target",
  "target_resolves",
  "target_ambiguous",
  "unknown_source",
  // note title resolution
  "path_not_found",
  "not_found",
  "ambiguous",
  // note template
  "unbalanced_section",
  "section_too_deep",
  "invalid_variable",
  // pinned
  "replace_target_missing",
  "budget_exceeded",
  // exact state
  "invalid_aspect",
  // host memory write
  "invalid_action",
  "invalid_target",
  "empty_content",
  // count guard, as the lifecycle tool reports it
  "count_guard",
  // the brain_expire refusals, reported under their class names
  "ExpirationValueError",
  "ExpirationTargetNotFoundError",
  "InvalidExpirationTargetError",
] as const;

/** A core-style error class that, like several real ones, never sets `this.name`. */
class Nameless extends Error {}

const UNCLASSIFIED_PREFIX = "warning: unclassified tool error mapped to internal_error: ";

describe("TOOL_ERROR_CODES", () => {
  test("is frozen and unique", () => {
    expect(Object.isFrozen(TOOL_ERROR_CODES)).toBe(true);
    expect(new Set(TOOL_ERROR_CODES).size).toBe(TOOL_ERROR_CODES.length);
  });

  test("is exactly the imported vocabularies plus the 21 new tokens", () => {
    const expected = new Set<string>([
      ...NEW_TOKENS,
      ...SEARCH_ERROR_CODES,
      ...Object.values(SHAPE_VIOLATION_CODES),
      ...Object.values(SEMANTIC_VIOLATION_CODES),
      VAULT_FROZEN_REFUSAL,
      WRITE_BINDING_REFUSED_CODE,
      REACH_REFUSAL,
      ...OWNER_SCOPE_REFUSALS,
      ...TYPE_ONLY_MEMBERS,
    ]);
    expect([...TOOL_ERROR_CODES].toSorted() as string[]).toEqual([...expected].toSorted());
    expect([...GENERIC_TOOL_ERROR_CODES].toSorted()).toEqual([...NEW_TOKENS].toSorted());
    expect(Object.values(TOOL_ERROR_CODE).toSorted()).toEqual([...NEW_TOKENS].toSorted());
    expect(Object.isFrozen(TOOL_ERROR_CODE)).toBe(true);
  });

  test("keeps the pinned wire tokens verbatim", () => {
    for (const token of ["budget_exceeded", "invalid_action", "invalid_target", "vault_frozen"]) {
      expect(isToolErrorCode(token)).toBe(true);
    }
  });

  test("the guards accept members only", () => {
    for (const outsider of ["", "ENOENT", "INTERNAL_ERROR", "unclassified", 42, null, undefined]) {
      expect(isToolErrorCode(outsider)).toBe(false);
      expect(isGenericToolErrorCode(outsider)).toBe(false);
    }
    expect(isGenericToolErrorCode("INDEX_MISSING")).toBe(false);
    expect(isToolErrorCode("INDEX_MISSING")).toBe(true);
  });
});

describe("toolErrorMeta", () => {
  test("names the schema and the code", () => {
    expect(TOOL_ERROR_META_KEY).toBe("open-second-brain/error");
    expect(TOOL_ERROR_SCHEMA).toBe("o2b.error.v1");
    expect(toolErrorMeta("safeguard_timeout")).toEqual({
      schema: "o2b.error.v1",
      code: "safeguard_timeout",
    });
  });
});

describe("defaultCodeForRpc", () => {
  test("maps each JSON-RPC constant to its snake token", () => {
    expect(defaultCodeForRpc(PARSE_ERROR)).toBe("parse_error");
    expect(defaultCodeForRpc(INVALID_REQUEST)).toBe("invalid_request");
    expect(defaultCodeForRpc(METHOD_NOT_FOUND)).toBe("method_not_found");
    expect(defaultCodeForRpc(INVALID_PARAMS)).toBe("invalid_params");
    expect(defaultCodeForRpc(INTERNAL_ERROR)).toBe("internal_error");
  });
});

describe("codeForError", () => {
  let stderr: Mock<typeof process.stderr.write>;
  let lines: string[];

  beforeEach(() => {
    lines = [];
    stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stderr.mockRestore();
  });

  test("returns the code a typed core error carries", () => {
    expect(codeForError(new WriteBatchError("invalid_path", 0, "bad path"))).toBe("invalid_path");
    expect(codeForError(new SearchError("INDEX_MISSING", "no index"))).toBe("INDEX_MISSING");
    expect(codeForError(new PinnedBatchError("budget_exceeded", -1, "too big"))).toBe(
      "budget_exceeded",
    );
    expect(lines).toEqual([]);
  });

  test("names the safeguard, config and count-guard errors", () => {
    expect(codeForError(new SafeguardTimeoutError("dream", 10))).toBe("safeguard_timeout");
    expect(codeForError(new SafeguardAbortError("dream"))).toBe("safeguard_aborted");
    expect(codeForError(new ConfigReadError("config.yaml", "EACCES"))).toBe("config_unreadable");
    expect(codeForError(new BrainConfigError("bad", "dream.x", "_brain.yaml"))).toBe(
      "config_invalid",
    );
    expect(codeForError(new CountGuardError("mismatch", 2, 1, ["a", "b"]))).toBe("count_guard");
    expect(codeForError(new OutputContractError("probe", ["$.ok: expected boolean"]))).toBe(
      "output_contract_failed",
    );
    expect(lines).toEqual([]);
  });

  test("an expiration refusal keeps its class name as its code", () => {
    expect(codeForError(new ExpirationValueError("soon", "bad date"))).toBe("ExpirationValueError");
    expect(codeForError(new ExpirationTargetNotFoundError("sig-x", ["Brain/inbox"]))).toBe(
      "ExpirationTargetNotFoundError",
    );
    expect(codeForError(new InvalidExpirationTargetError("x"))).toBe(
      "InvalidExpirationTargetError",
    );
    expect(lines).toEqual([]);
  });

  test("a Brain artifact parse failure is brain_artifact_unparseable, subclasses included", () => {
    const path = "/vault/Brain/retired/ret-broken.md";
    expect(codeForError(new BrainParseError("missing retired_at", path))).toBe(
      "brain_artifact_unparseable",
    );
    expect(
      codeForError(
        new BrainStatusFolderMismatchError(
          "status disagrees with folder",
          path,
          "retired",
          "preferences",
        ),
      ),
    ).toBe("brain_artifact_unparseable");
    expect(lines).toEqual([]);
  });

  test("walks the cause chain of a rethrown error", () => {
    const original = new BrainPreferenceNotFoundError("pref-x", "Brain/preferences/pref-x.md");
    const rethrown = new Error(original.message, { cause: original });
    expect(codeForError(rethrown)).toBe("preference_not_found");
    expect(lines).toEqual([]);
  });

  test("an unknown error is internal_error, logged once by name only", () => {
    const privatePath = "/home/someone/vault/private.md";
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [new Error(`boom at ${privatePath}`), "Error"],
      [Object.assign(new Error(`ENOENT: ${privatePath}`), { code: "ENOENT" }), "Error"],
      [`thrown string ${privatePath}`, "string"],
      // A class that never sets `this.name` is still named by its class.
      [new Nameless(`boom at ${privatePath}`), "Nameless"],
    ];
    for (const [thrown, name] of cases) {
      lines = [];
      expect(codeForError(thrown)).toBe("internal_error");
      expect(lines).toEqual([`${UNCLASSIFIED_PREFIX}${name}\n`]);
      expect(lines[0]).not.toContain(privatePath);
    }
  });
});
