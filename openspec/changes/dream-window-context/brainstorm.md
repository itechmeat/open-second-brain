# Brainstorm

This change is the first part of the replay. The decisions and the partner's attack belong to the brainstorm of the replay change, which is proposed separately; the code inventory is `inventory.md` in this folder; the owner's decisions are in the brainstorm of the change `agent-neutral-dream`. This file records only why this part stands alone and what it settles.

## Why a part of its own

The independent review of the replay artifacts judged the replay too large for one pull request and named the cleanest first cut: the refactor that gives every rule of the pass one present, together with the one rule change that refactor makes natural. Main is correct after it: every pass is one window, today's, and behaves as before apart from the one stated change.

## Decisions

1. **One value carries the present and the inputs.** Alternative: keep threading `now` and let the replay change add a second path. Rejected: eighteen rules read the present today and several steps read the log on their own, so a replay built beside them would miss one silently. With one value and a census test, a new rule that reads the clock fails the build.
2. **The value is built in two steps, and carries two clocks.** The plan-side rules run before the evidence is read, and the order of the evidence read is pinned by the checkpoint tests, so the context exists from the scan on and the evidence is set into it where it is read today. The instant the rules judge against, and the real wall clock. The archive rule reads the earlier of the two today, so that a pass told a future moment archives nothing early; a test pins it. The reviewer caught that a single instant would break that test.
3. **Evidence is cumulative.** The counters are totals over all history, so the value holds every evidence event up to the instant, read once, and the steps that reread the log on their own (the freshness trend, the preference bodies at apply) take it from the value.
4. **What stays outside.** The decide pass, the topic pass, the view pass, digest regeneration, the workrun journal and the snapshot gate keep their own clocks: they are facts about the run or have their own budgets. The census names the modules it covers.
5. **Evidence confirms a trial only when dated on or before its deadline.** Today any first application confirms, with no check against the deadline; a pass that runs in the evening confirms a trial that a pass in the morning would have retired. The partner showed this is one of the cases where daily runs and a replay disagree. No existing test pins the old behaviour, so the change adds the tests for both sides. **BREAKING** for a trial whose only evidence is dated after its deadline.
6. **A pass on a brain not yet on the store is left alone.** The first draft stopped its archive step, so that a last legacy pass could not archive a backlog the replay should consider. The second review showed the price: the changed gate counts the archive plan, so every such pass would become a changed run that moved nothing, and thirteen tests that pin the archive rule on legacy vaults would have to be rewritten onto store-served brains. Version 2.0 switches a brain to the store automatically when it is updated, so the state lasts only where a user turned the migration off. Decided: no change; the replay's bootstrap counts what was archived before the switch and reports it.
7. **The history generator and the daily driver land here.** The replay change needs a seeded generator of histories and a driver of daily passes as its reference. They are test helpers with no production counterpart, and landing them with the refactor lets the refactor be checked against generated histories too: daily passes before and after this change end in the same records.

## Rejected

1. Doing the refactor inside the replay change: one pull request too large to review.
2. Making the deadline rule a setting: a second behaviour to maintain for a case that is a defect.

## Partner

The decisions come from the replay's brainstorm (partner: an agent of another model family than the author, read-only, highest reasoning setting) and from the independent review of the replay artifacts by a third agent, which proposed this cut and found the two-clock requirement.
