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
