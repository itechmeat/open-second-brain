# Review

Independent review of the artifacts against the code, by an agent of another model family than the author, read-only. Round 1 verdict: not ready, six blocking findings. All findings are applied; the verdict below is the author's check of each fix against its finding.

## Blocking findings and their fixes

1. The write path on a brain with no store, or on a machine that has not switched, was undefined: one writer throws, the other loses records silently, and the existing dream tests run without a store. Fix: the queue exists only for a brain served from the store; elsewhere the pass calls nothing of it (design D4, spec requirement 1, task 3.2).
2. "Every function that writes takes the lock" deadlocks, because the lock is not re-entrant and take and answer produce a successor. Fix: one acquisition per entry point over unlocked internal steps, a 30 second budget, a take that cannot get the lock returns `busy` (D4, task 3.2).
3. A device that never held the private partition cannot know private work exists. Fix: it shows nothing; only a device that lost the partition says "unknown" (D5, spec requirement and scenarios).
4. The ladder works on counts and cannot return fact ids. Fix: the ladder is untouched; the salience gate returns the admitted ids, and the evidence of an item is the admitted ids no earlier item of the rung holds, so the queue is the record of what was handed out (D7, tasks 5.1 and 5.2). The identity rung's evidence is the fact rung's items.
5. "The next fold-and-repair step" did not exist. Fix: an internal settle step at the start of take and apply writes the closed and released records (D4, task 3.2).
6. Two scenarios had no task: a crash after producing, and the owner moved. Fix: tasks 3.2 and 3.4.

## Other findings and their fixes

7. The stream must be in `STORE_STREAMS`; the doctor check must be registered and its codes placed for the exit census (D1, D8, tasks 1.2 and 6.2).
8. There is no generator of the format document; the conformance test and the document's own versioning rule are named (Context 6, risk 8, task 1.2).
9. Sections 3 to 6 need the dream owner change in the branch (task 0.1).
10. Windows timings (task 8.4). The version bump rule and why this pull request has none (rule 3).
11. `applyAccepted` only in a live pass; the exact call sites; no call from planning code (D4, task 5.1).
12. The manifest needs child entries (D8, task 6.2).

## Notes kept

1. The fold reads the owner records to judge a lease (D1).
2. A stale lock takeover can admit a second writer; the risk and its narrowing are in Risks 6.
3. The queue's fold is not a digest fold hash (Risks 7).

Ready for implementation: yes
