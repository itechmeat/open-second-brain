/**
 * Canonical vault-relative path constants. Everywhere the codebase
 * builds a path inside the vault, it imports a constant from this
 * test's covered modules instead of repeating the literal. Future
 * renames (Brain → Memory, Brain/payments → Payments, ...) are a
 * one-line change in the constants module.
 */

import { describe, expect, test } from "bun:test";
import { posix } from "node:path";

import { BRAIN_ROOT_REL } from "../../src/core/brain/paths.ts";
import {
  PAY_MEMORY_ASSETS_REL,
  PAY_MEMORY_DRAFTS_REL,
  PAY_MEMORY_PENDING_REL,
  PAY_MEMORY_POLICIES_REL,
  PAY_MEMORY_REPORTS_REL,
  PAY_MEMORY_ROOT_REL,
  PAY_MEMORY_SPENDING_JSON_REL,
  PAY_MEMORY_SPENDING_MD_REL,
} from "../../src/core/pay-memory/paths.ts";

describe("BRAIN_ROOT_REL", () => {
  test("names the Brain-layer root directory", () => {
    expect(BRAIN_ROOT_REL).toBe("Brain");
  });
});

describe("PAY_MEMORY_*_REL constants", () => {
  test("compose under BRAIN_ROOT_REL so a Brain rename cascades", () => {
    expect(PAY_MEMORY_ROOT_REL).toBe(posix.join(BRAIN_ROOT_REL, "payments"));
    expect(PAY_MEMORY_POLICIES_REL).toBe(posix.join(PAY_MEMORY_ROOT_REL, "policies"));
    expect(PAY_MEMORY_ASSETS_REL).toBe(posix.join(PAY_MEMORY_ROOT_REL, "assets"));
    expect(PAY_MEMORY_DRAFTS_REL).toBe(posix.join(PAY_MEMORY_ROOT_REL, "drafts"));
    expect(PAY_MEMORY_REPORTS_REL).toBe(posix.join(PAY_MEMORY_ROOT_REL, "reports"));
    expect(PAY_MEMORY_PENDING_REL).toBe(posix.join(PAY_MEMORY_ROOT_REL, "_pending"));
  });

  test("spending policy file constants compose under policies", () => {
    expect(PAY_MEMORY_SPENDING_MD_REL).toBe(posix.join(PAY_MEMORY_POLICIES_REL, "spending.md"));
    expect(PAY_MEMORY_SPENDING_JSON_REL).toBe(posix.join(PAY_MEMORY_POLICIES_REL, "spending.json"));
  });
});
