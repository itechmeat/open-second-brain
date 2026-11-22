# Independent review

## Reviewer

An agent of a different model family than the author, which had not seen the artifacts being written; run read-only against the branch, one round. It checked the artifacts against the code, file by file.

## Findings

1. design.md D3 and tasks.md 3.5: the "dream claim lock" did not exist and no task built it. Fixed: a device-local pass lock is defined in D3, built in task 1.5 and held by a live pass.
2. tasks.md 4.1: named a test path that does not exist. Fixed: the real init test files are named.
3. tasks.md 1.4: pointed at a registry of record kinds that does not exist. Fixed: no registration is needed; the constants pattern is named.
4. design.md Context 1: review-candidates was listed as a live caller; it only previews. Fixed: moved to the preview list, with the other two preview callers.
5. design.md D2 and tasks.md 2.3: `stage`, `discard` and `retriage` of the staged lifecycle write files and were named nowhere. Fixed: they are gated like a live pass, in the design, the spec and the test table.
6. design.md D1: the view writer's rule that a claim waits one catch-up was forgotten, so two devices that claim before syncing could both run. Fixed: the rule is adopted, in D1, the spec and tasks 1.4, 1.5 and 2.3.
7. spec "Two requests": no test at the command surface for the losing requester. Fixed: a case in task 3.1.
8. tasks.md 3.2: the command manifest, help parity and completions were not named for the new command group. Fixed.
9. design.md D5 and tasks.md 4.2: `o2b store init` is a second path that creates a store. Fixed: both paths claim.
10. Note: the design replaces the brainstorm's wording that the owner is a shared setting. Fixed: D1 says so.
11. Note: "may still run once" understated a forced transfer. Fixed: the spec and D3 say the previous owner may keep running until its first catch-up after the forced claim.
12. Note: asserting that no model is asked needs a module mock of the decide entry. Fixed: task 2.3 says so.

## Verdict

Ready for implementation: yes
