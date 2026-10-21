/**
 * Extraction intake for the pledge family (dated-commitments wave).
 *
 * One validated, idempotent path turns an agent-posted typed pledge
 * extraction (a source page plus an array of items: title, due, evidence
 * quotes, optional text and counterparty names) into `Brain/pledges/`
 * pages, mirroring the extraction-intake discipline of
 * `intake/extract-intake.ts`. The kernel never calls a model: the model
 * that produced the extraction lives on the agent side of the MCP
 * boundary, and this module validates, anchors and commits.
 *
 *   - Validate EVERYTHING before any write. Structure, source
 *     readability at the caller's reach, and quote containment for every
 *     item are checked first; one invalid item refuses the whole intake
 *     and leaves the vault untouched (no partial batches). The create arm
 *     re-checks each slug under its own write lock, so a concurrent writer
 *     can still take a slug between validation and commit: that failure
 *     removes the pages this intake already created (best effort) and
 *     reports both what was created and what was rolled back. The residual
 *     window is a rollback that cannot remove a page (reported by name, not
 *     hidden) and any re-anchor rewrites made before the failing item.
 *   - Identity is idempotent. A pledge's identity is the sha256 prefix
 *     (first 12 hex) over the normalized `(title, due, source)` triple.
 *     A re-post of the same identity with the same normalized payload is
 *     a reported duplicate no-op; the same identity with a different
 *     payload throws a named {@link PledgeIntakeError} mismatch - the
 *     preference idempotency-key precedent.
 *   - Counterparties are anchored server-side. The kernel never trusts
 *     caller-supplied entity ids: names are resolved against canonical-
 *     scope entities the caller can read (`entityStatusInScope` plus the
 *     reach predicate - a withheld record is absent, so it can neither
 *     match nor block a match) by whole-name equality over the shared
 *     quality-gated match forms (`entityNameEqualsAnchorForm` - a name is
 *     resolved, not scanned for, so a name that merely contains an
 *     entity's name anchors nowhere). A name that resolves to exactly one
 *     entity becomes a `promised_to` edge; a name that resolves nowhere -
 *     or that two canonical records claim - is reported on the result and
 *     stored nowhere, so a pledge exists without edges rather than with
 *     fake ones.
 *   - The re-anchor arm. Re-posting the same identity and payload after
 *     the entity has since been registered computes the edge the first
 *     post could not, rewrites the page's `promised_to` frontmatter (the
 *     frontmatter-relations ingest projects the typed edges) and reports
 *     the slug under `reanchored`; a third identical post is a plain
 *     duplicate again. The arm is additive: it merges the stored and the
 *     freshly anchored ids and rewrites only when that union is larger,
 *     so an entity leaving canonical scope is reported under `staleEdges`
 *     and never turns an identical repost into an edge deletion.
 */

import { readFileSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { parseFrontmatterText } from "../vault.ts";
import { entityNameEqualsAnchorForm } from "./atomic-facts.ts";
import { buildEntityIndex } from "./entities/index-builder.ts";
import { resolveEntityLexicon } from "./entities/lexicon.ts";
import { ENTITY_STATUS_SCOPE, entityStatusInScope } from "./entities/status-scope.ts";
import {
  createPledgePage,
  isSourcePage,
  NOTES_HEADER,
  normalizePledgeSource,
  pledgeExists,
  pledgeIdentity,
  pledgeSlugCandidates,
  rewritePledgeFrontmatter,
  showPledge,
  type PledgePage,
} from "./pledges.ts";
import { validateIsoDate } from "./paths.ts";
import { acquireLockSyncWithRetry } from "./sync-lockfile.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";
import { pageVisibility, strictestVisibilityOf } from "../graph/visibility.ts";
import { PROMISED_TO_RELATION } from "../graph/relation-vocab.ts";
import { normalizeForQuoteComparison, quoteHaystack, spanOccursIn } from "./distill/quote-spans.ts";

/** A pledge-intake payload or anchor failed validation; nothing was written. */
export class PledgeIntakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PledgeIntakeError";
  }
}

