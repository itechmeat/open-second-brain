# Recall Injection Lifecycle - brainstorm audit trail

Consultant: Claude Code (`claude -p`, model `claude-opus-5-5`), primary path, exit 0, 3 parseable variants. Fallback not needed. Prompt: `cli-output/prompt.md`, raw output: `cli-output/claude.md`.

## Variants (consultant verbatim)

### Variant 1: Shared session-ledger substrate, feature lanes as thin consumers
- **Approach**: Add one small shared lane first. It extends `hooks/lib/session-state.ts` with typed, namespaced sub-records inside the existing per-scope JSON:
  - `recall.injected`: a path set plus its epoch.
  - `active.emitted`: the paths active-inject actually delivered.
  - `overflow`: the epoch, the queued parts and a cursor.

  The same lane adds a `claimHookState` primitive that tries the lock once and gives up fast, plus a `src/core/brain/recall-inject-config.ts` resolver. The resolver handles the four lenient caps and the validated slice list. The four feature lanes then each own disjoint files:
  - Dedupe: `hooks/recall-inject.ts` reads `session_id` and passes an `exclude` set into the pure core.
  - R2: the emitted-set record in `hooks/active-inject.ts`.
  - Slices: a pure multi-slice planner in `src/core/brain/recall-inject.ts`.
  - Overflow: a splitter, plus a carrier that piggybacks on the already-spawned `pretool-orient`, or a new PostToolUse `*` entry plus an allowlist change.

  A SessionStart `compact` bumps the epoch, which resets recall dedupe and replaces any pending overflow queue in one write.
- **Trade-offs**:
  - Pro: one file per session and one lock. The epoch makes compact-reset and queue overwrite a single atomic step, so cross-lane consistency (R2 and dedupe) comes almost for free.
  - Pro: lane ownership is clean once the substrate merges first. The pure core keeps the fake-retriever tests, and byte-identical defaults are easy to pin because every reader of an absent sub-record gets "empty".
  - Pro: the carrier can reuse the existing PreToolUse `*` process, so tool calls get no extra bun spawn.
  - Con: every lane competes for the same per-scope lock (20 x 5 ms). The overflow claim has to use the try-once path, otherwise recall and carrier writes on the same tool burst could skip each other's work.
  - Con: the JSON file grows with queued parts, and old scope files are still never cleaned up. That needs a size cap on queued parts.
  - Con: the substrate has to be designed up front. Changing its shape mid-cycle blocks every lane.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Per-lane sidecar state files with independent locks
- **Approach**: Leave the shared `<scope>.json` untouched and give each feature its own sidecar file under `hook-state/`, each with its own lock:
  - `<scope>.recall.json`: the injected set.
  - `<scope>.active-emitted.json`: written by active-inject, read-only for recall.
  - `<scope>.overflow.json`: the queue, epoch and cursor.

  The epoch is a monotonic counter stored in the active-emitted sidecar. Other lanes compare against it lazily, so compact-reset needs no cross-file write. The carrier runs as a dedicated `hooks/overflow-carrier.ts` on a new PostToolUse `*` matcher, extending the context-events allowlist the way `post-write-reminder` already does. Config and slice resolution sit in a shared resolver module, as in Variant 1.
- **Trade-offs**:
  - Pro: no lock contention between lanes, and each lane owns its file format outright. This gives the strongest parallel-lane isolation, and a corrupt queue cannot damage dedupe state.
  - Pro: a dedicated carrier hook is easy to test in isolation and easy to disable.
  - Con: comparing epochs across files lazily adds subtle ordering bugs. If recall reads a stale epoch during a compact race, it can wrongly dedupe against briefs the host has already lost.
  - Con: it triples the number of state files per session, and nothing cleans up old ones.
  - Con: a new PostToolUse `*` hook spawns an extra bun process on every tool call, even when the queue is empty, and it changes `hooks.json` and the Codex mirror.
  - Con: `session-state.ts` would need its file-path logic generalized anyway, so the substrate ends up only slightly smaller.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Unified pure "injection lifecycle" core with reducer-style state
- **Approach**: Model the whole lifecycle as one pure module, `src/core/brain/injection-lifecycle.ts`, with a state type covering the epoch, delivered paths per lane and the overflow queue. Pure reducers (`onSessionStart`, `onPrompt`, `onToolUse`) return the next state plus the output to emit. Hooks become thin adapters: read state, run the reducer, write state, print. Recall-inject's decide/render are folded into the planner as one slice kind among the operator-declared slices, and active-inject's assembly feeds its emitted set and overflow parts through the same reducer.
- **Trade-offs**:
  - Pro: every rule becomes a pure, table-testable transition with no spawned processes (compact reset, user prompt cancels the queue, exactly-once handout, epoch overwrite, cross-lane dedup). This gives the best long-term coherence and makes the census vocabulary easy to keep closed.
  - Con: it restructures two shipped hooks and the recall core at once, which risks byte-identical defaults and the existing audit-line formats.
  - Con: it serializes the lanes. Everything depends on one central module, which works against the requirement for parallel lanes with disjoint file ownership.
  - Con: folding active-inject into a reducer drifts toward reshaping active-inject, which the slices card explicitly rules out.
- **Complexity**: large
- **Risk**: high

### Consultant recommendation: Variant 1
**Rationale**: Variant 1 has the smallest shared surface: one ledger extension, a try-once claim primitive and one config/slice resolver. The four cards can then run as truly disjoint lanes. The single per-session file with an epoch also handles compact-reset, the cross-lane R2 dedup and queue overwrite atomically, which avoids Variant 2's lazy-epoch races. It keeps the shipped hooks and pure-core APIs intact, so defaults stay byte-identical. Variant 3's rewrite would put both of those at risk and serialize the lanes. The lock-sharing risk is contained by having the overflow carrier use the try-once path and skip delivery on contention. Reusing the existing PreToolUse `*` process means tool calls get no extra spawn cost.

## Final rationale

Variant 1 is accepted. It keeps the shared surface small: one ledger module over the existing per-session hook-state file, one locked read-modify-write primitive with a try-once mode, and the global config resolvers. That surface lands first, and three disjoint lanes then build on it. The single per-session file with an epoch written by active-inject makes three things one atomic step: the compact reset, the recording of the cross-lane emitted set, and the replacement of the re-delivery queue. That avoids Variant 2's cross-file epoch races. Variant 3 is rejected because it would restructure two shipped hooks and the recall core at once, put the byte-identical defaults at risk, and serialise the lanes.

One sub-choice inside Variant 1 is overridden: the carrier. The consultant suggested delivering parts through the already-spawned PreToolUse `pretool-orient` process. Nothing in this repository verifies that the hosts accept `additionalContext` on PreToolUse, and `hooks/lib/context-events.ts` records that emitting on an unaccepted event is worse than silence. PostToolUse `additionalContext` has a shipped precedent in `hooks/post-write-reminder.ts`, so the design adds a dedicated `reground-deliver` hook on PostToolUse and UserPromptSubmit. It exits before any vault read when its flag is off.

The premise verdicts bound the scope regardless of the variant:
- The completed-turn capture gate (t_5528ab98) is not built.
- The volunteering lane (t_e9da6b7e) is not rebuilt; only its config knobs and the cross-lane dedup are added.
- Slices (t_2d19157e) apply to recall-inject only.
- Re-grounding (t_55ee804e) gains only the overflow lane.

The card's "a real user prompt cancels the queue" is replaced by "a user prompt also carries the next part". In Open Second Brain nothing on UserPromptSubmit re-delivers the active digest, so cancelling would drop the remaining parts after every manual compaction.
