/**
 * The per-test budget for a test FILE whose tests read the whole of `src/`
 * or `tests/` (the architecture censuses, the version census), applied with
 * `setDefaultTimeout(SOURCE_SCAN_BUDGET_MS)` at the top of that file, the
 * same way `cli-timeout.ts` budgets the files that spawn the CLI.
 *
 * bun's default is 5 s per test, a budget for a unit test. A walk of the
 * tree reads and lexes every module, so its cost grows with the tree and
 * with the load on the machine, not with the assertion: the version census
 * took 5.8 s on a CI runner. Such a test passed only while the runner was
 * idle enough. One measured budget for the family, the one the content-class
 * census already carried: still finite, so a census that hangs fails.
 */
export const SOURCE_SCAN_BUDGET_MS = 20_000;
