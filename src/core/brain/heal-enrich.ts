/**
 * Heal-phase vault enrichment (Brain lifecycle suite, Feature 6).
 *
 * Deterministic, structural enrichment for the dream heal phase. Two
 * narrow operations, both safe to re-run:
 *
 *   - {@link deriveTitleFromContent}: a missing `title` is filled from
 *     the page's first H1. No inference beyond reading the heading.
 *   - {@link linkExactMentions}: insert wikilinks for EXACT, whole-token
 *     title/alias matches to known pages. Case-sensitive, longest-match
 *     first, idempotent (existing `[[...]]` and inline `code` spans are
 *     never re-linked). No fuzzy matching, no language heuristics.
 *
 * The whole feature is gated off by default in the dream pass
 * (`dream.heal_enrich_enabled`), because it rewrites user files; these
 * functions are pure and side-effect free regardless.
 */

import { escapeRegex } from "../strings.ts";

const H1_RE = /^#[ \t]+(.+?)[ \t]*$/m;
// Existing wikilinks, fenced code blocks, and inline code spans are
// protected from linking. The fenced-block alternation comes first so a
// multi-line ``` block is captured whole before the inline-code branch
// can match a backtick pair inside it.
const PROTECTED_RE = /(```[\s\S]*?```|\[\[[^\]]*\]\]|`[^`]*`)/g;

/** First H1 heading text, or null when the page has no H1. */
export function deriveTitleFromContent(markdown: string): string | null {
  const m = H1_RE.exec(markdown);
  if (!m) return null;
  const title = m[1]!.trim();
  return title.length > 0 ? title : null;
}

/**
 * One known title/alias, prepared once: the raw form (for per-page
 * self-link exclusion, which matches on the exact string the caller
 * supplied) and its regex-escaped, trimmed form (for the alternation).
 */
interface PreparedPhrase {
  readonly raw: string;
  readonly escaped: string;
}

/**
 * The full known title/alias set, trimmed / dropped-if-empty / sorted
 * longest-first (lexicographic tie-break) / regex-escaped ONCE. The heal
 * runner shares this across every page instead of re-sorting and
 * re-escaping K phrases per page (the dominant per-page cost), then
 * excludes each page's own few terms via {@link linkExactMentionsPrepared}.
 */
export interface PreparedHealPhrases {
  readonly entries: ReadonlyArray<PreparedPhrase>;
}

/** Build the shared, sorted, escaped phrase set. Order-preserving under
 * later per-page filtering, so output stays identical to sorting the
 * already-filtered list. */
export function prepareHealPhrases(known: ReadonlyArray<string>): PreparedHealPhrases {
  const entries = known
    .map((raw) => ({ raw, trimmed: raw.trim() }))
    .filter((e) => e.trimmed.length > 0)
    // Longest first so a multi-word title wins over a contained shorter
    // one at the same position; lexicographic tie-break for determinism.
    .toSorted(
      (a, b) =>
        b.trimmed.length - a.trimmed.length ||
        (a.trimmed < b.trimmed ? -1 : a.trimmed > b.trimmed ? 1 : 0),
    )
    .map((e) => Object.freeze({ raw: e.raw, escaped: escapeRegex(e.trimmed) }));
  return Object.freeze({ entries: Object.freeze(entries) });
}

/** Compile the alternation from the ordered escaped forms and link every
 * whole-token match outside protected spans. Shared core of both public
 * entry points. */
function applyPhrases(body: string, escaped: ReadonlyArray<string>): string {
  if (escaped.length === 0) return body;
  const alternation = escaped.join("|");
  // Whole-token boundaries via Unicode letter/number lookarounds so the
  // match is language-agnostic (works for any script).
  const linkRe = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])`, "gu");

  // Split on protected spans (captured, so they land at odd indices) and
  // only link in the free text at even indices.
  const parts = body.split(PROTECTED_RE);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]!.replace(linkRe, (match) => `[[${match}]]`);
  }
  return parts.join("");
}

/**
 * Wrap exact whole-token occurrences of any `known` title/alias in a
 * wikilink. Text inside existing wikilinks or inline code is left
 * untouched, so the function is idempotent. Returns the input unchanged
 * when `known` is empty.
 */
export function linkExactMentions(body: string, known: ReadonlyArray<string>): string {
  return applyPhrases(
    body,
    prepareHealPhrases(known).entries.map((e) => e.escaped),
  );
}

/**
 * Prepared-set variant of {@link linkExactMentions}: link every phrase in
 * `prepared` whose raw form is NOT in `exclude` (the page's own titles /
 * aliases). Filtering the pre-sorted set preserves order, so the
 * alternation - and therefore the output - is byte-identical to calling
 * `linkExactMentions` with the pre-excluded list.
 */
export function linkExactMentionsPrepared(
  body: string,
  prepared: PreparedHealPhrases,
  exclude: ReadonlySet<string>,
): string {
  const escaped: string[] = [];
  for (const entry of prepared.entries) {
    if (!exclude.has(entry.raw)) escaped.push(entry.escaped);
  }
  return applyPhrases(body, escaped);
}

/** A page view the heal planner reads. */
export interface HealPageInput {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

/** Pure, additive enrichment plan. `changed` is true iff anything applies. */
export interface HealPlan {
  readonly changed: boolean;
  /** Title to add when the page has none and an H1 exists. */
  readonly title?: string;
  /** Rewritten body when new wikilinks were inserted. */
  readonly body?: string;
}

/**
 * Compute a pure enrichment plan for one page. Fills a missing title
 * from the first H1 and links exact mentions of `knownTitlesAndAliases`.
 * Never overwrites an existing title; returns `changed: false` when
 * there is nothing to do.
 */
export function planHealEnrichment(
  page: HealPageInput,
  knownTitlesAndAliases: ReadonlyArray<string>,
): HealPlan {
  return finishPlan(page, linkExactMentions(page.body, knownTitlesAndAliases));
}

/**
 * Prepared-set variant of {@link planHealEnrichment} for the heal runner:
 * links against the shared, pre-sorted phrase set minus this page's own
 * titles/aliases. Output is byte-identical to
 * `planHealEnrichment(page, [...known].filter((k) => !exclude.has(k)))`,
 * but skips re-sorting and re-escaping the whole phrase set per page.
 */
export function planHealEnrichmentPrepared(
  page: HealPageInput,
  prepared: PreparedHealPhrases,
  exclude: ReadonlySet<string>,
): HealPlan {
  return finishPlan(page, linkExactMentionsPrepared(page.body, prepared, exclude));
}

/** Shared tail: derive a missing title from the first H1 and package the
 * (possibly) relinked body into a plan. */
function finishPlan(page: HealPageInput, linked: string): HealPlan {
  const existingTitle = page.frontmatter["title"];
  const hasTitle = typeof existingTitle === "string" && existingTitle.trim().length > 0;

  let title: string | undefined;
  if (!hasTitle) {
    const derived = deriveTitleFromContent(page.body);
    if (derived !== null) title = derived;
  }

  const body = linked !== page.body ? linked : undefined;

  return {
    changed: title !== undefined || body !== undefined,
    ...(title !== undefined ? { title } : {}),
    ...(body !== undefined ? { body } : {}),
  };
}
