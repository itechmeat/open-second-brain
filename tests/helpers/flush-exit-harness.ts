/**
 * Test harness for the CLI's final flush (`exitWhenFlushed`).
 *
 * Installs the real guard, writes far more than a pipe buffer holds, and
 * exits through the real flush, so a test can put a slow, closing or full
 * reader behind it. Used only by `tests/cli/stdout-flush-on-exit.test.ts`;
 * it is not part of the shipped CLI.
 *
 * Arguments: `<exit code> [late-stderr|exit-hook|short-bound]`.
 *
 * - `late-stderr`: a line goes to stderr 200 ms after the flush began; the
 *   test's reader takes one byte first and then pauses, so stdout is still
 *   held back when the line is written.
 * - `exit-hook`: an `exit` hook writes a line to stderr as the process
 *   ends, as the exit hooks of `o2b mcp` do.
 * - `short-bound`: the flush runs with a 100 ms Windows bound, so a reader
 *   that pauses longer shows that no bound cuts the output elsewhere.
 */

import {
  exitWhenFlushed,
  installStdoutEpipeGuard,
  PROCESS_FLUSH_DEPS,
} from "../../src/cli/stdout-guard.ts";

installStdoutEpipeGuard();

const [codeArg = "0", mode] = process.argv.slice(2);
process.stdout.write("x".repeat(300_000));
if (mode === "late-stderr") {
  setTimeout(() => process.stderr.write("late stderr line\n"), 200);
}
if (mode === "exit-hook") {
  process.on("exit", () => process.stderr.write("exit hook line\n"));
}
const code = Number.parseInt(codeArg, 10);
exitWhenFlushed(code, mode === "short-bound" ? { ...PROCESS_FLUSH_DEPS, boundMs: 100 } : undefined);
