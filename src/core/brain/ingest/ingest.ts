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

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

import type { FrontmatterMap } from "../../types.ts";
import { normToken, REMOTE_DENY_VISIBILITY_TOKEN } from "../../graph/visibility.ts";
import { canonicalNotePath, ensureInsideVault } from "../../path-safety.ts";
import { assertCheckpointId } from "../checkpoint-store.ts";
import {
  formatFrontmatter,
  parseFrontmatter,
  slugify,
  writeFrontmatterAtomic,
} from "../../vault.ts";
import { isoSecond } from "../time.ts";
import { sourcePagePath } from "../paths.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { intakeExtraction, type ExtractionIntake } from "../intake/extract-intake.ts";
import { normalizeSourceIdentity } from "../intake/source-trust.ts";
import { INTAKE_TRUST, untrustedSourceFrontmatter } from "../trust/untrusted-provenance.ts";
import {
  captureScopeForTrust,
  captureScopeFrontmatter,
  type CaptureScope,
} from "../provenance/capture-scope.ts";
import {
  renderProvenanceSection,
  sourceIdentityHash,
  type Provenance,
} from "../provenance/provenance.ts";
import { PLAN_ID_LABEL, recordCompleted } from "./checkpoint.ts";
import { readManifest, updateManifest } from "./content-manifest.ts";
import { deriveSourceSection, type PartsOutcome, type TableOutcome } from "./extract-source.ts";
import {
  isCodeStructureSource,
  preExtractCodeStructure,
  type PreExtractResult,
} from "./pre-extract.ts";

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
   *
   * Held to the checkpoint store's id grammar (lowercase hex - the id becomes
   * a filename) and REFUSED here, before any write, when it is not. The
   * checkpoint write below is best-effort, and a caller-supplied id that can
   * never work is not the transient fault that tolerance is for: swallowed,
   * it left every source ingested with no plan progress recorded at all and
   * `--reconcile` reporting the whole batch as never ingested.
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
  /**
   * May the caller read the vault file at this vault-relative path? Handed to
   * the intake: a source the predicate refuses is classified as one with no
   * local bytes (untrusted lane, no digest, `url-only`). A summary page it
   * refuses is left as it is and answered as absent. A local caller passes
   * nothing.
   */
  readonly readable?: (rel: string) => boolean;
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
   * How much of the source this page's knowledge was captured from: the
   * intake's lane for the cited source, as a capture scope. `full-local` for
   * a vault file, `url-only` for a source with no local bytes. Ingest never
   * stores an excerpt, so it never answers `bounded-local`: the summary is a
   * paraphrase, not a capture.
   */
  readonly captureScope: CaptureScope;
  /**
   * Code-structure pre-extraction seeds (P4), present only when the pass was
   * requested via {@link IngestSourceOptions.preExtract}. `extracted: false`
   * when the source is not a supported code file or has no readable bytes -
   * never a fake empty success. Absent entirely when the pass was off.
   */
  readonly preExtract?: PreExtractResult;
  /**
   * What the HTML extractor made of an HTML source: a part count, or the
   * named reason there is no `## Parts` section. Absent for every other
   * format.
   */
  readonly parts?: PartsOutcome;
  /**
   * What the table note made of a CSV or TSV source: its counts, or the
   * named reason there is no `## Table` section. Absent for every other
   * format.
   */
  readonly table?: TableOutcome;
}

/**
 * Frontmatter key an operator sets to scope a page's visibility. Kept on a
 * rewrite like `created_at`: dropping it on re-ingest would widen a page the
 * operator narrowed.
 */
