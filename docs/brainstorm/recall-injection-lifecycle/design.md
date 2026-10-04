# Recall Injection Lifecycle - session-aware recall briefs, operator slices and chunked re-grounding

**Status:** draft
**Author:** claude-devbox-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

The opt-in recall-inject hook (UserPromptSubmit) has no idea which session it serves. It re-injects the same notes on every prompt, including preferences the SessionStart digest already delivered. Its four caps are module constants that no operator can tune, and its one relevance query cannot be shaped into operator-declared slices. On the SessionStart side, active-inject emits standing rules, scoped rules and the memory body as one `additionalContext` payload. With default caps that payload can reach about 20,000 UTF-16 units, which is past the roughly 10,000-unit threshold where the host persists the payload to a file and shows only a preview. Re-grounding after compaction then fails quietly, exactly when it matters.

## Premise verdicts (authoritative for scope)

| Card | Verdict | What is built |
|---|---|---|
| t_5528ab98 turn-scoped recall/capture lifecycle | corrected | Per-session dedupe of the recall-inject brief only. The completed-turn-only capture gate is **not built**. Capture mines only user-authored prompt text at UserPromptSubmit, and an interrupted SessionEnd deliberately re-reads the transcript so in-flight user turns are captured (t_c181f92b), so the gate would reverse a shipped durability decision. The default-ON flip is not built either. |
| t_e9da6b7e confidence-gated volunteering | refuted, residue buildable | The volunteering lane already ships as recall-inject (floor 0.35 on IDF-weighted coverage, 4 notes, 900 chars, 2500 ms, default OFF). Built: R1, config knobs for the four caps, and R2, cross-lane dedup against what active-inject actually emitted. Not built: a second kill switch, default ON, fail-open replay, a 0.7 score gate, entity-pointer dedup. |
| t_2d19157e user-shapeable injection slices | corrected | Operator-declared named slices for recall-inject only. The active-inject source list is not reshaped: it is already budget-configurable and is not query-shaped. |
| t_55ee804e post-compaction chunked re-grounding | corrected | Re-grounding after compaction already ships (SessionStart `compact`), and priority order and a budget exist. Built: only the overflow lane, which splits, queues, delivers through a carrier and adds a meter flag, behind a config gate. |

## Scope

- **Per-session recall dedupe (t_5528ab98).** recall-inject reads `session_id`. Notes already injected in this session (identity: origin, vault-relative path and line span) are filtered after the confidence-floor check and before the `maxNotes` slice. If nothing new survives, the hook abstains with the new reason `all_already_injected`. The hook records the rendered notes after stdout. Dedupe is off when the host sends no session id. Every SessionStart, `compact` included, starts a new injection epoch that clears the recall set. Gate: `recall_inject_dedupe`, default on while `recall_inject_enabled` is on.
- **Recall caps as config (t_e9da6b7e R1).** Four keys go into the flat global config next to `recall_inject_enabled`, each with an `OPEN_SECOND_BRAIN_RECALL_INJECT_*` env override and resolved leniently: `recall_inject_max_notes` (1..10), `recall_inject_max_chars` (200..8000), `recall_inject_time_budget_ms` (250..6000) and `recall_inject_confidence_floor` (0..1). An invalid value falls back to the constant and is named in the audit line (`config_invalid: [<key>...]`). Unset keys keep output byte-identical.
- **Cross-lane dedup against the active digest (t_e9da6b7e R2).** active-inject records into per-session hook-state the note paths present in the body it actually emitted. That means the post-budget text, never the `Brain/active.md` file. recall-inject drops candidates whose path is in that set, matching on any line span.
- **Operator-declared recall slices (t_2d19157e).** A new `recall_inject:` block in `Brain/_brain.yaml` declares named slices. Each slice has an optional heading, a path-prefix filter, a frontmatter `type` class filter, a note limit and a char budget. Slices are retrieved in parallel under the one shared time budget and rendered as headed groups inside the single fence, and the global caps clamp the sum. No block means today's single implicit relevance slice, byte for byte.
- **Chunked re-delivery of an oversized SessionStart payload (t_55ee804e).** This lane is gated by `reground_parts_enabled` (default off). When the joined active-inject context exceeds the per-host part ceiling, the hook emits part 1 and queues the remaining parts in per-session hook-state under a new epoch. A new hook, `reground-deliver`, hands out exactly one part per PostToolUse or UserPromptSubmit event under a try-once lock. The size receipt gains `utf16_chars`, `part_ceiling_chars`, `parts_total` and `over_budget`.
- **Hook-state substrate.** This adds a locked multi-key read-modify-write with a try-once mode and stale-lock takeover, atomic-rename writes, a bounded mtime prune of old scope files, and one typed ledger module that owns every key name above.

