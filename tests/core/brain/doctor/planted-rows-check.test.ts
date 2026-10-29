/**
 * The planted-structure-rows doctor audit (t_c2ac4fc8, lane A5).
 *
 * The doctor leg of the write-time neutralization: a read-only counting
 * check over the pages third-party text was written into, sharing the
 * detection grammar with the neutralizer itself, so the finding, its
 * count and what enforce mode would change cannot drift apart. Mirrors
 * the privacy-marker check's shape: one warning, count and capped named
 * paths, `ctx.readable` filtering, silent when there is nothing to
 * report, never mutating and never throwing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { runDoctor } from "../../../../src/core/brain/doctor.ts";
import {
  PLANTED_STRUCTURE_ROWS_CODE,
  plantedRowsCheck,
} from "../../../../src/core/brain/doctor/planted-rows-check.ts";
import { planPlantedRows } from "../../../../src/core/brain/planted-rows.ts";
import { writeCaptureNote } from "../../../../src/core/brain/capture/capture-note.ts";
import { MARKDOWN_NEUTRALIZE_MODE_ENV } from "../../../../src/core/brain/text/neutralize-markdown.ts";
import type {
  DoctorCheckContext,
  DoctorFindings,
} from "../../../../src/core/brain/doctor/check.ts";

let vault: string;

const NOW = new Date("2026-08-01T10:00:00Z");

function prov(source = "telegram"): { source: string; sender: string; capturedAt: string } {
  return { source, sender: "12345", capturedAt: "2026-08-01T10:00:00Z" };
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-planted-rows-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** The one planted-structure-rows warning of a run, if any. */
function plantedWarning(v: string) {
  return runDoctor(v).warnings.find((w) => w.code === PLANTED_STRUCTURE_ROWS_CODE);
}

/** A DoctorCheckContext over `v`, with an optional readability predicate. */
function checkContext(v: string, readable?: (rel: string) => boolean): DoctorCheckContext {
  return {
    vault: v,
    now: NOW,
    config: undefined,
    dbPath: undefined,
    configPath: undefined,
    ...(readable !== undefined ? { readable } : {}),
    knownBasenames: new Set<string>(),
    idIndex: new Map<string, string[]>(),
    preferences: [],
    logs: [],
  };
}

function runCheck(v: string, readable?: (rel: string) => boolean): DoctorFindings {
  const findings: DoctorFindings = { issues: [], uncertain: [] };
  plantedRowsCheck.run(checkContext(v, readable), findings);
  return findings;
}

