/**
 * Child process for the drained-writers migration test: writes signals in
 * a loop until the vault's freeze refuses one, appending one JSON line per
 * write to `outFile`, and touches `readyFile` after its first write. A hard
 * time budget ends the loop if no refusal ever comes.
 *
 * The rows go to a file, not stdout: the parent runs the migration
 * synchronously and reads nothing meanwhile, so a pipe could fill and
 * block this writer for the whole migration window.
 *
 * argv: <vault> <name> <readyFile> <outFile>
 */
import { appendFileSync, writeFileSync } from "node:fs";

import { MigrationInProgressError } from "../../../../src/core/migration-gate.ts";
import { writeSignal } from "../../../../src/core/brain/signal.ts";

const [vault, name, readyFile, outFile] = process.argv.slice(2) as [string, string, string, string];
const emit = (row: unknown): void => appendFileSync(outFile, `${JSON.stringify(row)}\n`);
const deadline = Date.now() + 60_000;
const pause = new Int32Array(new SharedArrayBuffer(4));
for (let i = 0; Date.now() < deadline; i++) {
  try {
    const result = writeSignal(vault, {
      topic: `drain-${name}`,
      signal: "positive",
      agent: `@${name}`,
      principle: `Write ${i} of ${name}`,
      created_at: "2026-11-06T10:00:00Z",
      date: "2026-11-06",
      slug: `${name}-${i}`,
    });
    emit({ ok: result.path });
    if (i === 0) writeFileSync(readyFile, "ready");
  } catch (error) {
    if (error instanceof MigrationInProgressError) {
      emit({ refused: true });
      process.exit(0);
    }
    emit({ error: String(error) });
    process.exit(1);
  }
  Atomics.wait(pause, 0, 0, 5);
}
process.exit(2);
