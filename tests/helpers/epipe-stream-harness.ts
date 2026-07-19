/**
 * Test harness for the O1 stdout-EPIPE guard (t_2ed754d1).
 *
 * Installs the real guard and streams far more than a pipe buffer can hold, so
 * a downstream reader that closes early forces a closed-pipe write. Used only
 * by `tests/cli/stdout-epipe-guard.test.ts`; it is not part of the shipped CLI.
 */

import { installStdoutEpipeGuard } from "../../src/cli/stdout-guard.ts";

installStdoutEpipeGuard();

// ~20 MB across 100k lines: far past any pipe buffer, so a reader that closes
// early guarantees a closed-pipe write, yet small enough to finish promptly.
for (let i = 0; i < 100_000; i++) {
  process.stdout.write(`line ${i} ${"x".repeat(200)}\n`);
}
