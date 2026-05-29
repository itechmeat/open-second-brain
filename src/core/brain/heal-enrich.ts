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

const H1_RE = /^#[ \t]+(.+?)[ \t]*$/m;
// Existing wikilinks and inline code spans are protected from linking.
const PROTECTED_RE = /(\[\[[^\]]*\]\]|`[^`]*`)/g;

/** First H1 heading text, or null when the page has no H1. */
export function deriveTitleFromContent(markdown: string): string | null {
  const m = H1_RE.exec(markdown);
  if (!m) return null;
  const title = m[1]!.trim();
  return title.length > 0 ? title : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Wrap exact whole-token occurrences of any `known` title/alias in a
 * wikilink. Text inside existing wikilinks or inline code is left
 * untouched, so the function is idempotent. Returns the input unchanged
 * when `known` is empty.
 */
export function linkExactMentions(
  body: string,
  known: ReadonlyArray<string>,
): string {
  const phrases = known
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    // Longest first so a multi-word title wins over a contained shorter
    // one at the same position; lexicographic tie-break for determinism.
    .toSorted((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  if (phrases.length === 0) return body;

  const alternation = phrases.map(escapeRegExp).join("|");
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
  const existingTitle = page.frontmatter["title"];
  const hasTitle = typeof existingTitle === "string" && existingTitle.trim().length > 0;

  let title: string | undefined;
  if (!hasTitle) {
    const derived = deriveTitleFromContent(page.body);
    if (derived !== null) title = derived;
  }

  const linked = linkExactMentions(page.body, knownTitlesAndAliases);
  const body = linked !== page.body ? linked : undefined;

  return {
    changed: title !== undefined || body !== undefined,
    ...(title !== undefined ? { title } : {}),
    ...(body !== undefined ? { body } : {}),
  };
}
