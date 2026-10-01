/**
 * A served stdio transport that suffers one detached promise rejection.
 *
 * Spawned by `tests/cli/mcp-fault-guard-spawn.test.ts`. The guard is
 * installed exactly as `o2b mcp` installs it; once the loop is live a
 * promise is rejected with nothing awaiting it. Without the guard the
 * runtime default ends the process there; with it, the server must go on
 * answering and exit 0 on EOF.
 *
 * argv: <vault>
 */

import { installMcpFaultGuard } from "../../../src/cli/mcp-fault-guard.ts";
import { serveStdio } from "../../../src/mcp/stdio.ts";

const vault = process.argv[2];
if (vault === undefined) throw new Error("usage: serve-with-rejection.ts <vault>");

const guard = installMcpFaultGuard();
try {
  process.exitCode = await serveStdio(
    { vault },
    {
      onStart: () => {
        void Promise.reject(new Error("fixture rejection nobody awaits"));
      },
    },
  );
} finally {
  guard.release();
}
