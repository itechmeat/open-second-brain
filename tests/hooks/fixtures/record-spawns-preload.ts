/**
 * Preload for a hook run in a child process: every background worker the
 * child starts is written to the file `RECORD_SPAWNS_TO` names (one JSON
 * argv per line) and never run, so a test can see that the dream day
 * check started its worker without a real worker outliving the test. A
 * direct `Bun.spawn` is recorded as is; a start through the launcher that
 * reparents its child (`spawnSelfDetached`, a synchronous spawn whose
 * environment carries the worker's argv) is recorded with the worker's
 * argv. Every other synchronous spawn runs. It replaces the spawns of
 * that child process only, never of the test process.
 */
import { appendFileSync } from "node:fs";

import { REPARENT_PAYLOAD_ENV } from "../../../src/core/maintenance/o2b-command.ts";

const target = process.env["RECORD_SPAWNS_TO"];
if (target !== undefined && target !== "") {
  const bun = Bun as unknown as {
    spawn: (argv: string[]) => unknown;
    spawnSync: (opts: unknown) => unknown;
  };
  bun.spawn = (argv: string[]) => {
    appendFileSync(target, `${JSON.stringify(argv)}\n`);
    return { pid: 0, unref: () => {}, exited: Promise.resolve(0) };
  };
  const spawnSync = bun.spawnSync.bind(Bun);
  bun.spawnSync = (opts: unknown) => {
    const payload = (opts as { env?: Record<string, string | undefined> } | null)?.env?.[
      REPARENT_PAYLOAD_ENV
    ];
    if (payload === undefined) return spawnSync(opts);
    const { argv } = JSON.parse(payload) as { argv: string[] };
    appendFileSync(target, `${JSON.stringify(argv)}\n`);
    return { exitCode: 0, stdout: Buffer.from("pid:0"), exitedDueToTimeout: false };
  };
}
