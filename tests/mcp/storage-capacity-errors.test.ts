/**
 * The storage capacity error vocabulary at the MCP boundary.
 *
 * Claims pinned here:
 *
 *   1. `STORAGE_ERROR_CODES` is the closed pair (`capacity_unmeasurable`,
 *      `capacity_exhausted`), registered in `TOOL_ERROR_CODES` through the
 *      exhaustive-members check, so a code added to the leaf cannot fail
 *      to reach the wire.
 *   2. `StorageCapacityError` maps BY NAME through `codeForError`: the
 *      code the leaf chose is the code the wire carries, for both members.
 *   3. The error envelope carries only the schema tag and the code - no
 *      message field exists for it - so no vault path can reach a remote
 *      caller through the classified path.
 */

import { describe, expect, test } from "bun:test";

import {
  STORAGE_ERROR_CODES,
  StorageCapacityError,
} from "../../src/core/brain/storage/capacity-error.ts";
import {
  TOOL_ERROR_CODES,
  codeForError,
  isToolErrorCode,
  toolErrorMeta,
} from "../../src/mcp/tool-error-codes.ts";

const VAULT_PATH = "/tmp/o2b-some-vault/Brain/metrics";

describe("storage capacity error codes", () => {
  test("the leaf vocabulary is the closed pair and is registered", () => {
    expect(STORAGE_ERROR_CODES).toEqual(["capacity_unmeasurable", "capacity_exhausted"]);
    for (const code of STORAGE_ERROR_CODES) {
      expect(isToolErrorCode(code)).toBe(true);
      expect(TOOL_ERROR_CODES).toContain(code);
    }
  });

  test("the error maps by name through the classifier", () => {
    for (const code of STORAGE_ERROR_CODES) {
      const err = new StorageCapacityError(
        code,
        `storage capacity: the reading failed for ${VAULT_PATH}`,
      );
      expect(codeForError(err)).toBe(code);
    }
  });

  test("the classifier walks a cause chain to the typed error", () => {
    const typed = new StorageCapacityError(
      "capacity_exhausted",
      `storage capacity: vault ${VAULT_PATH} is past the critical threshold`,
    );
    const wrapped = new Error("capacity gate refused the write", { cause: typed });
    expect(codeForError(wrapped)).toBe("capacity_exhausted");
  });

  test("the wire envelope carries a code and schema only, never a message", () => {
    for (const code of STORAGE_ERROR_CODES) {
      const meta = toolErrorMeta(code);
      expect(Object.keys(meta).toSorted()).toEqual(["code", "schema"]);
      expect(meta.code).toBe(code);
      expect(JSON.stringify(meta)).not.toContain(VAULT_PATH);
    }
  });
});
