/**
 * Deterministic, language-agnostic entity extraction.
 *
 * Entities are proper-noun-ish anchors a query and a memory can share:
 * project names, people, identifiers, acronyms. We do NOT use an NER
 * model or any per-language word list - extraction relies purely on
 * structural Unicode cues, so it behaves identically across locales and
 * produces bit-stable output on every Syncthing peer:
 *
 *   - wikilink targets and their alias display text;
 *   - double-quoted spans;
 *   - capitalized token runs (one or more tokens each starting with a
 *     Unicode uppercase letter);
 *   - CamelCase tokens (internal uppercase), ALLCAPS tokens, and tokens
 *     mixing letters with digits (FTS5, v0.13.0).
 *
 * Entity matching is a re-ranking boost over already-retrieved
 * candidates, never a retrieval mechanism, so liberal extraction cannot
 * inject unrelated documents - it only nudges ordering. Output is
 * normalised (lowercased, whitespace-collapsed, deduped) and frozen.
 */

const WIKILINK_RE = /\[\[([^\]\n|]+?)(?:\|([^\]\n]+))?\]\]/gu;
const QUOTED_RE = /"([^"\n]{2,})"/gu;
// One or more consecutive uppercase-initial tokens (covers "Sergey" and
// "Open Second Brain"). Tokens may carry trailing letters/numbers.
const CAP_RUN_RE = /\p{Lu}[\p{L}\p{N}]*(?:[ \t]+\p{Lu}[\p{L}\p{N}]*)*/gu;
// Single tokens that are notable regardless of position: CamelCase,
// ALLCAPS, or letter+digit mixes.
const CAMEL_RE = /\p{Ll}+\p{Lu}[\p{L}\p{N}]*/gu;
const ALLCAPS_OR_DIGIT_RE = /[\p{Lu}\p{N}]*\p{Lu}[\p{Lu}\p{N}]+|\p{L}+\p{N}+|\p{N}+\p{L}+/gu;

/** Lowercase + collapse internal whitespace. */
function normalize(raw: string): string {
  return raw
    .trim()
    .replace(/[ \t]+/g, " ")
    .toLowerCase();
}

/** Last path segment without a markdown extension, for wikilink targets. */
function basename(target: string): string {
  const seg = target.split("/").pop() ?? target;
  return seg.replace(/\.md$/i, "");
}

export function extractEntities(text: string): ReadonlyArray<string> {
  if (!text) return Object.freeze([] as string[]);
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string): void => {
    const n = normalize(raw);
    if (n.length < 2) return;
    if (seen.has(n)) return;
    seen.add(n);
    out.push(n);
  };

  for (const m of text.matchAll(WIKILINK_RE)) {
    const target = m[1] ?? "";
    const alias = m[2];
    if (alias) add(alias);
    if (target) add(basename(target));
  }
  for (const m of text.matchAll(QUOTED_RE)) add(m[1] ?? "");
  for (const m of text.matchAll(CAP_RUN_RE)) {
    // Emit the full run ("Open Second Brain") and, for multi-token
    // runs, each constituent token ("open", "second", "brain") so a
    // query naming one of them still matches. Single-token runs add
    // just themselves.
    add(m[0]);
    const tokens = m[0].split(/[ \t]+/);
    if (tokens.length > 1) for (const t of tokens) add(t);
  }
  for (const m of text.matchAll(CAMEL_RE)) add(m[0]);
  for (const m of text.matchAll(ALLCAPS_OR_DIGIT_RE)) add(m[0]);

  return Object.freeze(out);
}
