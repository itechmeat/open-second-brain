/**
 * The processes one test started, found by a mark in their environment.
 *
 * A detached child of a child (a session start's migration worker, its
 * index rebuild, a removal worker) is no child of the test process: the
 * test cannot wait on it, and once the process that spawned it has exited
 * nothing in the test's own process tree names it. Its environment does.
 * A test puts {@link PROCESS_MARK_ENV} into the environment of every
 * process it starts, and each of them hands it on: the product starts its
 * background children with its own live environment
 * (`spawnSelfDetached`), so the whole tree carries it, detached ones too.
 * The mark is found by value, never by a process name.
 *
 * Linux shows each process's environment at its start in
 * `/proc/<pid>/environ`, readable for the processes of the same user, and
 * the suite's guard against temp entries that outlive their test fails
 * the run on POSIX only (`tests/setup.ts`). Elsewhere no process is found
 * and the wait ends at once, as before.
 */
import { readdirSync, readFileSync } from "node:fs";

/** The environment variable whose value marks the processes of one test. */
export const PROCESS_MARK_ENV = "O2B_TEST_PROCESS_MARK";

/** How often the process table is read again while a marked process lives. */
const LOOK_EVERY_MS = 20;

export interface MarkedProcess {
  readonly pid: number;
  readonly command: string;
}

/** Every live process whose environment carries `mark`. */
export function markedProcesses(mark: string): MarkedProcess[] {
  if (process.platform !== "linux") return [];
  const entry = `${PROCESS_MARK_ENV}=${mark}`;
  const found: MarkedProcess[] = [];
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return [];
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let environ: string;
    try {
      // A process that ended (a zombie included) reads empty or not at all.
      environ = readFileSync(`/proc/${name}/environ`, "latin1");
    } catch {
      continue;
    }
    if (!environ.split("\0").includes(entry)) continue;
    let command = "";
    try {
      command = readFileSync(`/proc/${name}/cmdline`, "latin1").split("\0").join(" ").trim();
    } catch {
      // gone in between: still listed, the next look drops it
    }
    found.push({ pid: Number(name), command });
  }
  return found;
}

/**
 * Resolve once no process carrying `mark` is alive; reject at the deadline,
 * naming the ones left. No event tells this process that a process which
 * is not its child has ended, so the table is read again every
 * {@link LOOK_EVERY_MS} until that holds: the wait ends on the condition,
 * never after a set time.
 */
export function markedProcessesEnded(mark: string, deadlineMs: number): Promise<void> {
  const until = Date.now() + deadlineMs;
  return new Promise((resolveEnded, reject) => {
    const look = (): void => {
      const left = markedProcesses(mark);
      if (left.length === 0) {
        resolveEnded();
        return;
      }
      if (Date.now() >= until) {
        const named = left.map((p) => `${p.pid} (${p.command})`).join(", ");
        reject(new Error(`processes this test started are still running: ${named}`));
        return;
      }
      setTimeout(look, LOOK_EVERY_MS);
    };
    look();
  });
}
