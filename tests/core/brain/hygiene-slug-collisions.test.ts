/**
 * Slug-collisions hygiene detector (search/diagnostics/vault-hygiene
 * wave; kanban t_7bad7ad8).
 *
 * The write path cannot clobber (exclusive-create ladder, caller-named
 * refusals), so the detector is informational: it names EXISTING
 * same-stem slug groups per directory - the suffixed stems an operator
 * sees with no explanation that they were one intended slug. Lost-race
 * `-2` pairs are reported too: the detector cannot distinguish a lost
 * race from an accidental duplicate, so the operator decides (evidence
 * carries mtimes).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { runHygieneScan } from "../../../src/core/brain/hygiene/scan.ts";
import { HYGIENE_DETECTOR_IDS } from "../../../src/core/brain/hygiene/types.ts";
import type { HygieneFinding } from "../../../src/core/brain/hygiene/types.ts";
import { hygieneFindingId } from "../../../src/core/brain/hygiene/detectors/id.ts";
import { detectSlugCollisions } from "../../../src/core/brain/hygiene/detectors/slug-collisions.ts";

let vault: string;

const NOW = new Date("2026-06-10T12:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-slug-collisions-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeNote(rel: string, mtimeMs?: number): void {
  const abs = join(vault, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "---\nkind: brain-preference\n---\n\nbody for " + rel + "\n", "utf8");
  if (mtimeMs !== undefined) utimesSync(abs, new Date(mtimeMs), new Date(mtimeMs));
}

function collisions(): HygieneFinding[] {
  return [...detectSlugCollisions(vault)];
}

describe("slug-collisions detector", () => {
  test("reports exactly one finding for a ladder-suffixed pair in one directory", () => {
    writeNote("Brain/captures/topic.md", Date.parse("2026-09-01T10:00:00Z"));
    writeNote("Brain/captures/topic-2.md", Date.parse("2026-09-01T10:00:01Z"));
    const findings = collisions();
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.detector).toBe("slug-collisions");
    expect(finding.severity).toBe("info");
    expect(finding.proposed_action).toBe("review");
    expect(finding.title).toBe('2 notes share the slug stem "topic" in Brain/captures/');
    expect(finding.targets).toEqual(["Brain/captures/topic.md", "Brain/captures/topic-2.md"]);
    expect(finding.evidence.stem).toBe("topic");
    expect(finding.evidence.directory).toBe("Brain/captures");
  });

  test("evidence mtimes run parallel to the sorted targets", () => {
    writeNote("Brain/captures/topic.md", Date.parse("2026-09-01T10:00:00Z"));
    writeNote("Brain/captures/topic-2.md", Date.parse("2026-09-12T08:31:00Z"));
    const mtimes = (collisions()[0]!.evidence.mtimes as string[]).map(Date.parse);
    expect(mtimes).toEqual([
      Date.parse("2026-09-01T10:00:00Z"),
      Date.parse("2026-09-12T08:31:00Z"),
    ]);
  });

  test("finding id comes from the shared hygieneFindingId over the targets and is stable", () => {
    writeNote("Brain/captures/topic.md");
    writeNote("Brain/captures/topic-2.md");
    const first = collisions();
    const second = collisions();
    expect(first[0]!.id).toBe(second[0]!.id);
    expect(first[0]!.id).toBe(hygieneFindingId("slug-collisions", first[0]!.targets));
  });

  test("groups a three-member ladder as one finding", () => {
    writeNote("Brain/captures/topic.md");
    writeNote("Brain/captures/topic-2.md");
    writeNote("Brain/captures/topic-3.md");
    const findings = collisions();
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toBe('3 notes share the slug stem "topic" in Brain/captures/');
    expect(findings[0]!.targets).toEqual([
      "Brain/captures/topic.md",
      "Brain/captures/topic-2.md",
      "Brain/captures/topic-3.md",
    ]);
  });

  test("does not report the same stem in different directories", () => {
    writeNote("Brain/captures/topic.md");
    writeNote("Brain/notes/topic-2.md");
    expect(collisions()).toHaveLength(0);
  });

  test("reports nothing on an empty vault", () => {
    expect(collisions()).toHaveLength(0);
  });

  test("does not report distinct stems", () => {
    writeNote("Brain/captures/alpha.md");
    writeNote("Brain/captures/beta.md");
    expect(collisions()).toHaveLength(0);
  });

  test("a month of date-named notes is not a collision", () => {
    for (const day of ["01", "02", "10", "11", "30", "31"])
      writeNote(`Brain/log/2026-09-${day}.md`);
    expect(collisions()).toHaveLength(0);
  });

  test("a numbered series without its bare base is not a collision", () => {
    writeNote("Brain/notes/chapter-2.md");
    writeNote("Brain/notes/chapter-3.md");
    expect(collisions()).toHaveLength(0);
  });

  test("a lone suffixed stem is not a collision", () => {
    writeNote("Brain/captures/topic-2.md");
    expect(collisions()).toHaveLength(0);
  });

  test("the ladder never emits -1 or zero-padded suffixes, so those are distinct stems", () => {
    writeNote("Brain/captures/topic.md");
    writeNote("Brain/captures/topic-1.md");
    writeNote("Brain/captures/topic-02.md");
    expect(collisions()).toHaveLength(0);
  });

  test("Brain-prefix allocations group via their final basenames", () => {
    writeNote("Brain/preferences/pref-topic.md");
    writeNote("Brain/preferences/pref-topic-2.md");
    const findings = collisions();
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence.stem).toBe("pref-topic");
    expect(findings[0]!.evidence.directory).toBe("Brain/preferences");
  });

  test("spellings that slugify to the same slug share a stem", () => {
    writeNote("Brain/captures/My Topic.md");
    writeNote("Brain/captures/my-topic.md");
    const findings = collisions();
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence.stem).toBe("my-topic");
    expect(findings[0]!.targets).toEqual([
      "Brain/captures/My Topic.md",
      "Brain/captures/my-topic.md",
    ]);
  });
});

describe("slug-collisions scan integration", () => {
  test("the detector id is registered in the closed tuple", () => {
    expect(HYGIENE_DETECTOR_IDS).toContain("slug-collisions");
  });

  test("the default sweep includes slug-collisions", () => {
    writeNote("Brain/captures/topic.md");
    writeNote("Brain/captures/topic-2.md");
    const report = runHygieneScan(vault, { now: NOW });
    expect(report.detectors_run).toContain("slug-collisions");
    expect(report.counts["slug-collisions"]).toBe(1);
    const finding = report.findings.find((f) => f.detector === "slug-collisions");
    expect(finding).toBeDefined();
    expect(finding!.targets).toEqual(["Brain/captures/topic.md", "Brain/captures/topic-2.md"]);
  });

  test("an explicit subset runs slug-collisions alone", () => {
    writeNote("Brain/captures/topic.md");
    writeNote("Brain/captures/topic-2.md");
    const report = runHygieneScan(vault, { detectors: ["slug-collisions"], now: NOW });
    expect(report.detectors_run).toEqual(["slug-collisions"]);
    expect(report.findings).toHaveLength(1);
  });
});
