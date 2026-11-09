/**
 * One writer of the two-process create-once test. Once loaded it touches
 * `<barrier>/<label>.ready`, polls every millisecond until the parent
 * creates `<barrier>/go` (released only when both writers are ready, so
 * neither can finish before the other starts; the sleep between polls
 * leaves the parent the CPU it needs to open the gate on a small runner), then creates one lane entry exclusively and prints
 * `created`, or `exists` with the error code the refusal carries. A hard
 * time budget ends the wait if the barrier never opens.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { writeLaneText } from "../../../../src/core/store/lane-pages.ts";

const [vault, path, barrier, label] = process.argv.slice(2) as [string, string, string, string];
writeFileSync(join(barrier, `${label}.ready`), "ready");
const go = join(barrier, "go");
const deadline = Date.now() + 30_000;
while (!existsSync(go)) {
  if (Date.now() > deadline) {
    process.stdout.write("barrier timeout\n");
    process.exit(2);
  }
  Bun.sleepSync(1);
}
try {
  writeLaneText(vault, path, `---\nkind: x\nwriter: ${label}\n---\nBody.\n`, { exclusive: true });
  process.stdout.write("created\n");
} catch (err) {
  process.stdout.write(`exists ${(err as NodeJS.ErrnoException).code ?? "?"}\n`);
}
