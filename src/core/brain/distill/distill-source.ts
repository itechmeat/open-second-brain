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
 * structurally (non-empty text, well-formed block ids), checks every quoted
 * span in a claim against the source ({@link checkClaimQuotes}), stamps a
 * content sha256 the verifier can reproduce from the source file, and writes
 * one distillation page per source identity, rewritten in place on
 * re-distill (never duplicated). A byte-identical re-run is inert.
 *
 * QUOTES. A span in quotation marks is a claim that the source says exactly
 * that. It is compared with the block the claim cites (or, without a block,
 * the whole source) in the SAME bytes the content digest is computed over -
 * one read feeds both. A span that does not verify loses its two marks on
 * the page (its words stay) and is named in the result's `quotes` report, so
 * the page never shows an unverified quote. `strictQuotes` refuses the whole
 * write instead, with {@link QuoteCheckError}, before anything is written.
 *
 * CAPTURE SCOPE. Every result says how much of the source the vault holds
 * (`captureScope`): a local file is `full-local` and adds nothing to the page;
 * a source with no local bytes is `url-only` and the page says so. For such a
 * source the caller may pass the verbatim `excerpt` it read: the page stores
 * it in a fenced `## Excerpt` section with its digest, becomes
 * `bounded-local`, and its quotes are checked against the excerpt. An excerpt
 * beside a local source, an empty one or one past the byte ceiling is refused
 * with {@link CaptureExcerptError} before anything is written.
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
 * ({@link readSourceOrigin}, the byte-keeping form of `classifySourceOrigin`),
 * so a source this vault does not own commits in the quarantine lane the
 * retrieval trust gate can actually see.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, relative } from "node:path";

import type { FrontmatterMap } from "../../types.ts";
import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { canonicalNotePath } from "../../path-safety.ts";
import { formatFrontmatter, parseFrontmatter, slugify } from "../../vault.ts";
import {
  UNTRUSTED_ORIGIN,
  isSourceHidden,
  normalizeSourceIdentity,
  readSourceOrigin,
} from "../intake/source-trust.ts";
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
import {
  CAPTURE_SCOPE,
  EXCERPT_HASH_KEY,
  assertExcerptAdmissible,
  captureScopeForTrust,
  captureScopeFrontmatter,
  excerptDigest,
  renderExcerptSection,
  type CaptureScope,
} from "../provenance/capture-scope.ts";
import { BLOCK_ID_RE } from "./block-resolve.ts";
import type { DistillClaim } from "./claim.ts";
import { checkClaimQuotes, type QuoteEvidence } from "./quote-check.ts";
import {
  QUOTES_UNQUOTED_KEY,
  QUOTES_VERIFIED_KEY,
  QUOTE_CHECK_OUTCOME,
  QuoteCheckError,
  type QuoteCheckReport,
} from "./quote-verdict.ts";

/** Frontmatter `kind:` marker of a distillation page. */
export const BRAIN_DISTILLATION_KIND = "brain-distillation";

export type { DistillClaim } from "./claim.ts";

/**
 * The most claims one call may carry. Every claim is checked against the
 * source, so the cap bounds the work one request can ask for.
 */
export const DISTILL_CLAIMS_MAX = 1000;

/** Line breaks a claim may not hold: a claim is one bullet line on the page. */
const CLAIM_LINE_BREAK_RE = /[\r\n]/;

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
  /**
   * The verbatim text the caller read from a source the vault holds no bytes
   * of (`url-only`). Stored on the page and used as the quote evidence;
   * refused for any other source.
   */
  readonly excerpt?: string;
}

export interface DistillSourceOptions {
  readonly agent: string;
  readonly now: Date;
  /**
   * Refuse the whole write with {@link QuoteCheckError} when any quoted span
   * would be unquoted, instead of unquoting it. Unpaired marks never refuse.
   */
  readonly strictQuotes?: boolean;
  /**
   * May the caller read the vault file at this vault-relative path? Asked of
   * the canonical source identity when the vault holds its bytes. A refusal
   * makes the source answer exactly as an absent one: untrusted lane,
   * `url-only` (an excerpt is admitted), every span `url-only`, and no digest
   * in the result or on the page.
   * Absent: the caller reads everything (the local CLI).
   */
  readonly readable?: (rel: string) => boolean;
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
  /** How much of the source the page's evidence holds, as written. */
  readonly captureScope: CaptureScope;
  /**
   * The quote check's account, present only when at least one claim contains
   * a quoted span. Every finding is a span that was unquoted on the page.
   */
  readonly quotes?: QuoteCheckReport;
}

/** Strict UTF-8: a source that is not text verifies no quote. */
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });

