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
 *
 * TRUST. Both arguments are caller-supplied, and the caller is the same agent
 * that read the material - so the source identity is a CLAIM, not a fact. This
 * module used to take it at face value: it canonicalised the string, stat-ed
 * and hashed whatever `join(vault, ...)` landed on, and wrote every page under
 * `provenance: stated`, the top authority tier. It now asks the same question
 * of the same classifier the other two claim-write paths ask
 * ({@link classifySourceOrigin}), so a source this vault does not own commits
 * in the quarantine lane the retrieval trust gate can actually see.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, relative } from "node:path";

import type { FrontmatterMap } from "../../types.ts";
import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { canonicalNotePath } from "../../path-safety.ts";
import { formatFrontmatter, parseFrontmatter, slugify } from "../../vault.ts";
import { classifySourceOrigin, normalizeSourceIdentity } from "../intake/source-trust.ts";
import { distillationPagePath } from "../paths.ts";
import {
  DISTILL_CLAIMS_SHAPE,
  DISTILL_CLAIMS_SURFACE,
  assertResponseShape,
} from "../response-shape.ts";
import {
  sourceContentHashFrontmatter,
  untrustedSourceFrontmatter,
  type IntakeTrust,
} from "../trust/untrusted-provenance.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import {
  renderProvenanceSection,
  sourceIdentityHash,
  type Provenance,
} from "../provenance/provenance.ts";
import { isoSecond } from "../time.ts";

/** Frontmatter `kind:` marker of a distillation page. */
export const BRAIN_DISTILLATION_KIND = "brain-distillation";

/** Structural grammar of an Obsidian block id (the text after `#^`). */
const BLOCK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** One atomic claim distilled from the source, with an optional block ref. */
export interface DistillClaim {
  /** The atomic claim text. */
  readonly text: string;
  /** Block id in the source the claim was drawn from (the `^abc` sigil, id only). */
  readonly block?: string;
}

/**
 * Normalize one agent-supplied claim record into a {@link DistillClaim}. Shared
 * by the CLI and MCP surfaces so both accept the same shape: a `text` string and
 * an optional `block` id (a leading `^` sigil is stripped; an empty block is
 * dropped). Structural validation of the block id happens later, in `validate`.
 */
export function normalizeClaim(rec: Record<string, unknown>): DistillClaim {
  const text = typeof rec["text"] === "string" ? rec["text"] : "";
  const block = typeof rec["block"] === "string" ? rec["block"].replace(/^\^/, "") : undefined;
  return { text, ...(block !== undefined && block.length > 0 ? { block } : {}) };
}

/**
 * Ingress of the agent-authored claims payload, shared by the CLI and MCP
 * surfaces. The payload is checked against the frozen distill shape BEFORE
 * {@link normalizeClaim} runs, so a non-string `text` is refused by name
 * instead of being normalized into an empty claim and rejected later for the
 * wrong reason. A violation throws `ResponseShapeError` and nothing is
 * written - the whole batch, not just the offending item.
 */
export function parseDistillClaims(payload: unknown): DistillClaim[] {
  assertResponseShape(DISTILL_CLAIMS_SURFACE, DISTILL_CLAIMS_SHAPE, payload);
  return (payload as ReadonlyArray<Record<string, unknown>>).map(normalizeClaim);
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
  /**
   * sha256 over the source bytes, ABSENT when there were none to hash.
   *
   * It used to be the literal string `missing` in that case, which recorded an
   * answer where there was none: a caller comparing digests had to know that
   * one particular value is not a digest at all. Absence is now the whole of
   * the report, and the reason for it is {@link trust}.
   */
  readonly sourceHash?: string;
  /**
   * The lane this distillation committed in, as the page was ACTUALLY written.
   * A caller told only where its page landed is told nothing about whether an
   * ordinary read can ever reach it again - the trust gate excludes an
   * untrusted page from every scope.
   */
  readonly trust: IntakeTrust;
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
 * {@link DistillValidationError} with no write on failure), classifies the
 * source, then writes a distillation page listing each claim with its
 * block-level citation and a `## Sources` provenance section. Idempotent on
 * the source identity.
 *
 * The classification lives HERE rather than at either surface because there
 * are two ways in - the MCP tool and `o2b brain distill` - and a guard in one
 * of them is a guard in neither.
 */
export function distillSource(
  vault: string,
  input: DistillSourceInput,
  opts: DistillSourceOptions,
): DistillSourceResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  validate(input);

  // The SAME normaliser the trust classifier uses, so the identity this page
  // records and the identity that was classified cannot be two different
  // strings. A bare `canonicalNotePath` left a caller's `[[Articles/x.md]]`
  // wrapped, which cited `[[[[Articles/x.md]]]]` in the body and keyed a
  // second page off a second identity hash for one source - the same defect
  // `ingestSource` was moved off in v1.46.0.
  const canonicalSource = normalizeSourceIdentity(input.sourcePath);
  const sourceLink = `[[${canonicalSource}]]`;
  const provenance: Provenance = { level: "stated", sources: [sourceLink], premises: [] };

  // Before any write, so a source the filesystem refuses to answer for leaves
  // no half-written page behind. The classifier owns both halves of the
  // question this module used to answer with a bare `existsSync`: whether the
  // identity is SHAPED like a location this vault owns (so `../../etc/passwd`
  // is never stat-ed, let alone hashed), and whether bytes are actually there.
  // `provenance.level` stays `stated` - that vocabulary bands how a conclusion
  // was DERIVED, which is orthogonal to who was entitled to supply the
  // material; the lane is carried by the marker below.
  const origin = classifySourceOrigin(vault, input.sourcePath);
  const sourceHash = origin.contentHash;

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
      // `source_hash` is this page kind's own historical spelling of the
      // content digest, kept because distillation pages already on disk carry
      // it and this release rewrites none of them. It cannot be the ONLY
      // record: on a `Brain/sources` page the same key holds the source
      // IDENTITY hash instead (`ingest/ingest.ts`), and `sources-registry.ts`
      // reads it generically - so a consumer holding an unknown Brain page
      // cannot tell which of the two it has. `source_content_hash` has one
      // meaning everywhere it appears, and it is written by the same helper
      // the entity registry writes it with.
      ...(sourceHash !== undefined ? { source_hash: sourceHash } : {}),
      ...sourceContentHashFrontmatter(sourceHash),
      // Marks the page when the claims were distilled from material this vault
      // does not own, so the retrieval trust gate excludes it with a reason
      // rather than ranking it beside the operator's own notes. A trusted
      // source adds nothing, keeping its page byte-identical to before.
      ...untrustedSourceFrontmatter(origin.trust),
      provenance: provenance.level,
      agent: opts.agent,
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
    ...(sourceHash !== undefined ? { sourceHash } : {}),
    trust: origin.trust,
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
