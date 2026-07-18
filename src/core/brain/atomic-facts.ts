/**
 * Atomic-fact decomposition (t_cbd22536): turn session/turn prose into
 * discrete single-sentence assertions - deterministically, with zero
 * model calls. Markdown structure does the heavy lifting (headings
 * carry context, list items are natural assertion units) and a
 * conservative sentence splitter with an abbreviation guard handles
 * paragraphs. The same precision discipline as `fact-extract.ts`:
 * fenced/inline code, quoted lines, and frontmatter never produce
 * assertions, because a hallucinated fact pollutes memory while a
 * missed one costs nothing.
 */

import { entityMatchForms, normalizeEntityName } from "./entities/canonical.ts";

/** Cap on one assertion's text length. */
export const MAX_ASSERTION_CHARS = 300;

/** Fragments shorter than this many characters are noise, not facts. */
const MIN_ASSERTION_CHARS = 15;

export type AtomicAssertionKind = "sentence" | "list_item";

/** The slice of a registry entity the anchorer needs. */
export interface AtomicEntityLike {
  readonly id: string;
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
  readonly status: string;
}

export interface AtomicAssertion {
  /** Whitespace-collapsed assertion text, length-capped. */
  readonly text: string;
  /** 1-based line number in the original input. */
  readonly line: number;
  /** Enclosing heading texts, outermost first. */
  readonly headingPath: ReadonlyArray<string>;
  readonly kind: AtomicAssertionKind;
  /** Canonical entity ids anchored in this assertion, sorted. */
  readonly entities: ReadonlyArray<string>;
}

export interface DecomposeOptions {
  /** Registry entities to anchor against (active only). */
  readonly entities?: ReadonlyArray<AtomicEntityLike>;
}

// Abbreviations a period may follow without ending the sentence.
// Lowercased, period-free. Single letters (initials) are handled
// separately by the splitter.
const ABBREVIATIONS = new Set([
  "e.g",
  "i.e",
  "etc",
  "vs",
  "cf",
  "ca",
  "approx",
  "dr",
  "mr",
  "mrs",
  "ms",
  "prof",
  "st",
  "no",
  "fig",
  "min",
  "max",
]);

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(.+)$/;

function collapse(span: string): string {
  return span.replace(/\s+/g, " ").trim().slice(0, MAX_ASSERTION_CHARS);
}

/**
 * Split one paragraph into sentences. A boundary is `.`/`!`/`?`
 * followed by whitespace and an upper-case/digit/quote opener -
 * EXCEPT after a known abbreviation, a single-letter initial, or a
 * digit-dot-digit number (versions, decimals never contain
 * whitespace, so those survive by construction).
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    const next = text[i + 1];
    if (next === undefined) break;
    if (!/\s/.test(next)) continue;
    const after = text.slice(i + 1).trimStart();
    if (after === "" || !/^[A-Z0-9"'([]/.test(after)) continue;
    if (ch === ".") {
      // Word immediately before the period, lowercased, period-free
      // prefix kept (so "e.g" matches as written in ABBREVIATIONS).
      const before = text.slice(start, i);
      const m = /(\S+)$/.exec(before);
      const word = (m?.[1] ?? "").toLowerCase();
      if (ABBREVIATIONS.has(word) || ABBREVIATIONS.has(word.replace(/\.$/, ""))) continue;
      if (/^[a-z]$/i.test(word)) continue; // single-letter initial
    }
    out.push(text.slice(start, i + 1));
    start = i + 1;
  }
  const tail = text.slice(start);
  if (tail.trim() !== "") out.push(tail);
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

/** Minimum normalised form length that participates in substring matching. */
const MIN_ANCHOR_FORM_LENGTH = 3;

/**
 * Anchor an assertion against active registry entities, sorted ids. Labels
 * pass through the quality gate (sanitise decoration, then normalise, drop
 * structurally-invalid forms) before matching - the same shared kernel the
 * fact-extract path uses. Pure: no I/O, so a junk stored label is simply
 * skipped (the fact-extract path is the one that logs the skip).
 */
function anchorEntities(text: string, entities: ReadonlyArray<AtomicEntityLike>): string[] {
  if (entities.length === 0) return [];
  const haystack = normalizeEntityName(text);
  const ids: string[] = [];
  for (const entity of entities) {
    if (entity.status !== "active") continue;
    const forms = entityMatchForms([entity.name, ...entity.aliases]).filter(
      (f) => f.length >= MIN_ANCHOR_FORM_LENGTH,
    );
    if (forms.some((f) => haystack.includes(f))) ids.push(entity.id);
  }
  return ids.toSorted();
}

/**
 * Decompose markdown/prose text into atomic assertions. Deterministic:
 * same input and entity set, same output.
 */
export function decomposeAtomicFacts(text: string, opts: DecomposeOptions = {}): AtomicAssertion[] {
  if (!text || text.trim() === "") return [];
  const entities = opts.entities ?? [];
  const lines = text.split(/\r?\n/);

  const out: AtomicAssertion[] = [];
  // Heading stack: [level, text] pairs; path = texts in order.
  const headingStack: Array<{ level: number; text: string }> = [];
  let inFence = false;
  let inFrontmatter = false;

  const push = (raw: string, line: number, kind: AtomicAssertionKind): void => {
    const stripped = collapse(raw.replace(/`[^`\n]*`/g, " "));
    if (stripped.length < MIN_ASSERTION_CHARS) return;
    out.push(
      Object.freeze({
        text: stripped,
        line,
        headingPath: Object.freeze(headingStack.map((h) => h.text)),
        kind,
        entities: Object.freeze(anchorEntities(stripped, entities)),
      }),
    );
  };

  // Paragraph accumulator: prose lines buffer until a blank/structural
  // line, then split into sentences attributed to the paragraph start.
  let paragraph: string[] = [];
  let paragraphStart = 0;
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const joined = paragraph.join(" ");
    for (const sentence of splitSentences(joined)) {
      push(sentence, paragraphStart, "sentence");
    }
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Frontmatter: only an opening `---` on the very first line.
    if (i === 0 && trimmed === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (trimmed === "---") inFrontmatter = false;
      continue;
    }

    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      flushParagraph();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (trimmed === "") {
      flushParagraph();
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushParagraph();
      continue;
    }

    const heading = HEADING_RE.exec(trimmed);
    if (heading !== null) {
      flushParagraph();
      const level = heading[1]!.length;
      while (headingStack.length > 0 && headingStack.at(-1)!.level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, text: collapse(heading[2]!) });
      continue;
    }

    const item = LIST_ITEM_RE.exec(line);
    if (item !== null) {
      flushParagraph();
      // A multi-sentence list item still decomposes; single-sentence
      // items (the common case) survive whole.
      const sentences = splitSentences(item[1]!);
      if (sentences.length <= 1) {
        push(item[1]!, i + 1, "list_item");
      } else {
        for (const sentence of sentences) push(sentence, i + 1, "list_item");
      }
      continue;
    }

    if (paragraph.length === 0) paragraphStart = i + 1;
    paragraph.push(trimmed);
  }
  flushParagraph();

  return out;
}
