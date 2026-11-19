/**
 * The automatic migration worker's error output log
 * (`autoMigrationWorkerLogPath`), kept small within one run. The start
 * truncates it and hands it to the worker as its stderr, opened for
 * appending (`spawnSelfDetached`); the worker bounds it here: once it
 * passes {@link WORKER_LOG_CAP_BYTES}, it is cut to its newest whole lines
 * (at most {@link WORKER_LOG_KEEP_BYTES}). Appending writers go on at the
 * new end, so nothing is left in a hole. A line written between the read
 * and the cut can be lost: it is a diagnostic tail, not a record.
 *
 * Node builtins only, and never throws: a log that cannot be read or cut
 * is left as it is.
 */
import { closeSync, openSync, readSync, statSync, writeFileSync } from "node:fs";

/** The size past which the log is cut. */
export const WORKER_LOG_CAP_BYTES = 64 * 1024;

/** At most this much of the newest output is kept by a cut. */
export const WORKER_LOG_KEEP_BYTES = 16 * 1024;

/** How much is written between two looks at the log's size. */
const CHECK_EVERY_BYTES = 4 * 1024;

/** Cut the log at `path` to its newest whole lines when it is past the cap; whether it was cut. */
export function trimLogToTail(path: string): boolean {
  try {
    const size = statSync(path).size;
    if (size <= WORKER_LOG_CAP_BYTES) return false;
    const fd = openSync(path, "r");
    let tail: Buffer;
    try {
      tail = Buffer.alloc(WORKER_LOG_KEEP_BYTES);
      const read = readSync(fd, tail, 0, tail.length, size - tail.length);
      tail = tail.subarray(0, read);
    } finally {
      closeSync(fd);
    }
    const cut = tail.indexOf(0x0a);
    writeFileSync(path, cut === -1 ? tail : tail.subarray(cut + 1));
    return true;
  } catch {
    return false;
  }
}

/**
 * Bound the log `path` that `stream` (this process's stderr) writes to:
 * every few KiB written, the log is cut to its tail when it is past the
 * cap. Returns the undo.
 */
export function boundStderrToLog(
  stream: { write: (...args: never[]) => boolean },
  path: string,
): () => void {
  trimLogToTail(path);
  const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  let since = 0;
  const bounded = (...args: unknown[]): boolean => {
    const ok = original(...args);
    const chunk = args[0];
    since +=
      typeof chunk === "string" ? Buffer.byteLength(chunk) : ((chunk as Uint8Array)?.length ?? 0);
    if (since >= CHECK_EVERY_BYTES) {
      since = 0;
      trimLogToTail(path);
    }
    return ok;
  };
  (stream as { write: unknown }).write = bounded;
  return () => {
    (stream as { write: unknown }).write = original;
  };
}
