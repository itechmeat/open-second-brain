/**
 * Child process for the concurrent-removal test: touches `<outFile>.ready`
 * once loaded, waits for a start file, so two racers begin at the same
 * moment, then removes the legacy tree of
 * `vault` with `--force` and writes what happened as one JSON object to
 * `outFile`: `{ removed, archive? }`, or `{ error, message }` when the
 * removal refused or failed. A hard time budget ends the wait.
 *
 * argv: <vault> <goFile> <outFile>
 * The environment (store root, state, device id, config) is the parent's.
 */
import { existsSync, writeFileSync } from "node:fs";

import { removeLegacy } from "../../../../src/core/store-migration/outcome.ts";

const [vault, goFile, outFile] = process.argv.slice(2) as [string, string, string];
const pause = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 30_000;
writeFileSync(`${outFile}.ready`, "ready");
while (!existsSync(goFile)) {
  if (Date.now() > deadline) process.exit(2);
  Atomics.wait(pause, 0, 0, 1);
}
try {
  const result = removeLegacy(vault, { force: true });
  writeFileSync(
    outFile,
    JSON.stringify({ removed: result.removed, archive: result.removed ? result.archive : null }),
  );
} catch (error) {
  const e = error as Error;
  writeFileSync(outFile, JSON.stringify({ error: e.name, message: e.message }));
}