## Out of scope

- The completed-turn-only capture gate (refuted, see the verdict table) and any change to `hooks/session-capture.ts` or `src/core/brain/session-lifecycle.ts`.
- Flipping `recall_inject_enabled` to default ON, a second kill switch, or a fail-open last-good replay of a recall brief.
- A score-based 0.7 gate. The floor stays on IDF-weighted coverage.
- Entity-pointer dedup. No such lane exists.
- Reshaping the active-inject source list or adding slices to it.
- Slice `sort` orders other than relevance. Results come back ranked by score, and an alternative order would need fields the recall row does not carry. This is deferred.
- Measuring host limits from host binaries. The limit is configuration with a conservative default.
- Chunked re-delivery on grok and unknown runtimes. Those keep today's single emission, and the divergence is declared in the grok parity test.
- Any MCP tool, CLI verb or doctor check change.

## Chosen approach

This is consultant Variant 1, "Shared session-ledger substrate, feature lanes as thin consumers", accepted, with one sub-choice overridden (the carrier, see below). A small substrate lands first. `hooks/lib/session-state.ts` gains `updateHookState`, a locked read-modify-write over the existing per-scope JSON file with a try-once mode. A new `hooks/lib/injection-ledger.ts` owns every ledger key and its typed accessors, and `src/core/config.ts` gains the global resolvers. Three feature lanes then consume it with disjoint files:
- Lane A changes the recall core and hook: dedupe, caps, cross-lane filter, slice execution.
- Lane B adds the `_brain.yaml` `recall_inject:` policy block that declares slices.
- Lane C changes active-inject, which records the emitted set and splits the payload, and adds the pure splitter and the new `reground-deliver` carrier.

One per-session file and an epoch written in a single locked step by active-inject make three things atomic: the compact reset, the recording of the cross-lane emitted set, and the queue overwrite. The shipped hooks and the pure-core API keep their shape. Every new path is either gated off or a no-op when unset.

**Override of the consultant's carrier suggestion.** The consultant proposed piggybacking part delivery on the already-spawned PreToolUse `pretool-orient` process to avoid an extra spawn. We do not do that. Nothing in this repository verifies that the hosts accept `additionalContext` on PreToolUse, and `hooks/lib/context-events.ts` records that emitting on an event the host does not accept is strictly worse than silence, because the payload is echoed into a validation error. PostToolUse `additionalContext` has a shipped precedent (`hooks/post-write-reminder.ts`). We pay one extra short spawn per tool call, which mirrors the accepted cost of the PreToolUse `*` `pretool-orient` registration, and the new hook exits before any vault read when its flag is off.

## Design decisions

