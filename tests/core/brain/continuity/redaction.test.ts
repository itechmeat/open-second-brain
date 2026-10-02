/**
 * `safeContinuityPayload` flags a payload that held a private region and
 * strips it, in time linear in the payload's size.
 */

import { describe, expect, test } from "bun:test";

import { safeContinuityPayload } from "../../../../src/core/brain/continuity/redaction.ts";

const PRIVATE_BODY = "between the tags";
/** 720 KB of open-close pairs: the size the quadratic test took 21.8 s on. */
const PRIVATE_RUN_BYTES = 720 * 1024;
const PRIVATE_RUN_CEILING_MS = 1_000;

describe("safeContinuityPayload", () => {
  test("a private region is flagged and stripped", () => {
    const result = safeContinuityPayload({ note: `a <private>${PRIVATE_BODY}</private> b` });
    expect(result.private).toBe(true);
    expect(JSON.stringify(result.payload)).not.toContain(PRIVATE_BODY);
  });

  test("a payload without one is not flagged", () => {
    expect(safeContinuityPayload({ note: "plain text" }).private).toBe(false);
  });

  test("a long run of private tags is flagged in linear time", () => {
    const unit = "<private>";
    const run = unit.repeat(Math.ceil(PRIVATE_RUN_BYTES / unit.length));
    const started = performance.now();
    const result = safeContinuityPayload({ note: run });
    expect(performance.now() - started).toBeLessThan(PRIVATE_RUN_CEILING_MS);
    expect(result.private).toBe(true);
  });
});
