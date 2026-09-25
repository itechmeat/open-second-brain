/**
 * A fixed, deterministic corpus of space-separated markdown notes for
 * chunker regression tests. Generated from a seeded PRNG, so the text is
 * identical on every machine and every run: the chunker's output over it
 * can be pinned by digest.
 *
 * The notes cover every block kind the chunker distinguishes (frontmatter,
 * headings, paragraphs, lists, tables, fenced code) and are long enough to
 * produce several chunks with overlap. Lines stay short (at most ~18
 * words), which is what real prose notes look like.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "index",
  "vault",
  "search",
  "note",
  "chunk",
  "token",
  "budget",
  "overlap",
  "heading",
  "paragraph",
  "embedding",
  "vector",
  "query",
  "rank",
  "graph",
  "link",
  "memory",
  "agent",
  "brain",
  "signal",
  "preference",
  "review",
  "the",
  "a",
  "of",
  "and",
  "to",
  "in",
  "is",
  "with",
  "for",
  "on",
  "that",
  "stable",
  "boundary",
  "rebuild",
  "window",
  "provider",
  "request",
  "limit",
  "Café",
  "naïve",
  "résumé",
  "Привет",
  "emoji🙂",
  "don't",
  "x=1;",
  "`code`",
];

function pick<T>(rand: () => number, xs: ReadonlyArray<T>): T {
  return xs[Math.floor(rand() * xs.length)]!;
}

function sentence(rand: () => number, min: number, max: number): string {
  const n = min + Math.floor(rand() * (max - min + 1));
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(pick(rand, WORDS));
  return out.join(" ") + ".";
}

function paragraph(rand: () => number): string {
  const lines = 1 + Math.floor(rand() * 6);
  const out: string[] = [];
  for (let i = 0; i < lines; i++) out.push(sentence(rand, 4, 18));
  return out.join("\n");
}

function note(rand: () => number, index: number): string {
  const parts: string[] = [];
  if (index % 2 === 0) {
    parts.push(`---\ntitle: Note ${index}\ntags:\n  - corpus\n  - n${index}\n---`);
  }
  parts.push(`# Note ${index}`);
  const sections = 2 + Math.floor(rand() * 6);
  for (let s = 0; s < sections; s++) {
    parts.push(`## Section ${s} ${pick(rand, WORDS)}`);
    const blocks = 2 + Math.floor(rand() * 8);
    for (let b = 0; b < blocks; b++) {
      const kind = rand();
      if (kind < 0.6) {
        parts.push(paragraph(rand));
      } else if (kind < 0.75) {
        const items = 2 + Math.floor(rand() * 6);
        const list: string[] = [];
        for (let i = 0; i < items; i++) list.push(`- ${sentence(rand, 2, 10)}`);
        parts.push(list.join("\n"));
      } else if (kind < 0.85) {
        const rows = 2 + Math.floor(rand() * 5);
        const table = ["| key | value |", "|---|---|"];
        for (let i = 0; i < rows; i++)
          table.push(`| ${pick(rand, WORDS)} | ${sentence(rand, 1, 5)} |`);
        parts.push(table.join("\n"));
      } else {
        const lines = 2 + Math.floor(rand() * 12);
        const code = ["```ts"];
        for (let i = 0; i < lines; i++) code.push(`const v${i} = "${sentence(rand, 1, 6)}";`);
        code.push("```");
        parts.push(code.join("\n"));
      }
    }
  }
  return parts.join("\n\n") + "\n";
}

/** The fixed corpus: `count` notes from `seed`. Same arguments, same text. */
export function spaceSeparatedCorpus(seed = 186, count = 24): ReadonlyArray<string> {
  const rand = mulberry32(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(note(rand, i));
  return out;
}

/** Option sets the regression digest is pinned under. */
export const CORPUS_OPTION_SETS = [
  { maxTokens: 800, minTokens: 100, overlapTokens: 100 },
  { maxTokens: 200, minTokens: 50, overlapTokens: 20 },
  { maxTokens: 120, minTokens: 30, overlapTokens: 0 },
] as const;