- **Recall dedupe key.** The key is origin, vault-relative path and line span: `<origin>:<path>#L<start>-L<end>`, with an empty origin for the primary vault. This is the exact identity a brief bullet points at. A different span of a long note is different content the agent has not been shown, so it stays eligible. Alternative considered: path only, which the premise check suggested. Rejected, because it would hide new chunks of long notes after one chunk was shown once. Against the active digest the match is path-only, because the digest delivers whole preferences, not spans.
- **What gets recorded.** The core returns `injectedNotes` on an `inject` decision. These are exactly the notes rendered into the brief after the decision-model filter and after char-budget fitting. The hook records them after the stdout write. Alternative considered: recording the pre-render candidate list. Rejected, because a note cut by the 900-char fit would be suppressed without ever having been shown.
- **Filter position and the floor coupling.** Retrieval stays at `limit = maxNotes`. The floor is checked on the unfiltered retrieval, then dedupe filters, then the `maxNotes` slice applies. There is no over-fetch and no backfill. Alternative considered: over-fetching to refill after dedupe. Rejected, because `idfWeightedCoverage` is measured over the retrieved rows, so over-fetching changes abstain/inject verdicts for the same prompt.
- **Dedupe default on under the opt-in hook.** `recall_inject_dedupe` defaults to true, but only matters while `recall_inject_enabled` is on, so a default install is untouched. The first prompt of every session stays byte-identical. Only repeated injection changes, which is the defect, and the change is disclosed in CHANGELOG for opt-in users. Alternative considered: default off for strict byte identity. Rejected, because the people who opted into the hook are the ones paying for the repeats.
- **Sessionless hosts.** `isRealSessionId` is true only for a non-empty session id. Without one, recall reads and writes no ledger and active-inject records nothing. Alternative considered: TTL-bounded dedupe in the shared `default` scope. Rejected, because one host's recall would suppress another's.
- **Epoch and reset.** Every SessionStart that emits (startup, resume, clear, compact) calls `beginInjectionEpoch`. In one locked write it sets the active emitted set, deletes the recall set, and sets or deletes the re-delivery queue. On `resume` this causes at most one repeat injection of a note, which is accepted for simplicity. Alternative considered: resetting only on `compact`. Rejected, because `clear` also discards the context, and a per-source table would add branching for no measurable gain.
- **Cross-lane emitted set.** `digestNotePaths(body)` maps each `` `pref-<slug>` `` token in the emitted text to `Brain/preferences/pref-<slug>.md`. It adds `Brain/active.md` when the active body is non-empty and `Brain/lessons.md` when the lessons body is non-empty, because both files are indexed and would otherwise be recalled verbatim. Only text that reached stdout counts. Under chunking, that includes parts still queued, because they are committed for delivery. Alternative considered: parsing `Brain/active.md` on disk. Rejected, because budget truncation means the file is not the delivered set.
- **Ledger writes only when a consumer exists.** active-inject writes the ledger only when `recall_inject_enabled` or `reground_parts_enabled` is on and a real session id is present. A default install therefore gets no new disk writes and no new state files.
- **Config layers.** Hook switches and numeric knobs go into the flat global config with env overrides, beside `recall_inject_enabled`, `nav_tier_enabled` and `hook_strict_enabled`. These are machine-level hook behaviour. Slices go into the vault's `_brain.yaml` because they name vault paths and note types. The global flat parser cannot express objects either. Alternative considered: flat-encoded slice keys in the global config. Rejected, because slices are vault content policy and the `_brain.yaml` block convention (`KNOWN_KEYS`, hard errors on out-of-range) already exists.
- **Slice config shape.** There is one `recall_inject:` block. `slices: [name, ...]` declares the slice names in order. Per-slice fields are flat-encoded as `slice_<name>_<field>`, as `active.most_applied_*` already does:
  - `heading` (string, default the name)
  - `path_prefix` (vault-relative)
  - `types` (inline array matched against frontmatter `type` through `SearchOptions.properties`)
  - `limit` (1..10)
  - `max_chars` (100..8000)

  Slice names match `^[a-z][a-z0-9]{0,23}$`. The name has no underscore, so the key splits unambiguously. The following are hard load errors:
  - an unknown field for a declared slice
  - a `slice_*` key for an undeclared name
  - duplicate names
  - more than 6 slices
  - out-of-range numbers

  A slice with neither `limit` nor `max_chars` takes the global caps.
- **Slice clamp and budget.** All slice retrievals run in parallel under one `withTimeBudget(timeBudgetMs)`; slices never get the budget each. The floor applies per slice, on that slice's own retrieval. Slices are allocated in declared order:
  - Each slice takes `min(slice.limit, notes left)` notes and `min(slice.max_chars, chars left)` of rendered lines.
  - The global `maxNotes` and `maxChars`, fence included, bound the sum.
  - A slice that finds nothing new is omitted.
  - A note already placed in an earlier slice is not repeated.

  If every slice abstains, the decision is `abstain` with reason `all_slices_abstained`, and the audit line carries per-slice `{name, outcome, notes}`. With slices declared there is still one fence and one audit record.
- **Part ceiling per host.** `resolveRegroundPartChars(runtime)` reads `reground_part_chars_<runtime>` first (`claudecode` or `codex`), then `reground_part_chars`, then the default 9000. The default is the observed Claude Code 10,000-unit persistence threshold less 10%, applied to Codex as well until measured. The range is 2000..100000, and an invalid value falls back to the default. Units are JS `.length`, which is UTF-16 code units, the host's own measure. Chunking applies only when `detectHookRuntime(payload)` is `claudecode` or `codex`, because those runtimes have the carrier registered. Any other runtime emits the single payload as today.
- **Splitting.** `splitRegroundParts(blocks, ceiling)` is pure:
  - It splits first at block boundaries (standing, then scoped, then memory, so priority order is kept), then at blank-line paragraph boundaries, then at line boundaries. A single over-long line is hard-cut.
  - Every part except a lone one carries the header `[Open Second Brain context - part i of n]` and, except the last, the trailer `(continued in part i+1 of n)`. Both are counted inside the ceiling.
  - At most 8 parts are produced. Anything past part 8 is dropped and reported as `parts_dropped` with `over_budget: true` in the receipt.
  - When the joined context fits, the function returns the input as one unchanged part, and the hook output is byte-identical to today.