/** One pledge the agent extracted from a source. */
export interface PledgeIntakeItem {
  readonly title: string;
  readonly due: string;
  readonly evidence: ReadonlyArray<string>;
  readonly text?: string;
  readonly counterparties?: ReadonlyArray<string>;
}

/** A typed pledge extraction the agent supplies for intake. */
export interface PledgeIntakeInput {
  /** The vault-relative page every item was extracted from and cites. */
  readonly source: string;
  readonly pledges: ReadonlyArray<PledgeIntakeItem>;
}

export interface PledgeIntakeResult {
  /** Slugs of pledges created by this intake, in input order. */
  readonly created: ReadonlyArray<string>;
  /** Slugs whose identity and payload were already stored (no-op). */
  readonly duplicates: ReadonlyArray<string>;
  /** Slugs whose `promised_to` edges this post added (the re-anchor arm). */
  readonly reanchored: ReadonlyArray<string>;
  /**
   * Slugs with a stored `promised_to` edge the readable canonical
   * registry can no longer reproduce (the entity left canonical scope,
   * or became unreadable). Reported, never removed: the page is left
   * byte-identical, because an edge that was valid when computed is not
   * the caller's to delete, and the re-anchor arm does not grow a new
   * edge beside a dead one.
   */
  readonly staleEdges: ReadonlyArray<string>;
  /**
   * Counterparty names that anchored to no canonical-scope entity, first
   * seen first, deduplicated. Stored nowhere: the pledge carries only the
   * edges that anchored.
   */
  readonly unanchoredCounterparties: ReadonlyArray<string>;
}

export interface PledgeIntakeOptions {
  /** Agent identity stamped as the page `agent`. */
  readonly agent: string;
  /** Injected clock for deterministic stamps. */
  readonly now: Date;
  /**
   * May the caller read the vault page at this vault-relative path? The
   * cited source is refused up front when the predicate says no, exactly
   * like an absent page - nothing is read from it, nothing is written
   * from it, and nothing about it leaks. The same predicate governs the
   * stored pledge lookup and the entity pages counterparties may anchor
   * to, so on those read surfaces a withheld page is identical to an
   * absent one.
   *
   * The create path is the deliberate exception: a slug already held by a
   * page the caller cannot read is refused at any reach ("pledge already
   * exists"), because the identity behind the gate cannot be compared and
   * creating there would replace the withheld page - the same discipline
   * `brain_pledge` documents for its add arm. A readable page held by a
   * DIFFERENT identity is not that case: the new pledge files under its
   * identity suffix instead. A caller can therefore learn that some page
   * holds a slug it cannot read; it can never read or overwrite it.
   */
  readonly readable?: (rel: string) => boolean;
}

/**
 * Hard cap on the pledge items one intake may post. Every distinct
 * counterparty name scans the canonical entity registry synchronously
 * inside one handler, so an unbounded batch multiplies that work; the
 * number follows the family's write-batch ceiling (`MAX_BATCH_OPERATIONS`,
 * 100) rather than inventing a second scale.
 */
export const MAX_INTAKE_PLEDGES = 100;

/** Per-item cap on counterparty names: each name is one registry scan. */
export const MAX_INTAKE_COUNTERPARTIES = 32;

/**
 * Longest counterparty name the intake accepts. The schema caps a pledge
 * title at 200 characters and a name is matched by the same occurrence
 * kernel, so one bound governs both.
 */
export const MAX_INTAKE_COUNTERPARTY_NAME_LENGTH = 200;

