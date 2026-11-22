# Review

Independent review of the artifacts against the code, by a reviewer that took no part in writing them (read-only, no tests run). Round 1 verdict: not ready, four blocking findings. All findings are applied below; the verdict after the fixes is the orchestrator's check of each fix against the finding.

## Blocking findings and their fixes

1. Importing the entry does not start the program: `src/cli/main.ts` guards dispatch, the closed-pipe handling and exit propagation with `import.meta.main`, and the MCP and log launchers insert a verb. Fix: design D1 no longer imports; every launcher starts one child with the entry and the inserted verb (table in D1).
2. A guard around an import cannot contain a hook: some hooks guard their start, others start on import and may exit with the blocking code. Fix: hooks run in the child; the hook launcher reports a failing child and exits 0 (D1, spec scenario "A hook that exits with a blocking code").
3. A Bun shebang loses the minimal-PATH recovery of the bash launchers. Fix: the requirement now says Bun is found on PATH; D1 states that the recovery stays in the bash launchers and that registrations with an absolute Bun belong to the change `setup-verb`.
4. The acceptance isolation was underspecified (a Windows child with only HOME writes the real profile; inherited XDG overrides are honoured). Fix: D5 lists the complete child environment, built from an empty object, and an assertion that every resolved path is inside the scratch root before any command runs.

## Other findings and their fixes

5. Missing runtime assets: the OpenCode plugin file, the discipline report pair, the Hermes root loader. Fix: inventory in D2. `bun.lock` is deliberately not packed, with the reason.
6. Task order and wrong assertions: lifecycle validation before `prepare` was removed; a Windows clone publishes `.cmd` wrappers, not links; `tests/version.test.ts` does not test bins. Fix: the removal is section 2, task 5.1 names both forms, task 1.4 searches for the real readers of `bin`.
7. Conflicting contracts: an old Bun must fail every command, yet a hook must exit 0; the fallback to a path without spaces contradicted the path scenario. Fix: separate hook scenario; the fallback is deleted.
8. Untested behaviour: generated npm shims, unusual home paths, failing hooks, signals, a real old-version refusal, argument preservation, proof that an asset was consumed, a skip that hides a missing run. Fix: the throwaway package root of task 1.1 and the cases of 1.2; D5 cases 2 and 3; `o2b init` must create a store; a CI variable turns the skip into a failure.
9. Reproducibility of the manifest: npm not pinned, ordering and line ends unspecified. Fix: D3 (npm pin, forward slashes, code-unit order, LF, sizes as ceilings).

## Notes kept

1. Removing `prepare` removes only the automatic git hooks path; no test references `scripts/prepare.ts`; the comment in `.githooks/pre-commit` is corrected (D4).
2. The macOS rule could also be met with `Database.setCustomSQLite`; rejected in D1 for exact parity with the bash rule.

Ready for implementation: yes

## Code review

- Finding 4657985053 holds: registry `vault-log` passed `append-event` to `src/cli/main.ts`, whose dispatcher has no such command. Decision: remove `vault-log` from the registry package and publish the three working commands; leave the legacy `scripts/` launchers untouched.
