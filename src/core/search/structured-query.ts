import {
  SearchError,
  type QueryIntent,
  type StructuredLexLane,
  type StructuredRecallQueryDocument,
} from "./types.ts";

const ALLOWED_INTENTS = new Set<QueryIntent>(["neutral", "exact", "entity", "broad"]);
const ALLOWED_LANES = new Set(["intent", "lex", "vec", "hyde"]);

function invalid(lineNumber: number, message: string): SearchError {
  return new SearchError("INVALID_INPUT", `structured query line ${lineNumber}: ${message}`);
}

function readQuoted(
  value: string,
  lineNumber: number,
  start: number,
): { text: string; next: number } {
  let charIndex = start + 1;
  let text = "";
  while (charIndex < value.length) {
    const char = value[charIndex]!;
    if (char === '"') return { text, next: charIndex + 1 };
    text += char;
    charIndex++;
  }
  throw invalid(lineNumber, "unterminated quoted lex token");
}

function readBare(value: string, start: number): { text: string; next: number } {
  let charIndex = start;
  while (charIndex < value.length && !/\s/u.test(value[charIndex]!)) charIndex++;
  return { text: value.slice(start, charIndex), next: charIndex };
}

function parseLexLane(value: string, lineNumber: number): StructuredLexLane {
  const include: string[] = [];
  const exclude: string[] = [];
  let charIndex = 0;

  while (charIndex < value.length) {
    while (charIndex < value.length && /\s/u.test(value[charIndex]!)) charIndex++;
    if (charIndex >= value.length) break;

    let negated = false;
    if (value[charIndex] === "-") {
      negated = true;
      charIndex++;
      if (charIndex >= value.length || /\s/u.test(value[charIndex]!)) {
        throw invalid(lineNumber, "negation must be followed by a lex token");
      }
    }

    const token =
      value[charIndex] === '"'
        ? readQuoted(value, lineNumber, charIndex)
        : readBare(value, charIndex);
    const text = token.text.trim();
    if (text.length === 0) throw invalid(lineNumber, "empty lex token");
    if (negated) exclude.push(text);
    else include.push(text);
    charIndex = token.next;
  }

  if (include.length === 0 && exclude.length === 0) {
    throw invalid(lineNumber, "lex lane must not be empty");
  }
  return Object.freeze({
    include: Object.freeze(include),
    exclude: Object.freeze(exclude),
  });
}

export function parseStructuredRecallQueryDocument(
  document: string,
): StructuredRecallQueryDocument {
  let intent: QueryIntent | null = null;
  const lexInclude: string[] = [];
  const lexExclude: string[] = [];
  const vec: string[] = [];
  const hyde: string[] = [];

  const lines = document.split(/\r?\n/u);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const lineNumber = lineIndex + 1;
    const line = lines[lineIndex]!.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const separator = line.indexOf(":");
    if (separator <= 0) throw invalid(lineNumber, "expected '<lane>: <value>'");
    const lane = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!ALLOWED_LANES.has(lane)) throw invalid(lineNumber, `unknown lane '${lane}'`);
    if (value.length === 0) throw invalid(lineNumber, `${lane} lane must not be empty`);

    if (lane === "intent") {
      if (intent !== null) throw invalid(lineNumber, "intent lane must not be repeated");
      if (!ALLOWED_INTENTS.has(value as QueryIntent)) {
        throw invalid(lineNumber, `intent must be neutral, exact, entity, or broad`);
      }
      intent = value as QueryIntent;
    } else if (lane === "lex") {
      const parsed = parseLexLane(value, lineNumber);
      lexInclude.push(...parsed.include);
      lexExclude.push(...parsed.exclude);
    } else if (lane === "vec") {
      vec.push(value);
    } else {
      hyde.push(value);
    }
  }

  if (
    intent === null &&
    lexInclude.length === 0 &&
    lexExclude.length === 0 &&
    vec.length === 0 &&
    hyde.length === 0
  ) {
    throw new SearchError(
      "INVALID_INPUT",
      "structured query document must contain at least one lane",
    );
  }

  return Object.freeze({
    intent,
    lex: Object.freeze({
      include: Object.freeze(lexInclude),
      exclude: Object.freeze(lexExclude),
    }),
    vec: Object.freeze(vec),
    hyde: Object.freeze(hyde),
  });
}

export function structuredRecallQueryText(document: StructuredRecallQueryDocument): string {
  return [...document.lex.include, ...document.vec, ...document.hyde].join(" ").trim();
}
