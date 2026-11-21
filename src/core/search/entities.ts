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
 * Every rule matches whole tokens only: a match starts where a run of
 * letters and digits starts. Before, a rule could start inside a token,
 * so a device id `a9dc68ab` gave `a9` and `dc68`, `UserPromptSubmit`
 * also gave `serpromptsubmit` and a timestamp's `T12` gave `t12`. On a
 * real-size brain store those fragments were a third of all entity rows,
 * and each one bridged tens of thousands of unrelated records.
 *
 * Entity matching is a re-ranking boost over already-retrieved
 * candidates, never a retrieval mechanism, so liberal extraction cannot
 * inject unrelated documents - it only nudges ordering. Output is
 * normalised (lowercased, whitespace-collapsed, deduped) and frozen.
 */

import { WIKILINK_ALIAS_RE } from "../brain/wikilink.ts";

const QUOTED_RE = /"([^"\n]{2,})"/gu;
// One or more consecutive uppercase-initial tokens (covers "Sergey" and
// "Open Second Brain"). Tokens may carry trailing letters/numbers.
const CAP_RUN_RE = /(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{N}]*(?:[ \t]+\p{Lu}[\p{L}\p{N}]*)*/gu;
// Single tokens that are notable regardless of position: CamelCase,
// ALLCAPS, or letter+digit mixes.
const CAMEL_RE = /(?<![\p{L}\p{N}])\p{Ll}+\p{Lu}[\p{L}\p{N}]*/gu;
// A whole token of letters and digits that holds both (`FTS5`, `v0`,
// `a9dc68ab`), or a whole token of two or more capitals (`API`).
//
// The leading look-behind is what keeps this linear. A match may only start
// where a token starts, so the two look-aheads scan each token once and the
// capital run backs off through one token at most; every other position
// fails on its first character. Without it, a letter run carrying no digit
// makes the engine retry every shorter prefix at every start position,
// which is quadratic per run and cubic over a document - and an unbroken
// letter run with no digits is what an ordinary Han, Thai or Lao paragraph
// IS (measured on 2160 Han characters: 11.7 s for the plain
// `\p{L}+\p{N}+`).
const ALLCAPS_OR_DIGIT_RE =
  /(?<![\p{L}\p{N}])(?:(?=[\p{L}\p{N}]*\p{L})(?=[\p{L}\p{N}]*\p{N})[\p{L}\p{N}]+|\p{Lu}{2,}(?![\p{L}\p{N}]))/gu;

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

  for (const m of text.matchAll(WIKILINK_ALIAS_RE)) {
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
