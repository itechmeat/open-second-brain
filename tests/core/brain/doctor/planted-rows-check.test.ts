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
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { runDoctor } from "../../../../src/core/brain/doctor.ts";
import {
  PLANTED_STRUCTURE_ROWS_CODE,
  plantedRowsCheck,
} from "../../../../src/core/brain/doctor/planted-rows-check.ts";
import { planPlantedRows } from "../../../../src/core/brain/planted-rows.ts";
import { writeCaptureNote } from "../../../../src/core/brain/capture/capture-note.ts";
import { intakeExtraction } from "../../../../src/core/brain/intake/extract-intake.ts";
import { ingestSource } from "../../../../src/core/brain/ingest/ingest.ts";
import { distillSource } from "../../../../src/core/brain/distill/distill-source.ts";
import { MARKDOWN_NEUTRALIZE_MODE_ENV } from "../../../../src/core/brain/text/neutralize-markdown.ts";
import { CHMOD_CANNOT_DENY } from "../../../helpers/platform.ts";
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
    // The five named paths are distinct rows, all staged captures of this
    // same-second batch, with the remainder counted after the cap.
    const namedPaths = warning!.message.match(/Brain\/captures\/cap-\S+?\.md/g) ?? [];
    expect(namedPaths).toHaveLength(5);
    expect(new Set(namedPaths).size).toBe(5);
    for (const path of namedPaths) {
      expect(path).toMatch(/^Brain\/captures\/cap-2026-08-01-100000-/);
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

  test("a capture's own guidance section is writer output, not planted", () => {
    // The writer renders the trailing ## Guidance heading itself
    // (capture-note.ts) under the capture_guidance marker; on this
    // third-party lane the heading is a live atx row like any other, so
    // without the writer-section exclusion a CLEAN capture reported its
    // own writer as planted.
    writeCaptureNote(vault, {
      body: "a clean capture",
      provenance: prov(),
      guidance: "file this under projects after reading",
    });
    expect(plantedWarning(vault)).toBeUndefined();
  });

  test("an extra planted row beside a writer section is still exactly that row", () => {
    // The exclusion covers the writer's ## Guidance heading, nothing
    // else: planted rows in the caller's body count, and the writer's
    // own heading does not.
    writeCaptureNote(vault, {
      body: "note [[planted-link]]\n\n## Planted Heading\n",
      provenance: prov(),
      guidance: "file this",
    });
    const warning = plantedWarning(vault)!;
    expect(warning.message).toContain("2 live structure row(s) across 1 Brain page(s)");
  });

  test("a Guidance heading no marker authorizes is still planted", () => {
    // The writer renders ## Guidance only when it set capture_guidance;
    // an unmarked capture carrying the heading is quoting caller text
    // (people quote documents), and the split is exactly what the marker
    // authorizes.
    writePlainPage(
      "Brain/captures/cap-unmarked.md",
      "kind: brain-capture",
      "quoted material\n\n## Guidance\n\n[[planted-link]]",
    );
    const page = planPlantedRows(vault).planted.find(
      (p) => p.path === "Brain/captures/cap-unmarked.md",
    );
    expect(page).toBeDefined();
    expect(page!.kinds).toEqual(["atx-heading", "wikilink"]);
  });

  test("a source summary's own citation sections are writer output, not planted", () => {
    // ingest.ts composes every summary page as prose plus the rendered
    // provenance and link sections; the `## Sources` heading and its
    // `- [[id]]` bullets are the writer's citation rows, so a clean
    // ingest must report none of them.
    const sections = [
      "## Sources",
      "",
      "- [[cap-2026-08-01-100000-ab12cd34]]",
      "",
      "## Premises (stated)",
      "",
      "- [[fact-one]]",
      "",
      "## Entities",
      "",
      "- [[entity-one]]",
      "",
      "## Connections to existing notes",
      "",
      "- [[note-one]]",
    ].join("\n");
    writePlainPage(
      "Brain/sources/s.md",
      "kind: brain-source\nsource_path: notes/a.md",
      `summary of the source\n\n${sections}`,
    );
    expect(planPlantedRows(vault).planted).toEqual([]);
    // Every provenance level is a writer-rendered heading spelling. The
    // writer renders Premises only AFTER its own ## Sources citation
    // (renderProvenanceSection emits Sources first), so the fixture carries
    // the citation a real summary page always has.
    writePlainPage(
      "Brain/sources/s2.md",
      "kind: brain-source\nsource_path: notes/b.md",
      "summary\n\n## Sources\n\n- [[cap-2026-08-01-100000-ab12cd34]]\n\n## Premises (inferred)\n\n- [[fact-two]]",
    );
    expect(planPlantedRows(vault).planted).toEqual([]);
  });

  test("the derivation headings a summary writer renders are not planted either", () => {
    // The html and table extractors append their own sections to the
    // same summary page (extract-html.ts `## Parts`, table-note.ts
    // `## Table` with one `### Rows a-b` heading per group); those
    // headings are writer-rendered like the citation sections.
    const derivation = [
      "## Parts",
      "",
      "```parts",
      "h1 Title | lines 0-3",
      "```",
      "",
      "## Table",
      "",
      "```table",
      "a | b",
      "1 | 2",
      "```",
      "",
      "### Rows 0-1",
      "",
      "```table",
      "a | b",
      "1 | 2",
      "```",
      "",
      "Rendered 2 of 2 rows.",
    ].join("\n");
    writePlainPage(
      "Brain/sources/t.md",
      "kind: brain-source\nsource_path: data/t.csv",
      `summary of the table\n\n## Sources\n\n- [[cap-2026-08-01-100000-ab12cd34]]\n\n${derivation}`,
    );
    expect(planPlantedRows(vault).planted).toEqual([]);
  });

  test("an extra planted row in the summary prose is still exactly that row", () => {
    const sections = ["## Sources", "", "- [[cap-one]]"].join("\n");
    writePlainPage(
      "Brain/sources/s.md",
      "kind: brain-source\nsource_path: notes/a.md",
      `caller [[planted-link]] prose\n\n## Planted Heading\n\n${sections}`,
    );
    const warning = plantedWarning(vault)!;
    expect(warning.message).toContain("2 live structure row(s) across 1 Brain page(s)");
  });

  test("a quarantined entity page's writer sections are writer output, not planted", () => {
    // The registry composes every quarantined entity page as the writer's
    // `# <name>` H1 plus the provenance citation (`## Sources` with its
    // `- [[source]]` bullet, renderProvenanceSection) - review H2: without
    // the brain-entity writer rules a CLEAN untrusted ingest reported its
    // own writer as planted, a permanent warning on any vault that ever
    // ingested an untrusted source.
    intakeExtraction(
      vault,
      { entities: [{ category: "person", name: "Alice Example" }], relations: [] },
      {
        agent: "claude",
        now: NOW,
        provenance: { level: "stated", sources: ["[[https://example.test/x]]"], premises: [] },
      },
    );
    const plan = planPlantedRows(vault);
    expect(plan.planted.find((p) => p.path.startsWith("Brain/entities/"))).toBeUndefined();
  });

  test("a planted name on an entity page is exactly that row beside the writer's sections", () => {
    // The writer's H1 shape (`# ` on the first body line) and its citation
    // sections are exempt; the NAME content is caller text, so a wikilink
    // planted inside it counts - the heading row on the same line does not.
    intakeExtraction(
      vault,
      {
        entities: [{ category: "person", name: "Alice [[evil-target]] Example" }],
        relations: [],
      },
      {
        agent: "claude",
        now: NOW,
        provenance: { level: "stated", sources: ["[[https://example.test/x]]"], premises: [] },
      },
    );
    const page = planPlantedRows(vault).planted.find((p) => p.path.startsWith("Brain/entities/"));
    expect(page).toBeDefined();
    expect(page!.kinds).toEqual(["wikilink"]);
    expect(page!.count).toBe(1);
  });

  test("a distillation page's writer sections are writer output, not planted", () => {
    // distill-source.ts composes every distillation page from its own
    // `## Claims`, `## Excerpt` and `## Sources` sections (review H2): a
    // clean untrusted distillation reported 4 planted rows of the writer's
    // own output.
    distillSource(
      vault,
      {
        sourcePath: "https://example.test/y",
        claims: [{ text: "The sky is blue" }],
        excerpt: "The sky is blue today",
      },
      { agent: "claude", now: NOW },
    );
    const plan = planPlantedRows(vault);
    expect(plan.planted.find((p) => p.path.startsWith("Brain/distillations/"))).toBeUndefined();
  });

  test("a planted claim is exactly that row beside the writer's block citation", () => {
    // The writer's claim-bullet citation `([[source#^block]])` ties to the
    // page's own source_path frontmatter and is exempt; a wikilink planted
    // in the caller's claim TEXT ties to nothing and counts.
    distillSource(
      vault,
      {
        sourcePath: "https://example.test/y",
        claims: [{ text: "The [[planted]] claim", block: "abc" }],
      },
      { agent: "claude", now: NOW },
    );
    const page = planPlantedRows(vault).planted.find((p) =>
      p.path.startsWith("Brain/distillations/"),
    );
    expect(page).toBeDefined();
    expect(page!.kinds).toEqual(["wikilink"]);
    expect(page!.count).toBe(1);
  });

  test("a quoted writer heading in the prose is planted when the writer rendered no such section", () => {
    // Review M1, reproduced end to end: the writer emits no ## Entities
    // section when the extraction named no entities (ingest.ts renders the
    // link sections only when non-empty), so a summary QUOTING the heading
    // is its last occurrence and its planted bullets used to be masked.
    const summary = [
      "Some prose about the source.",
      "",
      "## Entities",
      "",
      "- [[evil-target]]",
      "- [[another-planted]]",
    ].join("\n");
    const res = ingestSource(
      vault,
      {
        sourcePath: "https://example.test/z",
        summary,
        extraction: { entities: [], relations: [] },
      },
      { agent: "claude", now: NOW },
    );
    const page = planPlantedRows(vault).planted.find((p) => p.path === res.summaryPath);
    expect(page).toBeDefined();
    expect(page!.kinds).toEqual(["atx-heading", "wikilink"]);
    expect(page!.count).toBe(3);
  });

  test("a quoted section reports while the writer's own section after the citation stays exempt", () => {
    // The writer's sections all render after its ## Sources citation, so
    // that heading is the writer's prose boundary: an occurrence before it
    // is a caller quotation and counts, the writer's own occurrence after
    // it stays exempt.
    writePlainPage(
      "Brain/sources/q.md",
      "kind: brain-source\nsource_path: notes/a.md",
      [
        "prose",
        "",
        "## Entities",
        "",
        "- [[evil-target]]",
        "",
        "## Sources",
        "",
        "- [[cap-one]]",
        "",
        "## Entities",
        "",
        "- [[ent-real]]",
      ].join("\n"),
    );
    const page = planPlantedRows(vault).planted.find((p) => p.path === "Brain/sources/q.md");
    expect(page).toBeDefined();
    expect(page!.kinds).toEqual(["atx-heading", "wikilink"]);
    expect(page!.count).toBe(2);
  });

  test("a quoted ### Rows heading outside the writer's derivation region is planted", () => {
    // The ranged Rows headings are writer output only inside the writer's
    // own region (after its ## Sources citation); the prefix match no
    // longer exempts every occurrence anywhere in the body.
    writePlainPage(
      "Brain/sources/r.md",
      "kind: brain-source\nsource_path: data/t.csv",
      "prose\n\n### Rows 0-9\n\n[[planted]]\n\n## Sources\n\n- [[cap-one]]",
    );
    const page = planPlantedRows(vault).planted.find((p) => p.path === "Brain/sources/r.md");
    expect(page).toBeDefined();
    expect(page!.kinds).toEqual(["atx-heading", "wikilink"]);
    expect(page!.count).toBe(2);
  });

  test("a staged copy is reported when its published twin is unreadable to the caller", () => {
    // Dedupe runs inside the planner, which knows nothing of
    // ctx.readable; the check filters by it afterwards. A readable
    // staged page whose hash-equal twin the caller may not read must
    // still be reported - dropping the staged copy in favor of a twin
    // the check then filters out would make BOTH disappear.
    const note = writeCaptureNote(vault, { body: "twin [[a]]", provenance: prov() });
    const stagedRel = "Brain/pending/ingest/ing-2026-08-01-x.md";
    mkdirSync(dirname(join(vault, ...stagedRel.split("/"))), { recursive: true });
    writeFileSync(
      join(vault, ...stagedRel.split("/")),
      readFileSync(join(vault, ...note.path.split("/")), "utf8"),
    );
    const findings = runCheck(vault, (rel) => rel !== note.path);
    expect(findings.issues).toHaveLength(1);
    expect(findings.issues[0]!.message).toContain(stagedRel);
    expect(findings.issues[0]!.message).not.toContain(note.path);
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
    // The population split, stated exactly as the planner applies it:
    // one family everywhere, the other only on the lanes, and the
    // writers' own sections excluded from both.
    expect(warning.message).toContain("The population splits by family");
    expect(warning.message).toContain(
      "marker and osb-fence families are scanned on every readable page under Brain/",
    );
    expect(warning.message).toContain(
      "wikilink and heading families are scanned only on the third-party provenance lanes",
    );
    expect(warning.message).toContain("excluded, not reported");
    expect(warning.message).toContain("1 of the page(s) sit in the third-party lanes");
    // Third-party pages are named before the rest: the provenance context.
    expect(warning.message.indexOf("Brain/captures/")).toBeLessThan(
      warning.message.indexOf("Brain/notes/"),
    );
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a publish twin the audit cannot hash does not drop its staged copy",
    () => {
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
    },
  );

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

  test("the check never mutates and never throws over a NUL-byte page", () => {
    writeCaptureNote(vault, { body: "planted [[a]]", provenance: prov() });
    // A NUL byte in the body is ordinary text, not structure: detection
    // neither chokes on it nor counts it, and the page's live wikilink
    // row is reported exactly as it would be without the byte.
    writePlainPage("Brain/captures/corrupt.md", "kind: brain-capture", "body [[x]]\n\x00binary");
    const before = snapshot(vault);
    expect(() => runCheck(vault)).not.toThrow();
    expect(runCheck(vault).issues.length).toBeGreaterThanOrEqual(1);
    const nulPage = planPlantedRows(vault).planted.find(
      (p) => p.path === "Brain/captures/corrupt.md",
    );
    expect(nulPage).toBeDefined();
    expect(nulPage!.count).toBe(1);
    expect(nulPage!.kinds).toEqual(["wikilink"]);
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
