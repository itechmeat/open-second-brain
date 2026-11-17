import { OS_PROBE_LIMIT_MS } from "./windows-process-probe.ts";

/**
 * The per-test budget for a test FILE whose tests drive the real `o2b`
 * command line, applied with `setDefaultTimeout(CLI_SPAWN_BUDGET_MS)` at the
 * top of that file.
 *
 * bun's default is 5 s per test. That is a budget for a unit test, not for a
 * test that boots the CLI: a single `o2b doctor` costs several seconds on a
 * loaded machine, and none of that cost belongs to the assertion - it is
 * process start, the import graph, and the external probes the command runs.
 * Tests that pay it passed only when the machine happened to be idle, so the
 * suite's verdict was a function of what else the machine was doing. That is
 * the same defect 1.45.1 fixed for a leaked config env and 1.47.0 fixed for a
 * pair of readiness tests that spawned twice; the predicate is simply wider
 * than "spawns twice".
 *
 * The number is one budget rather than a per-test guess. It is measured, not
 * chosen: one `o2b doctor` costs ~4.5 s on an idle 4-core box and up to ~27 s
 * on the same box at load average 20, and some tests here invoke the CLI
 * twice to compare an opt-out run against an opt-in one. Two worst-case
 * invocations is the budget. It is still finite, so a test that genuinely
 * hangs fails in a minute instead of never, and it matches the 60 s that the
 * bench and race tests in this suite already carry as their own annotation.
 *
 * It is applied per file rather than project-wide because bun offers no
 * working project-wide knob, which was established by experiment on bun
 * 1.3.14 rather than assumed:
 *
 *   - bunfig.toml's `[test] timeout`, which bun's own bundled docs describe,
 *     is parsed and ignored: a 3 s test still passes under `timeout = 1500`
 *     while a `preload` in the same file demonstrably runs.
 *   - `setDefaultTimeout()` from that preload applies only to the first test
 *     file bun happens to execute, and bun's file order is not alphabetical -
 *     so it silently leaves every other file on the 5 s default.
 *   - `bun test --timeout` works, but CI runs bare `bun test`
 *     (.github/workflows/ci.yml, "TypeScript test suite"), as does anyone
 *     running one file, so a flag on a wrapper script would not reach them.
 *
 * Calling it in the test file itself is the one form that behaves the same
 * under `bun test`, `bun test <file>`, and `bun run test`.
 */
export const CLI_SPAWN_BUDGET_MS = 60_000;

/** How long a killed child gets to be reaped before the failure is raised. */
export const KILL_REAP_MS = 2_000;

/**
 * How long the output pipes get, after the child exited, to deliver what is
 * already buffered and reach end-of-file. Past it a process the child
 * started holds a pipe, and the result is returned without waiting for it.
 */
export const EXIT_DRAIN_GRACE_MS = 2_000;

/** Slack for the timers and the event loop between those steps. */
const LIMIT_MARGIN_MS = 1_000;

/**
 * What a call may still need after its per-call limit fired, or after a
 * child that exited just before it: the Windows process probe
 * (`OS_PROBE_LIMIT_MS`), the reap wait after the kill ({@link KILL_REAP_MS}),
 * the drain grace after an exit ({@link EXIT_DRAIN_GRACE_MS}) and a margin.
 * The probe and the reap follow a limit, the drain follows an exit, so one
 * call never needs all three; adding them keeps the sum simple and safe.
 */
const AFTER_LIMIT_MS = OS_PROBE_LIMIT_MS + KILL_REAP_MS + EXIT_DRAIN_GRACE_MS + LIMIT_MARGIN_MS;

/**
 * The per-call limit that fits a test whose own timeout is `testTimeoutMs`:
 * that timeout minus what the call may need after the limit
 * (`AFTER_LIMIT_MS`, 7 s). A single-spawn test then gets the limit
 * failure, with its evidence, before its own timeout. A test whose
 * timeout leaves no room for a limit is refused, not given a silent one.
 */
export function cliChildLimitFor(testTimeoutMs: number): number {
  const limit = testTimeoutMs - AFTER_LIMIT_MS;
  if (limit <= 0) {
    throw new Error(
      `a ${testTimeoutMs} ms test timeout leaves no room for a per-call limit: ` +
        `the failure path alone needs ${AFTER_LIMIT_MS} ms`,
    );
  }
  return limit;
}

/**
 * The longest one spawned `o2b` child may run (`runCli` with a subprocess,
 * `tests/helpers/run-cli.ts`) before it is killed and its test fails with
 * the command line, the elapsed time and the output so far:
 * `cliChildLimitFor(CLI_SPAWN_BUDGET_MS)`, 60 s - 7 s = 53 s.
 *
 * It is a hang check, not a speed check, so it follows the test's own time
 * budget instead of a fixed guess: a diagnostic must not lower the pass
 * threshold. A CLI call usually costs a few seconds, but one call on the
 * Windows runner has taken about 25 s, and a single-spawn test with the
 * 60 s budget must still pass at that speed, as it did before the limit
 * existed. Every file that spawns the CLI runs with
 * {@link CLI_SPAWN_BUDGET_MS}; a file or test that has to keep a shorter
 * timeout passes `limitMs: cliChildLimitFor(<its timeout>)`.
 *
 * For one spawn in a 60 s test: a hung child is killed at 53 s and the
 * failure, with up to 2 s of Windows probe and 2 s of reap wait, is raised
 * by about 57 s; a child that exits just before the limit returns, after
 * at most 2 s of pipe drain, by about 55 s. Both are inside the test.
 *
 * A test that spawns several times shares its one test timeout between
 * those calls, and the limit bounds each call alone. If the earlier calls
 * took time, a later hung call reaches the test timeout before its own
 * limit: the test then fails with bun's timeout instead of the limit's
 * evidence. That is accepted: the limit exists to make a single hung call
 * diagnosable, and it never fails a test that the test timeout would have
 * passed.
 */
export const CLI_CHILD_LIMIT_MS = cliChildLimitFor(CLI_SPAWN_BUDGET_MS);
