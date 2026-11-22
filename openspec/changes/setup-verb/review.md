# Review

Independent review of the artifacts against the code, by an agent of another model family than the author, read-only. Verdict of the round: not ready, nine blocking findings. All are applied below; by the owner's instruction to stop polishing there is no second round, and the verdict line is the author's check of each fix.

1. The origin was not part of the install environment, and two places that rebuild the command (`update`, `bootstrap`) were not named: an update would have rewritten a registry registration to the bare name. Fix: design D2, tasks 2.1 and 2.2, a spec scenario.
2. The registry head broke Grok's argument list. Fix: `cliArgs` strips it (D2, task 2.1).
3. The command probe would not check the launcher file. Fix: the registered shape is Bun, `run`, launcher, which the probe already grades (D2, D6).
4. `install --check` exits 0 for a host that is not installed. Fix: setup reads the adapter's own status (D4).
5. The composed steps print to standard output. Fix: one capture helper; one JSON document (D4, task 4.1).
6. The print kind had no step, and reading bootstrap's modes from the new table would have admitted new targets to bootstrap. Fix: the generic target ends with 7; bootstrap is unchanged (D4, D5).
7. npm's runner cache also sits under `node_modules`. Fix: runner caches are checked first; the spec says "known" (D1).
8. A plan failed on an unconfigured machine. Fix: choices are checked only for an apply (D4, spec).
9. The self-test writes on every call. Fix: skipped when nothing was written in the run; the claim is scoped (D4, spec).

Smaller: this file now exists; the origin is stamped in one place; the plugin cache rule moves to core; the census and documentation tests are named.

Ready for implementation: yes
