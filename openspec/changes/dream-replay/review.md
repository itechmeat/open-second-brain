# Review

Independent review of the artifacts against the code, by an agent of another model family than the author, read-only. Round 1 verdict: not ready, six blocking findings, and the advice to split. All findings are applied; a second independent round checks the fixes before the verdict line below is trusted.

## Blocking findings and their fixes

1. A record first read while an early window was admitted, and dated later, was behind the position and in no admission record: lost. Fix: a window's inputs are everything below its boundary filtered by effective time, not the newly read records (design D3, "Inputs of a window"; task 3.1).
2. The archive rule reads the earlier of the pass's moment and the real clock, pinned by a test; "the instant" alone would break it. Fix: the context carries both clocks (`dream-window-context` design D1, D2).
3. No read path by position exists, nothing verifies a stored prefix digest, and the pass reads through folds that hide positions. Fix: the read layer work is named and tasked (design Context 8, D3 "The read path this needs", tasks section 2), and `dream-scan.ts` and `dream-refresh.ts` are in the impact and in task 3.2.
4. A record id must be a ULID and a second create throws, so "an effect id as the record's id" had no carrier. Fix: effect ids are idempotency keys for new preferences and body fields for audit and ledger records, with payloads frozen in the plan record (design Context 9, D4).
5. The staged flow validates today's plan and then runs live; a loop that replays first would execute another plan. Fix: staged operations are refused while windows are behind (design D1, spec requirement, task 5.4).
6. The equivalence gate came before the ledgers it needs. Fix: ledgers are section 4, the gate is 5.5.

## Other findings and their fixes

7. Missing scenarios in the equivalence table: added (task 1.2).
8. The table of rules was incomplete and the census unscoped: the table and the module list are now in `dream-window-context` design D2, with what stays outside named.
9. Renaming rollup targets would have changed a daily pass: the path stays and is frozen in the plan (design D4.6).
10. No existing test pins the deadline rule: new tests on both sides (`dream-window-context` task 2.1).
11. The snapshot wording, the human-change carve-out, the "changed pass" wording, the impact list: fixed (design D1, D7; spec; proposal).

## The split

The review named four parts. Two are taken as changes: `dream-window-context` (the context refactor, the deadline rule, the history helpers) and this change (the rest). Transfer and surfaces stay here: they are small beside the core and are not useful to ship apart from it.

## Round 2

Closure of the eleven: ten closed, the first closed with a new problem. New findings and their fixes:

1. The time filter was not computable on a fold of entities. Fix: only inputs are filtered, a signal by its creating record and an evidence event by itself; state is never filtered by time (design D3, task 3.1).
2. The audit tail was a skip where it must be rebuilt from the plan, with a subject per event kind. Fix: design D4.4, tasks 5.1 and 5.2.
3. The reconciliation requirement had no design. Fix: design D5a, tasks 1.2 and 5.3.
4. Smaller: the log reader has no cache and the entity cache has one slot (D3); re-triage joins the staged refusal and heal enrichment is lifted out of the apply (D1, tasks 5.3, 5.4); a fixture helper for hand-built coverage, the rebase count in the audit events, the budget between windows (tasks 3.0, 3.1, 5.1).

## Closure round

All earlier findings closed. Three new ones, fixed in the artifacts without a further round, by the owner's instruction to stop polishing:

1. The fold's evidence counters were not bounded by the window. Fix: `preference-evidence` records are inputs like log events; counters come from the filtered evidence (design D3, task 3.1).
2. A retired rule does not keep its deadline. Fix: the retirement effect carries it; history for older retirements; a not-checkable count otherwise (design D5a, task 5.3).
3. The audit tail needs more than the effects. Fix: an `audit` part in the plan record covering every event kind (design D4.4, tasks 5.1, 5.2).

Ready for implementation: yes