const VISIBILITY_FRONTMATTER_KEY = "visibility";

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
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  // Before anything is written: an id the checkpoint store cannot use is a
  // resume that will never engage, and the caller has to hear it now rather
  // than discover it from a reconciliation report.
  if (opts.planId !== undefined && opts.planId.length > 0) {
    assertCheckpointId(PLAN_ID_LABEL, opts.planId);
  }
  // The SAME normaliser the trust classifier uses. This used to be a bare
  // `canonicalNotePath`, which left a caller-supplied `[[Articles/x.md]]`
  // wrapped: the summary page then wrote `[[[[Articles/x.md]]]]` and keyed on
  // a different identity hash than the bare spelling of the same source,
  // producing two summary pages for one source against this pipeline's
  // documented idempotency.
  const canonicalSource = normalizeSourceIdentity(input.sourcePath);
  const preExtract =
    opts.preExtract === true ? runPreExtract(vault, canonicalSource, opts.readable) : undefined;
  const sourceLink = `[[${canonicalSource}]]`;
  const provenance: Provenance = { level: "stated", sources: [sourceLink], premises: [] };

  // The intake classifies the cited source itself and reports the lane back.
  // It used to be classified here as well and handed down as an argument,
  // which meant the same source was read twice and the second answer could be
  // overridden by the caller - see `intake/extract-intake.ts`.
  const intake = intakeExtraction(vault, input.extraction, {
    agent: opts.agent,
    now: opts.now,
    provenance,
    ...(opts.readable !== undefined ? { readable: opts.readable } : {}),
  });
  const trust = intake.trust;
  const captureScope = captureScopeForTrust(trust);
  const connections = intake.entitiesUpdated;
  const allEntities = [...intake.entitiesCreated, ...intake.entitiesUpdated];
  // After the intake, which decided the lane: the derived section reads the
  // source only in the trusted lane and only at the caller's reach.
  const derivation = deriveSourceSection(vault, canonicalSource, trust, opts.readable);

  // The page filename keys on the source-identity hash, not just the slug:
  // two distinct non-ASCII / symbol-only source paths can slugify to the same
  // fallback, which would silently clobber one summary with another. A hash
  // suffix keeps distinct sources distinct while staying idempotent (the same
  // source path always yields the same hash, hence the same file).
  const sourceHash = sourceIdentityHash([canonicalSource]);
  const absPath = sourcePagePath(vault, `${slugify(canonicalSource)}-${sourceHash.slice(0, 12)}`);
  // A summary page the caller may not read (it inherited a reserved
  // source's visibility) is neither read nor rewritten, and the answer is
  // the one an absent page gets: its path is deterministic, so `created`
  // would otherwise tell the caller the page exists.
  const summaryPath = canonicalNotePath(relative(vault, absPath));
  const withheld = existsSync(absPath) && opts.readable?.(summaryPath) === false;
  const existed = !withheld && existsSync(absPath);
  const stamp = isoSecond(opts.now);
  // Preserve the original created_at and an operator-set visibility on a
  // re-ingest; bump updated_at.
  const kept: KeptFrontmatter = existed
    ? readKeptFrontmatter(absPath, stamp)
    : { createdAt: stamp };

  const meta: FrontmatterMap = {
    kind: BRAIN_SOURCE_KIND,
    source_path: canonicalSource,
    source_hash: sourceHash,
    provenance: provenance.level,
    // Marks the summary page itself when the material behind it came from
    // outside the vault, so the retrieval trust gate excludes it with a
    // reason rather than ranking it beside the operator's own notes. Trusted
    // sources add nothing, keeping their page byte-identical to before.
    ...untrustedSourceFrontmatter(trust),
    // Says how much of the source was captured when it is less than the
    // whole file; a full-local source adds nothing, for the same reason.
    ...captureScopeFrontmatter(captureScope),
    // An HTML, CSV or TSV source read in the trusted lane names its format,
    // the digest of the bytes the section was derived from, and its own
    // keys. Every other source adds nothing.
    ...derivation?.frontmatter,
    created_at: kept.createdAt,
    updated_at: stamp,
    tags: ["brain", "brain/source"],
    ...visibilityFrontmatter(kept.visibility, derivation?.visibility),
  };

  const body = [
    input.summary.trim(),
    renderProvenanceSection(provenance),
    renderLinkSection("Entities", allEntities),
    renderLinkSection("Connections to existing notes", connections),
    derivation?.section ?? "",
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");

  // Idempotent no-op: only rewrite the summary page when its bytes would
  // actually change. A byte-identical rewrite would churn the mtime and wake
  // the index watcher for nothing; skipping it keeps a re-ingest of an
  // unchanged source truly inert.
  const nextContents = formatFrontmatter(meta, body);
  const unchanged = existed && readFileSync(absPath, "utf8") === nextContents;
  if (!withheld && !unchanged) {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFrontmatterAtomic(absPath, meta, body, { overwrite: true });
  }

  // Record the source's CONTENT hash so a future re-ingest can classify it
  // `unchanged` and skip the extraction pass. Only when the source resolves to
  // a real file inside the vault - URL and other identity-only sources have no
  // bytes to hash and must leave the manifest untouched (backward-compatible).
  // The containment predicate is the same one the pre-extract read answers to:
  // an escaping identity must not reach `existsSync` either, or a path outside
  // the vault would be hashed into the content manifest and keyed into a
  // folder-plan checkpoint.
  // Only in the trusted lane, which the intake grants only to a file the
  // caller may read at its reach: a source answered as absent records no
  // digest anywhere, the manifest included.
  // Nor when the page was withheld: the manifest would then record a
  // summary as current that this call did not write.
  if (
    !withheld &&
    trust === INTAKE_TRUST.trusted &&
    resolvesInsideVault(vault, canonicalSource) &&
    existsSync(join(vault, canonicalSource))
  ) {
    updateManifest(vault, [canonicalSource]);
    // Record plan-scoped progress so an interrupted batch resumes at the item
    // boundary (t_ba1fa5f6). Only for real vault files - a URL/identity-only
    // source has no place in a folder plan's checkpoint. Best-effort: a
    // checkpoint write failure must never fail the ingest that already landed.
    if (opts.planId !== undefined && opts.planId.length > 0) {
      try {
        recordCompleted(vault, opts.planId, dirname(canonicalSource), [canonicalSource], opts.now);
      } catch {
        // Checkpointing is a resumability optimization, not correctness -
        // and what is tolerated here is now only the TRANSIENT half: a lock
        // this run could not take, a write that failed. The permanent,
        // caller-caused half (an id the store cannot use) was refused at the
        // top of this function, before the ingest wrote anything.
      }
    }
  }

  return {
    summaryPath,
    created: !existed,
    entitiesCreated: intake.entitiesCreated,
    entitiesUpdated: intake.entitiesUpdated,
    connections,
    captureScope,
    ...(preExtract !== undefined ? { preExtract } : {}),
    ...(derivation?.parts !== undefined ? { parts: derivation.parts } : {}),
    ...(derivation?.table !== undefined ? { table: derivation.table } : {}),
  };
}

