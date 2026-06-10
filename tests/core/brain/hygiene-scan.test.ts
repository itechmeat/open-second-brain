/**
 * Hygiene kernel: scan over pure detectors
 * (continuity-hygiene-freshness suite, Task 8; kanban t_698db8f7 /
 * t_db375a60 detection side).
 *
 * `runHygieneScan` is read-only composition: each detector returns
 * typed findings, the scan folds them into one frozen digest, and a
 * broken detector lands in `errors` instead of failing the run.
 * Detectors here: `conflicts` (truth-layer value conflicts),
 * `usefulness` (preferences with no recall evidence), `freshness`
 * (stale -> recompile, orphaned -> review).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { appendClaimEvent } from "../../../src/core/brain/truth/store.ts";
import { emitRecallTelemetry } from "../../../src/core/brain/recall-telemetry.ts";
import {
  computeSourceStamp,
  formatSourceStampFrontmatter,
} from "../../../src/core/brain/freshness.ts";
import { runHygieneScan } from "../../../src/core/brain/hygiene/scan.ts";

let vault: string;

const NOW = new Date("2026-06-10T12:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-hygiene-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writePref(slug: string, createdAt: string): void {
  writeFileSync(
    join(vault, "Brain", "preferences", `pref-${slug}.md`),
    [
      "---",
      "kind: brain-preference",
      `id: pref-${slug}`,
      "tags: [brain, brain/preference]",
      `topic: ${slug}`,
      "_status: confirmed",
      `principle: principle for ${slug}`,
      `created_at: ${createdAt}`,
      `unconfirmed_until: ${createdAt}`,
      "---",
      "",
    ].join("\n"),
    "utf8",
  );
}

describe("conflicts detector", () => {
  test("surfaces a contested truth slot as a review finding", () => {
    appendClaimEvent(vault, {
      ts: "2026-06-01T10:00:00Z",
      agent: "agent-a",
      entity: "ACME Corp",
      aspect: "headquarters",
      value: "Berlin",
      source: "[[note-a]]",
    });
    appendClaimEvent(vault, {
      ts: "2026-06-05T10:00:00Z",
      agent: "agent-b",
      entity: "ACME Corp",
      aspect: "headquarters",
      value: "Lisbon",
      source: "[[note-b]]",
    });
    const report = runHygieneScan(vault, { detectors: ["conflicts"], now: NOW });
    expect(report.findings).toHaveLength(1);
    const finding = report.findings[0]!;
    expect(finding.detector).toBe("conflicts");
    expect(finding.proposed_action).toBe("review");
    expect(finding.targets[0]).toBe("acme corp#headquarters");
    expect(report.counts.conflicts).toBe(1);
  });

  test("no conflicts means no findings", () => {
    const report = runHygieneScan(vault, { detectors: ["conflicts"], now: NOW });
    expect(report.findings).toHaveLength(0);
  });
});

describe("usefulness detector", () => {
  test("flags old preferences with zero recall evidence, skips recalled ones", () => {
    writePref("never-recalled", "2026-01-01T00:00:00Z");
    writePref("recalled", "2026-01-01T00:00:00Z");
    writePref("too-young", "2026-06-01T00:00:00Z");
    emitRecallTelemetry(vault, {
      host: "test",
      mode: "context_pack",
      status: "ok",
      durationMs: 5,
      resultCount: 1,
      topArtifacts: [{ id: "pref-recalled" }],
    });
    const report = runHygieneScan(vault, { detectors: ["usefulness"], now: NOW });
    expect(report.findings).toHaveLength(1);
    const finding = report.findings[0]!;
    expect(finding.detector).toBe("usefulness");
    expect(finding.targets).toEqual(["pref-never-recalled"]);
    expect(finding.proposed_action).toBe("review");
  });
});

describe("freshness detector", () => {
  test("maps stale pages to recompile and orphaned pages to review", () => {
    writeFileSync(join(vault, "notes-src.md"), "alpha", "utf8");
    const staleStamp = computeSourceStamp(vault, ["notes-src.md"]);
    mkdirSync(join(vault, "Brain", "derived"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "derived", "stale.md"),
      `---\n${formatSourceStampFrontmatter(staleStamp)}\n---\nbody`,
      "utf8",
    );
    const orphanStamp = computeSourceStamp(vault, ["gone-src.md"]);
    writeFileSync(
      join(vault, "Brain", "derived", "orphan.md"),
      `---\n${formatSourceStampFrontmatter(orphanStamp)}\n---\nbody`,
      "utf8",
    );
    writeFileSync(join(vault, "notes-src.md"), "alpha CHANGED", "utf8");

    const report = runHygieneScan(vault, { detectors: ["freshness"], now: NOW });
    const byAction = new Map(report.findings.map((f) => [f.proposed_action, f]));
    expect(byAction.get("recompile")?.targets[0]?.endsWith("stale.md")).toBe(true);
    expect(byAction.get("review")?.targets[0]?.endsWith("orphan.md")).toBe(true);
  });
});

describe("scan composition", () => {
  test("runs every requested detector, freezes the digest, reports counts", () => {
    const report = runHygieneScan(vault, { now: NOW });
    expect(report.detectors_run).toEqual(["conflicts", "dedup", "freshness", "usefulness"]);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.findings)).toBe(true);
    expect(report.errors).toHaveLength(0);
    expect(report.generated_at).toBe(NOW.toISOString());
  });

  test("finding ids are deterministic across runs", () => {
    writePref("never-recalled", "2026-01-01T00:00:00Z");
    const first = runHygieneScan(vault, { detectors: ["usefulness"], now: NOW });
    const second = runHygieneScan(vault, { detectors: ["usefulness"], now: NOW });
    expect(first.findings[0]?.id).toBe(second.findings[0]?.id);
  });
});
