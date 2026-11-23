# Review

Independent review of the artifacts against the code, by an agent of another model family than the author, read-only, on a branch that did not yet hold the merged package change and the later review rounds of the dream owner. Verdict of the round: not ready, two blocking findings. Both are applied; there is no second round, by the owner's instruction, and the verdict line is the author's check of each fix.

1. The claim was built on the pass lock, which cannot be handed to another process. Fix: a claim record with a token, as the post-upgrade worker uses; the worker takes the pass lock itself (design D2, D3).
2. A day closed with work nobody here can answer was reported nowhere. Fix: a note at session start on the owner's machine and a doctor code (D4, D6, D7).

Smaller, applied: the hook and the server keep the config they load, so the closed-day path adds one read; the check runs on every event of the hook's matcher and at the one seam of tool calls; notes travel through the runtime notices channel and are printed alone on an empty payload; a host with only the command line has no entry.

Not applied, because it is not true of main: the reviewer's branch had no package manifest script; main has it since the registry package change, and the gate keeps `pack:check`.

Ready for implementation: yes