/**
 * The largest source the code-structure pass reads. A hand-written module
 * is far smaller; a larger file is generated or vendored, and its seeds are
 * not worth a parse whose cost grows with the file.
 */
export const PRE_EXTRACT_MAX_SOURCE_BYTES = 1_048_576;

/** Why a source read yields no text, apart from a thrown error. */
const SOURCE_UNREAD = Object.freeze({
  notAFile: "not a regular file",
  tooLarge: "larger than the read limit",
} as const);

/** Why {@link readSourceBounded} read no text. */
export type SourceUnread = (typeof SOURCE_UNREAD)[keyof typeof SOURCE_UNREAD];

/**
 * How a source is opened: read-only and never blocking, so a FIFO met
 * where a file was expected cannot stall the server. No `O_NOFOLLOW`: an
 * in-vault symlink is admitted by the containment check in
 * `runPreExtract` (`resolvesInsideVault`). The flag
 * is POSIX; where the platform lacks it it is simply absent.
 */
const SOURCE_OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0);

/**
 * Read a source through ONE descriptor, so the checks hold for the bytes
 * read: the descriptor must be a regular file, and no more than `maxBytes`
 * is read however large the file has grown since the `fstat`. The buffer is
 * sized to the file plus one byte, so a small source costs a small buffer;
 * a file that grew under the cap is read on into one buffer of the cap plus
 * one byte. `bytes` are exactly the bytes read, for a caller that must judge
 * their encoding itself.
 */
export function readSourceBounded(
  absolute: string,
  maxBytes: number,
):
  | { readonly text: string; readonly bytes: Uint8Array; readonly unread?: undefined }
  | { readonly text: null; readonly bytes?: undefined; readonly unread: SourceUnread } {
  const fd = openSync(absolute, SOURCE_OPEN_FLAGS);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { text: null, unread: SOURCE_UNREAD.notAFile };
    if (stat.size > maxBytes) return { text: null, unread: SOURCE_UNREAD.tooLarge };
    // One byte past the size, so growth since the fstat is seen.
    let buffer = Buffer.allocUnsafe(stat.size + 1);
    let filled = 0;
    for (;;) {
      // A full buffer is under the cap here: past it, the loop has returned.
      if (filled === buffer.length) buffer = Buffer.concat([buffer], maxBytes + 1);
      const count = readSync(fd, buffer, filled, buffer.length - filled, null);
      if (count === 0) break;
      filled += count;
      if (filled > maxBytes) return { text: null, unread: SOURCE_UNREAD.tooLarge };
    }
    const bytes = buffer.subarray(0, filled);
    return { text: bytes.toString("utf8"), bytes };
  } finally {
    closeSync(fd);
  }
}

/**
 * Run the code-structure pre-extraction pass over a vault-file source. A source
 * with no readable file bytes (a URL or identity-only source) cannot be parsed,
 * so it is reported as unextracted rather than a fake empty success. A source
 * `readable` refuses is answered the same way, before its bytes are read, so
 * the pass reads no file the intake would treat as having no local bytes.
 */
