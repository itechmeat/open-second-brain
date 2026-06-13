/**
 * Parameterized research pipeline (Knowledge Provenance suite).
 *
 * Turns N sources plus an agent-run synthesis into one dated, cited report
 * page in the vault. Each finding cites the source(s) that flagged it, so the
 * report is auditable back to its inputs and becomes a first-class recall
 * input itself.
 *
 * Provider-agnostic: the agent pulls the sources and writes the findings; OSB
 * runs no model. OSB owns the deterministic half - validating that every
 * finding cites at least one of the consulted sources (no uncited claims),
 * stamping provenance, and writing the report page idempotently (one
 * date+title maps to one report, rewritten in place).
 *
 * The citation constraint is the point: a finding with no source, or a finding
 * citing a source that was not consulted, is rejected rather than written as
 * an unprovenanced claim.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, relative } from "node:path";

import type { FrontmatterMap } from "../../types.ts";
import { canonicalNotePath } from "../../path-safety.ts";
import { slugify, writeFrontmatterAtomic } from "../../vault.ts";
import { isoDate, isoSecond } from "../time.ts";
import { reportPagePath } from "../paths.ts";
import { renderProvenanceSection, type Provenance } from "../provenance/provenance.ts";

/** Frontmatter `kind:` marker of a research report page. */
export const BRAIN_REPORT_KIND = "brain-report";

/** One finding plus the sources that flagged it. */
export interface ResearchFinding {
  readonly statement: string;
  /** Source identifiers (a subset of the consulted sources) that flagged this. */
  readonly sources: readonly string[];
}

export interface ResearchReportInput {
  readonly title: string;
  readonly findings: readonly ResearchFinding[];
  /** Every source consulted for the report. */
  readonly sources: readonly string[];
}

export interface ResearchReportOptions {
  readonly agent: string;
  readonly now: Date;
}

export interface ResearchReportResult {
  /** Vault-relative path of the report page. */
  readonly reportPath: string;
  readonly created: boolean;
  readonly findingCount: number;
}

/** A research report failed validation; nothing was written. */
export class ResearchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchValidationError";
  }
}

/** Wrap a bare source identifier in a wikilink; leave an existing one as-is. */
function asWikilink(source: string): string {
  const trimmed = source.trim();
  return trimmed.startsWith("[[") ? trimmed : `[[${canonicalNotePath(trimmed)}]]`;
}

function validate(input: ResearchReportInput): void {
  if (input.title.trim().length === 0) {
    throw new ResearchValidationError("report title must not be empty");
  }
  if (input.sources.length === 0) {
    throw new ResearchValidationError("a report must consult at least one source");
  }
  if (input.findings.length === 0) {
    throw new ResearchValidationError("a report must contain at least one finding");
  }
  const consulted = new Set(input.sources.map((s) => s.trim()));
  for (const [i, finding] of input.findings.entries()) {
    if (finding.statement.trim().length === 0) {
      throw new ResearchValidationError(`finding[${i}] statement must not be empty`);
    }
    if (finding.sources.length === 0) {
      throw new ResearchValidationError(
        `finding[${i}] must cite at least one source (no uncited claims)`,
      );
    }
    for (const src of finding.sources) {
      if (!consulted.has(src.trim())) {
        throw new ResearchValidationError(
          `finding[${i}] cites a source not in the consulted set: ${JSON.stringify(src)}`,
        );
      }
    }
  }
}

/**
 * Write a dated, cited research report. Validates the citation contract first
 * (throwing {@link ResearchValidationError} with no write on failure), then
 * writes the report page idempotently on the date+title path.
 */
export function writeResearchReport(
  vault: string,
  input: ResearchReportInput,
  opts: ResearchReportOptions,
): ResearchReportResult {
  validate(input);

  const date = isoDate(opts.now);
  const stamp = isoSecond(opts.now);
  const absPath = reportPagePath(vault, date, slugify(input.title));

  const findingLines = input.findings.map((f) => {
    const cites = f.sources.map(asWikilink).join(", ");
    return `- ${f.statement.trim()} (cites: ${cites})`;
  });
  const provenance: Provenance = {
    level: "stated",
    sources: input.sources.map(asWikilink),
    premises: [],
  };

  const body = [
    `# ${input.title.trim()}`,
    ["## Findings", "", ...findingLines].join("\n"),
    renderProvenanceSection(provenance),
  ].join("\n\n");

  const meta: FrontmatterMap = {
    kind: BRAIN_REPORT_KIND,
    title: input.title.trim(),
    report_date: date,
    provenance: provenance.level,
    source_count: input.sources.length,
    created_at: stamp,
    updated_at: stamp,
    tags: ["brain", "brain/report"],
  };

  mkdirSync(dirname(absPath), { recursive: true });
  // Idempotent on date+title: a re-run rewrites the same report page in place.
  // existsSync drives the `created` flag; an overwrite write then surfaces a
  // real I/O error directly instead of a catch masking it as a re-run.
  const created = !existsSync(absPath);
  writeFrontmatterAtomic(absPath, meta, body, { overwrite: true });

  return {
    reportPath: canonicalNotePath(relative(vault, absPath)),
    created,
    findingCount: input.findings.length,
  };
}
