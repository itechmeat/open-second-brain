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
 *               error.
 *   - `fulfill` stamps the fulfillment date; a fulfilled pledge stays
 *               stamped (one-off, not recurring).
 *   - `list`    reads pages up to an optional cap, due-sorted, with an
 *               overdue flag and whole days until due (null if undated);
 *               open pledges only unless the caller asks for fulfilled too.
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
  /** True when due is strictly before today (UTC). */
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
      promised_to: [...page.counterparties],
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
  if (!existsSync(path)) return null;
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
    counterparties: Object.freeze(requireStringList(meta["promised_to"])),
    fulfilled: parseIsoDate(meta["fulfilled"]) || null,
    agent: typeof meta["agent"] === "string" ? meta["agent"] : "",
    notes,
    path,
  });
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
  assertEvidenceInSource(source, sourceText, evidence);
  const [sourceMeta] = parseFrontmatterText(sourceText);
  const visibility = strictestVisibilityOf([pageVisibility(sourceMeta)]);
  const slug = slugify(title);
  const now = input.now ?? new Date();
  const page = {
    slug,
    title,
    text: (input.text ?? "").trim(),
    due,
    createdAt: isoSecond(now),
    source,
    evidence: Object.freeze(evidence),
    counterparties: Object.freeze(
      (input.counterparties ?? []).map((id) => id.trim()).filter((id) => id.length > 0),
    ),
    fulfilled: null,
    agent: input.agent,
    notes: (input.notes ?? "").trim(),
  };
  const path = pledgePath(vault, slug);
  const handle = acquireLockSyncWithRetry(path);
  try {
    if (existsSync(path)) {
      throw new PledgeError(`pledge already exists: ${slug} (remove it first to recreate)`);
    }
    atomicWriteFileSync(path, render(page, visibility));
    return Object.freeze({ ...page, path });
  } finally {
    handle.release();
  }
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
 * Pledges sorted by due (earliest first), then slug; undated pages last.
 * Open pledges only unless `includeFulfilled`. A page the `readable`
 * predicate refuses is dropped before anything counts it: identical-to-absent.
 */
export function listPledges(
  vault: string,
  input: {
    now: Date;
    readable?: (rel: string) => boolean;
    includeFulfilled?: boolean;
    /** Maximum readable pages to read in name order; omitted means unbounded. */
    readonly readCap?: number;
  },
): ReadonlyArray<PledgeListItem> {
  const dir = pledgesDir(vault);
  if (!existsSync(dir)) return [];
  const today = isoDate(input.now);
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const out: PledgeListItem[] = [];
  let pagesRead = 0;
  for (const name of readdirSync(dir).toSorted()) {
    if (input.readCap !== undefined && pagesRead >= input.readCap) break;
    if (!name.endsWith(".md")) continue;
    const slug = name.replace(/\.md$/u, "");
    if (input.readable !== undefined && !input.readable(pledgeRel(slug))) continue;
    const page = parsePage(vault, slug);
    if (page === null) continue;
    pagesRead += 1;
    if (page.fulfilled !== null && input.includeFulfilled !== true) continue;
    const dueMs = page.due === "" ? Number.NaN : Date.parse(`${page.due}T00:00:00Z`);
    const daysUntilDue = Number.isNaN(dueMs) ? null : Math.round((dueMs - todayMs) / ONE_DAY_MS);
    const overdue = !Number.isNaN(dueMs) && dueMs < todayMs;
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
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
}

/** Retire a pledge into Brain/pledges/archive/ with a collision suffix. */
export function removePledge(vault: string, input: { slug: string }): RemovePledgeResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const normalized = slugify(input.slug);
  const activePath = pledgePath(vault, normalized);
  if (!existsSync(activePath)) throw noPledgeError(normalized);
  // The archive move is a mutation of the page's presence, so it holds the
  // same pledge-path lock the family's other writers do: two concurrent
  // removes must not both pass the existence probe and race the rename.
  const handle = acquireLockSyncWithRetry(activePath);
  try {
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
