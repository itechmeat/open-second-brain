/**
 * The `capture-scope` hygiene detector. A retrievable page of active
 * knowledge whose every cited source is CURRENTLY `url-only` rests on a
 * locator that may rot; the detector names it (`warning`, `review`). The
 * scope is re-derived from each cited identity on every sweep, so a
 * full-local page whose file vanished reports, and a stamped
 * `bounded-local` counts as backing only while its excerpt block is present
 * and matches its digest. Quarantined pages are skipped: their untrusted
 * marker already names the condition.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { formatFrontmatter, parseFrontmatter } from "../../../src/core/vault.ts";
import type { FrontmatterMap } from "../../../src/core/types.ts";
import { ingestSource } from "../../../src/core/brain/ingest/ingest.ts";
import {
  BRAIN_REPORT_KIND,
  writeResearchReport,
} from "../../../src/core/brain/research/research.ts";
import { distillSource } from "../../../src/core/brain/distill/distill-source.ts";
import {
  CAPTURE_SCOPE,
  excerptDigest,
  renderExcerptSection,
} from "../../../src/core/brain/provenance/capture-scope.ts";
import {
  CAPTURE_SCOPE_DETECTOR_ID,
  detectCaptureScope,
} from "../../../src/core/brain/hygiene/detectors/capture-scope.ts";
import { runHygieneScan } from "../../../src/core/brain/hygiene/scan.ts";
import {
  UNTRUSTED_SOURCE_FRONTMATTER_KEY,
  hasUntrustedSourceMarker,
} from "../../../src/core/brain/trust/untrusted-provenance.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import { DEFAULT_SCAN_IDS, HYGIENE_DETECTOR_IDS } from "../../../src/core/brain/hygiene/types.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-06-13T12:00:00Z");
const LOCAL_SOURCE = "Articles/a.md";
const URL_A = "https://example.test/a";
const URL_B = "https://example.test/b";
const ENTITY_PAGE = "Brain/entities/concept/ent-concept-alpha.md";
const BOUNDED_PAGE = "Brain/distillations/dist-bounded.md";
const EXCERPT = "The protocol settles in two rounds.\n";

function seed(rel: string): void {
  mkdirSync(join(vault, dirname(rel)), { recursive: true });
  writeFileSync(join(vault, rel), "bytes\n", "utf8");
}

function writePage(rel: string, meta: FrontmatterMap, body: string): void {
  mkdirSync(join(vault, dirname(rel)), { recursive: true });
  writeFileSync(join(vault, rel), formatFrontmatter(meta, body), "utf8");
}

function writeEntity(status: string, source: string): void {
  writePage(
    ENTITY_PAGE,
    {
      kind: "brain-entity",
      entity_id: "ent-concept-alpha",
      category: "concept",
      name: "Alpha",
      status,
      tags: ["brain", "brain/entity"],
    },
    `# Alpha\n\n## Sources\n\n- [[${source}]]`,
  );
}

function writeBounded(excerpt: string, stampedHashOf: string): void {
  writePage(
    BOUNDED_PAGE,
    {
      kind: "brain-distillation",
      source_path: URL_A,
      capture_scope: CAPTURE_SCOPE.boundedLocal,
      excerpt_hash: excerptDigest(stampedHashOf),
      provenance: "stated",
    },
    [
      "## Claims",
      "",
      "- A claim.",
      "",
      "## Sources",
      "",
      `- [[${URL_A}]]`,
      "",
      renderExcerptSection(excerpt),
    ].join("\n"),
  );
}

function findingsFor(page: string) {
  return detectCaptureScope(vault).filter((f) => f.targets.includes(page));
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-hygiene-scope-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-hygiene-scope-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("detectCaptureScope", () => {
  test("a finding that opens a fence and never closes it does not hide the report", () => {
    const report = writeResearchReport(
      vault,
      { title: "T", sources: [URL_B], findings: [{ statement: "x\n```", sources: [URL_B] }] },
      { agent: "claude", now: NOW },
    );

    expect(findingsFor(report.reportPath)).toHaveLength(1);
  });

  test("a research report citing only URLs is one review warning naming the URLs", () => {
    const report = writeResearchReport(
      vault,
      { title: "T", sources: [URL_A, URL_B], findings: [{ statement: "S", sources: [URL_A] }] },
      { agent: "claude", now: NOW },
    );

    const findings = findingsFor(report.reportPath);
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.detector).toBe(CAPTURE_SCOPE_DETECTOR_ID);
    expect(finding.severity).toBe("warning");
    expect(finding.proposed_action).toBe("review");
    expect(finding.title).toBe("Active knowledge rests on url-only sources");
    expect(finding.targets).toEqual([report.reportPath]);
    expect(finding.evidence).toEqual({ sources: [URL_A, URL_B], stamped: null });
  });

  test("a report citing one URL and one vault file is not reported", () => {
    seed(LOCAL_SOURCE);
    const report = writeResearchReport(
      vault,
      {
        title: "T",
        sources: [URL_A, LOCAL_SOURCE],
        findings: [{ statement: "S", sources: [URL_A] }],
      },
      { agent: "claude", now: NOW },
    );

    expect(findingsFor(report.reportPath)).toEqual([]);
  });

  test("an active entity citing a URL is reported; the same entity in quarantine is not", () => {
    writeEntity("active", URL_A);
    expect(findingsFor(ENTITY_PAGE)).toHaveLength(1);

    writeEntity("quarantine", URL_A);
    expect(findingsFor(ENTITY_PAGE)).toEqual([]);
  });

  test("an archived entity is outside the canonical scope and is not reported", () => {
    writeEntity("archived", URL_A);
    expect(findingsFor(ENTITY_PAGE)).toEqual([]);
  });

  test("an untrusted ingest page is already gated out and is not reported", () => {
    const ingest = ingestSource(
      vault,
      { sourcePath: URL_A, summary: "S.", extraction: { entities: [], relations: [] } },
      { agent: "claude", now: NOW },
    );

    expect(findingsFor(ingest.summaryPath)).toEqual([]);

    // The cause is the marker, not a page the detector cannot read: the
    // same page without it is reported.
    const [meta, body] = parseFrontmatter(join(vault, ingest.summaryPath));
    expect(hasUntrustedSourceMarker(meta)).toBe(true);
    const { [UNTRUSTED_SOURCE_FRONTMATTER_KEY]: _marker, ...released } = meta;
    writePage(ingest.summaryPath, released, body);
    expect(findingsFor(ingest.summaryPath)).toHaveLength(1);
  });

  test("a distillation whose vault source was deleted is re-derived as url-only", () => {
    seed(LOCAL_SOURCE);
    const distilled = distillSource(
      vault,
      { sourcePath: LOCAL_SOURCE, claims: [{ text: "A claim." }] },
      { agent: "claude", now: NOW },
    );
    expect(findingsFor(distilled.distillationPath)).toEqual([]);

    unlinkSync(join(vault, LOCAL_SOURCE));

    const findings = findingsFor(distilled.distillationPath);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence).toEqual({ sources: [LOCAL_SOURCE], stamped: null });
  });

  test("a bounded-local page backs itself only while its excerpt matches the digest", () => {
    writeBounded(EXCERPT, EXCERPT);
    expect(findingsFor(BOUNDED_PAGE)).toEqual([]);

    writeBounded("The protocol settles in three rounds.\n", EXCERPT);
    const edited = findingsFor(BOUNDED_PAGE);
    expect(edited).toHaveLength(1);
    expect(edited[0]!.evidence).toEqual({ sources: [URL_A], stamped: CAPTURE_SCOPE.boundedLocal });

    writePage(
      BOUNDED_PAGE,
      {
        kind: "brain-distillation",
        source_path: URL_A,
        capture_scope: CAPTURE_SCOPE.boundedLocal,
        excerpt_hash: excerptDigest(EXCERPT),
      },
      `## Claims\n\n- A claim.\n\n## Sources\n\n- [[${URL_A}]]`,
    );
    expect(findingsFor(BOUNDED_PAGE)).toHaveLength(1);
  });

  test("a page of another kind is never inspected", () => {
    // Inside an inspected directory, so only the kind filter can exclude it.
    writePage("Brain/distillations/n.md", { kind: "note" }, `## Sources\n\n- [[${URL_A}]]`);
    expect(detectCaptureScope(vault)).toEqual([]);
  });
});

describe("capture-scope when the filesystem refuses a source", () => {
  test.skipIf(CHMOD_CANNOT_DENY)(
    "an unreadable cited source is treated as backing and does not abort the sweep",
    () => {
      const locked = join(vault, "locked");
      seed("locked/inner/a.md");
      writePage("Brain/reports/a.md", { kind: BRAIN_REPORT_KIND }, `## Sources\n\n- [[${URL_A}]]`);
      writePage(
        "Brain/reports/b.md",
        { kind: BRAIN_REPORT_KIND },
        "## Sources\n\n- [[locked/inner/a.md]]",
      );
      chmodSync(locked, 0o000);
      try {
        const report = runHygieneScan(vault, { now: NOW, detectors: [CAPTURE_SCOPE_DETECTOR_ID] });
        expect(report.errors).toEqual([]);
        expect(report.counts[CAPTURE_SCOPE_DETECTOR_ID]).toBe(1);
        expect(findingsFor("Brain/reports/a.md")).toHaveLength(1);
        expect(findingsFor("Brain/reports/b.md")).toEqual([]);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );
});

describe("capture-scope in the hygiene sweep", () => {
  test("the detector is registered and runs in the default sweep", () => {
    expect(HYGIENE_DETECTOR_IDS).toContain(CAPTURE_SCOPE_DETECTOR_ID);
    expect(DEFAULT_SCAN_IDS).toContain(CAPTURE_SCOPE_DETECTOR_ID);
    writeEntity("active", URL_A);

    const report = runHygieneScan(vault, { now: NOW });

    expect(report.detectors_run).toContain(CAPTURE_SCOPE_DETECTOR_ID);
    expect(report.counts[CAPTURE_SCOPE_DETECTOR_ID]).toBe(1);
  });

  test("finding ids are deterministic across sweeps", () => {
    writeEntity("active", URL_A);
    const first = detectCaptureScope(vault).map((f) => f.id);
    const second = detectCaptureScope(vault).map((f) => f.id);
    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(first[0]!.startsWith(`${CAPTURE_SCOPE_DETECTOR_ID}:`)).toBe(true);
  });
});
