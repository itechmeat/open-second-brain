# Review

Independent review of the artifacts against the code, by an agent of another model family than the author, read-only. Verdict of the round: not ready, ten blocking findings. All are applied; by the owner's instruction to stop polishing there is no second round, and the verdict line is the author's check of each fix.

1. The pass is synchronous and the executor is not. Fix: the work runs in the asynchronous front door the callers already await (design D1).
2. Production in the pass's executing branch never ran on a pass that changes nothing: the backlog would deadlock. Fix: production is unconditional, in the front door (D1, a spec scenario).
3. The "existing write blocks" are closures inside planning's locked section, not functions. Fix: planning is the applier (D2).
4. Producing item by item reads and folds the whole stream per item. Fix: `produceWorkBatch` (D3, task 1.1).
5. A veto and a "none" route have no write to reuse. Fix: standing verdicts are read from finished items; no new record kind (D2).
6. The abstain rule contradicted itself for the two kinds that always decide. Fix: D5 and the spec.
7. Two waiting reasons had no record behind them. Fix: a release keeps its reason; "not reached" is derived (D4, D7).
8. Owner-judged writes beside a planning view writer create duplicate topics. Fix: planning moves to the dream owner as a whole (D2).
9. The merge verdict record had no writable home. Fix: no such record; hints come from the queue's fold (D2).
10. Topic planning is a wrapper around the pass, not a step in it. Fix: the order of D1.

Smaller: the builder that ranks options is `rankedRouteTopics`; the answer carries provider and model in its value; the model name comes from the response; a choice with no confidence abstains; payloads are built without the egress mask; the two spellings of use names; the unstable input of `milestone-done` has a test; the files to touch are named.

Ready for implementation: yes
