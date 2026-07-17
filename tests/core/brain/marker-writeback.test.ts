/**
 * Tests for the `@osb set` marker write-back engine (today-operator-
 * surface, Task 6). Covers the report/apply mode contract, the
 * guardrail gate, schema-validated mutation, the `attribute-write`
 * audit event, per-marker isolation on ambiguous/invalid targets,
 * marker consumption, and idempotence.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brainDirs } from "../../../src/core/brain/paths.ts";
import { parseFrontmatter } from "../../../src/core/vault.ts";
import { readAttributes } from "../../../src/core/brain/attributes.ts";
import { parseLogDay } from "../../../src/core/brain/log.ts";
import {
  applyMarkerWritebacks,
  MarkerWritebackGuardrailError,
} from "../../../src/core/brain/marker-writeback.ts";

const NOW = new Date("2026-07-17T12:34:56Z");
const LOG_DATE = "2026-07-17";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-marker-writeback-"));
  const dirs = brainDirs(vault);
  for (const d of [dirs.brain, dirs.log]) {
    mkdirSync(d, { recursive: true });
  }
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeConfig(opts: { markerWriteback: boolean; readPaths?: ReadonlyArray<string> }): void {
  const readPaths = opts.readPaths ?? ["Notes"];
  const lines = [
    "schema_version: 1",
    "primary_agent: null",
    "",
    "dream:",
    "  candidate_threshold: 3",
    "  unconfirmed_window_days: 14",
    "  contradiction_window_days: 14",
    "",
    "retire:",
    "  stale_evidence_days: 90",
    "",
    "confidence:",
    "  low_max_applied: 2",
    "  medium_min: 0.40",
    "  high_min: 0.75",
    "",
    "snapshots:",
    "  retention_count: 10",
    "",
    "schema:",
    "  page_types: [paper]",
    "  attributes:",
    "    - paper.status=reading status",
    "    - paper.year=publication year",
    "",
    "notes:",
    "  read_paths:",
    ...readPaths.map((p) => `    - ${p}`),
    "",
    "guardrails:",
    `  marker_writeback: ${opts.markerWriteback ? "true" : "false"}`,
    "",
  ];
  writeFileSync(join(brainDirs(vault).brain, "_brain.yaml"), lines.join("\n"), "utf8");
}

function writePaper(rel: string, front: Record<string, string> = {}): void {
  const path = join(vault, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  const fm = ["---", "type: paper", "title: A Paper"];
  for (const [k, v] of Object.entries(front)) fm.push(`${k}: ${v}`);
  fm.push("---", "", "# A Paper", "", "body", "");
  writeFileSync(path, fm.join("\n"), "utf8");
}

function writeSource(rel: string, ...markerLines: string[]): void {
  const path = join(vault, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `# Journal\n\n${markerLines.join("\n")}\n`, "utf8");
}

function readSource(rel: string): string {
  return readFileSync(join(vault, rel), "utf8");
}

function attrsOf(rel: string): Record<string, string> {
  const [fm] = parseFrontmatter(join(vault, rel));
  return readAttributes(fm);
}

function attributeWriteEvents() {
  return parseLogDay(vault, LOG_DATE).entries.filter((e) => e.eventType === "attribute-write");
}

describe("report mode", () => {
  test("lists pending mutations, resolves the target, and writes nothing", async () => {
    writeConfig({ markerWriteback: true });
    writePaper("Notes/paper.md");
    writeSource("Notes/journal.md", "@osb set note=paper field=status value=queued");

    const report = await applyMarkerWritebacks(vault, {
      files: ["Notes/journal.md"],
      apply: false,
      agent: "claude-dev-agent",
      now: NOW,
    });

    expect(report.apply).toBe(false);
    expect(report.entries).toHaveLength(1);
    const entry = report.entries[0]!;
    expect(entry.status).toBe("would-apply");
    expect(entry.resolvedPath).toBe("Notes/paper.md");
    expect(entry.field).toBe("status");
    expect(entry.value).toBe("queued");
    expect(entry.priorValue).toBeNull();
    expect(report.pendingCount).toBe(1);

    // Nothing written: target frontmatter untouched, source unconsumed,
    // no log file.
    expect(attrsOf("Notes/paper.md")).toEqual({});
    expect(readSource("Notes/journal.md")).not.toContain("@osb✓");
    expect(parseLogDay(vault, LOG_DATE).entries).toHaveLength(0);
  });

  test("report mode works even with the guardrail off", async () => {
    writeConfig({ markerWriteback: false });
    writePaper("Notes/paper.md");
    writeSource("Notes/journal.md", "@osb set note=paper field=status value=queued");

    const report = await applyMarkerWritebacks(vault, {
      files: ["Notes/journal.md"],
      apply: false,
      agent: "a",
      now: NOW,
    });
    expect(report.guardrailEnabled).toBe(false);
    expect(report.entries[0]!.status).toBe("would-apply");
  });
});

describe("guardrail gate", () => {
  test("apply mode with the guardrail off throws a typed error naming the flag", async () => {
    writeConfig({ markerWriteback: false });
    writePaper("Notes/paper.md");
    writeSource("Notes/journal.md", "@osb set note=paper field=status value=queued");

    let caught: unknown;
    try {
      await applyMarkerWritebacks(vault, {
        files: ["Notes/journal.md"],
        apply: true,
        agent: "a",
        now: NOW,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MarkerWritebackGuardrailError);
    expect((caught as MarkerWritebackGuardrailError).flag).toBe("marker_writeback");
    expect((caught as Error).message).toContain("guardrails.marker_writeback");

    // Fail-closed: nothing written.
    expect(attrsOf("Notes/paper.md")).toEqual({});
    expect(readSource("Notes/journal.md")).not.toContain("@osb✓");
  });
});

describe("apply mode - happy path", () => {
  test("writes the attribute, appends one audit event, consumes the marker", async () => {
    writeConfig({ markerWriteback: true });
    writePaper("Notes/paper.md");
    writeSource("Notes/journal.md", "@osb set note=paper field=status value=queued");

    const report = await applyMarkerWritebacks(vault, {
      files: ["Notes/journal.md"],
      apply: true,
      agent: "claude-dev-agent",
      now: NOW,
    });

    expect(report.apply).toBe(true);
    expect(report.appliedCount).toBe(1);
    expect(report.entries[0]!.status).toBe("applied");
    expect(report.entries[0]!.priorValue).toBeNull();

    // Frontmatter mutated.
    expect(attrsOf("Notes/paper.md")).toEqual({ status: "queued" });

    // Exactly one attribute-write event with the full body shape.
    const events = attributeWriteEvents();
    expect(events).toHaveLength(1);
    const body = events[0]!.body;
    expect(body["note"]).toBe("Notes/paper.md");
    expect(body["field"]).toBe("status");
    expect(body["prior_value"]).toBe("null");
    expect(body["new_value"]).toBe("queued");
    expect(body["source_path"]).toBe("Notes/journal.md");
    expect(body["source_line"]).toBe("3");
    expect(body["agent"]).toBe("claude-dev-agent");

    // Marker consumed (sentinel present).
    expect(readSource("Notes/journal.md")).toContain("@osb✓");
  });

  test("re-running over the same files applies nothing (idempotent)", async () => {
    writeConfig({ markerWriteback: true });
    writePaper("Notes/paper.md");
    writeSource("Notes/journal.md", "@osb set note=paper field=status value=queued");

    await applyMarkerWritebacks(vault, {
      files: ["Notes/journal.md"],
      apply: true,
      agent: "a",
      now: NOW,
    });
    const second = await applyMarkerWritebacks(vault, {
      files: ["Notes/journal.md"],
      apply: true,
      agent: "a",
      now: NOW,
    });

    expect(second.entries).toHaveLength(0);
    expect(second.appliedCount).toBe(0);
    // Still exactly one audit event and one attribute value.
    expect(attributeWriteEvents()).toHaveLength(1);
    expect(attrsOf("Notes/paper.md")).toEqual({ status: "queued" });
  });

  test("prior value is captured on overwrite", async () => {
    writeConfig({ markerWriteback: true });
    writePaper("Notes/paper.md");
    writeSource("Notes/first.md", "@osb set note=paper field=status value=queued");
    writeSource("Notes/second.md", "@osb set note=paper field=status value=finished");

    await applyMarkerWritebacks(vault, {
      files: ["Notes/first.md"],
      apply: true,
      agent: "a",
      now: NOW,
    });
    const report = await applyMarkerWritebacks(vault, {
      files: ["Notes/second.md"],
      apply: true,
      agent: "a",
      now: NOW,
    });

    expect(report.entries[0]!.priorValue).toBe("queued");
    expect(attrsOf("Notes/paper.md")).toEqual({ status: "finished" });

    const events = attributeWriteEvents();
    expect(events).toHaveLength(2);
    expect(events[1]!.body["prior_value"]).toBe("queued");
    expect(events[1]!.body["new_value"]).toBe("finished");
  });
});

describe("apply mode - per-marker isolation", () => {
  test("an ambiguous target fails that marker with candidates; others still apply", async () => {
    writeConfig({ markerWriteback: true, readPaths: ["Notes", "Archive"] });
    writePaper("Notes/paper.md");
    writePaper("Archive/paper.md");
    writePaper("Notes/report.md");
    writeSource(
      "Notes/journal.md",
      "@osb set note=paper field=status value=queued",
      "@osb set note=Notes/report.md field=year value=2026",
    );

    const report = await applyMarkerWritebacks(vault, {
      files: ["Notes/journal.md"],
      apply: true,
      agent: "a",
      now: NOW,
    });

    const ambiguous = report.entries.find((e) => e.rawTarget === "paper")!;
    expect(ambiguous.status).toBe("invalid-target");
    expect(ambiguous.errorCode).toBe("ambiguous");
    expect([...ambiguous.candidates].toSorted()).toEqual(["Archive/paper.md", "Notes/paper.md"]);

    const good = report.entries.find((e) => e.rawTarget === "Notes/report.md")!;
    expect(good.status).toBe("applied");

    // The valid marker applied and was consumed; the ambiguous one is
    // left unconsumed for a later retry.
    expect(attrsOf("Notes/report.md")).toEqual({ year: "2026" });
    const src = readSource("Notes/journal.md");
    expect(src).toContain("@osb✓ [[Notes/report.md]] set note=Notes/report.md");
    expect(src).toContain("@osb set note=paper field=status value=queued");
    expect(attrsOf("Notes/paper.md")).toEqual({});
  });

  test("an undeclared field fails closed via the vocabulary error, unconsumed", async () => {
    writeConfig({ markerWriteback: true });
    writePaper("Notes/paper.md");
    writeSource("Notes/journal.md", "@osb set note=paper field=rating value=5");

    const report = await applyMarkerWritebacks(vault, {
      files: ["Notes/journal.md"],
      apply: true,
      agent: "a",
      now: NOW,
    });

    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]!.status).toBe("invalid-field");
    expect(report.entries[0]!.error).toContain("rating");
    expect(report.failedCount).toBe(1);

    // Nothing written or consumed.
    expect(attrsOf("Notes/paper.md")).toEqual({});
    expect(readSource("Notes/journal.md")).not.toContain("@osb✓");
    expect(attributeWriteEvents()).toHaveLength(0);
  });

  test("an untyped target note fails closed as invalid-field", async () => {
    writeConfig({ markerWriteback: true });
    // A note with no `type` in frontmatter under a read path.
    const path = join(vault, "Notes", "untyped.md");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "# Untyped\n\nbody\n", "utf8");
    writeSource("Notes/journal.md", "@osb set note=untyped field=status value=queued");

    const report = await applyMarkerWritebacks(vault, {
      files: ["Notes/journal.md"],
      apply: true,
      agent: "a",
      now: NOW,
    });

    expect(report.entries[0]!.status).toBe("invalid-field");
    expect(report.entries[0]!.error).toContain("declares no type");
    expect(readSource("Notes/journal.md")).not.toContain("@osb✓");
  });
});
