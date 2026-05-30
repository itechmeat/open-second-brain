const HAN_RE = /\p{Script=Han}/u;
const HIRAGANA_RE = /\p{Script=Hiragana}/u;
const KATAKANA_RE = /\p{Script=Katakana}/u;
const HANGUL_RE = /\p{Script=Hangul}/u;
const LATINISH_RE = /[\p{L}\p{N}_-]/u;

let jiebaCut: ((text: string) => string[]) | null | undefined;
let tinySegment: ((text: string) => string[]) | null | undefined;

export function containsCjk(text: string): boolean {
  for (const char of text) {
    if (isCjk(char)) return true;
  }
  return false;
}

export function tokenizeCjkSearchText(text: string): string[] {
  const primaryTokens: string[] = [];
  const fallbackTokens: string[] = [];
  let index = 0;
  while (index < text.length) {
    const char = charAt(text, index);
    const kind = cjkKind(char);
    if (kind !== null) {
      const start = index;
      index += char.length;
      while (index < text.length) {
        const next = charAt(text, index);
        if (cjkKind(next) !== kind) break;
        index += next.length;
      }
      const segmented = segmentCjkRun(text.slice(start, index), kind);
      primaryTokens.push(...segmented.primary);
      fallbackTokens.push(...segmented.fallback);
      continue;
    }

    if (LATINISH_RE.test(char) && !isCjk(char)) {
      const start = index;
      index += char.length;
      while (index < text.length) {
        const next = charAt(text, index);
        if (!LATINISH_RE.test(next) || isCjk(next)) break;
        index += next.length;
      }
      const token = text.slice(start, index).trim();
      if (token.length > 0) primaryTokens.push(token);
      continue;
    }

    index += char.length;
  }
  return unique([...primaryTokens, ...fallbackTokens]);
}

export function expandTextForCjkFts(text: string): string {
  if (!containsCjk(text)) return text;
  const tokens = tokenizeCjkSearchText(text);
  if (tokens.length === 0) return text;
  return `${text}\n${tokens.join(" ")}`;
}

function segmentCjkRun(run: string, kind: CjkKind): CjkSegmentedRun {
  if (kind === "han") {
    const cut = loadJiebaCut();
    if (cut) return withFallbackTokens(run, cut(run), 2);
  }
  if (kind === "kana") {
    const segment = loadTinySegmenter();
    if (segment) return withFallbackTokens(run, segment(run), 2);
  }
  const fallback = fallbackCjkTokens(run, kind === "hangul" ? 1 : 2);
  return { primary: fallback.primary, fallback: fallback.fallback };
}

function withFallbackTokens(
  run: string,
  segmented: ReadonlyArray<string>,
  ngramSize: number,
): CjkSegmentedRun {
  const clean = segmented.map((token) => token.trim()).filter((token) => token.length > 0);
  const fallback = fallbackCjkTokens(run, ngramSize);
  return {
    primary: unique([...clean, ...fallback.primary]),
    fallback: fallback.fallback,
  };
}

function fallbackCjkTokens(run: string, ngramSize: number): CjkSegmentedRun {
  const chars = Array.from(run).filter((char) => isCjk(char));
  const primary: string[] = [];
  if (ngramSize > 1 && chars.length >= ngramSize) {
    for (let index = 0; index <= chars.length - ngramSize; index++) {
      primary.push(chars.slice(index, index + ngramSize).join(""));
    }
  }
  if (primary.length === 0) primary.push(...chars);
  return { primary: unique(primary), fallback: unique(chars) };
}

function loadJiebaCut(): ((text: string) => string[]) | null {
  if (jiebaCut !== undefined) return jiebaCut;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@node-rs/jieba") as {
      cut?: (text: string) => string[];
      default?: { cut?: (text: string) => string[] };
    };
    jiebaCut = mod.cut ?? mod.default?.cut ?? null;
  } catch {
    jiebaCut = null;
  }
  return jiebaCut;
}

function loadTinySegmenter(): ((text: string) => string[]) | null {
  if (tinySegment !== undefined) return tinySegment;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("tiny-segmenter") as {
      new (): { segment(text: string): string[] };
      default?: new () => { segment(text: string): string[] };
    };
    const Segmenter = mod.default ?? mod;
    const segmenter = new Segmenter();
    tinySegment = (text: string) => segmenter.segment(text);
  } catch {
    tinySegment = null;
  }
  return tinySegment;
}

type CjkKind = "han" | "kana" | "hangul";

interface CjkSegmentedRun {
  readonly primary: ReadonlyArray<string>;
  readonly fallback: ReadonlyArray<string>;
}

function cjkKind(char: string): CjkKind | null {
  if (HAN_RE.test(char)) return "han";
  if (HIRAGANA_RE.test(char) || KATAKANA_RE.test(char)) return "kana";
  if (HANGUL_RE.test(char)) return "hangul";
  return null;
}

function isCjk(char: string): boolean {
  return cjkKind(char) !== null;
}

function charAt(text: string, index: number): string {
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
}

function unique(tokens: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}
