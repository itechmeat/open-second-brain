/**
 * Test helper: ask a question in a fresh `bun` process.
 *
 * Some answers are remembered per process (the store-only predicate keeps
 * the switches it has seen, so a switched machine reads its store once).
 * A test of what the NEXT process answers (from the switch record, or from
 * the sticky device-local marker when the store cannot be read) must not
 * be answered by this process's memory, and production code offers no
 * reset for it. So the question runs in a child with this process's
 * environment. A cold start costs a few hundred milliseconds: keep these
 * few.
 */
import { join } from "node:path";

const STORE_ONLY = join(import.meta.dir, "..", "..", "src", "core", "store", "store-only.ts");

/** `storeOnlyMode({ vault })` as a fresh process on this machine answers it. */
export function storeOnlyModeInFreshProcess(vault: string | null): {
  storeOnly: boolean;
  reason: string;
} {
  const code =
    `import { storeOnlyMode } from ${JSON.stringify(STORE_ONLY)};\n` +
    `const m = storeOnlyMode({ vault: ${JSON.stringify(vault)} });\n` +
    `console.log("answer=" + JSON.stringify({ storeOnly: m.storeOnly, reason: m.reason }));\n`;
  const child = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const match = /answer=(\{.*\})/.exec(child.stdout.toString());
  if (match === null) throw new Error(`fresh process failed: ${child.stderr.toString()}`);
  return JSON.parse(match[1]!) as { storeOnly: boolean; reason: string };
}
