# Review

Independent review of the artifacts against the code, by an agent of another model family than the author, read-only. Round 1 verdict: not ready, six blocking findings. All are applied; a closure round checks the fixes before the verdict line is trusted.

## Blocking findings and their fixes

1. The context was built after the evidence read, but three rules that need it run before. Fix: built after the scan, evidence set where it is read today, so the checkpoint order holds (design D1).
2. The wall clock's read point moves. Fix: stated, with why no outcome depends on it (D1).
3. The single evidence read dropped `ret-` targets, and `moveToRetired` in `preference.ts` reads the log on its own. Fix: the read covers both targets; the apply passes evidence down; the command line's path keeps its own read (D1, D2, task 1.3).
4. Stopping the archive on a legacy brain made every such pass a changed run and rewrote thirteen tests. Fix: dropped from the change, with the reason (Non-Goal 4, brainstorm 6).
5. The rollup row was false: it reads no clock. Fix: removed (D2).
6. The audit row needed the instant as well as the day. Fix: D2.

## Other findings and their fixes

7. Two outside callers relied on defaults the census forbids. Fix: they pass their value (D2, task 1.4).
8. The census could not pass with `evidence.ts` and `dream-refresh.ts` importing the log reader, and "imports a log reader" was undefined. Fix: the split into `evidence-read.ts`, the banned symbols named, the allowed uses named (D2, tasks 1.1, 1.3).
9. The dumps: what they exclude, a store-served brain, a check that `src/` is untouched (D4, task 0.3).

## Closure round

All findings closed. Two small additions applied: a fourth outside caller (`src/cli/brain/verbs/intent-review.ts`) and the lookup's options (design D1, D2).

Ready for implementation: yes