/** Collapse whitespace runs and trim: the intake's normalization for text. */
function collapse(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

/** A vault-relative POSIX path from an absolute one, whatever the host separator. */
function vaultRel(vault: string, abs: string): string {
  return relative(vault, abs).split(sep).join("/");
}

/**
 * Normalize one item's counterparty names and enforce the per-item caps
 * at the point the work happens: every name is a registry scan, and a
 * name is matched by the same occurrence kernel that bounds a title, so
 * a longer or more numerous list is refused with a named error before
 * anything is anchored or written.
 */
function prepareCounterpartyNames(slug: string, raw: ReadonlyArray<string> | undefined): string[] {
  const names = (raw ?? []).map((name) => name.trim()).filter((name) => name.length > 0);
  if (names.length > MAX_INTAKE_COUNTERPARTIES) {
    throw new PledgeIntakeError(
      `pledge intake item names more than ${MAX_INTAKE_COUNTERPARTIES} counterparties: ${slug} - ` +
        "keep the counterparty list to the people the promise is owed to",
    );
  }
  for (const name of names) {
    if (name.length > MAX_INTAKE_COUNTERPARTY_NAME_LENGTH) {
      throw new PledgeIntakeError(
        `pledge intake counterparty name is longer than ${MAX_INTAKE_COUNTERPARTY_NAME_LENGTH} ` +
          `characters (${name.length}): ${slug}`,
      );
    }
  }
  return names;
}

/**
 * The normalized payload a stored pledge must match for a re-post to read
 * as a duplicate: the promise text and the evidence quote set, order-
 * insensitive over the quotes. Counterparty names are deliberately not
 * part of the payload - they are anchor requests the server resolves, and
 * a re-post that names a since-registered entity is the re-anchor arm,
 * not a mismatch. The notes section is deliberately not part of it either:
 * the intake never writes one, so a note added to a stored page by hand
 * must not turn an otherwise identical re-post into a mismatch (the
 * re-anchor rewrite preserves such a note untouched).
 */
function payloadKey(text: string, evidence: ReadonlyArray<string>): string {
  return JSON.stringify([collapse(text), evidence.map((quote) => collapse(quote)).toSorted()]);
}

function storedPayloadKey(page: PledgePage): string {
  return payloadKey(page.text, page.evidence);
}

/** The item shape the validation pass hands to the write pass. */
interface PreparedIntakeItem {
  readonly slug: string;
  readonly title: string;
  readonly due: string;
  readonly evidence: string[];
  readonly text?: string;
  readonly counterparties: string[];
  /** The stored page under the same slug, or null when the slug is free. */
  readonly existing: PledgePage | null;
}

/**
 * Intake a typed pledge extraction into the pledge family. Validates the
 * full payload first (throwing {@link PledgeIntakeError} with no write on
 * failure), anchors counterparties server-side, then commits: creates new
 * pledges, reports stored identity-and-payload repeats as duplicates,
 * adds edges through the re-anchor arm when an entity registered between
 * two identical posts, and reports - without writing - a stored edge the
 * anchor can no longer reproduce under `staleEdges`.
 */
export function intakePledges(
  vault: string,
  input: PledgeIntakeInput,
  opts: PledgeIntakeOptions,
): PledgeIntakeResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);

  // The batch ceiling comes before any read: an oversized extraction is
  // refused whole, so a caller cannot buy unbounded registry scans.
  if (input.pledges.length > MAX_INTAKE_PLEDGES) {
    throw new PledgeIntakeError(
      `a pledge intake may contain at most ${MAX_INTAKE_PLEDGES} pledges, got ${input.pledges.length}`,
    );
  }

  // --- Validation pass: everything, before any write. ---
  const source = normalizePledgeSource(input.source);
  if (source.length === 0 || source.startsWith("..")) {
    throw new PledgeIntakeError(
      `pledge intake source must name a vault page: ${JSON.stringify(input.source)}`,
    );
  }
  // The reach question comes first, before any stat or read, so a refused
  // source never even has its existence on disk confirmed. The reach
  // predicate answers false for an absent path too, so a withheld and an
  // absent source both refuse right here, under one message - identical to
  // absent; the not-found arm below is the local reach's own diagnostic.
  if (opts.readable !== undefined && !opts.readable(source)) {
    throw new PledgeIntakeError(
      `pledge intake source page is not readable at the caller's reach: ${source}`,
    );
  }
  const sourceAbs = join(vault, source);
  if (!isSourcePage(sourceAbs)) {
    throw new PledgeIntakeError(
      `pledge intake source page not found: ${source} - a pledge cites bytes the vault holds`,
    );
  }
  const sourceText = readFileSync(sourceAbs, "utf8");
  const haystack = quoteHaystack(normalizeForQuoteComparison(sourceText));
  // Read once, derived twice: the containment haystack above and the
  // visibility the created pages inherit. The write pass hands both to
  // `createPledgePage`, so a full batch never re-reads the source.
  const [sourceMeta] = parseFrontmatterText(sourceText);
  const visibility = strictestVisibilityOf([pageVisibility(sourceMeta)]);

  const prepared: PreparedIntakeItem[] = [];
  const seenSlugs = new Set<string>();
  const seenIdentities = new Map<string, string>();
  const counterpartyNames: string[] = [];
  const seenNames = new Set<string>();
  for (const item of input.pledges) {
    const title = collapse(item.title);
    if (title.length === 0) {
      throw new PledgeIntakeError("pledge intake item title must not be empty");
    }
    let due: string;
    try {
      due = validateIsoDate(item.due);
    } catch {
      throw new PledgeIntakeError(
        `pledge intake due is not a valid calendar date: ${JSON.stringify(item.due)}`,
      );
    }
    const evidence = item.evidence.map((quote) => quote.trim()).filter((quote) => quote.length > 0);
    if (evidence.length === 0) {
      throw new PledgeIntakeError(
        "pledge intake evidence must cite at least one quote from the source page (an uncited pledge is refused)",
      );
    }
    for (const quote of evidence) {
      if (!spanOccursIn(quote, haystack)) {
        throw new PledgeIntakeError(
          `evidence quote does not occur in the source page ${source}: ${JSON.stringify(quote)}`,
        );
      }
    }
    const identity = pledgeIdentity(title, due, source);
    // Slug resolution, exactly the order the create arm will try: the title
    // slug, then its identity suffix. A candidate held by a DIFFERENT
    // identity is skipped, not refused - titles that differ only in
    // non-ASCII letters fold to one slug, and promises to different people
    // are the family's core case. A repeat of the SAME identity inside one
    // batch keeps the duplicated-post refusal.
    const candidates = pledgeSlugCandidates(title, due, source);
    let slug = candidates[0]!;
    let existing: PledgePage | null = null;
    // The first candidate no stored page occupies. The scan records it and
    // keeps going: a LATER candidate may hold this exact identity (the
    // suffixed page a since-removed slug-holder once forced), and the same
    // promise must win over a free slot or a re-post would file a second
    // copy under the freed slug.
    let free: string | null = null;
    let resolved = false;
    for (const candidate of candidates) {
      if (seenSlugs.has(candidate)) {
        if (seenIdentities.get(candidate) === identity) {
          throw new PledgeIntakeError(
            `pledge intake repeats a slug within one batch: ${candidate} - post each pledge once per intake`,
          );
        }
        continue;
      }
      const stored = showPledge(vault, {
        slug: candidate,
        // The stored-page lookup answers at the caller's reach: a withheld
        // page is identical to an absent one, so nothing is compared,
        // classified or rewritten behind the gate.
        ...(opts.readable !== undefined ? { readable: opts.readable } : {}),
      });
      if (stored !== null) {
        if (pledgeIdentity(stored.title, stored.due, stored.source) === identity) {
          slug = candidate;
          existing = stored;
          resolved = true;
          break;
        }
        continue;
      }
      // A withheld page passes the lookup above as absent; the create arm
      // refuses that taken slug, and so does the validation pass, before any
      // write - a create would otherwise replace a page the caller cannot
      // read.
      if (pledgeExists(vault, candidate)) {
        throw new PledgeIntakeError(
          `pledge already exists: ${candidate} (remove it first to recreate)`,
        );
      }
      if (free === null) free = candidate;
    }
    if (!resolved && free !== null) {
      slug = free;
      existing = null;
      resolved = true;
    }
    if (!resolved) {
      throw new PledgeIntakeError(
        `pledge intake slug already held by a different pledge: ${candidates[0]} - remove the existing pledge first`,
      );
    }
    seenSlugs.add(slug);
    seenIdentities.set(slug, identity);
    if (existing !== null && storedPayloadKey(existing) !== payloadKey(item.text ?? "", evidence)) {
      throw new PledgeIntakeError(
        `pledge intake identity mismatch: ${slug} already stores this identity with a different ` +
          "payload - repost the stored payload or remove the pledge first",
      );
    }
    // The text arm of the same promise: a notes-section header is refused by
    // `addPledge` when the page is rendered, pulled into the validation pass
    // so one failing item cannot strand the items before it on disk.
    if ((item.text ?? "").split(/\r?\n/u).some((line) => line.trim() === NOTES_HEADER)) {
      throw new PledgeIntakeError(
        `pledge intake item text must not contain the ${NOTES_HEADER} section header: ${slug}`,
      );
    }
    const counterparties = prepareCounterpartyNames(slug, item.counterparties);
    for (const name of counterparties) {
      if (!seenNames.has(name)) {
        seenNames.add(name);
        counterpartyNames.push(name);
      }
    }
    prepared.push({
      slug,
      title,
      due,
      evidence,
      ...(item.text !== undefined ? { text: item.text.trim() } : {}),
      counterparties,
      existing,
    });
  }

  // --- Anchoring pass: read-only, server-side, never caller-supplied ids. ---
  const lexicon = resolveEntityLexicon(vault);
  // Canonical scope AND the caller's reach: a record the caller cannot
  // read is absent, so it can neither match a name nor block the one
  // readable record that does (the brief's stated rule). At local reach
  // the predicate is undefined and the per-entity check is skipped.
  const canonical = buildEntityIndex(vault).entities.filter(
    (entity) =>
      entityStatusInScope(entity.status, ENTITY_STATUS_SCOPE.canonical) &&
      (opts.readable === undefined || opts.readable(vaultRel(vault, entity.path))),
  );
  const canonicalIds = new Set(canonical.map((entity) => entity.id));
  const verdictByName = new Map<string, string | null>();
  const unanchoredCounterparties: string[] = [];
  for (const name of counterpartyNames) {
    // Whole-name equality, not occurrence: a counterparty NAME is resolved
    // to the entity it names, so a name that merely contains an entity's
    // name ("the Ada Lovelace team") is a different party and anchors
    // nowhere, reported below instead of stored as a false edge.
    const matches = canonical.filter((entity) =>
      entityNameEqualsAnchorForm(name, [entity.name, ...entity.aliases], { lexicon }),
    );
    verdictByName.set(name, matches.length === 1 ? matches[0]!.id : null);
    if (matches.length !== 1) unanchoredCounterparties.push(name);
  }

  // --- Write pass: nothing above wrote; everything below is decided. ---
  const created: string[] = [];
  const createdPages: PledgePage[] = [];
  const duplicates: string[] = [];
  const reanchored: string[] = [];
  const staleEdges: string[] = [];
  try {
    for (const prep of prepared) {
      const anchoredIds = [
        ...new Set(
          prep.counterparties
            .map((name) => verdictByName.get(name))
            .filter((id): id is string => typeof id === "string"),
        ),
      ].toSorted();
      if (prep.existing === null) {
        const page = createPledgePage(vault, {
          title: prep.title,
          due: prep.due,
          source,
          sourceText,
          visibility,
          evidence: prep.evidence,
          ...(prep.text !== undefined ? { text: prep.text } : {}),
          counterparties: anchoredIds,
          agent: opts.agent,
          now: opts.now,
        });
        createdPages.push(page);
        // The page's own slug, not the validation pass's prediction: the
        // create arm re-resolves the candidates under its lock, and the
        // report must name the page that is actually on disk.
        created.push(page.slug);
        continue;
      }
      const storedIds = [...new Set(prep.existing.counterparties)].toSorted();
      // Staleness is a fact about each STORED edge versus the readable
      // canonical registry, never about the names this particular post
      // carried: names are anchor requests, not part of the payload, so a
      // repost that omits some (or all) of them asked for no anchoring and
      // says nothing about the stored edges. A slug with a stale edge is
      // reported and left byte-identical - no edge is removed, and the
      // re-anchor arm does not grow a new edge beside a dead one.
      if (storedIds.some((id) => !canonicalIds.has(id))) {
        staleEdges.push(prep.slug);
        continue;
      }
      const mergedIds = [...new Set([...storedIds, ...anchoredIds])].toSorted();
      if (mergedIds.length === storedIds.length) {
        duplicates.push(prep.slug);
        continue;
      }
      rewritePledgeCounterparties(prep.existing, mergedIds);
      reanchored.push(prep.slug);
    }
  } catch (err) {
    // Validation checked every slug, but a create takes its lock and checks
    // again at write time: a concurrent add or a second intake can take a
    // slug in between, so item N can fail after items 1..N-1 were written.
    // Remove the pages this intake created (best effort) and report both
    // lists, so the no-partial-batches promise holds rather than leaving a
    // silent half-batch on disk. Nothing created means nothing to undo: the
    // original refusal (a lock collision included) surfaces unchanged.
    if (createdPages.length === 0) throw err;
    const removed: string[] = [];
    const stuck: string[] = [];
    for (const page of createdPages) {
      try {
        rmSync(page.path, { force: true });
        removed.push(page.slug);
      } catch {
        stuck.push(page.slug);
      }
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new PledgeIntakeError(
      `pledge intake failed after creating ${createdPages.length} pledge(s): ${reason}; ` +
        `rolled back ${removed.length > 0 ? removed.join(", ") : "none"}` +
        (stuck.length > 0 ? ` - could not remove ${stuck.join(", ")}` : ""),
    );
  }

  return Object.freeze({
    created: Object.freeze(created),
    duplicates: Object.freeze(duplicates),
    reanchored: Object.freeze(reanchored),
    staleEdges: Object.freeze(staleEdges),
    unanchoredCounterparties: Object.freeze(unanchoredCounterparties),
  });
}

/**
 * Rewrite one stored pledge page's `promised_to` frontmatter in place
 * through the shared family helper ({@link rewritePledgeFrontmatter}):
 * the stored map is parsed back whole, only `promised_to` is mutated, and
 * the page is re-rendered with its body bytes untouched - a `visibility`
 * a private pledge carries, or any key an operator added by hand, survives
 * the rewrite. A fixed-key render would be correct only for creation,
 * where there are no prior bytes to preserve; a rewrite has them, so it
 * mutates rather than regenerates.
 */
function rewritePledgeCounterparties(
  page: PledgePage,
  counterparties: ReadonlyArray<string>,
): void {
  // Same lock discipline as the family's other writers: the rewrite is a
  // read-modify-write of the whole frontmatter, so a re-anchor racing a
  // fulfill (or a second re-anchor) must never overwrite either edit.
  const handle = acquireLockSyncWithRetry(page.path);
  try {
    atomicWriteFileSync(
      page.path,
      rewritePledgeFrontmatter(page, (meta) => {
        meta[PROMISED_TO_RELATION] = [...counterparties];
      }),
    );
  } finally {
    handle.release();
  }
}
