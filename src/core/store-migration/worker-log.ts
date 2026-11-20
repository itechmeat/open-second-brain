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
import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";

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

// ----- Attempts ---------------------------------------------------------

/**
 * How many attempts the log keeps: the new one and the ones before it. A
 * start that spawns a worker after a killed one (kill -9, a crash) keeps
 * what the killed run wrote instead of truncating it.
 */
export const WORKER_LOG_ATTEMPTS_KEPT = 3;

/** The start of the line that opens one attempt's part of the log. */
export const WORKER_LOG_ATTEMPT_PREFIX = "===== attempt ";

/** The line that opens a new attempt's part of the log. */
export function workerLogAttemptHeader(now: Date, detail: string): string {
  return `${WORKER_LOG_ATTEMPT_PREFIX}${now.toISOString()} ${detail} =====`;
}

/** The text of the log split into attempts: each part starts at its header (the first may have none). */
function attempts(text: string): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith(WORKER_LOG_ATTEMPT_PREFIX) && current.length > 0) {
      parts.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.some((l) => l !== "")) parts.push(current.join("\n"));
  return parts.filter((p) => p.trim() !== "");
}

/**
 * Open a new attempt in the log at `path`: what is there is cut to its
 * tail when it passed the cap, only the last
 * `WORKER_LOG_ATTEMPTS_KEPT - 1` attempts are kept, and `header` is
 * appended. Never throws: a log that cannot be read is started anew, one
 * that cannot be written is left to the spawn's own open.
 */
export function beginWorkerLogAttempt(path: string, header: string): void {
  try {
    trimLogToTail(path);
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      text = "";
    }
    const kept = attempts(text).slice(-(WORKER_LOG_ATTEMPTS_KEPT - 1));
    const body = kept.map((p) => (p.endsWith("\n") ? p : `${p}\n`)).join("");
    writeFileSync(path, `${body}${header}\n`);
  } catch {
    // left to the spawn's own open
  }
}

/** The part of the log the latest attempt wrote: everything after its header line. */
export function latestWorkerLogAttempt(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.startsWith(WORKER_LOG_ATTEMPT_PREFIX)) return lines.slice(i + 1).join("\n");
  }
  return text;
}