function runPreExtract(
  vault: string,
  canonicalSource: string,
  readable: ((rel: string) => boolean) | undefined,
): PreExtractResult {
  // The identity is caller-supplied and `..` segments survive normalization,
  // so the read is contained the same way the trust classifier contains its
  // own resolution (`source-trust.ts`): an identity that resolves outside the
  // vault is not this vault's file to read, and is reported as unextracted
  // rather than turned into a host-filesystem read.
  if (!resolvesInsideVault(vault, canonicalSource)) {
    return {
      extracted: false,
      reason: `source does not resolve inside this vault; code-structure pre-extraction skipped: ${canonicalSource}`,
    };
  }
  // A source the pass cannot parse needs neither its bytes nor the manifest:
  // the pass itself reports the unsupported extension, by name.
  if (!isCodeStructureSource(canonicalSource)) {
    return preExtractCodeStructure(canonicalSource, "");
  }
  const noBytes: PreExtractResult = {
    extracted: false,
    reason: `source has no readable file bytes for code-structure pre-extraction: ${canonicalSource}`,
  };
  if (readable !== undefined && !readable(canonicalSource)) return noBytes;
  const tooLarge: PreExtractResult = {
    extracted: false,
    reason: `source is larger than ${PRE_EXTRACT_MAX_SOURCE_BYTES} bytes; code-structure pre-extraction skipped: ${canonicalSource}`,
  };
  let content: string;
  try {
    const read = readSourceBounded(join(vault, canonicalSource), PRE_EXTRACT_MAX_SOURCE_BYTES);
    if (read.text === null) return read.unread === SOURCE_UNREAD.tooLarge ? tooLarge : noBytes;
    content = read.text;
  } catch {
    // A source with no readable file bytes - a URL/identity-only source, a
    // directory, a permission failure, or a deletion race - cannot be parsed,
    // so it is reported as unextracted rather than aborting the whole ingest.
    return noBytes;
  }
  // The manifest's canonical path set is what a relative import specifier
  // may bind to: a specifier probes it and fills the seed's `resolvedTo`
  // only on an exactly-one match. The source's OWN entry is not in the set
  // yet - the manifest is updated after this pass - which is the correct
  // incremental reality: a module cannot have been ingested before it was.
  // Read once, outside the source-read guard: a corrupted or unsupported
  // manifest is its own named error, never "no readable file bytes".
  return preExtractCodeStructure(canonicalSource, content, {
    ingestedFiles: new Set(Object.keys(readManifest(vault).entries)),
  });
}

/**
 * Does this canonical identity resolve to a location this vault owns? The
 * same containment the note-write ladder enforces, applied to the one
 * read path in the ingest pipeline that takes a caller-named identity.
 */
function resolvesInsideVault(vault: string, canonicalSource: string): boolean {
  try {
    ensureInsideVault(join(vault, canonicalSource), vault);
    return true;
  } catch {
    return false;
  }
}

/** The frontmatter a rewrite keeps from the page it replaces. */
interface KeptFrontmatter {
  readonly createdAt: string;
  readonly visibility?: FrontmatterMap[string];
}

/**
 * Read the stable `created_at` and an operator-set `visibility` from an
 * existing summary page; `created_at` falls back to `fallback`.
 */
function readKeptFrontmatter(absPath: string, fallback: string): KeptFrontmatter {
  const [meta] = parseFrontmatter(absPath);
  const value = meta["created_at"];
  const createdAt = typeof value === "string" && value.length > 0 ? value : fallback;
  const visibility = meta[VISIBILITY_FRONTMATTER_KEY];
  return visibility === undefined || visibility === null
    ? { createdAt }
    : { createdAt, visibility };
}

/**
 * The summary page's `visibility`. The page's audience is never wider than
 * the source's or the operator's: when only one side declares tokens, that
 * side's tokens are written (a page with neither gains none); when both do,
 * the page keeps the tokens both allow, and when they share none it gets
 * the reserved token, so it is withheld below local reach rather than
 * widened. The reserved token is kept whenever either side carries it.
 */
function visibilityFrontmatter(
  kept: KeptFrontmatter["visibility"],
  source: readonly string[] | undefined,
): FrontmatterMap {
  if (source === undefined || source.length === 0) {
    return kept !== undefined ? { [VISIBILITY_FRONTMATTER_KEY]: kept } : {};
  }
  let keptTokens: string[] = [];
  if (Array.isArray(kept)) keptTokens = kept.map((k) => normToken(String(k)));
  else if (kept !== undefined) keptTokens = [normToken(String(kept))];
  keptTokens = keptTokens.filter((k) => k.length > 0);
  if (keptTokens.length === 0) return { [VISIBILITY_FRONTMATTER_KEY]: [...source] };
  const merged = source.filter((token) => keptTokens.includes(token));
  const reserved =
    merged.length === 0 ||
    keptTokens.includes(REMOTE_DENY_VISIBILITY_TOKEN) ||
    source.includes(REMOTE_DENY_VISIBILITY_TOKEN);
  if (reserved && !merged.includes(REMOTE_DENY_VISIBILITY_TOKEN)) {
    merged.push(REMOTE_DENY_VISIBILITY_TOKEN);
  }
  return { [VISIBILITY_FRONTMATTER_KEY]: merged };
}
