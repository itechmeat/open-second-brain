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
 * `Response` holds a live stream reader, which keeps the loop alive on
 * every platform, and returns the same text.
 */
export async function readStdinText(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}
