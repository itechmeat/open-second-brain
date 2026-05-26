import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_POLICY_TEMPLATE,
  readPolicy,
  writePolicyIfMissing,
} from "../../src/core/pay-memory/policy.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-pay-policy-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("writePolicyIfMissing", () => {
  test("creates the policy on first run", () => {
    const result = writePolicyIfMissing(tmp);
    expect(result.created).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.overwritten).toBe(false);
    expect(readFileSync(result.path, "utf8")).toBe(DEFAULT_POLICY_TEMPLATE);
  });

  test("re-running without --overwrite leaves existing content intact", () => {
    const first = writePolicyIfMissing(tmp);
    writeFileSync(first.path, "manually edited\n", "utf8");
    const second = writePolicyIfMissing(tmp);
    expect(second.skipped).toBe(true);
    expect(second.created).toBe(false);
    expect(readFileSync(second.path, "utf8")).toBe("manually edited\n");
  });

  test("--overwrite rewrites the policy", () => {
    const first = writePolicyIfMissing(tmp);
    writeFileSync(first.path, "stale\n", "utf8");
    const second = writePolicyIfMissing(tmp, { overwrite: true });
    expect(second.overwritten).toBe(true);
    expect(second.created).toBe(false);
    expect(readFileSync(second.path, "utf8")).toBe(DEFAULT_POLICY_TEMPLATE);
  });
});

describe("readPolicy", () => {
  test("returns null when missing", () => {
    expect(readPolicy(tmp)).toBeNull();
  });

  test("returns content when present", () => {
    writePolicyIfMissing(tmp);
    expect(readPolicy(tmp)).toBe(DEFAULT_POLICY_TEMPLATE);
  });
});

describe("DEFAULT_POLICY_TEMPLATE", () => {
  test("includes generic placeholders, not pinned services", () => {
    expect(DEFAULT_POLICY_TEMPLATE).toContain("## Allowed services");
    expect(DEFAULT_POLICY_TEMPLATE).toContain("- TODO");
    // The example service appears only as a comment-block hint.
    const idx = DEFAULT_POLICY_TEMPLATE.indexOf("paysponge/fal");
    expect(idx).toBeGreaterThan(-1);
    const before = DEFAULT_POLICY_TEMPLATE.slice(0, idx);
    expect(before.lastIndexOf("<!--")).toBeGreaterThan(before.lastIndexOf("-->"));
  });

  test("documents the post-call evidence the agent must save", () => {
    expect(DEFAULT_POLICY_TEMPLATE).toContain("raw payment-tool output");
    expect(DEFAULT_POLICY_TEMPLATE).toContain("Brain/payments/<date>/");
  });
});
