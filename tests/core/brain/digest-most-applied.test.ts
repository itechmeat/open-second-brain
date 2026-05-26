/**
 * `brain_digest` v0.10.11 — `most_applied` block in Markdown + JSON.
 *
 * Mirrors `Brain/active.md`'s `Most-applied (Nd)` section behind the
 * same `_brain.yaml:active.most_applied_*` knobs.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderDigest } from "../../../src/core/brain/digest.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import {
  BRAIN_APPLY_RESULT,
  BRAIN_LOG_EVENT_KIND,
} from "../../../src/core/brain/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-digest-ma-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  // confirmed preference referenced by apply-evidence events
  writeFileSync(
    join(vault, "Brain", "preferences", "pref-a.md"),
    `---
kind: brain-preference
id: pref-a
created_at: 2026-04-01T00:00:00Z
_confirmed_at: 2026-04-05T00:00:00Z
unconfirmed_until: 2026-04-08T00:00:00Z
tags: []
topic: a
_status: confirmed
principle: principle a
_evidenced_by: []
_applied_count: 0
_violated_count: 0
_last_evidence_at: null
_confidence: medium
_confidence_value: 0.5
pinned: false
---
body
`,
  );
});

afterEach(() => {
  try { rmSync(vault, { recursive: true, force: true }); } catch {}
});

function writeBrainYaml(content: string): void {
  writeFileSync(join(vault, "Brain", "_brain.yaml"), content);
}

function seedApplied(stamp: string, prefRef: string): void {
  appendLogEvent(vault, {
    timestamp: stamp,
    eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
    body: { preference: prefRef, result: BRAIN_APPLY_RESULT.applied, artifact: "[[x.md]]" },
  });
}

describe("digest most_applied block — defaults", () => {
  test("JSON contains the block at defaults (30d / 10) even when empty", () => {
    const result = renderDigest(vault, {
      format: "json",
      now: new Date("2026-05-20T12:00:00Z"),
      since: new Date("2026-05-19T12:00:00Z"),
      until: new Date("2026-05-20T12:00:00Z"),
    });
    const parsed = JSON.parse(result.content);
    expect(parsed.most_applied).toBeDefined();
    expect(parsed.most_applied.window_days).toBe(30);
    expect(parsed.most_applied.limit).toBe(10);
    expect(parsed.most_applied.entries).toEqual([]);
  });

  test("Markdown omits the section when window has no applied events", () => {
    const result = renderDigest(vault, {
      format: "markdown",
      now: new Date("2026-05-20T12:00:00Z"),
      since: new Date("2026-05-19T12:00:00Z"),
      until: new Date("2026-05-20T12:00:00Z"),
    });
    expect(result.content).not.toContain("## Most-applied");
  });

  test("JSON entries populated when applied events exist in window", () => {
    seedApplied("2026-05-15T10:00:00Z", "[[pref-a]]");
    seedApplied("2026-05-15T11:00:00Z", "[[pref-a]]");
    const result = renderDigest(vault, {
      format: "json",
      now: new Date("2026-05-20T12:00:00Z"),
      since: new Date("2026-05-19T12:00:00Z"),
      until: new Date("2026-05-20T12:00:00Z"),
    });
    const parsed = JSON.parse(result.content);
    expect(parsed.most_applied.entries.length).toBe(1);
    expect(parsed.most_applied.entries[0].id).toBe("pref-a");
    expect(parsed.most_applied.entries[0].applied_in_window).toBe(2);
  });

  test("Markdown renders the section with the default window in the header", () => {
    seedApplied("2026-05-15T10:00:00Z", "[[pref-a]]");
    const result = renderDigest(vault, {
      format: "markdown",
      now: new Date("2026-05-20T12:00:00Z"),
      since: new Date("2026-05-19T12:00:00Z"),
      until: new Date("2026-05-20T12:00:00Z"),
    });
    expect(result.content).toContain("## Most-applied (30d)");
  });
});

describe("digest most_applied block — custom config", () => {
  test("honours window_days / limit from _brain.yaml", () => {
    writeBrainYaml(
      "schema_version: 1\n" +
      "active:\n" +
      "  most_applied_window_days: 7\n" +
      "  most_applied_limit: 3\n",
    );
    seedApplied("2026-05-19T10:00:00Z", "[[pref-a]]");  // within 7d
    const result = renderDigest(vault, {
      format: "json",
      now: new Date("2026-05-20T12:00:00Z"),
      since: new Date("2026-05-19T12:00:00Z"),
      until: new Date("2026-05-20T12:00:00Z"),
    });
    const parsed = JSON.parse(result.content);
    expect(parsed.most_applied.window_days).toBe(7);
    expect(parsed.most_applied.limit).toBe(3);
  });

  test("Markdown header reflects custom window", () => {
    writeBrainYaml(
      "schema_version: 1\n" +
      "active:\n" +
      "  most_applied_window_days: 14\n" +
      "  most_applied_limit: 5\n",
    );
    seedApplied("2026-05-19T10:00:00Z", "[[pref-a]]");
    const result = renderDigest(vault, {
      format: "markdown",
      now: new Date("2026-05-20T12:00:00Z"),
      since: new Date("2026-05-19T12:00:00Z"),
      until: new Date("2026-05-20T12:00:00Z"),
    });
    expect(result.content).toContain("## Most-applied (14d)");
  });

  test("malformed _brain.yaml does not break the digest (falls back to defaults)", () => {
    writeBrainYaml("this is not yaml\nschema_version: nope\n");
    const result = renderDigest(vault, {
      format: "json",
      now: new Date("2026-05-20T12:00:00Z"),
      since: new Date("2026-05-19T12:00:00Z"),
      until: new Date("2026-05-20T12:00:00Z"),
    });
    const parsed = JSON.parse(result.content);
    expect(parsed.most_applied.window_days).toBe(30);
  });
});
