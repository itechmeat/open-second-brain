/**
 * Whether the disks a stalled CLI child depends on still answer, for the
 * failure `spawnWithLimit` (`run-cli.ts`) raises at its per-call limit.
 *
 * Every child that hung on the Windows runner did so while the runner's
 * disk queue stayed pinned at two or more with the processor idle (the
 * `windows-telemetry` artifact): the child had started, used a fraction of
 * a second of processor time and then waited on the kernel with no output.
 * A small write that is flushed to the device in each folder the child
 * reads and writes through tells a stalled disk from a stuck program, and
 * which volume stalled. The probe runs only on the failure path, never for
 * a passing call, and each folder is bounded: a write that does not answer
 * in time is reported as such and left to finish (and remove its file) in
 * the background.
 */

import { randomBytes } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** What one probe writes: one page, enough to reach the device on a flush. */
const PROBE_BYTES = 4096;

/**
 * The folders worth probing: the temp folder the fixtures live in, and on
 * Windows the user's own temp folder on the system volume, and the
 * runner's temp folder, so a stall on either volume is named when the job
 * moved `TEMP` off the system volume.
 */
export function stallProbeDirs(): string[] {
  const dirs = [tmpdir()];
  // The suite points `LOCALAPPDATA` into its own temp root
  // (`tests/setup.ts`), so the user's temp folder on the system volume is
  // found from the profile itself.
  if (process.platform === "win32") dirs.push(join(homedir(), "AppData", "Local", "Temp"));
  const runnerTemp = process.env["RUNNER_TEMP"];
  if (runnerTemp !== undefined && runnerTemp !== "") dirs.push(runnerTemp);
  return dirs;
}

/** Writes one page to a fresh file in `dir`, flushes it to the device and removes it. */
async function writeAndFlush(dir: string): Promise<void> {
  const file = join(dir, `o2b-disk-probe-${process.pid}-${randomBytes(4).toString("hex")}`);
  const handle = await open(file, "wx");
  try {
    await handle.write(Buffer.alloc(PROBE_BYTES, 0x2e), 0, PROBE_BYTES, 0);
    await handle.sync();
  } finally {
    await handle.close();
    await rm(file, { force: true });
  }
}

/**
 * One line per distinct folder:
 * `disk at the limit (<dir>): write and flush <ms> ms`, `no answer after
 * <ms> ms` or `failed: <reason>`. Never throws, and returns within about
 * `limitMs` whatever the disks do.
 */
export async function diskProbeLines(
  dirs: ReadonlyArray<string>,
  limitMs: number,
): Promise<string[]> {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const dir of dirs) {
    const key = process.platform === "win32" ? resolve(dir).toLowerCase() : resolve(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(dir);
  }
  return await Promise.all(
    unique.map(async (dir) => {
      const head = `disk at the limit (${dir}): `;
      const startedAt = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const write = writeAndFlush(dir).then(
        () => `write and flush ${Date.now() - startedAt} ms`,
        (err: unknown) => `failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      const cap = new Promise<string>((done) => {
        timer = setTimeout(() => done(`no answer after ${limitMs} ms`), limitMs);
      });
      try {
        return head + (await Promise.race([write, cap]));
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}
