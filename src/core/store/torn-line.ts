/**
 * Recognise a line torn by a crash (FORMAT.md, "Reading"; `appender.ts`
 * step 4): an append the writer never finished leaves a fragment of a
 * record line, and the device's next append closes it with a newline, so
 * the fragment becomes one bad line in the middle of the shard.
 *
 * Such a fragment is a strict prefix of a JSON object: every byte of it
 * fits the JSON grammar and only the end is missing. A record the writer
 * finished and that later changed (a flipped byte, a bad checksum, a
 * line a peer or a person replaced) is not: it is complete JSON, or it
 * breaks the grammar before its end. The torn fragment was never a record
 * any machine read, so a reader that must not miss a record can leave it
 * out; every other bad line hides a record that may matter.
 */

type Expect =
  | "value"
  | "key-or-close" // just after `{`
  | "key" // after `,` in an object
  | "colon"
  | "comma-or-close-object"
  | "value-or-close" // just after `[`
  | "comma-or-close-array"
  | "end";

const LITERALS = ["true", "false", "null"] as const;
const WHITESPACE = new Set([" ", "\t", "\r", "\n"]);
const NUMBER_CHARS = /[0-9+\-.eE]/;
const HEX = /[0-9a-fA-F]/;

/**
 * Whether `text` is a JSON object cut short: it starts an object, breaks
 * no grammar rule, and ends before the object closes. Complete JSON and
 * anything that is not a prefix of an object answer `false`.
 */
export function isTornObjectPrefix(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{")) return false;
  const stack: Array<"o" | "a"> = [];
  let expect = "value" as Expect;
  let i = 0;
  const afterValue = (): void => {
    const top = stack.at(-1);
    expect =
      top === undefined ? "end" : top === "o" ? "comma-or-close-object" : "comma-or-close-array";
  };
  while (i < trimmed.length) {
    const c = trimmed[i]!;
    if (WHITESPACE.has(c)) {
      i += 1;
      continue;
    }
    if (expect === "end") return false;
    if (expect === "colon") {
      if (c !== ":") return false;
      expect = "value";
      i += 1;
      continue;
    }
    if (expect === "comma-or-close-object" || expect === "comma-or-close-array") {
      const close = expect === "comma-or-close-object" ? "}" : "]";
      if (c === ",") expect = expect === "comma-or-close-object" ? "key" : "value";
      else if (c === close) {
        stack.pop();
        afterValue();
      } else return false;
      i += 1;
      continue;
    }
    if (expect === "key-or-close" && c === "}") {
      stack.pop();
      afterValue();
      i += 1;
      continue;
    }
    if (expect === "value-or-close" && c === "]") {
      stack.pop();
      afterValue();
      i += 1;
      continue;
    }
    const keyPosition = expect === "key" || expect === "key-or-close";
    if (c === '"') {
      // A string: escapes are checked, an unclosed one is a cut end.
      i += 1;
      let closed = false;
      while (i < trimmed.length) {
        const s = trimmed[i]!;
        if (s === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (s < " ") return false;
        if (s === "\\") {
          const e = trimmed[i + 1];
          if (e === undefined) return true;
          if (e === "u") {
            for (let k = 2; k < 6; k += 1) {
              const h = trimmed[i + k];
              if (h === undefined) return true;
              if (!HEX.test(h)) return false;
            }
            i += 6;
            continue;
          }
          if (!'"\\/bfnrt'.includes(e)) return false;
          i += 2;
          continue;
        }
        i += 1;
      }
      if (!closed) return true;
      if (keyPosition) expect = "colon";
      else afterValue();
      continue;
    }
    if (keyPosition) return false;
    if (c === "{") {
      stack.push("o");
      expect = "key-or-close";
      i += 1;
      continue;
    }
    if (c === "[") {
      stack.push("a");
      expect = "value-or-close";
      i += 1;
      continue;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      let j = i;
      while (j < trimmed.length && NUMBER_CHARS.test(trimmed[j]!)) j += 1;
      const run = trimmed.slice(i, j);
      if (j === trimmed.length) return /^-?(\d+(\.\d*)?([eE][+-]?\d*)?)?$/.test(run);
      if (!/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(run)) return false;
      i = j;
      afterValue();
      continue;
    }
    const literal = LITERALS.find((word) => word.startsWith(c));
    if (literal === undefined) return false;
    const rest = trimmed.slice(i, i + literal.length);
    if (!literal.startsWith(rest)) return false;
    if (rest.length < literal.length) return i + rest.length === trimmed.length;
    i += literal.length;
    afterValue();
  }
  // Every byte fit and the object is still open: the end was cut off.
  return stack.length > 0;
}
