# Actionable-now batch - brainstorm audit trail

Host execution mode: the consultant role ran as an in-session subagent (external CLIs are forbidden by host-mode rules); the prompt that would have been sent is at `cli-output/prompt.md` and the consultant's output is the three variants below, carried into `variants.md` verbatim in substance. No external CLI was invoked.

## Variants as returned

### Variant 1: Four disjoint lanes per card cluster, one integrator

- **Approach**: Group the seven cards by the cluster of files they actually touch, and run one lane per cluster with exclusive file ownership: Lane A "entity-write-surface" (t_28a8789d entity merge + t_69fec179 destination aggregate - both end at the `brain` CLI verb surface, `query-tools.ts`, and the registry/manifest/census pins), Lane B "session-lanes" (t_3b44cd9a catch-up lane + t_ba04a81a injection hardening - both live in `hooks/**` and the SessionStart assembly), Lane C "small-fixes" (t_d8e7320f collation + t_dee22e5d Hermes entry point - one core file plus packaging), Lane D "okf-v02" (t_ffdb4fac - one portability module and its suite). An integrator pass afterwards runs the full gates and reviews census registrations across lanes. Landing order inside a lane follows the task list; lanes have no ordering constraints.
- **Trade-offs**:
  - Pro: code ownership is disjoint against the recon anchors, with the census/pin test files as the one deliberate shared surface - more than one lane can need a row or a count move in the same file, and the integrator reconciles those edits - so two agents essentially never race the same index/census/pin file, the failure mode that costs the most rework in multi-lane waves.
  - Pro: pairing by cluster halves the review contexts (4 instead of 7) while keeping each pair topically coherent: a reviewer of Lane A sees both halves of the write/verb surface; a reviewer of Lane B sees both halves of the hook-lane story.
  - Pro: cards with unresolved friction (t_28a8789d's new plan-hash surface, t_ba04a81a's meter-attribution coupling) get a lane that owns all the coupled files, so the fix never crosses a lane boundary.
  - Con: each lane is a two-card diff, so a reviewer must hold two premises at once.
  - Con: lane C and lane D are single-cluster and small; they finish early and wait at the integrator gate.
- **Complexity**: medium
- **Risk**: low

### Variant 2: One lane per card, sequential integration chain

- **Approach**: Seven lanes, one per card, all started in parallel with their own worktrees; integration is a fixed serial chain (C -> D -> B -> A) where each landed lane rebases on the previous, and the pins (`docs/cli-reference.md`, `command-manifest.ts`, MCP frozen-surface counts, write-site census) are re-resolved at every hop.
- **Trade-offs**:
  - Pro: smallest possible diff per review; each card is one self-contained reviewable unit with its own premise.
  - Pro: any card that stalls at review does not block the others from being reviewed.
  - Con: t_28a8789d and t_69fec179 both end in `src/cli/brain/verbs/index.ts`, `help-text.ts`, `command-manifest.ts`, `docs/cli-reference.md`, and the MCP pin suites; t_3b44cd9a and t_ba04a81a both end in `hooks/hooks.json` and `hooks/lib/active-context.ts`. Seven parallel lanes guarantee merge conflicts in exactly those files, and the serial chain serializes the whole wave on re-resolving them four times.
  - Con: census pins are two-way (count in the test, row in the registry); seven independent movers of the same counts guarantee stale-pin churn at every hop.
- **Complexity**: medium (per lane) / high (integration chain)
- **Risk**: medium

### Variant 3: Two mega-lanes splitting core-vs-surface

- **Approach**: Lane 1 "core" takes every core-module change (entity page-merge module, destination reader, `untrusted-source.ts` promotion, `gap-loop.ts`, `vault.ts` collator, `okf.ts`, config keys); Lane 2 "surface" takes every exposure change (CLI verbs, hooks entries, MCP tools, manifests, docs, pyproject) and wires onto Lane 1's exports once they land. Two worktrees, one handoff, one integrator.
- **Trade-offs**:
  - Pro: the cleanest layering story - core lands with pure unit tests, surface lands against frozen exports; no surface task ever waits on a core task mid-flight, only once.
  - Pro: only two review contexts, and each is internally homogeneous (algorithms vs wiring).
  - Con: the mega-diffs are exactly what the review budget struggles with: Lane 1 spans entities, notes, hooks-lib dependencies, vault, and portability in one PR - five unrelated premises in one diff, and a regression in any one blocks landing all five.
  - Con: the injection-hardening card (t_ba04a81a) does not split cleanly: its guard IS the chokepoint inside `hooks/lib/active-context.ts` (surface), but its primitive lives in core, so the card straddles both lanes and forces either a mid-wave handoff or an ownership exception - reintroducing the coupling Variant 1 exists to remove.
  - Con: `bun run fmt`/`lint` and the full suite effectively gate only the second lane, so core defects surface late.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 1

Variant 1 is the only variant whose code-file ownership is fully disjoint against the recon anchors; the census/pin test files stay a shared surface that several lanes legitimately need rows in, and the integrator reconciles those, so the wave's real risk (two agents editing the same registry/pin file) narrows to one known, reconciled surface rather than resting on integration discipline. It keeps every coupled pair inside one lane - the plan-hash gate with its verb, the guard with the meter it feeds - so no design decision has to cross a lane boundary, and it holds the review contexts at four coherent two-card diffs instead of seven fragmentary ones or two mega-diffs. Variants 2 and 3 both pay more for less: Variant 2 buys minimal diffs at the price of a serialized integration chain over shared pin files; Variant 3 buys layering purity at the price of one straddled card and five-premise mega-diffs. Orchestrator rationale: the wave's cards are independent by premise, so parallelism is free; the only thing parallelism costs is index races, and disjoint ownership eliminates exactly that - parallel speed with per-cluster review coherence and one integrator pass to sweep the census registrations.
