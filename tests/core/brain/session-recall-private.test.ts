/**
 * An imported session turn whose oversized text is externalized is
 * flagged private exactly when the redactor finds a `<private>` region in
 * it - the same detection the continuity sanitiser uses - and finding it
 * takes linear time on a run of opening tags that never close.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importSessionRecall } from "../../../src/core/brain/session-recall.ts";

/** Long enough to be externalized under the default payload policy. */
const BLOB = "QUJD".repeat(5_000);
/** An opening tag with no `>`: the shape that made the old detection quadratic. */
const OPEN_TAG_RUN = "<private ";
/** 720 KB of unclosed opening tags. */
const LONG_RUN_CHARS = 720 * 1024;
/** The audit's bound for that input. */
const LONG_RUN_BUDGET_MS = 1_000;

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-session-recall-private-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** Import one turn and return whether its row is flagged private. */
function importedPrivate(sessionId: string, text: string): boolean {
  const result = importSessionRecall(vault, {
    sessionId,
    createdAt: "2026-09-20T10:00:00.000Z",
    turns: [{ turnId: "t1", role: "user", timestamp: "2026-09-20T10:00:01.000Z", text }],
  });
  return result.rawTurns[0]!.private;
}

describe("an externalized session turn is flagged private by the redactor's region detection", () => {
  test("a turn with no private region is not flagged", () => {
    expect(importedPrivate("s-open", `ordinary ${BLOB}`)).toBe(false);
  });

  test("a closed private region flags the turn", () => {
    expect(importedPrivate("s-closed", `<private>internal</private> ${BLOB}`)).toBe(true);
  });

  for (const prefix of ["tail <private", "keep <private note="]) {
    test(`an unclosed tag (${JSON.stringify(prefix)}) flags the turn, as the redactor strips it`, () => {
      expect(importedPrivate("s-unclosed", `${BLOB} ${prefix}`)).toBe(true);
    });
  }

  test("720 KB of unclosed opening tags is imported in under a second", () => {
    const text = `${BLOB} ${OPEN_TAG_RUN.repeat(Math.ceil(LONG_RUN_CHARS / OPEN_TAG_RUN.length))}`;
    const started = performance.now();
    importedPrivate("s-long", text);
    expect(performance.now() - started).toBeLessThan(LONG_RUN_BUDGET_MS);
  });
});
