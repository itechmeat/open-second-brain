/**
 * One-off pledges as first-class Brain pages (dated-commitments wave).
 *
 * A pledge is a promise made in prose: a title, a promise text, a due
 * date, the source page the promise was read from, and evidence quotes
 * verified against that source at write time - so a stored quote is one
 * the source contained when the pledge was written. Each pledge is a
 * Markdown page at `Brain/pledges/<slug>.md`: operator-readable,
 * greppable, versionable. The kernel never calls a model - the due
 * arithmetic is pure UTC calendar math, exactly like the recurring
 * obligations this family mirrors.
 *
 *   - `add`     creates the page; every evidence quote must occur in the
 *               cited source page (quote-span containment through the
 *               shared comparators), or the write refuses with a named
 *               error. A title slug another pledge already holds is taken
 *               with an identity suffix, so two promises whose titles differ
 *               only in non-ASCII letters land on distinct pages.
 *   - `fulfill` stamps the fulfillment date; a fulfilled pledge stays
 *               stamped (one-off, not recurring).
 *   - `list`    reads pages up to an optional cap, due-sorted, with an
 *               overdue flag and whole days until due (null if undated);
 *               open pledges only unless the caller asks for fulfilled too.
 *               A keep cap bounds the pages the call returns and a scan
 *               cap the pages it parses, so the work stays bounded.
 *   - `show`    reads one page; a page the caller's reach withholds
 *               answers null, identical to an absent slug.
 *   - `remove`  retires the page into `Brain/pledges/archive/` with a
 *               collision suffix, the obligations pattern.
 *
 * Counterparties ride the `promised_to:` frontmatter key, whose name is a
 * relation in the shared vocabulary (`PROMISED_TO_RELATION`), so the
 * existing frontmatter-relations ingest projects the typed edges; this
 * module adds no projection code of its own.
 *
 * Creates lock the pledge path across the existence check and atomic
 * commit, using the shared bounded lock-wait policy. Concurrent creators
 * therefore cannot replace the first page written for the same slug.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, posix } from "node:path";

import type { FrontmatterMap } from "../types.ts";
import { atomicWriteFileSync, renameWithRetry } from "../fs-atomic.ts";
import { formatFrontmatter, parseFrontmatter, parseFrontmatterText, slugify } from "../vault.ts";
import {
  pledgePath,
  pledgesArchiveDir,
  pledgesDir,
  validateIsoDate,
  BRAIN_PLEDGES_REL,
} from "./paths.ts";
import { pageVisibility, strictestVisibilityOf } from "../graph/visibility.ts";
import { PROMISED_TO_RELATION } from "../graph/relation-vocab.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";
import { acquireLockSyncWithRetry } from "./sync-lockfile.ts";
import { isoDate, isoSecond } from "./time.ts";
import { normalizeForQuoteComparison, quoteHaystack, spanOccursIn } from "./distill/quote-spans.ts";

export class PledgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PledgeError";
  }
}

/** The refusal for a slug that names no active pledge page. */
export function noPledgeError(slug: string): PledgeError {
  return new PledgeError(`no pledge: ${slug}`);
}

export interface PledgePage {
  readonly slug: string;
  readonly title: string;
  /** The promise text (the page body, ahead of the notes section). */
  readonly text: string;
  /** Due date (`YYYY-MM-DD`); empty when a hand edit broke it. */
  readonly due: string;
  readonly createdAt: string;
  /** Vault-relative path of the cited source page. */
  readonly source: string;
  /** Quotes verified against the source page at write time. */
  readonly evidence: ReadonlyArray<string>;
  /** Anchored counterparty entity ids (`promised_to` relation targets). */
  readonly counterparties: ReadonlyArray<string>;
  /** Fulfillment date, or null while the pledge is open. */
  readonly fulfilled: string | null;
  readonly agent: string;
  readonly notes: string;
  readonly path: string;
}

export interface AddPledgeInput {
  readonly title: string;
  readonly due: string;
  readonly source: string;
  readonly evidence: ReadonlyArray<string>;
  readonly text?: string;
  /**
   * Anchored counterparty entity ids (`promised_to` relation targets).
   * Trust boundary: ids are anchored by the intake or validated at the MCP
   * seam against the canonical registry and the caller's reach; this
   * function only trims them, so it never invents an edge from a dangling id.
   */
  readonly counterparties?: ReadonlyArray<string>;
  readonly notes?: string;
  readonly agent: string;
  readonly now?: Date;
  /** Refuse a source page the caller cannot read, before probing its bytes. */
  readonly readable?: (rel: string) => boolean;
}