/** The evidence a quote is checked against: the bytes the digest covers. */
function quoteEvidence(bytes: Uint8Array | undefined): QuoteEvidence {
  if (bytes === undefined) return { kind: QUOTE_CHECK_OUTCOME.urlOnly };
  try {
    return { kind: "text", text: UTF8_STRICT.decode(bytes) };
  } catch (cause) {
    // A decode failure IS the verdict: these bytes are not text, so no span
    // can be said to occur in them. It is reported per span, by name. The
    // fatal decoder signals that with a TypeError; anything else is a fault.
    if (!(cause instanceof TypeError)) throw cause;
    return { kind: "not-text" };
  }
}

/**
 * The capture scope of this write and the evidence its quotes are checked
 * against. An excerpt is admitted only for a `url-only` source, and then IS
 * the evidence; otherwise the evidence is the bytes the digest covers.
 */
function captureOf(
  trust: IntakeTrust,
  bytes: Uint8Array | undefined,
  excerpt: string | undefined,
): { readonly scope: CaptureScope; readonly evidence: QuoteEvidence } {
  const scope = captureScopeForTrust(trust);
  if (excerpt === undefined) return { scope, evidence: quoteEvidence(bytes) };
  assertExcerptAdmissible(scope, excerpt);
  return { scope: CAPTURE_SCOPE.boundedLocal, evidence: { kind: "text", text: excerpt } };
}

/** The page's quote counters; nothing when no claim held a span. */
function quotesFrontmatter(report: QuoteCheckReport | null): FrontmatterMap {
  return report === null
    ? {}
    : {
        [QUOTES_VERIFIED_KEY]: report.verified_in_block + report.verified_in_source,
        [QUOTES_UNQUOTED_KEY]: report.unquoted,
      };
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
  if (input.claims.length > DISTILL_CLAIMS_MAX) {
    throw new DistillValidationError(
      `distillation accepts at most ${DISTILL_CLAIMS_MAX} claims per call, got ${input.claims.length}`,
    );
  }
  input.claims.forEach((claim, i) => {
    if (claim.text.trim().length === 0) {
      throw new DistillValidationError(`claim ${i} has empty text`);
    }
    if (CLAIM_LINE_BREAK_RE.test(claim.text)) {
      throw new DistillValidationError(`claim ${i} spans more than one line; a claim is one line`);
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
  //
  // A source the caller may not read answers exactly as an absent one: the
  // untrusted lane, no bytes, no digest. No span is checked against it, an
  // excerpt is admitted for it, and nothing in the result or on the page
  // tells the caller that the page exists or what it says. Asked first, so
  // the source is never stat-ed or read for such a caller.
  const origin = isSourceHidden(vault, input.sourcePath, opts.readable)
    ? UNTRUSTED_ORIGIN
    : readSourceOrigin(vault, input.sourcePath);
  const sourceHash = origin.contentHash;

  // The quote check runs on the bytes the digest above was computed over (or
  // on the admitted excerpt), before any write, so a refusal of either kind
  // leaves nothing behind.
  const { excerpt } = input;
  const capture = captureOf(origin.trust, origin.bytes, excerpt);
  const checked = checkClaimQuotes({ claims: input.claims, evidence: capture.evidence });
  const quotes = checked.report;
  if (opts.strictQuotes === true && quotes !== null && quotes.unquoted > 0) {
    throw new QuoteCheckError(quotes.findings);
  }

  const idHash = sourceIdentityHash([canonicalSource]);
  const absPath = distillationPagePath(vault, `${slugify(canonicalSource)}-${idHash.slice(0, 12)}`);
  const existed = existsSync(absPath);
  const stamp = isoSecond(opts.now);
  const createdAt = existed ? readCreatedAt(absPath, stamp) : stamp;
  const priorUpdatedAt = existed ? readUpdatedAt(absPath, stamp) : stamp;

  const claimsSection = [
    "## Claims",
    "",
    ...checked.claims.map((c) => renderClaim(c, canonicalSource)),
  ].join("\n");
  // The rendered section ends in a newline; the join supplies the separation.
  const excerptSection = excerpt !== undefined ? renderExcerptSection(excerpt).trimEnd() : "";
  const body = [claimsSection, excerptSection, renderProvenanceSection(provenance)]
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
      // How much of the source the page holds; nothing for a local file, so
      // its page stays byte-identical to before.
      ...captureScopeFrontmatter(capture.scope),
      ...(excerpt !== undefined ? { [EXCERPT_HASH_KEY]: excerptDigest(excerpt) } : {}),
      provenance: provenance.level,
      agent: opts.agent,
      claim_count: input.claims.length,
      ...quotesFrontmatter(quotes),
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
    captureScope: capture.scope,
    ...(quotes !== null ? { quotes } : {}),
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
