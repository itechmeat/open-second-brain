/**
 * The link-candidate manifest carried by note-producing envelopes
 * (nothing-writes-silently, unit E).
 *
 * Three of the six needs-llm-step lanes ask the calling agent for a note
 * that CITES the vault - the rollup ladder ("cite the items you fold
 * in"), the diarization profile, the design note. All three hand over a
 * prompt and no way to know which wikilink targets exist, so every link
 * the agent writes is a guess, and a guess that misses lands a dangling
 * link in a note nobody will re-read.
 *
 * This module is the answer they share: a bounded list of the basenames a
 * `[[wikilink]]` can actually resolve to, built from
 * {@link listVaultBasenames} - the cheap readdir-only walker with
 * Obsidian's own resolution semantics. NOTHING here reads note bytes,
 * parses frontmatter, opens the search index, or contacts an embedding
 * provider: a candidate list is an existence question, and existence is
 * answerable from directory entries alone. `tests/core/brain/notes/
 * link-candidates.test.ts` walks this module's whole import closure to
 * keep that true.
 *
 * ## The manifest is not the field it carries
 *
 * A bare array of names would be the misleading shape this wave removes:
 * a forty-name list from a five-hundred-note vault reads exactly like a
 * complete one. So the manifest reports the TOTAL it measured beside the
 * subset it can carry, says whether it truncated, and names how the
 * subset was chosen. {@link linkCandidateSchemaHint} turns those numbers
 * into the one constraint line the envelope's `schema_hints` carries -
 * the DATA stays in `link_candidates`, because `schema_hints` is the
 * constraint channel and smuggling a payload into it makes both
 * unreadable.
 *
 * ## Why the ranking is token overlap and not similarity
 *
 * The vault's own deterministic matcher (`tokenise`/`jaccard`, the same
 * pair `findSimilarDecisions` ranks with) is reused rather than
 * re-invented, so a lane that ranks candidates reaches them the same way
 * every other surface reaches related records - and no model is consulted
 * to decide relevance. The one adjustment is that basenames are SLUGS:
 * the shared tokeniser deliberately keeps hyphens (Brain principles are
 * prose, and `fail-closed` is one word there), which would make
 * `ada-lovelace` share no token with the query `Ada Lovelace`. Both sides
 * are split on the slug separators here, and only here.
 */

import { jaccard, tokenise } from "../similarity.ts";
import { listVaultBasenames } from "../../vault.ts";

/**
 * How many candidates an envelope may carry.
 *
 * Bounded by the MCP tool-result preview budget rather than by taste:
 * `brain_diarize` and its siblings return their envelope through a
 * 2000-character budget, above which the whole result is parked in the
 * artifact store and the caller gets a preview instead. Forty basenames
 * is a kilobyte at most, so adding candidates never pushes a lane's own
 * answer out of the response - and a vault larger than that is reported
 * as truncated rather than trimmed in silence.
 */
export const LINK_CANDIDATE_LIMIT = 40;

/** How the carried subset was chosen. */
export type LinkCandidateSelection =
  /** The vault fits inside the bound; the list is every note there is. */
  | "all"
  /** Over the bound with a query: the subset is the highest token overlap. */
  | "relevance"
  /** Over the bound with no query: the subset is the first N by name. */
  | "alphabetical";

/** Wikilink targets an envelope offers the calling agent, and their bound. */
export interface LinkCandidateManifest {
  /** Note basenames a `[[wikilink]]` resolves to, in selection order. */
  readonly candidates: ReadonlyArray<string>;
  /** Basenames the walk found in the whole vault, before the bound. */
  readonly total: number;
  /** True when {@link candidates} is a subset of what {@link total} counts. */
  readonly truncated: boolean;
  readonly selection: LinkCandidateSelection;
}

export interface LinkCandidateOptions {
  /**
   * What the note is about. Used ONLY to rank an over-bound vault; it
   * never filters, so a query that matches nothing still yields the
   * bound's worth of candidates.
   */
  readonly query?: string;
  /** Override for {@link LINK_CANDIDATE_LIMIT}; must be a positive integer. */
  readonly limit?: number;
}

/** A candidate manifest was asked for with a bound that cannot hold one. */
export class LinkCandidateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkCandidateError";
  }
}

/**
 * Build one manifest for `vault`. Read-only and deterministic: the same
 * vault and the same query give the same list, in the same order.
 */
export function buildLinkCandidateManifest(
  vault: string,
  opts: LinkCandidateOptions = {},
): LinkCandidateManifest {
  const limit = opts.limit ?? LINK_CANDIDATE_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new LinkCandidateError(
      `link candidates: limit must be a positive integer, got ${String(limit)}`,
    );
  }

  const all = [...listVaultBasenames(vault)].toSorted((a, b) => a.localeCompare(b));
  const total = all.length;
  if (total <= limit) return freezeManifest(all, total, false, "all");

  const query = opts.query?.trim() ?? "";
  if (query.length === 0) return freezeManifest(all.slice(0, limit), total, true, "alphabetical");

  const queryTokens = slugTokens(query);
  const ranked = all
    .map((name) => ({ name, score: jaccard(queryTokens, slugTokens(name)) }))
    // Name is the tie-break, so two candidates with the same score never
    // depend on the order the directory walk happened to return them in.
    .toSorted((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => entry.name);
  return freezeManifest(ranked, total, true, "relevance");
}

/**
 * The one `schema_hints` line a lane adds for its manifest: a CONSTRAINT
 * on the artifact, stating what the list in `link_candidates` is and -
 * when it is a subset - that a target outside it may still exist. A hint
 * claiming the list is exhaustive over a truncated manifest would be the
 * confident-sounding falsehood this wave exists to remove.
 */
export function linkCandidateSchemaHint(manifest: LinkCandidateManifest): string {
  if (manifest.total === 0) {
    return "wikilinks: this vault holds no notes yet, so link_candidates is empty and any wikilink you write will dangle";
  }
  if (manifest.truncated) {
    return (
      `wikilinks: link_candidates carries ${manifest.candidates.length} of the ${manifest.total} ` +
      "notes this vault holds; a target it does not name may still exist, so cite one only when " +
      "the note itself is in your grounding"
    );
  }
  return (
    `wikilinks: link_candidates carries all ${manifest.total} notes this vault holds; ` +
    "a target it does not name does not exist and the link will dangle"
  );
}

/**
 * Tokens of a slug. Hyphens and underscores are separators here even
 * though the shared tokeniser keeps them - see the module docblock.
 */
function slugTokens(text: string): ReadonlySet<string> {
  return tokenise(text.replace(/[-_]+/g, " "));
}

function freezeManifest(
  candidates: ReadonlyArray<string>,
  total: number,
  truncated: boolean,
  selection: LinkCandidateSelection,
): LinkCandidateManifest {
  return Object.freeze({
    candidates: Object.freeze([...candidates]),
    total,
    truncated,
    selection,
  });
}
