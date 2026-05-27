/**
 * Per-preference edit-history sidecar (F4).
 *
 * Append-only `Brain/preferences/pref-<slug>.history.jsonl` capturing
 * one entry per content mutation. Convergent under Syncthing: appending
 * an entry whose (revision, field, after) already exists is a no-op, so
 * two peers replaying the same write do not diverge. Reads skip
 * malformed lines; rendering is deterministic.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendEditHistory,
  readEditHistory,
  renderEditHistory,
  type EditHistoryEntry,
} from "../../../../src/core/brain/health/edit-history.ts";
import { preferenceHistoryPath } from "../../../../src/core/brain/paths.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-edit-history-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const entry = (over: Partial<EditHistoryEntry>): EditHistoryEntry => ({
  ts: "2026-05-27T00:00:00Z",
  agent: "claude-vps-agent",
  revision: 1,
  field: "principle",
  before: "use tabs",
  after: "use spaces",
  ...over,
});

describe("appendEditHistory / readEditHistory", () => {
  test("appends entries and round-trips them", () => {
    appendEditHistory(vault, "tabs", [
      entry({ revision: 1, field: "principle" }),
      entry({ revision: 1, field: "scope", before: null, after: "coding" }),
    ]);
    const read = readEditHistory(vault, "tabs");
    expect(read.length).toBe(2);
    expect(read[0]!.field).toBe("principle");
    expect(read[1]!.after).toBe("coding");
  });

  test("is idempotent per (revision, field, after)", () => {
    appendEditHistory(vault, "tabs", [entry({})]);
    const appended = appendEditHistory(vault, "tabs", [entry({})]);
    expect(appended).toBe(0);
    expect(readEditHistory(vault, "tabs").length).toBe(1);
  });

  test("a later revision touching the same field is a new entry", () => {
    appendEditHistory(vault, "tabs", [entry({ revision: 1 })]);
    appendEditHistory(vault, "tabs", [
      entry({ revision: 2, before: "use spaces", after: "use 2-space indent" }),
    ]);
    expect(readEditHistory(vault, "tabs").length).toBe(2);
  });

  test("read returns empty for a missing sidecar", () => {
    expect(readEditHistory(vault, "never-written")).toEqual([]);
  });

  test("read skips malformed lines", () => {
    const path = preferenceHistoryPath(vault, "tabs");
    writeFileSync(
      path,
      [
        JSON.stringify(entry({})),
        "this is not json",
        JSON.stringify({ partial: true }),
        JSON.stringify(entry({ revision: 2, field: "scope", after: "writing" })),
        "",
      ].join("\n"),
    );
    const read = readEditHistory(vault, "tabs");
    expect(read.length).toBe(2);
    expect(read.map((e) => e.revision)).toEqual([1, 2]);
  });
});

describe("renderEditHistory", () => {
  test("renders a deterministic timeline ordered by revision then field", () => {
    const out = renderEditHistory([
      entry({ revision: 2, field: "scope", before: null, after: "coding" }),
      entry({ revision: 1, field: "principle", before: "use tabs", after: "use spaces" }),
    ]);
    const firstRev = out.indexOf("rev 1");
    const secondRev = out.indexOf("rev 2");
    expect(firstRev).toBeGreaterThanOrEqual(0);
    expect(firstRev).toBeLessThan(secondRev);
    expect(out).toContain("principle");
    expect(out).toContain("use tabs");
    expect(out).toContain("use spaces");
  });

  test("renders an empty timeline as a stable placeholder", () => {
    expect(renderEditHistory([]).trim().length).toBeGreaterThan(0);
  });
});
