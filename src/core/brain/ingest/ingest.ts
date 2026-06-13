/**
 * Source-ingest pipeline (Knowledge Provenance suite).
 *
 * Turns one text-bearing source (a document, note, or URL's text) into
 * cross-referenced Brain knowledge: the entities and concepts it mentions
 * become registry pages, and a per-source summary page links back to the raw
 * artifact, lists the entities it introduced, and lists its connections to
 * material already in the brain.
 *
 * Provider-agnostic: the calling agent extracts the entities/relations and
 * writes the prose summary; this pipeline never runs a model. OSB owns the
 * deterministic half - routing the extraction through the shared intake
 * primitive, stamping provenance, and committing the summary page idempotently
 * (one source path maps to one summary page, rewritten in place on re-ingest,
 * never duplicated). Text-bearing sources only: no OCR, binary, or media path.
 *
 * The connections list is derived, not guessed: an entity that ALREADY existed
 * before this ingest (the intake reports it as updated, not created) is a
 * genuine connection to prior material; a freshly created entity is not.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, relative } from "node:path";

import type { FrontmatterMap } from "../../types.ts";
import { canonicalNotePath } from "../../path-safety.ts";
import { parseFrontmatter, slugify, writeFrontmatterAtomic } from "../../vault.ts";
import { isoSecond } from "../time.ts";
import { sourcePagePath } from "../paths.ts";
import { intakeExtraction, type ExtractionIntake } from "../intake/extract-intake.ts";
import {
  renderProvenanceSection,
  sourceIdentityHash,
  type Provenance,
} from "../provenance/provenance.ts";

/** Frontmatter `kind:` marker of an ingested source summary page. */
export const BRAIN_SOURCE_KIND = "brain-source";

export interface IngestSourceInput {
  /** Source identity - a vault-relative path or a URL. Canonicalized on write. */
  readonly sourcePath: string;
  /** Agent-written summary prose for the source. */
  readonly summary: string;
  /** The entities + relations the agent extracted from the source. */
  readonly extraction: ExtractionIntake;
}

export interface IngestSourceOptions {
  readonly agent: string;
  readonly now: Date;
}

export interface IngestSourceResult {
  /** Vault-relative path of the summary page. */
  readonly summaryPath: string;
  /** `false` when the summary page already existed and was rewritten. */
  readonly created: boolean;
  /** Entity ids newly created by this ingest. */
  readonly entitiesCreated: readonly string[];
  /** Entity ids that already existed and were touched. */
  readonly entitiesUpdated: readonly string[];
  /** Pre-existing entity ids this source connected to (its connections). */
  readonly connections: readonly string[];
}

function renderLinkSection(heading: string, ids: readonly string[]): string {
  if (ids.length === 0) return "";
  return [`## ${heading}`, "", ...ids.map((id) => `- [[${id}]]`)].join("\n");
}

/**
 * Ingest one source: intake its extracted entities/relations, then write the
 * per-source summary page with a Sources backlink, an entity list, and a
 * connections-to-existing-notes list. Idempotent on the source path.
 */
export function ingestSource(
  vault: string,
  input: IngestSourceInput,
  opts: IngestSourceOptions,
): IngestSourceResult {
  const canonicalSource = canonicalNotePath(input.sourcePath);
  const sourceLink = `[[${canonicalSource}]]`;
  const provenance: Provenance = { level: "stated", sources: [sourceLink], premises: [] };

  const intake = intakeExtraction(vault, input.extraction, {
    agent: opts.agent,
    now: opts.now,
    provenance,
  });
  const connections = intake.entitiesUpdated;
  const allEntities = [...intake.entitiesCreated, ...intake.entitiesUpdated];

  // The page filename keys on the source-identity hash, not just the slug:
  // two distinct non-ASCII / symbol-only source paths can slugify to the same
  // fallback, which would silently clobber one summary with another. A hash
  // suffix keeps distinct sources distinct while staying idempotent (the same
  // source path always yields the same hash, hence the same file).
  const sourceHash = sourceIdentityHash([canonicalSource]);
  const absPath = sourcePagePath(vault, `${slugify(canonicalSource)}-${sourceHash.slice(0, 12)}`);
  const existed = existsSync(absPath);
  const stamp = isoSecond(opts.now);
  // Preserve the original created_at on a re-ingest; bump updated_at.
  const createdAt = existed ? readCreatedAt(absPath, stamp) : stamp;

  const meta: FrontmatterMap = {
    kind: BRAIN_SOURCE_KIND,
    source_path: canonicalSource,
    source_hash: sourceHash,
    provenance: provenance.level,
    created_at: createdAt,
    updated_at: stamp,
    tags: ["brain", "brain/source"],
  };

  const body = [
    input.summary.trim(),
    renderProvenanceSection(provenance),
    renderLinkSection("Entities", allEntities),
    renderLinkSection("Connections to existing notes", connections),
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");

  mkdirSync(dirname(absPath), { recursive: true });
  writeFrontmatterAtomic(absPath, meta, body, { overwrite: true });

  return {
    summaryPath: canonicalNotePath(relative(vault, absPath)),
    created: !existed,
    entitiesCreated: intake.entitiesCreated,
    entitiesUpdated: intake.entitiesUpdated,
    connections,
  };
}

/** Read a stable `created_at` from an existing summary page, else fall back. */
function readCreatedAt(absPath: string, fallback: string): string {
  const [meta] = parseFrontmatter(absPath);
  const value = meta["created_at"];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
