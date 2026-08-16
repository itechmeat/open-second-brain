/**
 * The one line reader every session adapter uses.
 *
 * Each adapter used to `readFileSync(path, "utf8")` and then `split("\n")`,
 * which retained the whole file twice over - once as the text, once as the
 * array of lines - before the first turn was yielded. The `iterate` contract
 * has always been `AsyncIterable<SessionTurn>`, so the laziness was there in
 * the signature and nowhere in the behaviour. This module supplies it: a
 * chunked read over Bun's file stream that never holds more than one chunk
 * plus the partial line carried across the chunk boundary.
 *
 * Line semantics match what `split("\n")` gave the adapters, deliberately:
 *
 *   - `\n` terminates a line; a `\r` immediately before it is part of the
 *     terminator, not the content (a lone `\r` mid-line is content).
 *   - A blank line in the middle is yielded as `""`.
 *   - A final line with no trailing newline is still yielded.
 *   - A trailing newline does NOT produce a phantom empty final line, which
 *     is the one place this differs from `split("\n")`. Every adapter skips
 *     blank lines, so the turns they emit - and the line numbers they derive
 *     fallback turn ids from - are unchanged.
 *   - An empty file yields nothing.
 *
 * A multi-byte character split across a chunk boundary is the case the
 * whole-file read could never hit and a naive chunked reader always gets
 * wrong; `TextDecoder`'s streaming mode holds the partial sequence instead of
 * emitting U+FFFD.
 */

import { SessionImportError } from "./types.ts";

/**
 * High-water mark, in bytes, of the largest window this module has held:
 * the chunk being scanned plus the partial line carried into it. Module-level
 * because `SessionAdapter.iterate(path)` takes only a path - there is no seam
 * to hand an observer through - and because the number worth bounding is the
 * peak across every reader alive at once, which is exactly what a shared mark
 * measures. Kept always-on: it costs one comparison per chunk, and a bound
 * that is only measured when someone remembers to ask for it is not a bound.
 */
let retainedHighWaterBytes = 0;

/** Peak retained window in bytes since the last {@link resetLineReaderRetainedBytes}. */
export function lineReaderRetainedBytes(): number {
  return retainedHighWaterBytes;
}

/** Drop the high-water mark so a measurement can start from a known zero. */
export function resetLineReaderRetainedBytes(): void {
  retainedHighWaterBytes = 0;
}

function recordWindow(chunkBytes: number, carry: string): void {
  const window = chunkBytes + Buffer.byteLength(carry, "utf8");
  if (window > retainedHighWaterBytes) retainedHighWaterBytes = window;
}

function ioError(path: string, err: unknown): SessionImportError {
  const detail = err instanceof Error ? err.message : String(err);
  return new SessionImportError(
    "IO",
    `cannot read session file ${path}: ${detail}; check the path exists and is readable`,
  );
}

/** Strip the `\r` of a `\r\n` terminator, leaving any other CR as content. */
function stripTerminatorCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Open the byte stream. Split out so the `IO` translation wraps the open and
 * nothing else — in particular never a `yield`, whose completion would
 * otherwise be caught and mislabelled as a read failure.
 */
function openReader(path: string) {
  try {
    return Bun.file(path).stream().getReader();
  } catch (err) {
    throw ioError(path, err);
  }
}

async function readChunk(reader: ReturnType<typeof openReader>, path: string) {
  try {
    return await reader.read();
  } catch (err) {
    throw ioError(path, err);
  }
}

/**
 * Yield the lines of `path` without ever materialising the file.
 *
 * Throws {@link SessionImportError} with code `IO` if the file cannot be
 * opened or read; a caller walking a directory can then report the file and
 * carry on rather than losing the whole run to a raw errno.
 */
export async function* readLines(path: string): AsyncGenerator<string> {
  const reader = openReader(path);
  const decoder = new TextDecoder("utf-8");
  let carry = "";
  try {
    for (;;) {
      // Chunk n+1 cannot be requested before chunk n is scanned — that is
      // the bound this module exists to hold.
      // oxlint-disable-next-line no-await-in-loop
      const chunk = await readChunk(reader, path);
      if (chunk.done === true || chunk.value === undefined) break;

      recordWindow(chunk.value.byteLength, carry);
      const text = carry + decoder.decode(chunk.value, { stream: true });
      // Scan by offset rather than re-slicing the remainder each time: a
      // chunk holding thousands of lines would otherwise be quadratic.
      let start = 0;
      let nl = text.indexOf("\n", start);
      while (nl >= 0) {
        yield stripTerminatorCr(text.slice(start, nl));
        start = nl + 1;
        nl = text.indexOf("\n", start);
      }
      carry = start === 0 ? text : text.slice(start);
    }
    // Flush any bytes the decoder was still holding, then the last unterminated
    // line. A file ending in `\n` leaves nothing here - no phantom empty line.
    carry += decoder.decode();
    if (carry.length > 0) yield stripTerminatorCr(carry);
  } finally {
    // Reached on normal completion AND when the consumer breaks early
    // (`readFirstLine` always does), so the file handle never outlives the
    // loop that opened it.
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * The first line of `path`, read by stopping at the first newline instead of
 * reading the file. Autodetect needs one line; it used to pay for the whole
 * file, and then the adapter read the same file a second time.
 *
 * An empty file has no first line and returns `""` - the same value
 * `split("\n")[0]` produced, and one no adapter's `detect` accepts.
 */
export async function readFirstLine(path: string): Promise<string> {
  for await (const line of readLines(path)) return line;
  return "";
}
