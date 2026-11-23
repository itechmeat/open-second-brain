# Review

Independent review of the artifacts against the code, by an agent of another model family than the author, read-only. Verdict of the round: not ready, eight blocking findings. All are applied; by the owner's instruction to stop polishing there is no second round, and the verdict line is the author's check of each fix.

1. The design named things of `dream-closed-questions` as present code. They are that change's; this one is built on a branch that holds it, and says so (Context 1, task 0.1).
2. A profile of three tools still served resources, and kept the capability tool. Fix: the profile is exact, with no resources and no prompts (D3, spec).
3. No helper starts a program, awaits it for minutes and ends it. Fix: a new one (D4, task 1.3).
4. A five minute wait would exceed the shared deadline of the MCP tool and the lane task. Fix: the budget is clamped to the caller's remaining time less a reserve (D4, spec).
5. An environment marker cannot keep a later batch import out. Fix: the session marks its own transcript and the capture boundary ignores it at both seams (D2, spec).
6. Nothing produced the wording item. Fix: the producer of closed questions does, with the `topic-new` item (D6, task 5.1).
7. The fold could not know the drafts setting and the listing had no text. Fix: D7.
8. There is no command line splitter. Fix: a custom command is an array of arguments (D1).

Smaller: the flag is `--tool-profile`; the setup verb only if it is in the branch; the files that enumerate profiles and doctor codes are named; the call log; the lock order of the rollup apply has a test.

Ready for implementation: yes
