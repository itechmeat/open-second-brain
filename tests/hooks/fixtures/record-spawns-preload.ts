/**
 * Preload for a hook run in a child process: every `Bun.spawn` the child
 * makes is written to the file `RECORD_SPAWNS_TO` names (one JSON argv per
 * line) and never run, so a test can see that the dream day check started
 * its worker without a real worker outliving the test. It replaces the
 * spawn of that child process only, never of the test process.
 */
import { appendFileSync } from "node:fs";

const target = process.env["RECORD_SPAWNS_TO"];
if (target !== undefined && target !== "") {
  (Bun as unknown as { spawn: (argv: string[]) => unknown }).spawn = (argv: string[]) => {
    appendFileSync(target, `${JSON.stringify(argv)}\n`);
    return { pid: 0, unref: () => {}, exited: Promise.resolve(0) };
  };
}
