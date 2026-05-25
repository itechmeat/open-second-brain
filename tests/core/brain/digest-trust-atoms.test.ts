/**
 * v0.10.16: `DigestJson` gains optional `trust_verdict` plus
 * `uncertain_count` and `quarantined_count`. Atom commit asserts the
 * shape and the absent-by-default contract; the consumer commit
 * threads doctor / dream inputs into the digest renderer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DigestJson } from "../../../src/core/brain/digest.ts";
import { renderDigest } from "../../../src/core/brain/digest.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-digest-trust-atoms-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("DigestJson trust-layer atoms", () => {
  test("clean vault: trust_verdict absent, counts zero", () => {
    const result = renderDigest(vault, { format: "json" });
    const payload = JSON.parse(result.content) as DigestJson;
    expect(payload.trust_verdict).toBeUndefined();
    expect(payload.uncertain_count).toBe(0);
    expect(payload.quarantined_count).toBe(0);
  });

  test("markdown digest still renders without trust fields", () => {
    const result = renderDigest(vault, { format: "markdown" });
    expect(typeof result.content).toBe("string");
    // No `## Trust` section appears when no trust input was provided.
    expect(result.content).not.toContain("## Trust");
  });
});
