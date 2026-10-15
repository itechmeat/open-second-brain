/**
 * Retire routing through the hygiene pipeline (storage lifecycle, Lane 4
 * task 4.2).
 *
 * The `retire` action joins the closed vocabulary and the applier
 * capability table as mechanical, but it is the destructive class: the
 * unattended plan default (no ids) holds it in the review path, and it
 * executes only when a caller names its finding id. `executeFinding`
 * then dispatches it to the retirement core; the count-guard semantics
 * the surfaces already enforce on `plan.selected` cover it unchanged.
 *
 * These tests drive the REAL pipeline end to end: detect on a fixture
 * vault, plan, apply - because the routing is only proved when the
 * retirement actually lands.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readManifest, updateManifest } from "../../../src/core/brain/ingest/content-manifest.ts";
import { listContinuityRecords } from "../../../src/core/brain/continuity/store.ts";
import { applyHygienePlan } from "../../../src/core/brain/hygiene/apply.ts";
import { buildHygienePlan } from "../../../src/core/brain/hygiene/plan.ts";
import { runHygieneScan } from "../../../src/core/brain/hygiene/scan.ts";
import {
  HYGIENE_PROPOSED_ACTIONS,
  type HygieneFinding,
} from "../../../src/core/brain/hygiene/types.ts";
import { requireRepairCapability } from "../../../src/core/brain/applier-capability.ts";

let vault: string;

const NOW = new Date("2026-06-01T00:00:00Z");
const CANONICAL_BODY =
  "Collect the latency metrics before optimizing the render loop and archive the traces weekly";
const DUPLICATE_BODY =
  "Collect the latency metrics before optimizing the render loop and archive the traces daily";

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-retire-routing-"));
  mkdirSync(join(vault, "Brain", "sources"), { recursive: true });
  mkdirSync(join(vault, "imports"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeSourcePage(slug: string, body: string, createdAt: string): string {
  const abs = join(vault, "Brain", "sources", `src-${slug}.md`);
  writeFileSync(
    abs,
    [
      "---",
      "kind: brain-source",
      `source_path: imports/${slug}.md`,
      `source_hash: ${"a".repeat(64)}`,
      "tags: [brain, brain/source]",
      `created_at: ${createdAt}`,
      "---",
      "",
      body,
      "",
    ].join("\n"),
    "utf8",
  );
  return `Brain/sources/src-${slug}.md`;
}

/**
 * Near-duplicate pair, both sources recorded in the manifest. The
 * detector keeps the NEWEST page as canonical, so src-b (created
 * 2026-02-01) survives and src-a (created 2026-01-01) is the stale
 * copy a retirement removes.
 */
function seedPair(): { canonical: string; retired: string } {
  writeFileSync(join(vault, "imports", "a.md"), "older source bytes\n", "utf8");
  writeFileSync(join(vault, "imports", "b.md"), "newer source bytes\n", "utf8");
  const retired = writeSourcePage("a", CANONICAL_BODY, "2026-01-01T00:00:00Z");
  const canonical = writeSourcePage("b", DUPLICATE_BODY, "2026-02-01T00:00:00Z");
  updateManifest(vault, ["imports/a.md", "imports/b.md"]);
  return { canonical, retired };
}

/** Scan with the document-dedup detector and return its retire finding. */
function scanRetireFinding(): HygieneFinding {
  const report = runHygieneScan(vault, { detectors: ["document-dedup"], now: NOW });
  const finding = report.findings.find((f) => f.proposed_action === "retire");
  if (finding === undefined) throw new Error("fixture produced no retire finding");
  return finding;
}

