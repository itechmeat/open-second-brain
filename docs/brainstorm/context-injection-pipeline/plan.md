# Context injection pipeline - implementation plan

Three implementation lanes with disjoint file ownership plus one integrator task. Each task is TDD-ready: write the failing test first, implement until green, refactor with all tests green, format and lint before every commit, commit only the task's own files (`git commit --only <paths>`).

## Cross-lane contract

Shared files are pinned here so every merge is textual and disjoint. A lane that needs a file outside its ownership stops and renegotiates the contract; it never reaches into another lane's files.

- **hooks/hooks.json** — touched by lanes A and B only, in disjoint positions. Neither lane adds, removes or reorders matcher groups.
  - Lane A appends exactly one hook object to the existing PostToolUse `"Write|Edit|MultiEdit|apply_patch"` group's `hooks` array, after the post-write-reminder object:
    ```json
    {
      "type": "command",
      "command": "r=\"$CLAUDE_PLUGIN_ROOT\"; if [ -n \"$r\" ] && [ -x \"$r/scripts/o2b-hook\" ]; then exec \"$r/scripts/o2b-hook\" subagent-inject; fi; command -v o2b-hook >/dev/null 2>&1 && exec o2b-hook subagent-inject; exit 0",
      "timeout": 10,
      "statusMessage": "OSB: delivering standing rules to a subagent"
    }
    ```
  - Lane B appends exactly one hook object to the existing Stop `"*"` group's `hooks` array, after the stop-log-guardrail object:
    ```json
    {
      "type": "command",
      "command": "r=\"$CLAUDE_PLUGIN_ROOT\"; if [ -n \"$r\" ] && [ -x \"$r/scripts/o2b-hook\" ]; then exec \"$r/scripts/o2b-hook\" hygiene-digest; fi; command -v o2b-hook >/dev/null 2>&1 && exec o2b-hook hygiene-digest; exit 0",
      "timeout": 10,
      "statusMessage": "OSB: surfacing pending hygiene findings (opt-in)"
    }
    ```
