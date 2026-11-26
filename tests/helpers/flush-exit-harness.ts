/**
 * Test harness for the CLI's final flush (`exitWhenFlushed`).
 *
 * Installs the real guard, writes far more than a pipe buffer holds, and
 * exits through the real flush, so a test can put a slow, closing or full
 * reader behind it. Used only by `tests/cli/stdout-flush-on-exit.test.ts`;
 * it is not part of the shipped CLI.
 *
 * Arguments: `<exit code> [late-stderr|exit-hook]`. With `late-stderr`, a
 * line goes to stderr 200 ms after the flush began, while a slow reader
 * still holds stdout back. With `exit-hook`, an `exit` hook writes a line
 * to stderr as the process ends, as the exit hooks of `o2b mcp` do.
 */

import { exitWhenFlushed, installStdoutEpipeGuard } from "../../src/cli/stdout-guard.ts";

installStdoutEpipeGuard();

const [codeArg = "0", mode] = process.argv.slice(2);
process.stdout.write("x".repeat(300_000));
if (mode === "late-stderr") {
  setTimeout(() => process.stderr.write("late stderr line\n"), 200);
}
if (mode === "exit-hook") {
  process.on("exit", () => process.stderr.write("exit hook line\n"));
}
exitWhenFlushed(Number.parseInt(codeArg, 10));
