/**
 * Canonical vault-relative path constants. Everywhere the codebase
 * builds a path inside the vault, it imports a constant from this
 * test's covered modules instead of repeating the literal. Future
 * renames (Brain → Memory, ...) are a one-line change in the
 * constants module.
 */

import { describe, expect, test } from "bun:test";

import { BRAIN_ROOT_REL } from "../../src/core/brain/paths.ts";

describe("BRAIN_ROOT_REL", () => {
  test("names the Brain-layer root directory", () => {
    expect(BRAIN_ROOT_REL).toBe("Brain");
  });
});