- **Exactly-once hand-out and the lock.** The repository has a lock precedent in the per-scope advisory lockfile from `session-state.ts`. It has no lockfile-free precedent for claim semantics, so the design reuses that lock and writes through `atomicWriteFileSync`, so lock-free readers never see a torn file.
  - `takeRegroundPart` runs `updateHookState` with `tryOnce: true`. That is a single lock attempt with no retry, and on contention it returns `busy` and the carrier emits nothing for that event. The lock can never stall the hook.
  - A lockfile older than `HOOK_STATE_STALE_LOCK_MS` (30 s, three times the 10 s host timeout, so no live hook can hold it that long) is taken over. The takeover follows the stale-takeover precedent in `hooks/session-capture.ts`.
  - The cursor advance is written before the part is printed, so a crash between the two loses that part and never duplicates it. Delivery is exactly once in the absence of a crash in that window.
- **User prompt carries a part instead of cancelling.** The card says a real user prompt cancels the queue, because upstream's turn-start path re-delivers its loaders anyway. In Open Second Brain nothing on UserPromptSubmit re-delivers the active digest. After a manual `/compact` the very next event is a user prompt, so cancelling would drop parts 2..n almost every time. That is the failure the card exists to fix. So `reground-deliver` is registered on UserPromptSubmit too and hands out the next part there. A new SessionStart replaces the queue under a new epoch, which covers the card's "restart on compaction". Alternative considered: cancel on prompt, as the card says. Rejected for the reason above.
- **Carrier event gating.** `reground-deliver` emits only for an exact `hook_event_name` of `PostToolUse` or `UserPromptSubmit`, following the `post-write-reminder` precedent. `CONTEXT_EVENT_NAMES` is not widened, because that list states what the injecting hooks emit, and widening it would license recall-inject and nav-inject on PostToolUse.
- **Meter.** `recordInjectionSize` gains `utf16_chars`, `part_ceiling_chars`, `parts_total`, `parts_dropped` and `over_budget` under `extra.injection`. These fields are present only when `reground_parts_enabled` is on, so today's receipt shape is unchanged. Each carrier delivery writes one hook audit line with `part`, `total`, `epoch`, `bytes`, `utf16_chars`, `part_ceiling_chars` and `over_budget`.
- **Hook-state growth.** `pruneHookStateFiles(vault)` deletes scope files whose mtime is older than 7 days, at most 200 per sweep. active-inject calls it only when it has just written the ledger on a `startup` SessionStart, so the cost is paid at most once per new session and only by installs that use these features.
- **Abstain vocabulary.** `all_already_injected` and `all_slices_abstained` join the `RecallAbstainReason` union. They flow through the existing telemetry and audit projections, which already carry `reason` verbatim. The verdict-vocabulary census registers recall faults, not abstain reasons (verified), so no census change is needed.

## File changes

Substrate S (lands first):
- `hooks/lib/session-state.ts` (modified): `updateHookState`, `HookStateMutator`, `HookStateUpdateOutcome`, `HOOK_STATE_STALE_LOCK_MS`, `pruneHookStateFiles`; `writeHookStamp` switches to an atomic-rename write.
- `hooks/lib/injection-ledger.ts` (new): key constants, `isRealSessionId`, `recallNoteKey`, `readRecallInjected`, `recordRecallInjected`, `readActiveEmittedPaths`, `digestNotePaths`, `beginInjectionEpoch`, `takeRegroundPart`, `RegroundTake`.
- `src/core/config.ts` (modified): `resolveRecallInjectCaps`, `resolveRecallInjectDedupe`, `resolveRegroundPartsEnabled`, `resolveRegroundPartChars`, `REGROUND_PART_CHARS_DEFAULT`.
- Tests: `tests/hooks/session-state.test.ts` (extended), `tests/hooks/injection-ledger.test.ts` (new), `tests/core/config-recall-inject.test.ts` (new).

