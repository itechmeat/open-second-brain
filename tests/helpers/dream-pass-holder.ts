/**
 * Start a separate process that holds the dream pass lock of one device
 * (`dream-pass-holder-main.ts`), for tests that need a live holder other
 * than the test process. Resolves once the child holds the lock; the
 * caller kills it or awaits its exit.
 */
import { join } from "node:path";

import type { StoreHandle } from "../../src/core/store/store-open.ts";

const MAIN = join(import.meta.dir, "dream-pass-holder-main.ts");

export async function startDreamPassHolder(
  store: StoreHandle,
  holdMs: number,
): Promise<Bun.Subprocess<"ignore", "pipe", "inherit">> {
  const handle = JSON.stringify({ ...store, partitions: [...store.partitions] });
  const proc = Bun.spawn([process.execPath, MAIN, handle, String(holdMs)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env },
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (!out.includes("held")) {
    // Reads are sequential by nature: each waits for the one before.
    // oxlint-disable-next-line no-await-in-loop
    const { value, done } = await reader.read();
    if (done) throw new Error(`the holder exited before it held the lock: ${out}`);
    out += decoder.decode(value);
  }
  reader.releaseLock();
  return proc;
}
