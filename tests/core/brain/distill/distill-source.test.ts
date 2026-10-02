/**
 * Source distillation core (t_2e2e959f): condense a source into atomic claims
 * with block-level provenance. Provider-agnostic; idempotent on the source.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  DISTILL_CLAIMS_MAX,
  distillSource,
  DistillValidationError,
} from "../../../../src/core/brain/distill/distill-source.ts";
import { BRAIN_DISTILLATIONS_REL } from "../../../../src/core/brain/paths.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";

let vault: string;
const NOW = new Date("2026-07-10T08:00:00Z");
const LATER = new Date("2026-07-11T09:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-distill-"));
  bootstrapBrain(vault);
  mkdirSync(join(vault, "Articles"), { recursive: true });
  writeFileSync(join(vault, "Articles", "restaking.md"), "# Restaking\n\nBody text.\n", "utf8");
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const INPUT = {
  sourcePath: "Articles/restaking.md",
  claims: [
    { text: "Restaking reuses staked capital to secure additional services.", block: "abc" },
    { text: "It introduces correlated slashing risk." },
  ],
};

function readPage(path: string): string {
  return readFileSync(join(vault, path), "utf8");
}

describe("distillSource", () => {
  test("writes a distillation page with atomic claims and block-level citations", () => {
    const res = distillSource(vault, INPUT, { agent: "claude", now: NOW });
    expect(res.created).toBe(true);
    expect(res.claimCount).toBe(2);

    const md = readPage(res.distillationPath);
    expect(md).toContain("kind: brain-distillation");
    expect(md).toContain("## Claims");
    // The block-bearing claim renders a block-level citation; the other does not.
    expect(md).toContain(
      "- Restaking reuses staked capital to secure additional services. ([[Articles/restaking.md#^abc]])",
    );
    expect(md).toContain("- It introduces correlated slashing risk.");
    expect(md).toContain("## Sources");
    expect(md).toContain("[[Articles/restaking.md]]");
  });

  test("stamps a source_hash equal to sha256 of the source bytes", () => {
    const res = distillSource(vault, INPUT, { agent: "claude", now: NOW });
    const expected = createHash("sha256")
      .update(readFileSync(join(vault, "Articles", "restaking.md")))
      .digest("hex");
    expect(res.sourceHash).toBe(expected);
    expect(readPage(res.distillationPath)).toContain(`source_hash: ${expected}`);
  });

  test("rejects an empty claim list and an empty-text claim (no page written)", () => {
    expect(() =>
      distillSource(
        vault,
        { sourcePath: "Articles/restaking.md", claims: [] },
        {
          agent: "claude",
          now: NOW,
        },
      ),
    ).toThrow(DistillValidationError);
    expect(() =>
      distillSource(
        vault,
        { sourcePath: "Articles/restaking.md", claims: [{ text: "   " }] },
        { agent: "claude", now: NOW },
      ),
    ).toThrow(DistillValidationError);
  });

  test("refuses a claim that spans more than one line, writing nothing", () => {
    for (const text of ["x\n## Sources\n- [[Notes/any.md]]", "one\rtwo"]) {
      expect(() =>
        distillSource(
          vault,
          { sourcePath: "Articles/restaking.md", claims: [{ text: "fine" }, { text }] },
          { agent: "claude", now: NOW },
        ),
      ).toThrow(
        new DistillValidationError("claim 1 spans more than one line; a claim is one line"),
      );
    }
    const dir = join(vault, BRAIN_DISTILLATIONS_REL);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  test("refuses more claims than the per-call cap, naming the cap and the count", () => {
    const claims = Array.from({ length: DISTILL_CLAIMS_MAX + 1 }, (_, i) => ({ text: `c${i}` }));
    expect(() =>
      distillSource(
        vault,
        { sourcePath: "Articles/restaking.md", claims },
        { agent: "claude", now: NOW },
      ),
    ).toThrow(
      new DistillValidationError(
        `distillation accepts at most ${DISTILL_CLAIMS_MAX} claims per call, got ${DISTILL_CLAIMS_MAX + 1}`,
      ),
    );
    const atCap = claims.slice(0, DISTILL_CLAIMS_MAX);
    expect(
      distillSource(
        vault,
        { sourcePath: "Articles/restaking.md", claims: atCap },
        { agent: "claude", now: NOW },
      ).claimCount,
    ).toBe(DISTILL_CLAIMS_MAX);
  });

  test("rejects a malformed block id", () => {
    expect(() =>
      distillSource(
        vault,
        { sourcePath: "Articles/restaking.md", claims: [{ text: "x", block: "bad id!" }] },
        { agent: "claude", now: NOW },
      ),
    ).toThrow(/block id/);
  });

  test("is idempotent on the source: same input rewrites nothing, changed input rewrites in place", () => {
    const first = distillSource(vault, INPUT, { agent: "claude", now: NOW });
    const before = readPage(first.distillationPath);

    const second = distillSource(vault, INPUT, { agent: "claude", now: LATER });
    expect(second.created).toBe(false);
    expect(second.distillationPath).toBe(first.distillationPath);
    // Byte-identical re-run: created_at preserved, no updated_at churn.
    expect(readPage(second.distillationPath)).toBe(before);

    const changed = distillSource(
      vault,
      { sourcePath: INPUT.sourcePath, claims: [{ text: "A single revised claim." }] },
      { agent: "claude", now: LATER },
    );
    expect(changed.distillationPath).toBe(first.distillationPath);
    const md = readPage(changed.distillationPath);
    expect(md).toContain("- A single revised claim.");
    expect(md).toContain('created_at: "2026-07-10T08:00:00Z"');
    expect(md).toContain('updated_at: "2026-07-11T09:00:00Z"');
  });
});