export interface FulfillPledgeInput {
  readonly slug: string;
  /** Fulfillment date (`YYYY-MM-DD`); defaults to today (UTC). */
  readonly date?: string;
  readonly now?: Date;
}

export interface ShowPledgeInput {
  readonly slug: string;
  /**
   * May the caller read the vault page at this vault-relative path?
   * A page the predicate refuses answers null, identical to an absent
   * slug, so neither its text nor its existence crosses.
   */
  readonly readable?: (rel: string) => boolean;
}

export interface PledgeListItem {
  readonly slug: string;
  readonly title: string;
  readonly due: string;
  /** True when the pledge is unfulfilled and due is strictly before today (UTC). */
  readonly overdue: boolean;
  /** Whole days until due; negative when overdue, null when undated. */
  readonly daysUntilDue: number | null;
  readonly counterparties: ReadonlyArray<string>;
  readonly fulfilled: string | null;
  readonly source: string;
  readonly path: string;
}

export interface RemovePledgeResult {
  readonly slug: string;
  readonly archivePath: string;
}

/** Body section header holding the pledge notes, after the promise text. */
export const NOTES_HEADER = "## Notes";

/** Milliseconds in one UTC day; the due-delta unit of the list math. */
const ONE_DAY_MS = 24 * 3600 * 1000;

/** A `[[wikilink]]`-wrapped target, to unwrap into the vault path itself. */
const WIKILINK_SOURCE_RE = /^\[\[([\s\S]+)\]\]$/u;

/**
 * True when the absolute path names an existing regular file. A directory
 * satisfies a bare existence probe but no page read: callers check this so
 * a source that names a folder refuses with the family's named error
 * instead of surfacing a raw fs error past the typed error boundary.
 */
export function isSourcePage(abs: string): boolean {
  const stat = statSync(abs, { throwIfNoEntry: false });
  return stat !== undefined && stat.isFile();
}

/**
 * Normalize a caller-supplied source reference to the vault-relative POSIX
 * path it names: a `[[wikilink]]` wrapper is unwrapped, backslash
 * separators fold, the result is POSIX-normalized and trimmed. Comparison
 * only - the page's bytes are never rewritten through this.
 */
export function normalizePledgeSource(source: string): string {
  const unwrapped = source.trim().replace(WIKILINK_SOURCE_RE, (_m, inner: string) => inner.trim());
  return posix.normalize(unwrapped.replaceAll("\\", "/").trim());
}

/** The vault-relative page of a pledge slug, as the reach predicate sees it. */
export function pledgeRel(slug: string): string {
  return posix.join(BRAIN_PLEDGES_REL, `${slug}.md`);
}

/** Length of the pledge identity digest: a 12-hex sha256 prefix, the 48-bit idiom. */
const IDENTITY_HEX_LENGTH = 12;

/**
 * Length of the suffix appended to a title slug another identity already
 * holds: a 6-hex (24-bit) prefix of this pledge's own identity. Six hex is
 * the conventional short-id width and keeps the collision space far above
 * the handful of promises one title slug can plausibly share.
 */
const SLUG_SUFFIX_HEX_LENGTH = 6;

