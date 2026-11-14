/**
 * Records, per test process, which test file and which test of it is
 * running right now, so a suite that stops making progress can say where.
 *
 * A test that blocks its process synchronously (a busy loop, or a runtime
 * call that never returns, like the `spawnSync` that spun forever under
 * `--isolate` before Bun 1.4.3) cannot be stopped by bun's per-test
 * timeout: the timer that would fire runs on the same thread. Under
 * `--parallel` the worker then never reports the file done and the run
 * waits on it in silence, with nothing in the log that names the file. The
 * CI wrapper `.github/scripts/test-watchdog.sh` sets
 * {@link INFLIGHT_DIR_ENV}, and when the suite outlives its bound it
 * prints these records before it stops the run.
 *
 * One small file per process (`<pid>.txt`), overwritten in place, holding
 * one line: `loading <file>`, `running <file> test #<n>` or
 * `idle after <file> test #<n>`, each with the time it was written. Off
 * unless the variable is set, so a local run writes nothing.
 */
import { afterEach, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

// The originals, taken when the preload loads and before any test runs:
// tests that spy on `fs.writeFileSync` and assert what was written must not
// see the recorder's own writes. A named import is a live binding, so it
// would follow the spy; these constants do not.
const rawMkdirSync = mkdirSync;
const rawWriteFileSync = writeFileSync;

/** Directory the records go to; recording is off when it is unset or empty. */
export const INFLIGHT_DIR_ENV = "O2B_TEST_INFLIGHT_DIR";

export function installInflightRecorder(env: NodeJS.ProcessEnv = process.env): void {
  const dir = env[INFLIGHT_DIR_ENV];
  if (dir === undefined || dir === "") return;
  try {
    rawMkdirSync(dir, { recursive: true });
  } catch {
    // A diagnostic must never fail a test; the writes below fail quietly too.
  }
  const record = join(dir, `${process.pid}.txt`);
  const write = (line: string): void => {
    try {
      rawWriteFileSync(record, `${line} (${new Date().toISOString()})\n`);
    } catch {
      // A diagnostic must never fail a test.
    }
  };
  const currentFile = (): string => relative(process.cwd(), Bun.main);

  // Under `--parallel` (which implies `--isolate`) the preload runs again
  // for every file, so this line also covers a file stuck before its
  // first test: in its imports or in a `beforeAll`.
  let file = currentFile();
  let index = 0;
  write(`loading ${file}`);

  // A serial run evaluates the preload once and these hooks see every
  // file, so the file name is re-read per test rather than kept.
  beforeEach(() => {
    const now = currentFile();
    if (now !== file) {
      file = now;
      index = 0;
    }
    index += 1;
    write(`running ${file} test #${index}`);
  });
  afterEach(() => {
    write(`idle after ${file} test #${index}`);
  });
}
