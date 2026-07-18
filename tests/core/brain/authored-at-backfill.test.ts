/**
 * Conversation-chronology backfill (S1 / t_347e8224).
 *
 *   - Dry-run by DEFAULT: never writes; reports the candidates.
 *   - Applies the additive `authored_at` field to session signals that
 *     preserved a turn instant (valid_from/recorded_at) but predate it.
 *   - Idempotent: a re-run over an already-backfilled vault is a no-op.
 *   - Documents without a turn instant are unchanged.
 *   - Non-session / non-signal files are ignored.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brainDirs } from "../../../src/core/brain/paths.ts";
import { planAuthoredAtBackfill } from "../../../src/core/brain/authored-at-backfill.ts";
import { parseSignal, writeSignal } from "../../../src/core/brain/signal.ts";
import { parseFrontmatter } from "../../../src/core/vault.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-authored-backfill-"));
  const dirs = brainDirs(vault);
  for (const d of [dirs.brain, dirs.inbox, dirs.processed, dirs.retired]) {
    mkdirSync(d, { recursive: true });
  }
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** A pre-feature session signal: turn instant preserved, no authored_at. */
function oldSessionSignal(slug: string, instant: string): string {
  const { path } = writeSignal(vault, {
    topic: slug,
    signal: "positive",
    agent: "test",
    principle: `pre-feature session turn ${slug}`,
    created_at: instant,
    date: instant.slice(0, 10),
    slug,
    source_type: "session",
    valid_from: instant,
    recorded_at: instant,
  });
  return path;
}

function frontmatter(path: string): Record<string, unknown> {
  return parseFrontmatter(path)[0] as Record<string, unknown>;
}

describe("planAuthoredAtBackfill", () => {
  test("dry-run (default) reports candidates without writing", () => {
    const path = oldSessionSignal("alpha", "2026-05-20T10:00:00Z");
    expect(frontmatter(path)["authored_at"]).toBeUndefined();

    const result = planAuthoredAtBackfill(vault);
    expect(result.applied).toBe(false);
    expect(result.updated).toBe(0);
    expect(result.candidates.map((c) => c.authoredAt)).toEqual(["2026-05-20T10:00:00Z"]);
    // No write happened.
    expect(frontmatter(path)["authored_at"]).toBeUndefined();
  });

  test("apply stamps authored_at from the preserved turn instant", () => {
    const path = oldSessionSignal("beta", "2026-05-20T11:30:00Z");

    const result = planAuthoredAtBackfill(vault, { apply: true });
    expect(result.applied).toBe(true);
    expect(result.updated).toBe(1);
    expect(frontmatter(path)["authored_at"]).toBe("2026-05-20T11:30:00Z");
    // The rest of the signal still parses cleanly.
    const sig = parseSignal(path);
    expect(sig.valid_from).toBe("2026-05-20T11:30:00Z");
  });

  test("re-run after apply is an idempotent no-op", () => {
    oldSessionSignal("gamma", "2026-05-20T12:00:00Z");
    expect(planAuthoredAtBackfill(vault, { apply: true }).updated).toBe(1);
    const second = planAuthoredAtBackfill(vault, { apply: true });
    expect(second.updated).toBe(0);
    expect(second.candidates).toHaveLength(0);
  });

  test("a signal with no turn instant is unchanged", () => {
    const { path } = writeSignal(vault, {
      topic: "live",
      signal: "positive",
      agent: "test",
      principle: "a live signal with no turn instant",
      created_at: "2026-05-20T13:00:00Z",
      date: "2026-05-20",
      slug: "live",
      source_type: "session",
      // No valid_from / recorded_at → no turn instant.
    });
    const result = planAuthoredAtBackfill(vault, { apply: true });
    expect(result.updated).toBe(0);
    expect(frontmatter(path)["authored_at"]).toBeUndefined();
  });

  test("a non-session signal is not touched", () => {
    const { path } = writeSignal(vault, {
      topic: "inline",
      signal: "positive",
      agent: "test",
      principle: "an inline signal, not from a session",
      created_at: "2026-05-20T14:00:00Z",
      date: "2026-05-20",
      slug: "inline",
      source_type: "inline",
      valid_from: "2026-05-20T14:00:00Z",
    });
    const result = planAuthoredAtBackfill(vault, { apply: true });
    expect(result.scanned).toBe(0);
    expect(result.updated).toBe(0);
    expect(frontmatter(path)["authored_at"]).toBeUndefined();
  });
});
