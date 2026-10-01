/**
 * Preload for a real `o2b mcp` process: one detached rejection, raised
 * only once the fault guard is listening.
 *
 * Spawned by `tests/cli/mcp-fault-guard-spawn.test.ts` as
 * `bun --preload <this> src/cli/main.ts mcp ...`. Product code has no
 * hook to inject a fault, so this file watches the process-global
 * `unhandledRejection` listener count from outside: when the guard that
 * `o2b mcp` installs raises it above the count seen at preload, a promise
 * is rejected with nothing awaiting it. At exit the file prints the
 * listener count again, so the test can see that the verb released the
 * guard before the process ended.
 */

/** How often the listener count is checked while waiting for the guard. */
const POLL_MS = 10;

/** Prefix of the exit line the spawned test parses. */
const EXIT_LINE_PREFIX = "fixture: unhandledRejection listeners at exit: ";

const EVENT = "unhandledRejection";
const baseline = process.listenerCount(EVENT);

const poll = setInterval(() => {
  if (process.listenerCount(EVENT) <= baseline) return;
  clearInterval(poll);
  void Promise.reject(new Error("fixture rejection inside o2b mcp"));
}, POLL_MS);
poll.unref();

process.on("exit", () => {
  process.stderr.write(EXIT_LINE_PREFIX + (process.listenerCount(EVENT) - baseline) + "\n");
});
