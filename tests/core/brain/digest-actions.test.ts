/**
 * Coverage for the v0.10.15 ranked maintenance actions surfaced via
 * `brain_digest`. Confirms the JSON payload carries an `actions`
 * array, that the Markdown renderer emits a `## Actions` section
 * when populated, and that an empty vault stays quiet.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderDigest } from "../../../src/core/brain/digest.ts";

let vault: string;

const DERIVED_KEYS = new Set([
  "status",
  "applied_count",
  "violated_count",
  "last_evidence_at",
  "confidence",
  "confidence_value",
  "evidenced_by",
  "contradicted_by",
  "lifecycle",
  "confirmed_at",
]);

function writePref(slug: string, fields: Record<string, string>) {
  const lines = [
    "---",
    "kind: brain-preference",
    `id: pref-${slug}`,
    "tags: [brain, brain/preference]",
  ];
  for (const [k, v] of Object.entries(fields)) {
    const key = DERIVED_KEYS.has(k) ? `_${k}` : k;
    lines.push(`${key}: ${v}`);
  }
  lines.push("---", "");
  writeFileSync(join(vault, "Brain", "preferences", `pref-${slug}.md`), lines.join("\n"));
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-digest-actions-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox", "processed"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("brain_digest actions surface", () => {
  test("empty vault renders no Actions section in markdown", () => {
    const res = renderDigest(vault, {
      format: "markdown",
      since: new Date("2026-05-24T00:00:00Z"),
      until: new Date("2026-05-25T00:00:00Z"),
    });
    expect(res.content).not.toContain("## Actions");
  });

  test("empty vault still carries an empty actions array in JSON", () => {
    const res = renderDigest(vault, {
      format: "json",
      since: new Date("2026-05-24T00:00:00Z"),
      until: new Date("2026-05-25T00:00:00Z"),
    });
    const payload = JSON.parse(res.content) as { actions: unknown };
    expect(Array.isArray(payload.actions)).toBe(true);
    expect((payload.actions as Array<unknown>).length).toBe(0);
  });

  test("dedup candidates appear as a ranked action in markdown when window has activity", () => {
    // One window-active preference makes the digest non-empty so
    // the full renderer (and therefore the ## Actions section) runs.
    writePref("active", {
      topic: "writing",
      principle: "Active in window",
      status: "unconfirmed",
      created_at: "2026-05-24T12:00:00Z",
      unconfirmed_until: "2026-06-01T00:00:00Z",
    });
    // Dedup pair (out-of-window, vault-state).
    writePref("alpha", {
      topic: "writing",
      principle: "Use imperative voice",
      created_at: "2026-01-01T00:00:00Z",
    });
    writePref("alpha-dup", {
      topic: "writing",
      principle: "Use imperative voice",
      created_at: "2026-02-01T00:00:00Z",
    });
    const res = renderDigest(vault, {
      format: "markdown",
      since: new Date("2026-05-24T00:00:00Z"),
      until: new Date("2026-05-25T00:00:00Z"),
    });
    expect(res.content).toContain("## Actions");
    expect(res.content).toContain("[dedup]");
    expect(res.content).toContain("pref-alpha");
  });

  test("JSON payload exposes the actions list even when the window is empty", () => {
    // No window-active items - the JSON still carries the full
    // shape, including the (vault-state) actions array. Operators
    // and downstream consumers can read it without checking the
    // emptiness flag first.
    writePref("a", {
      topic: "x",
      principle: "y",
      created_at: "2026-01-01T00:00:00Z",
    });
    writePref("b", {
      topic: "x",
      principle: "y",
      created_at: "2026-02-01T00:00:00Z",
    });
    const json = renderDigest(vault, {
      format: "json",
      since: new Date("2026-05-24T00:00:00Z"),
      until: new Date("2026-05-25T00:00:00Z"),
    });
    const payload = JSON.parse(json.content) as {
      actions: Array<{ category: string; impact: number }>;
    };
    expect(payload.actions.length).toBeGreaterThanOrEqual(1);
    expect(payload.actions[0]!.category).toBe("dedup");
    expect(payload.actions[0]!.impact).toBeGreaterThan(0);
  });
});