function writePlainPage(rel: string, frontmatter: string, body: string): string {
  const abs = join(vault, ...rel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
  return rel;
}

/** Every file under `v` as [vault-relative path, bytes], sorted - a mutation detector. */
function snapshot(v: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const rel of readdirSync(v, { recursive: true }) as string[]) {
    const abs = join(v, rel);
    try {
      out.push([rel.replaceAll("\\", "/"), readFileSync(abs, "utf8")]);
    } catch {
      // a directory entry: readdirSync(recursive) lists those too
    }
  }
  return out.toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

const PLANTED_BODY = "quotes [[planted-note]] and a\n\n## Planted Heading\n";

describe("plantedRowsCheck (the counting check)", () => {
  test("silent when nothing is planted", () => {
    writeCaptureNote(vault, { body: "a clean capture", provenance: prov() });
    expect(plantedWarning(vault)).toBeUndefined();
  });

  test("one warning counting planted pages, naming capped paths", () => {
    for (let i = 0; i < 7; i++) {
      writeCaptureNote(vault, {
        body: `capture ${i} [[planted-${i}]]`,
        provenance: prov(),
      });
    }
    const warning = plantedWarning(vault);
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe("warning");
    expect(warning!.message).toContain("7 Brain page(s)");
    for (let i = 0; i < 5; i++) {
      expect(warning!.message).toContain(`Brain/captures/cap-2026-08-01-100000-`);
    }
    expect(warning!.message).toContain("and 2 more");
    // The paths are vault-relative: the vault root itself is never named.
    expect(warning!.message).not.toContain(vault);
  });

  test("a page the caller may not read is neither named nor counted", () => {
    writeCaptureNote(vault, { body: "visible [[a]]", provenance: prov() });
    const hidden = writeCaptureNote(vault, { body: "hidden [[b]]", provenance: prov("other") });
    const findings = runCheck(vault, (rel) => rel !== hidden.path);
    expect(findings.issues).toHaveLength(1);
    expect(findings.issues[0]!.message).not.toContain(hidden.path);
    expect(findings.issues[0]!.message).toContain("1 Brain page(s)");
  });

  test("a staged copy identical to its publish target is counted once", () => {
    const note = writeCaptureNote(vault, { body: "once [[a]]", provenance: prov() });
    const publishedAbs = join(vault, note.path);
    const stagedDir = join(vault, "Brain", "pending", "ingest");
    mkdirSync(stagedDir, { recursive: true });
    writeFileSync(join(stagedDir, "ing-2026-08-01-x.md"), readFileSync(publishedAbs, "utf8"));
    const findings = runCheck(vault);
    expect(findings.issues).toHaveLength(1);
    expect(findings.issues[0]!.message).toContain("1 Brain page(s)");
    expect(findings.issues[0]!.message).toContain(note.path);
    expect(findings.issues[0]!.message).not.toContain("Brain/pending/ingest");
  });

  test("the marker and fence families scan every readable Brain page; the rest stay lane-keyed", () => {
    // A planted @osb marker on a page NO Brain writer could have authored
    // it on is reported wherever it sits: the §9 vault scan would harvest
    // a live marker from any page it walks, and no Brain writer ever
    // emits one (only the consumed @osb✓ sentinel), so provenance gates
    // nothing for the marker and fence families.
    writePlainPage(
      "Brain/notes/note-x.md",
      "kind: note",
      "@osb feedback negative topic=t principle=p\n",
    );
    writePlainPage("Notes/plain.md", "kind: note", "@osb feedback negative topic=t principle=p\n");
    const plan = planPlantedRows(vault);
    const paths = plan.planted.map((p) => p.path);
    expect(paths).toEqual(["Brain/notes/note-x.md"]);
    expect(paths).not.toContain("Notes/plain.md");
    // Not a third-party lane: the classification rides along as context.
    expect(plan.planted[0]!.thirdParty).toBe(false);
    expect(plan.planted[0]!.kinds).toEqual(["osb-inline"]);
    // The wikilink and heading families stay keyed to the third-party
    // lanes: the Brain's own writers render those by design on pages
    // outside the lanes (the manual's section headings, the log's
    // [[Brain/log/...]] refs), so reporting them regardless of provenance
    // would report the vault's own structure as planted on every run.
    writePlainPage("Brain/notes/note-y.md", "kind: note", PLANTED_BODY);
    const laneKeyed = planPlantedRows(vault);
    expect(laneKeyed.planted.map((p) => p.path)).toEqual(["Brain/notes/note-x.md"]);
    // On a third-party lane page the same body IS a finding.
    writePlainPage(
      "Brain/sources/s.md",
      "kind: brain-source\nsource_path: x\nuntrusted_source: true",
      PLANTED_BODY,
    );
    const after = planPlantedRows(vault);
    const afterPaths = after.planted.map((p) => p.path);
    expect(afterPaths).toContain("Brain/sources/s.md");
    expect(after.planted.find((p) => p.path === "Brain/sources/s.md")!.thirdParty).toBe(true);
    expect(after.planted.find((p) => p.path === "Brain/sources/s.md")!.kinds).toEqual([
      "atx-heading",
      "wikilink",
    ]);
    // The Brain's own machinery is silent: a bootstrap vault's manual
    // carries designed headings and no marker family rows at all.
    expect(afterPaths).not.toContain("Brain/_BRAIN.md");
  });

  test("the finding names the population split and counts the third-party lanes", () => {
    writeCaptureNote(vault, { body: "third [[a]]", provenance: prov() });
    writePlainPage("Brain/notes/note-y.md", "kind: note", "@osb set note=n field=f value=v");
    const warning = plantedWarning(vault)!;
    expect(warning.message).toContain("Brain page(s)");
    expect(warning.message).toContain(
      "marker and osb-fence families are scanned on every readable page under Brain/",
    );
    expect(warning.message).toContain("1 of the page(s) sit in the third-party lanes");
    // Third-party pages are named before the rest: the provenance context.
    expect(warning.message.indexOf("Brain/captures/")).toBeLessThan(
      warning.message.indexOf("Brain/notes/"),
    );
  });

  test("a publish twin the audit cannot hash does not drop its staged copy", () => {
    // The published twin goes unreadable between the walk (which admits
    // it) and the hash (which comes back undefined). An undefined hash
    // must match nothing - two unreadable pages are not the same page -
    // so the readable staged copy stays in the report.
    const note = writeCaptureNote(vault, { body: "once [[a]]", provenance: prov() });
    const stagedDir = join(vault, "Brain", "pending", "ingest");
    mkdirSync(stagedDir, { recursive: true });
    const stagedRel = "Brain/pending/ingest/ing-2026-08-01-x.md";
    writeFileSync(
      join(vault, ...stagedRel.split("/")),
      readFileSync(join(vault, note.path), "utf8"),
    );
    const publishedAbs = join(vault, ...note.path.split("/"));
    chmodSync(publishedAbs, 0o000);
    try {
      const findings = runCheck(vault);
      expect(findings.issues[0]!.message).toContain(stagedRel);
    } finally {
      chmodSync(publishedAbs, 0o644);
    }
  });

  test("the body scan is fence-masked: inert code hides nothing in, planted fences count", () => {
    // A wikilink inside a python fence is inert; an osb block's fence
    // lines are live structure the marker scanners consume.
    writeCaptureNote(vault, {
      body: "```python\nx = '[[inert]]'\n```\n\nlive [[live-one]]\n",
      provenance: prov(),
    });
    const plan = planPlantedRows(vault);
    expect(plan.planted).toHaveLength(1);
    expect(plan.planted[0]!.count).toBe(1);
    expect(plan.planted[0]!.kinds).toEqual(["wikilink"]);
    writeCaptureNote(vault, {
      body: "```osb\nkind: set\nnote: n\nfield: a\nvalue: b\n```\n",
      provenance: prov(),
    });
    const fencePlan = planPlantedRows(vault);
    const fencePage = fencePlan.planted.find((p) => p.kinds.includes("osb-fence"));
    expect(fencePage).toBeDefined();
    expect(fencePage!.kinds).toEqual(["osb-fence"]);
  });

  test("the check never mutates and never throws over an unreadable page", () => {
    writeCaptureNote(vault, { body: "planted [[a]]", provenance: prov() });
    // A corrupt page in the population: unreadable as frontmatter, still
    // walked. The audit skips it rather than throwing.
    writePlainPage("Brain/captures/corrupt.md", "kind: brain-capture", "body [[x]]\n\x00binary");
    const before = snapshot(vault);
    expect(() => runCheck(vault)).not.toThrow();
    expect(runCheck(vault).issues.length).toBeGreaterThanOrEqual(1);
    expect(snapshot(vault)).toEqual(before);
  });

  test("shadow mode adds the would-be-enforce wording; off does not", () => {
    const saved = process.env[MARKDOWN_NEUTRALIZE_MODE_ENV];
    try {
      process.env[MARKDOWN_NEUTRALIZE_MODE_ENV] = "shadow";
      writeCaptureNote(vault, { body: "planted [[a]]", provenance: prov() });
      const shadowMessage = plantedWarning(vault)!.message;
      expect(shadowMessage).toContain("shadow");
      expect(shadowMessage).toContain("enforce");
      rmSync(join(vault, "Brain", "captures"), { recursive: true, force: true });
      delete process.env[MARKDOWN_NEUTRALIZE_MODE_ENV];
      writeCaptureNote(vault, { body: "planted [[b]]", provenance: prov() });
      expect(plantedWarning(vault)!.message).not.toContain("shadow");
    } finally {
      if (saved === undefined) delete process.env[MARKDOWN_NEUTRALIZE_MODE_ENV];
      else process.env[MARKDOWN_NEUTRALIZE_MODE_ENV] = saved;
    }
  });
});
