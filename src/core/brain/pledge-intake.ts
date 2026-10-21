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
 *     and leaves the vault untouched (no partial batches).
 *   - Identity is idempotent. A pledge's identity is the sha256 prefix
 *     (first 12 hex) over the normalized `(title, due, source)` triple.
 *     A re-post of the same identity with the same normalized payload is
 *     a reported duplicate no-op; the same identity with a different
 *     payload throws a named {@link PledgeIntakeError} mismatch - the
 *     preference idempotency-key precedent.
 *   - Counterparties are anchored server-side. The kernel never trusts
 *     caller-supplied entity ids: names are anchored against
 *     canonical-scope entities the caller can read (`entityStatusInScope`
 *     plus the reach predicate - a withheld record is absent, so it can
 *     neither match nor block a match) through the shared
 *     occurrence-anchoring kernel (`anchorEntityForms`). A name that
 *     anchors to exactly one entity becomes a `promised_to` edge; a name
 *     that anchors nowhere - or that two canonical records claim - is
 *     reported on the result and stored nowhere, so a pledge exists
 *     without edges rather than with fake ones.
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

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { slugify } from "../vault.ts";
import { anchorEntityForms } from "./atomic-facts.ts";
import { buildEntityIndex } from "./entities/index-builder.ts";
import { resolveEntityLexicon } from "./entities/lexicon.ts";
import { ENTITY_STATUS_SCOPE, entityStatusInScope } from "./entities/status-scope.ts";
import {
  addPledge,
  isSourcePage,
  NOTES_HEADER,
  normalizePledgeSource,
  pledgeExists,
  rewritePledgeFrontmatter,
  showPledge,
  type PledgePage,
} from "./pledges.ts";
import { validateIsoDate } from "./paths.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";
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
   * Slugs whose stored `promised_to` edge the anchor can no longer
   * reproduce (the entity left canonical scope, or became unreadable).
   * Reported, never removed: the page is left byte-identical, because an
   * edge that was valid when computed is not the caller's to delete.
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
   * to, so a withheld page is identical to an absent one everywhere.
   */
  readonly readable?: (rel: string) => boolean;
}

/** Length of the identity digest: a 12-hex sha256 prefix, the 48-bit idiom. */
const IDENTITY_HEX_LENGTH = 12;

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
 * The identity of a pledge: sha256 first 12 hex over the normalized
 * `(title, due, source)` triple. Whitespace in the title folds, so a
 * re-post that only reformats the title keeps its identity.
 */
function pledgeIdentity(normalizedTitle: string, due: string, normalizedSource: string): string {
  return createHash("sha256")
    .update(`${normalizedTitle}\n${due}\n${normalizedSource}`)
    .digest("hex")
    .slice(0, IDENTITY_HEX_LENGTH);
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

function storedIdentity(page: PledgePage): string {
  return pledgeIdentity(collapse(page.title), page.due, page.source);
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
  // source never even has its existence on disk confirmed.
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
  const haystack = quoteHaystack(normalizeForQuoteComparison(readFileSync(sourceAbs, "utf8")));

  const prepared: PreparedIntakeItem[] = [];
  const seenSlugs = new Set<string>();
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
    const slug = slugify(title);
    if (seenSlugs.has(slug)) {
      throw new PledgeIntakeError(
        `pledge intake repeats a slug within one batch: ${slug} - post each pledge once per intake`,
      );
    }
    seenSlugs.add(slug);
    const existing = showPledge(vault, {
      slug,
      // The stored-page lookup answers at the caller's reach: a withheld
      // page is identical to an absent one, so nothing is compared,
      // classified or rewritten behind the gate. The create arm below
      // refuses the taken slug exactly as it does for a readable page.
      ...(opts.readable !== undefined ? { readable: opts.readable } : {}),
    });
    if (existing !== null) {
      // A slug already held is either the SAME pledge (idempotent path) or
      // a different one (refusal). Identity decides; nothing is overwritten
      // either way.
      if (storedIdentity(existing) !== pledgeIdentity(title, due, source)) {
        throw new PledgeIntakeError(
          `pledge intake slug already held by a different pledge: ${slug} - remove the existing pledge first`,
        );
      }
      if (storedPayloadKey(existing) !== payloadKey(item.text ?? "", evidence)) {
        throw new PledgeIntakeError(
          `pledge intake identity mismatch: ${slug} already stores this identity with a different ` +
            "payload - repost the stored payload or remove the pledge first",
        );
      }
    }
    // Two refusals the create arm would only produce at WRITE time, pulled
    // into the validation pass so one failing item cannot strand the items
    // before it on disk (the no-partial-batches promise):
    //   - a text carrying the notes-section header is refused by
    //     `addPledge` when the page is rendered;
    //   - a slug held by a page the caller cannot read passes the stored-
    //     page lookup above as absent and is refused by `addPledge`'s
    //     existence check. The refusal and its message are exactly the
    //     ones the create arm produces - only earlier, so nothing has
    //     been written when they fire.
    if ((item.text ?? "").split(/\r?\n/u).some((line) => line.trim() === NOTES_HEADER)) {
      throw new PledgeIntakeError(
        `pledge intake item text must not contain the ${NOTES_HEADER} section header: ${slug}`,
      );
    }
    if (existing === null && pledgeExists(vault, slug)) {
      throw new PledgeIntakeError(`pledge already exists: ${slug} (remove it first to recreate)`);
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
  const verdictByName = new Map<string, string | null>();
  const unanchoredCounterparties: string[] = [];
  for (const name of counterpartyNames) {
    const matches = canonical.filter(
      (entity) => anchorEntityForms(name, [entity.name, ...entity.aliases], { lexicon }).length > 0,
    );
    verdictByName.set(name, matches.length === 1 ? matches[0]!.id : null);
    if (matches.length !== 1) unanchoredCounterparties.push(name);
  }

  // --- Write pass: nothing above wrote; everything below is decided. ---
  const created: string[] = [];
  const duplicates: string[] = [];
  const reanchored: string[] = [];
  const staleEdges: string[] = [];
  for (const prep of prepared) {
    const anchoredIds = [
      ...new Set(
        prep.counterparties
          .map((name) => verdictByName.get(name))
          .filter((id): id is string => typeof id === "string"),
      ),
    ].toSorted();
    if (prep.existing === null) {
      addPledge(vault, {
        title: prep.title,
        due: prep.due,
        source,
        evidence: prep.evidence,
        ...(prep.text !== undefined ? { text: prep.text } : {}),
        counterparties: anchoredIds,
        agent: opts.agent,
        now: opts.now,
      });
      created.push(prep.slug);
      continue;
    }
    const storedIds = [...new Set(prep.existing.counterparties)].toSorted();
    const storedSet = new Set(storedIds);
    // Additive only: a stored edge the anchor can no longer reproduce
    // (the entity left canonical scope, or became unreadable) is reported
    // and the page is left byte-identical - an identical repost must
    // never delete an edge that was valid when it was computed.
    if (anchoredIds.length < storedIds.length && anchoredIds.every((id) => storedSet.has(id))) {
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
  atomicWriteFileSync(
    page.path,
    rewritePledgeFrontmatter(page, (meta) => {
      meta["promised_to"] = [...counterparties];
    }),
  );
}