- **src/core/config.ts and src/core/brain/config-template.ts** — lane B only (`hygiene_digest_enabled`). Lane A needs no flag: the carrier is always on and silent when there is nothing to deliver.
- **hooks/lib/standing-block.ts and hooks/active-inject.ts** — lane A only.
- **hooks/lib/injection-ledger.ts** — lane A only.
- **hooks/lib/hygiene-digest-text.ts, hooks/lib/hygiene-digest-state.ts, hooks/hygiene-digest.ts** — lane B only.
- **hooks/lib/messages.ts** — touched by nobody: each new hook keeps its per-runtime output helper local to its own module, so the shared text module stays out of every lane.
- **src/core/brain/text/text-budget.ts, src/core/brain/active-budget.ts, src/core/brain/active-budget-pressure.ts** — lane C only.
- **tests/hooks/hooks-json-shape.test.ts and tests/hooks/active-inject.test.ts** — shared append-only: a lane extends them only with tests for its own behavior and never edits another lane's assertions.
- **scripts/o2b-hook** — touched by nobody: hook resolution is name-driven, so new hooks need no dispatcher change.
- **hooks/README.md, docs/** and **CHANGELOG.md** — integrator task only; the CHANGELOG entry lands inside the release PR per the playbook, not in a lane commit.
- **Untouched everywhere**: `applySectionBudget` semantics for its existing consumers (standing-rules, scoped-rules), `CONTEXT_EVENT_NAMES`, the reground pipeline, the writeback contract, the instruction-file ceiling.

## Lane A - subagent delivery (carrier)

### Task A1: Extract the standing-rules renderer

- **Files**: new `hooks/lib/standing-block.ts` (renderer, failure-render helper, `InjectionMeter` type, meter parameter optional); modified `hooks/active-inject.ts` (imports the extracted renderer, private copy deleted); new `tests/hooks/standing-block.test.ts`.
- **Acceptance**: a passing unit test renders the block from a fixture rules file, asserts the absent-file case yields an empty string and the failed-read case yields the explicit failure block; every existing `tests/hooks/active-inject*.test.ts` test passes unchanged.
- **Depends on**: none.

### Task A2: Subagent carrier hook and ledger key

- **Files**: new `hooks/subagent-inject.ts`; modified `hooks/lib/injection-ledger.ts` (key constant `osb.subagent_inject.delivered`, capped agent-id set helpers, cap constant); new `tests/hooks/subagent-inject.test.ts`.
- **Acceptance**: a passing spawn-based hook test proves: payload without a non-empty `agent_id` produces no stdout; the first `agent_id` on a write-shaped PostToolUse call emits exactly one line whose `additionalContext` equals the standing-rules block (or the explicit failure block on a failed read); a second call with the same `agent_id` is silent; an absent or empty rules file is silent; a missing vault is silent; a missing session scope is silent; the ledger records the id only after a successful emission.
- **Depends on**: A1.

### Task A3: Wire the carrier into hooks.json

- **Files**: modified `hooks/hooks.json` (exact object pinned in the cross-lane contract); extended `tests/hooks/hooks-json-shape.test.ts`.
- **Acceptance**: the shape test passes with the new PostToolUse entry covered: dispatch target `subagent-inject` resolves to an existing hook file, timeout 10, fail-soft command shape identical to its siblings.
- **Depends on**: A2.

## Lane B - hygiene digest at turn end

### Task B1: Pure digest composer

- **Files**: new `hooks/lib/hygiene-digest-text.ts` (findings plus dangling-link count to one line; wording, prefix "Open Second Brain hygiene", pointer to `o2b brain hygiene scan`, and the length cap all as named constants); new `tests/hooks/hygiene-digest-text.test.ts`.
- **Acceptance**: a passing unit test proves: `info`-only findings compose to null; zero findings compose to null; counts are per detector in `HYGIENE_DETECTOR_IDS` order with the dangling-link count last; `warning` and `action` findings are included; the output is one line whose length never exceeds the cap constant, including on a pathological fixture; identical input composes byte-identical output.
- **Depends on**: none.

### Task B2: Hash-ledger state helpers

- **Files**: new `hooks/lib/hygiene-digest-state.ts` (read, compare, overwrite-only write of `<vault>/.open-second-brain/hygiene-digest.hash`, using `sha256Hex`/`canonicalJson` from src/core/integrity/digest.ts); new `tests/hooks/hygiene-digest-ledger.test.ts`.
- **Acceptance**: a passing unit test proves: a missing file reads as null; a corrupt file reads as null (fail-soft); identical state compares equal and changed state compares unequal; a write-then-read roundtrip returns the written hash; the write replaces the file in place (no growth, no siblings).
- **Depends on**: none.

### Task B3: Stop hook, config flag, config template

- **Files**: new `hooks/hygiene-digest.ts` (stop-log-guardrail skeleton: `stop_hook_active` guard, transcript gate via `summarizeTurn` hadArtifact, `resolveVault` null check, default-sweep `runHygieneScan` plus dangling-link measurement, per-runtime output helper local to this file); modified `src/core/config.ts` (`resolveHygieneDigestEnabled`, default false, checked before vault resolution) and `src/core/brain/config-template.ts` (`hygiene_digest_enabled` entry); new `tests/hooks/hygiene-digest.test.ts`.
- **Acceptance**: a passing spawn-based hook test proves: flag off produces no stdout and never invokes the scan; flag on with a fixture vault holding eligible findings and a transcript showing an artifact write emits exactly one line and writes the hash file; an immediate second identical run is silent; `stop_hook_active` is silent; a transcript without artifact writes is silent; a missing vault is silent; claudecode receives the `hookSpecificOutput` Stop shape and other runtimes the portable one-line shape.
- **Depends on**: B1, B2.

### Task B4: Wire the digest into hooks.json

- **Files**: modified `hooks/hooks.json` (exact object pinned in the cross-lane contract); extended `tests/hooks/hooks-json-shape.test.ts`.
- **Acceptance**: the shape test passes with the new Stop entry covered: dispatch target `hygiene-digest` resolves to an existing hook file, timeout 10, fail-soft command shape identical to its siblings.
- **Depends on**: B3.

## Lane C - tiered shrink under the budget

### Task C1: Bullet primitives in the text-budget core

- **Files**: modified `src/core/brain/text/text-budget.ts` (pure helpers: bullet split of a section into heading, lead-in lines and item lines; first-parenthesized-group extraction after the id prefix; ranking keys — `applied_in_window` descending, confidence value descending, `applied` descending then `violated` ascending); extended `tests/core/brain/text-budget.test.ts`.
- **Acceptance**: passing unit tests prove: the split isolates heading and non-bullet lead-ins; the group parser reads only the first parenthesized group and survives nested parentheses like `(confidence: high (0.95))`; lines without a recognizable id-tag prefix rank last in original order; ranking is deterministic and the helpers are pure.
- **Depends on**: none.

### Task C2: Headline tier ladder and notice

- **Files**: modified `src/core/brain/active-budget.ts` (tier step inside `budgetActiveBody`, applied before `applySectionBudget` only when the split body exceeds the budget; sections at `KEEP_GUARD_PRIORITY` exempt; top-N constant, default 3; `headLines` set to the kept non-bullet line count; tier-notice wording constants; tiered sections named when tiering fired, including the no-drops case); extended `tests/core/brain/active-budget.test.ts`.
- **Acceptance**: passing tests prove: within budget the output stays byte-identical (existing test still green); over budget a tiered section keeps its heading, its lead-ins and exactly the top-N ranked bullets; a headlines-only remnant that still overflows drops through the headLines guard; when tiering alone fits the budget the tier notice is emitted with no drop notice; when drops still occur the drop order matches today's; running the function twice yields byte-identical output.
- **Depends on**: C1.

### Task C3: Pressure-probe mirror

- **Files**: modified `src/core/brain/active-budget-pressure.ts` (the probe models the tier step with the same exemptions and the same top-N; docblock contract updated); extended `tests/core/brain/active-budget-pressure.test.ts`.
- **Acceptance**: passing tests prove the probe and the reactive path agree on which section degrades first and on the tier threshold, for a fixture body; the existing never-disagree property test stays green.
- **Depends on**: C2.

### Task C4: End-to-end injection budgeting

- **Files**: extended `tests/hooks/active-inject.test.ts` (append-only).
- **Acceptance**: a passing end-to-end test proves an over-budget assembled active body reaches the injected context tiered with the tier notice, and a within-budget body arrives byte-identical.
- **Depends on**: C2.

## Integrator

### Task I1: Documentation

- **Files**: modified `hooks/README.md` (event-table rows for the PostToolUse carrier and the Stop digest), `docs/how-it-works.md` (`hygiene_digest_enabled` in the config-key list, headline-tier wording in the deterministic-drop passage, carrier mention in the additionalContext description), `docs/mcp.md` (note on the `brain_hygiene` row that findings are also pushed at turn end when enabled).
- **Acceptance**: the docs checks (including the prose-only CI filter) pass; every user-visible surface added by lanes A, B and C has a row or a paragraph; no placeholder text anywhere.
- **Depends on**: A3, B4, C3.

## Commit shape

- Lane commits use conventional messages on this branch, each committing only its own files via `git commit --only <paths>`: `feat(hooks): <imperative summary>` for lanes A and B, `feat(brain): <imperative summary>` for lane C, `docs: <imperative summary>` for the integrator.
- The brainstorm artifacts commit separately as `chore(brainstorm): context-injection-pipeline` before any lane work.
