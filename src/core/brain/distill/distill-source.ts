/**
 * Source distillation (Ingestion & Import Robustness suite, t_2e2e959f).
 *
 * Condenses one source into discrete atomic claims, each carrying provenance
 * back to the exact block it was drawn from. Composes the primitives OSB
 * already has - block-id wikilinks (`[[Note#^abc]]`), source sha256 provenance,
 * and the idempotent per-source page write - rather than building extraction
 * from scratch.
 *
 * Provider-agnostic: the calling agent supplies the atomic claims and their
 * block references; this core runs NO model. It validates the claims
 * structurally (non-empty text, well-formed block ids), stamps a content
 * sha256 the verifier can reproduce from the source file, and writes one
 * distillation page per source identity, rewritten in place on re-distill
 * (never duplicated). A byte-identical re-run is inert.
 *
 * Language-agnostic: block-id validation is structural (the Obsidian `^id`
 * grammar), never over natural-language vocabulary.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import type { FrontmatterMap } from "../../types.ts";
import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { canonicalNotePath } from "../../path-safety.ts";
import { formatFrontmatter, parseFrontmatter, slugify } from "../../vault.ts";
import { distillationPagePath } from "../paths.ts";
import {
  renderProvenanceSection,
  sourceIdentityHash,
  type Provenance,
} from "../provenance/provenance.ts";
import { isoSecond } from "../time.ts";

/** Frontmatter `kind:` marker of a distillation page. */
export const BRAIN_DISTILLATION_KIND = "brain-distillation";

/** Hash recorded for a source whose bytes are not on disk (a URL identity). */
const MISSING_SOURCE_HASH = "missing";

/** Structural grammar of an Obsidian block id (the text after `#^`). */
const BLOCK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** One atomic claim distilled from the source, with an optional block ref. */
export interface DistillClaim {
  /** The atomic claim text. */
  readonly text: string;
  /** Block id in the source the claim was drawn from (the `^abc` sigil, id only). */
  readonly block?: string;
}

export interface DistillSourceInput {
  /** Source identity: a vault-relative path or a URL. Canonicalized on write. */
  readonly sourcePath: string;
  /** The atomic claims the agent distilled from the source (non-empty). */
  readonly claims: readonly DistillClaim[];
}

export interface DistillSourceOptions {
  readonly agent: string;
  readonly now: Date;
}

export interface DistillSourceResult {
  /** Vault-relative path of the distillation page. */
  readonly distillationPath: string;
  /** `false` when the page already existed and was rewritten. */
  readonly created: boolean;
  /** Number of atomic claims written. */
  readonly claimCount: number;
  /** sha256 over the source bytes, or `missing` when the source has no bytes. */
  readonly sourceHash: string;
}

/** A distillation failed structural validation; nothing was written. */
export class DistillValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DistillValidationError";
  }
}

function validate(input: DistillSourceInput): void {
  if (input.claims.length === 0) {
    throw new DistillValidationError("distillation requires at least one claim");
  }
  input.claims.forEach((claim, i) => {
    if (claim.text.trim().length === 0) {
      throw new DistillValidationError(`claim ${i} has empty text`);
    }
    if (claim.block !== undefined && !BLOCK_ID_RE.test(claim.block)) {
      throw new DistillValidationError(
        `claim ${i} has a malformed block id ${JSON.stringify(claim.block)} - expected an Obsidian block id (alphanumerics and hyphens)`,
      );
    }
  });
}

/** Render one claim bullet, citing its source block when the claim carries one. */
function renderClaim(claim: DistillClaim, canonicalSource: string): string {
  const text = claim.text.trim();
  return claim.block !== undefined
    ? `- ${text} ([[${canonicalSource}#^${claim.block}]])`
    : `- ${text}`;
}

/**
 * Distill a source into atomic claims. Validates the claims (throwing
 * {@link DistillValidationError} with no write on failure), then writes a
 * distillation page listing each claim with its block-level citation and a
 * `## Sources` provenance section. Idempotent on the source identity.
 */
export function distillSource(
  vault: string,
  input: DistillSourceInput,
  opts: DistillSourceOptions,
): DistillSourceResult {
  validate(input);

  const canonicalSource = canonicalNotePath(input.sourcePath);
  const sourceLink = `[[${canonicalSource}]]`;
  const provenance: Provenance = { level: "stated", sources: [sourceLink], premises: [] };

  // Content sha256 the verifier can reproduce from the file (provenance the
  // block citations hang off). URL / identity-only sources have no bytes.
  const absSource = join(vault, canonicalSource);
  const sourceHash = existsSync(absSource)
    ? createHash("sha256").update(readFileSync(absSource)).digest("hex")
    : MISSING_SOURCE_HASH;

  const idHash = sourceIdentityHash([canonicalSource]);
  const absPath = distillationPagePath(vault, `${slugify(canonicalSource)}-${idHash.slice(0, 12)}`);
  const existed = existsSync(absPath);
  const stamp = isoSecond(opts.now);
  const createdAt = existed ? readCreatedAt(absPath, stamp) : stamp;
  const priorUpdatedAt = existed ? readUpdatedAt(absPath, stamp) : stamp;

  const claimsSection = [
    "## Claims",
    "",
    ...input.claims.map((c) => renderClaim(c, canonicalSource)),
  ].join("\n");
  const body = [claimsSection, renderProvenanceSection(provenance)]
    .filter((section) => section.length > 0)
    .join("\n\n");

  const buildContents = (updatedAt: string): string => {
    const meta: FrontmatterMap = {
      kind: BRAIN_DISTILLATION_KIND,
      source_path: canonicalSource,
      source_hash: sourceHash,
      provenance: provenance.level,
      claim_count: input.claims.length,
      created_at: createdAt,
      updated_at: updatedAt,
      tags: ["brain", "brain/distillation"],
    };
    return formatFrontmatter(meta, body);
  };

  // Idempotent no-op: if the page would be byte-identical with its EXISTING
  // updated_at preserved, nothing meaningful changed - skip the write and leave
  // updated_at (and the mtime) alone. A real content change bumps updated_at.
  const onDisk = existed ? readFileSync(absPath, "utf8") : null;
  if (onDisk === null || onDisk !== buildContents(priorUpdatedAt)) {
    mkdirSync(dirname(absPath), { recursive: true });
    atomicWriteFileSync(absPath, buildContents(stamp));
  }

  return {
    distillationPath: canonicalNotePath(relative(vault, absPath)),
    created: !existed,
    claimCount: input.claims.length,
    sourceHash,
  };
}

/** Read a stable `created_at` from an existing distillation page, else fall back. */
function readCreatedAt(absPath: string, fallback: string): string {
  return readStampField(absPath, "created_at", fallback);
}

/** Read the existing `updated_at` so an unchanged re-run preserves it. */
function readUpdatedAt(absPath: string, fallback: string): string {
  return readStampField(absPath, "updated_at", fallback);
}

function readStampField(absPath: string, field: string, fallback: string): string {
  const [meta] = parseFrontmatter(absPath);
  const value = meta[field];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