describe("retire joins the vocabulary and the capability table", () => {
  test("the vocabulary carries retire as a mechanical, attended-only action", () => {
    expect(HYGIENE_PROPOSED_ACTIONS).toContain("retire");
    const capability = requireRepairCapability("retire");
    expect(capability.verdict).toBe("mechanical");
    expect(
      capability.verdict === "mechanical" && capability.fixer.includes("retireDocumentCopies"),
    ).toBe(true);
  });

  test("an unattended plan holds retire findings in the review path", () => {
    seedPair();
    const finding = scanRetireFinding();
    const report = runHygieneScan(vault, { detectors: ["document-dedup"], now: NOW });

    const unattended = buildHygienePlan(report);
    expect(unattended.selected).toEqual([]);
    expect(unattended.excluded_review).toEqual([finding.id]);
  });

  test("an attended plan selects the retire finding by id", () => {
    seedPair();
    const finding = scanRetireFinding();
    const report = runHygieneScan(vault, { detectors: ["document-dedup"], now: NOW });

    const attended = buildHygienePlan(report, { ids: [finding.id] });
    expect(attended.selected.map((f) => f.id)).toEqual([finding.id]);
    expect(attended.excluded_review).toEqual([]);
  });
});

describe("applyHygienePlan dispatches retire to the retirement core", () => {
  test("an attended apply retires the stale copy for real", async () => {
    const { canonical, retired } = seedPair();
    const finding = scanRetireFinding();
    const plan = buildHygienePlan(
      runHygieneScan(vault, { detectors: ["document-dedup"], now: NOW }),
      {
        ids: [finding.id],
      },
    );

    const result = await applyHygienePlan(vault, plan, {
      agent: "tester",
      now: NOW,
    });

    expect(result.errors).toEqual([]);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]!.action).toBe("retire");
    expect(result.applied[0]!.finding_id).toBe(finding.id);
    expect(result.applied[0]!.detail).toContain(canonical);

    expect(existsSync(join(vault, retired))).toBe(false);
    expect(existsSync(join(vault, canonical))).toBe(true);
    // The manifest entry dropped is the RETIRED copy's source; the
    // canonical copy's source stays recorded.
    expect(readManifest(vault).entries["imports/a.md"]).toBeUndefined();
    expect(readManifest(vault).entries["imports/b.md"]).toBeDefined();
    expect(
      listContinuityRecords(vault, { kind: "source_invalidation" }).some((r) => r.id !== null),
    ).toBe(true);
  });

  test("a dry run previews the retirement with zero writes", async () => {
    const { retired } = seedPair();
    const finding = scanRetireFinding();
    const plan = buildHygienePlan(
      runHygieneScan(vault, { detectors: ["document-dedup"], now: NOW }),
      {
        ids: [finding.id],
      },
    );

    const result = await applyHygienePlan(vault, plan, {
      dryRun: true,
      agent: "tester",
      now: NOW,
    });

    expect(result.dry_run).toBe(true);
    expect(result.planned.map((p) => p.action)).toEqual(["retire"]);
    expect(result.applied).toEqual([]);
    // Nothing moved: the page is still on disk and the manifest intact.
    expect(existsSync(join(vault, retired))).toBe(true);
    expect(readManifest(vault).entries["imports/a.md"]).toBeDefined();
    expect(listContinuityRecords(vault, { kind: "source_invalidation" })).toHaveLength(0);
  });

  test("a per-copy failure surfaces in the apply errors, fail-soft", async () => {
    const { canonical, retired } = seedPair();
    // The report - and the plan built from it - is captured BEFORE the
    // canonical vanishes, exactly as an operator's prior scan would be.
    const report = runHygieneScan(vault, { detectors: ["document-dedup"], now: NOW });
    const finding = report.findings.find((f) => f.proposed_action === "retire")!;
    // The retirement refuses the copy rather than strand every inbound
    // link to a page that is not there.
    rmSync(join(vault, canonical));
    const plan = buildHygienePlan(report, { ids: [finding.id] });

    const result = await applyHygienePlan(vault, plan, {
      agent: "tester",
      now: NOW,
    });

    expect(result.applied).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.finding_id).toBe(finding.id);
    expect(result.errors[0]!.message).toContain("canonical");
    // The failed copy stays on disk.
    expect(existsSync(join(vault, retired))).toBe(true);
  });
});
