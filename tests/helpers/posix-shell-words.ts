/**
 * Split one POSIX shell command line back into its words, for the subset
 * the operator-facing echoes emit: bare words and single-quoted strings
 * with the `'\'` + `'` quote escape. This is the parse side of the
 * shell-word round-trip the echoes promise - a command an operator (or
 * an agent) pastes back must yield the arguments that were previewed.
 *
 * Deliberately NOT a general shell parser: no double quotes, no `$`
 * expansion, no globs - the echoes never emit those forms, and a word
 * using them here would read as the literal characters a bare word
 * carries.
 */
export function splitPosixShellWords(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === "'") {
      // A quoted span: scan to the closing quote, treating the
      // close-backslash-quote-quote run as an escaped quote that
      // reopens the span.
      inWord = true;
      let j = i + 1;
      for (;;) {
        const close = line.indexOf("'", j);
        if (close < 0) throw new Error("unterminated single quote");
        word += line.slice(j, close);
        if (line[close + 1] === "\\" && line[close + 2] === "'" && line[close + 3] === "'") {
          word += "'";
          j = close + 4;
          continue;
        }
        i = close + 1;
        break;
      }
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (inWord) {
        words.push(word);
        word = "";
        inWord = false;
      }
      i += 1;
      continue;
    }
    inWord = true;
    word += ch;
    i += 1;
  }
  if (inWord) words.push(word);
  return words;
}