/** Collapse whitespace runs and trim: the identity's title normalization. */
function collapseWhitespace(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

/**
 * The identity of one pledge: a sha256 prefix over the normalized
 * `(title, due, source)` triple. Two posts with the same identity are the
 * same promise however the title's whitespace was formatted; a different
 * due date or source is a different promise even under one title slug.
 */
export function pledgeIdentity(title: string, due: string, source: string): string {
  return createHash("sha256")
    .update(`${collapseWhitespace(title)}\n${due}\n${source}`)
    .digest("hex")
    .slice(0, IDENTITY_HEX_LENGTH);
}

/**
 * The page slugs one pledge may occupy, in preference order: the title
 * slug, then the same slug with a short identity suffix. `slugify` folds
 * every non-ASCII letter into a separator, so titles that differ only in
 * diacritics share the base slug; the suffix is what keeps them apart
 * without transliterating or rewriting the title.
 */
export function pledgeSlugCandidates(
  title: string,
  due: string,
  source: string,
): ReadonlyArray<string> {
  const base = slugify(title);
  return Object.freeze([
    base,
    `${base}-${pledgeIdentity(title, due, source).slice(0, SLUG_SUFFIX_HEX_LENGTH)}`,
  ]);
}

function requireIsoDate(value: string, label: string): string {
  try {
    validateIsoDate(value);
  } catch {
    throw new PledgeError(`${label} is not a valid calendar date: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Soft-parse an ISO date read from disk: return it when it is a valid
 * calendar date, otherwise return the empty string. Unlike
 * {@link requireIsoDate} this never throws, because a frontmatter value
 * edited by hand should not crash listing or showing the whole family.
 */
function parseIsoDate(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    validateIsoDate(value);
    return value;
  } catch {
    return "";
  }
}

function requireStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Every quote must occur in the cited source page: containment through the
 * shared quote-span comparators, presentation-forgiving and wording-strict.
 * A quote that fails is a named refusal - there is no unverified-evidence
 * lane and no leniency knob; the agent re-quotes verbatim.
 */
function assertEvidenceInSource(
  rel: string,
  sourceText: string,
  evidence: ReadonlyArray<string>,
): void {
  const haystack = quoteHaystack(normalizeForQuoteComparison(sourceText));
  for (const quote of evidence) {
    if (!spanOccursIn(quote, haystack)) {
      throw new PledgeError(
        `evidence quote does not occur in the source page ${rel}: ${JSON.stringify(quote)}`,
      );
    }
  }
}

function render(page: Omit<PledgePage, "path">, visibility: ReadonlyArray<string> = []): string {
  const body =
    page.notes.length > 0 ? `${page.text}\n\n${NOTES_HEADER}\n\n${page.notes}` : page.text;
  return formatFrontmatter(
    {
      title: page.title,
      created_at: page.createdAt,
      due: page.due,
      source: page.source,
      evidence: [...page.evidence],
      [PROMISED_TO_RELATION]: [...page.counterparties],
      fulfilled: page.fulfilled ?? "",
      agent: page.agent,
      ...(visibility.length > 0 ? { visibility: [...visibility] } : {}),
    },
    body,
  );
}

/**
 * Render a stored pledge with only the requested frontmatter mutation.
 * Re-parse the full map so visibility and operator-added keys survive;
 * the caller commits the returned bytes through its atomic write path.
 */
export function rewritePledgeFrontmatter(
  page: Pick<PledgePage, "path">,
  mutate: (meta: FrontmatterMap) => void,
): string {
  const [meta, body] = parseFrontmatter(page.path);
  mutate(meta);
  return formatFrontmatter(meta, body);
}

function parsePage(vault: string, slug: string): PledgePage | null {
  const path = pledgePath(vault, slug);
  // A regular-file probe, not a bare existence probe: a directory named
  // `*.md` satisfies `existsSync` and then stalls or throws inside the
  // directory read. A path that is not a page answers null exactly like an
  // absent one, so every surface refuses it before touching its bytes.
  if (!isSourcePage(path)) return null;
  const [meta, body] = parseFrontmatter(path);
  const headerMatch = new RegExp(`^${NOTES_HEADER}$`, "mu").exec(body);
  const headerIndex = headerMatch?.index ?? -1;
  const text = (headerIndex < 0 ? body : body.slice(0, headerIndex)).trim();
  const notes = headerIndex < 0 ? "" : body.slice(headerIndex + NOTES_HEADER.length).trim();
  return Object.freeze({
    slug,
    title: typeof meta["title"] === "string" ? meta["title"] : slug,
    text,
    due: parseIsoDate(meta["due"]),
    createdAt: typeof meta["created_at"] === "string" ? meta["created_at"] : "",
    source: typeof meta["source"] === "string" ? meta["source"] : "",
    evidence: Object.freeze(requireStringList(meta["evidence"])),
    counterparties: Object.freeze(requireStringList(meta[PROMISED_TO_RELATION])),
    fulfilled: parseIsoDate(meta["fulfilled"]) || null,
    agent: typeof meta["agent"] === "string" ? meta["agent"] : "",
    notes,
    path,
  });
}

/** The write-side input of one pledge page; the caller owns validation. */
export interface CreatePledgePageInput {
  readonly title: string;
  readonly due: string;
  /** Vault-relative POSIX path of the cited source page (already normalized). */
  readonly source: string;
  /**
   * The cited source page's bytes, read once by the caller's validation
   * pass. Evidence containment is re-checked against them here, so the
   * write path never stores an unverified quote and never re-reads disk.
   */
  readonly sourceText: string;
  readonly evidence: ReadonlyArray<string>;
  /** Visibility inherited from the source page, derived from `sourceText`. */
  readonly visibility: ReadonlyArray<string>;
  readonly text?: string;
  readonly notes?: string;
  readonly counterparties?: ReadonlyArray<string>;
  readonly agent: string;
  readonly now?: Date;
}

/**
 * Commit one pledge page: slug resolution, lock, taken-slug refusal,
 * render, atomic write. No reads of its own - the caller supplies the
 * source bytes it validated - so the extraction intake can create a whole
 * batch from the one source read its validation pass already paid for.
 * Refusals are the family's named errors, byte-identical to
 * {@link addPledge}'s.
 *
 * A title slug held by a DIFFERENT identity is not a refusal: the page
 * takes the identity-suffixed candidate instead, under that candidate's
 * own lock. A true duplicate - the same `(title, due, source)` identity
 * already stored at the base slug - keeps the taken-slug refusal.
 */
export function createPledgePage(vault: string, input: CreatePledgePageInput): PledgePage {
  const evidence = input.evidence.map((quote) => quote.trim()).filter((quote) => quote.length > 0);
  assertEvidenceInSource(input.source, input.sourceText, evidence);
  const now = input.now ?? new Date();
  const identity = pledgeIdentity(input.title, input.due, input.source);
  const page = {
    title: input.title,
    text: (input.text ?? "").trim(),
    due: input.due,
    createdAt: isoSecond(now),
    source: input.source,
    evidence: Object.freeze(evidence),
    counterparties: Object.freeze(
      (input.counterparties ?? []).map((id) => id.trim()).filter((id) => id.length > 0),
    ),
    fulfilled: null,
    agent: input.agent,
    notes: (input.notes ?? "").trim(),
  };
  const candidates = pledgeSlugCandidates(input.title, input.due, input.source);
  // A page holding this exact identity is the same promise wherever it
  // files - including the suffixed candidate a since-removed slug-holder
  // once forced - so the true-duplicate refusal is decided across ALL
  // candidates before the create loop, not only when the loop happens to
  // reach that candidate before the first free one.
  for (const slug of candidates) {
    const stored = parsePage(vault, slug);
    if (stored !== null && pledgeIdentity(stored.title, stored.due, stored.source) === identity) {
      throw new PledgeError(`pledge already exists: ${slug} (remove it first to recreate)`);
    }
  }
  for (const slug of candidates) {
    const path = pledgePath(vault, slug);
    const handle = acquireLockSyncWithRetry(path);
    try {
      if (existsSync(path)) {
        const stored = parsePage(vault, slug);
        // A different identity frees the NEXT candidate; anything this
        // lookup cannot read as a pledge - a non-regular path included -
        // is occupied by something a create must not replace.
        if (
          stored === null ||
          pledgeIdentity(stored.title, stored.due, stored.source) === identity
        ) {
          throw new PledgeError(`pledge already exists: ${slug} (remove it first to recreate)`);
        }
        continue;
      }
      const resolved = { ...page, slug };
      atomicWriteFileSync(path, render(resolved, input.visibility));
      return Object.freeze({ ...resolved, path });
    } finally {
      handle.release();
    }
  }
  // Every candidate is held by another pledge: the title slug and its
  // identity suffix both name different promises.
  throw new PledgeError(
    `pledge already exists: ${candidates[candidates.length - 1]} (remove it first to recreate)`,
  );
}

/** Create a one-off pledge page. */
export function addPledge(vault: string, input: AddPledgeInput): PledgePage {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const title = input.title.trim();
  if (title.length === 0) throw new PledgeError("pledge title must not be empty");
  const due = requireIsoDate(input.due, "due");
  for (const field of ["text", "notes"] as const) {
    if ((input[field] ?? "").split(/\r?\n/u).some((line) => line.trim() === NOTES_HEADER)) {
      throw new PledgeError(`pledge ${field} must not contain the ${NOTES_HEADER} section header`);
    }
  }
  const evidence = input.evidence.map((quote) => quote.trim()).filter((quote) => quote.length > 0);
  if (evidence.length === 0) {
    throw new PledgeError(
      "pledge evidence must cite at least one quote from the source page (an uncited pledge is refused)",
    );
  }
  const source = normalizePledgeSource(input.source);
  if (source.length === 0 || source.startsWith("..")) {
    throw new PledgeError(`pledge source must name a vault page: ${JSON.stringify(input.source)}`);
  }
  if (input.readable !== undefined && !input.readable(source)) {
    throw new PledgeError(`pledge source page is not readable or absent: ${source}`);
  }
  const sourceAbs = join(vault, source);
  if (!isSourcePage(sourceAbs)) {
    throw new PledgeError(
      `pledge source page not found: ${source} - a pledge cites bytes the vault holds`,
    );
  }
  const sourceText = readFileSync(sourceAbs, "utf8");
  const [sourceMeta] = parseFrontmatterText(sourceText);
  const visibility = strictestVisibilityOf([pageVisibility(sourceMeta)]);
  return createPledgePage(vault, {
    title,
    due,
    source,
    sourceText,
    visibility,
    evidence,
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.counterparties !== undefined ? { counterparties: input.counterparties } : {}),
    agent: input.agent,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
}

/** Stamp a pledge fulfilled. A one-off stays stamped: a second stamp refuses. */
export function fulfillPledge(vault: string, input: FulfillPledgeInput): PledgePage {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const slug = slugify(input.slug);
  const path = pledgePath(vault, slug);
  // The stamp is a read-modify-write of the whole frontmatter, so it holds
  // the same pledge-path lock a create does: a fulfill racing the intake's
  // re-anchor rewrite (or a second fulfill) must never overwrite either
  // writer's edit.
  const handle = acquireLockSyncWithRetry(path);
  try {
    const prior = parsePage(vault, slug);
    if (prior === null) throw noPledgeError(slug);
    if (prior.fulfilled !== null) {
      throw new PledgeError(`pledge already fulfilled: ${slug} (on ${prior.fulfilled})`);
    }
    const now = input.now ?? new Date();
    const date = input.date ? requireIsoDate(input.date, "date") : isoDate(now);
    atomicWriteFileSync(
      prior.path,
      rewritePledgeFrontmatter(prior, (meta) => {
        meta["fulfilled"] = date;
      }),
    );
    return Object.freeze({ ...prior, fulfilled: date });
  } finally {
    handle.release();
  }
}

/** One pledge, or null. A page the caller's reach withholds answers null. */
export function showPledge(vault: string, input: ShowPledgeInput): PledgePage | null {
  const slug = slugify(input.slug);
  if (input.readable !== undefined && !input.readable(pledgeRel(slug))) return null;
  return parsePage(vault, slug);
}

/**
 * True when an active pledge page already exists for `slug`. Lets callers
 * detect a same-title collision structurally before attempting a create
 * that {@link addPledge} would reject.
 */
export function pledgeExists(vault: string, slug: string): boolean {
  return existsSync(pledgePath(vault, slugify(slug)));
}

/**
 * The input of one pledge listing: the reach, the filters, and the two
 * ceilings that bound the work.
 */
export interface ListPledgesInput {
  now: Date;
  readable?: (rel: string) => boolean;
  includeFulfilled?: boolean;
  /**
   * Maximum pages this call keeps, in name order; omitted means unbounded.
   * Counted after the `includeFulfilled` filter, so completed pledges do
   * not consume the window an open one needs.
   */
  readonly readCap?: number;
  /**
   * Maximum markdown pages this call scans, including pages it drops;
   * omitted means unbounded. The ceiling bounds the FILESYSTEM work: a
   * page the walk parses and then drops - fulfilled, unparseable or
   * filtered out - still spends the budget, so the work cannot grow with
   * the number of pledge pages on disk. A page the `readable` predicate
   * refuses is never parsed, so it spends no budget.
   */
  readonly scanCap?: number;
}

/**
 * Pledges sorted by due (earliest first), then slug; undated pages last.
 * Open pledges only unless `includeFulfilled`. A page the `readable`
 * predicate refuses is dropped before anything counts it: identical-to-absent.
 * Two ceilings bound the work: `readCap` bounds the pages the call KEEPS
 * and `scanCap` the pages it PARSES, so the filesystem work does not grow
 * with the number of pledge pages on disk.
 */
export function listPledges(vault: string, input: ListPledgesInput): ReadonlyArray<PledgeListItem> {
  const dir = pledgesDir(vault);
  if (!existsSync(dir)) return [];
  const today = isoDate(input.now);
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const out: PledgeListItem[] = [];
  let pagesRead = 0;
  let pagesScanned = 0;
  for (const name of readdirSync(dir).toSorted()) {
    if (input.readCap !== undefined && pagesRead >= input.readCap) break;
    if (!name.endsWith(".md")) continue;
    const slug = name.replace(/\.md$/u, "");
    if (input.readable !== undefined && !input.readable(pledgeRel(slug))) continue;
    // The scan ceiling bounds the PARSING, not only the keeping: a page the
    // walk parses and then drops - fulfilled, unparseable - spends the
    // budget, so the filesystem work cannot grow with the number of pledge
    // pages on disk. A page the `readable` predicate refuses is never
    // parsed, so it spends no budget.
    if (input.scanCap !== undefined && pagesScanned >= input.scanCap) break;
    pagesScanned += 1;
    const page = parsePage(vault, slug);
    if (page === null) continue;
    // The cap bounds the pages a caller actually receives, not the pages on
    // disk: a fulfilled page the default filter drops spends no budget, so
    // a long tail of completed promises cannot crowd an open one out of the
    // brief's read window.
    if (page.fulfilled !== null && input.includeFulfilled !== true) continue;
    pagesRead += 1;
    const dueMs = page.due === "" ? Number.NaN : Date.parse(`${page.due}T00:00:00Z`);
    const daysUntilDue = Number.isNaN(dueMs) ? null : Math.round((dueMs - todayMs) / ONE_DAY_MS);
    const overdue = page.fulfilled === null && !Number.isNaN(dueMs) && dueMs < todayMs;
    out.push(
      Object.freeze({
        slug: page.slug,
        title: page.title,
        due: page.due,
        overdue,
        daysUntilDue,
        counterparties: page.counterparties,
        fulfilled: page.fulfilled,
        source: page.source,
        path: page.path,
      }),
    );
  }
  return out.toSorted((a, b) => {
    if (a.due === "" && b.due !== "") return 1;
    if (a.due !== "" && b.due === "") return -1;
    if (a.due !== b.due) return a.due < b.due ? -1 : 1;
    if (a.slug === b.slug) return 0;
    return a.slug < b.slug ? -1 : 1;
  });
}

/** Retire a pledge into Brain/pledges/archive/ with a collision suffix. */
export function removePledge(vault: string, input: { slug: string }): RemovePledgeResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const normalized = slugify(input.slug);
  const activePath = pledgePath(vault, normalized);
  // The archive move is a mutation of the page's presence, so it holds the
  // same pledge-path lock the family's other writers do: two concurrent
  // removes must not both pass the existence probe and race the rename.
  const handle = acquireLockSyncWithRetry(activePath);
  try {
    // The probe lives inside the lock, like fulfillPledge's read: a page the
    // winning remover already moved answers the named no-pledge refusal here,
    // instead of the archive move's fallback surfacing a raw ENOENT.
    if (!existsSync(activePath)) throw noPledgeError(normalized);
    const archiveDir = pledgesArchiveDir(vault);
    mkdirSync(archiveDir, { recursive: true });
    let archivePath = join(archiveDir, `${normalized}.md`);
    for (let suffix = 2; existsSync(archivePath); suffix++) {
      archivePath = join(archiveDir, `${normalized}-${suffix}.md`);
    }
    try {
      renameWithRetry(activePath, archivePath);
    } catch {
      atomicWriteFileSync(archivePath, readFileSync(activePath, "utf8"));
      rmSync(activePath, { force: true });
    }
    return Object.freeze({ slug: normalized, archivePath });
  } finally {
    handle.release();
  }
}
