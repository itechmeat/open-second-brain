/**
 * Read all of stdin as UTF-8 text.
 *
 * `await Bun.stdin.text()` is the obvious spelling, and on POSIX it is
 * fine. On Windows Bun it does not keep the event loop alive while the
 * pipe drains: the CLI entry awaits `main()` through a promise chain, the
 * loop sees nothing pending, and the process exits 0 with no output before
 * the read resolves. `echo body | o2b brain capture` then "succeeded"
 * without capturing anything, and `o2b brain secret set` stored nothing -
 * a silent data loss, not a crash. Draining `Bun.stdin.stream()` through a
 * held stream reader keeps the loop alive on every platform, and returns
 * the same text.
 *
 * The read runs to completion through the stream's own async iterator,
 * which releases the stream when it ends: the CLI reads stdin once per
 * process, but a long-lived embedder (the test runner among them) shares
 * one stdin across callers, and a reader left holding the drained body
 * locks it forever - the next event-listener reader in the same process,
 * the y/N prompt, then fails with `ReadableStream is locked` instead of
 * seeing the empty pipe the drained stdin is. A second call still refuses
 * (`Bun.stdin`'s body is single-consumption), exactly as before.
 */
export async function readStdinText(): Promise<string> {
  let text = "";
  for await (const chunk of Bun.stdin.stream()) {
    text += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
  }
  return text;
}