Lane A, recall:
- `src/core/brain/recall-inject.ts` (modified): `alreadyInjected` and `activeDigestPaths` options, `injectedNotes` on the inject decision, new abstain reasons, a `slices` option with a per-slice retriever factory, sectioned rendering.
- `hooks/recall-inject.ts` (modified): reads `session_id`, caps, the dedupe flag, the ledger and slices; records after stdout; audit fields `config_invalid`, `deduped`, `slices` and `slices_config`. A `_brain.yaml` that fails to load falls back to the unsliced path, recorded as `slices_config: "invalid"`.
- Tests: `tests/core/brain/recall-inject.test.ts` (extended), `tests/core/brain/recall-inject-slices.test.ts` (new), `tests/hooks/recall-inject.test.ts` (extended), `tests/hooks/recall-inject-dedupe.test.ts` (new).

Lane B, slice declaration:
- `src/core/brain/policy/blocks/recall-inject.ts` (new): `parseRecallInjectBlock` and the slice bounds constants.
- `src/core/brain/policy/validate.ts` (modified): registers the block.
- `src/core/brain/types.ts` (modified): `RecallSliceSpec`, `BrainRecallInjectConfig`, `BrainConfig.recall_inject`.
- Tests: `tests/core/brain/policy/recall-inject-block.test.ts` (new).

Lane C, active digest and re-delivery:
- `src/core/brain/reground-parts.ts` (new): `splitRegroundParts`, `RegroundSplit`, `REGROUND_MAX_PARTS`.
- `hooks/active-inject.ts` (modified): records the ledger epoch, splits, emits part 1, adds meter fields, prunes.
- `hooks/reground-deliver.ts` (new): the PostToolUse and UserPromptSubmit carrier.
- `hooks/hooks.json` (modified): PostToolUse `*` and a UserPromptSubmit entry for `reground-deliver`. `plugins/codex/hooks/hooks.json` is regenerated by `bun run sync-plugin-mirrors`.
- `tests/core/install/adapters/grok-hook-parity.test.ts` (modified): declared grok divergences for `reground-deliver`.
- Tests: `tests/core/brain/reground-parts.test.ts` (new), `tests/hooks/active-inject-ledger.test.ts` (new), `tests/hooks/active-inject-reground.test.ts` (new), `tests/hooks/reground-deliver.test.ts` (new), `tests/hooks/hooks-json-shape.test.ts` (extended with assertions for the two new `reground-deliver` entries).

Docs task D (last):
- `docs/decision-models/recall-inject.md` (dedupe, caps, slices), `docs/cli-reference.md` (the config keys beside `recall_inject_enabled` at :739 and the context-delivery keys at :816), `docs/observability.md` (receipt and audit fields), `hooks/README.md` (rows for the new `reground-deliver` registrations). The root `README.md` does not list hook config keys, so it and its Codex mirror stay unchanged.

## Risks and open questions

- **Per-tool-call spawn.** The new PostToolUse `*` registration adds one short bun process per tool call for every install, including installs with the flag off. Mitigation: the hook checks `reground_parts_enabled` before resolving the vault or reading state, and the plan's acceptance includes a flag-off test asserting no state directory is created. The cost matches the shipped PreToolUse `*` `pretool-orient` precedent.
- **Host acceptance of PostToolUse context on Codex.** This rests on the same assumption as the mirrored `post-write-reminder`. If Codex ignores it, parts queue and expire with the 24 h TTL. No error surfaces and nothing is duplicated.
- **Lock contention between lanes.** recall and active writes use the existing 20 x 5 ms retry, and the carrier uses try-once. A burst of parallel tool calls can skip several deliveries, but the next event delivers. Delivery is never duplicated.
- **Byte identity.** These cases are pinned by tests: flag off (recall and reground), flag on with no new keys on the first prompt, no `recall_inject:` block, a payload that fits the ceiling, and the active-inject receipt shape with the reground flag off.
- **Dedupe behaviour change for opt-in users.** The second and later prompts may abstain where they used to repeat. This is disclosed in CHANGELOG. `recall_inject_dedupe: false` restores the old behaviour.
- **Slice retrieval cost.** Up to 6 parallel searches compete for the 2.5 s budget on a large vault. A timeout still yields the existing fail-closed `error` decision, and operators trade slice count against latency. The docs say so.
