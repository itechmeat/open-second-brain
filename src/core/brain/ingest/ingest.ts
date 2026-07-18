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

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import type { FrontmatterMap } from "../../types.ts";
import { canonicalNotePath } from "../../path-safety.ts";
import {
  formatFrontmatter,
  parseFrontmatter,
  slugify,
  writeFrontmatterAtomic,
} from "../../vault.ts";
import { isoSecond } from "../time.ts";
import { sourcePagePath } from "../paths.ts";
import { intakeExtraction, type ExtractionIntake } from "../intake/extract-intake.ts";
import {
  renderProvenanceSection,
  sourceIdentityHash,
  type Provenance,
} from "../provenance/provenance.ts";
import { recordCompleted } from "./checkpoint.ts";
import { updateManifest } from "./content-manifest.ts";
import { preExtractCodeStructure, type PreExtractResult } from "./pre-extract.ts";

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
  /**
   * Batch-plan id (t_ba1fa5f6). When set, a successful ingest of a vault-file
   * source records the source into that plan's resume checkpoint
   * (union-as-you-go). The content manifest stays the authoritative final
   * state; the checkpoint only tracks plan progress. Absent → no checkpoint.
   */
  readonly planId?: string;
  /**
   * Run the deterministic code-structure pre-extraction pass (P4, t_ef786747)
   * over the source file and surface its JSON seeds on the result, so the agent
   * step can use them as pre-extracted facts. Off by default: with the pass
   * unset the ingest is byte-identical to before (no file read, no result
   * field). The seeds are NEVER written into the summary page - they travel on
   * the result only, keeping the persisted page unchanged.
   */
  readonly preExtract?: boolean;
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
  /**
   * Code-structure pre-extraction seeds (P4), present only when the pass was
   * requested via {@link IngestSourceOptions.preExtract}. `extracted: false`
   * when the source is not a supported code file or has no readable bytes -
   * never a fake empty success. Absent entirely when the pass was off.
   */
  readonly preExtract?: PreExtractResult;
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
  const preExtract = opts.preExtract === true ? runPreExtract(vault, canonicalSource) : undefined;
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

  // Idempotent no-op: only rewrite the summary page when its bytes would
  // actually change. A byte-identical rewrite would churn the mtime and wake
  // the index watcher for nothing; skipping it keeps a re-ingest of an
  // unchanged source truly inert.
  const nextContents = formatFrontmatter(meta, body);
  const unchanged = existed && readFileSync(absPath, "utf8") === nextContents;
  if (!unchanged) {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFrontmatterAtomic(absPath, meta, body, { overwrite: true });
  }

  // Record the source's CONTENT hash so a future re-ingest can classify it
  // `unchanged` and skip the extraction pass. Only when the source resolves to
  // a real file inside the vault - URL and other identity-only sources have no
  // bytes to hash and must leave the manifest untouched (backward-compatible).
  if (existsSync(join(vault, canonicalSource))) {
    updateManifest(vault, [canonicalSource]);
    // Record plan-scoped progress so an interrupted batch resumes at the item
    // boundary (t_ba1fa5f6). Only for real vault files - a URL/identity-only
    // source has no place in a folder plan's checkpoint. Best-effort: a
    // checkpoint write failure must never fail the ingest that already landed.
    if (opts.planId !== undefined && opts.planId.length > 0) {
      try {
        recordCompleted(vault, opts.planId, dirname(canonicalSource), [canonicalSource], opts.now);
      } catch {
        // Checkpointing is a resumability optimization, not correctness.
      }
    }
  }

  return {
    summaryPath: canonicalNotePath(relative(vault, absPath)),
    created: !existed,
    entitiesCreated: intake.entitiesCreated,
    entitiesUpdated: intake.entitiesUpdated,
    connections,
    ...(preExtract !== undefined ? { preExtract } : {}),
  };
}

/**
 * Run the code-structure pre-extraction pass over a vault-file source. A source
 * with no readable file bytes (a URL or identity-only source) cannot be parsed,
 * so it is reported as unextracted rather than a fake empty success.
 */
function runPreExtract(vault: string, canonicalSource: string): PreExtractResult {
  const abs = join(vault, canonicalSource);
  if (!existsSync(abs)) {
    return {
      extracted: false,
      reason: `source has no readable file bytes for code-structure pre-extraction: ${canonicalSource}`,
    };
  }
  return preExtractCodeStructure(canonicalSource, readFileSync(abs, "utf8"));
}

/** Read a stable `created_at` from an existing summary page, else fall back. */
function readCreatedAt(absPath: string, fallback: string): string {
  const [meta] = parseFrontmatter(absPath);
  const value = meta["created_at"];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
