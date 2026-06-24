# Session Lifecycle Capture Durability — implementation plan

Branch: `feat/session-lifecycle-capture-durability`

Overall release scope (ships together in this single release):

- `t_c181f92b` — Capture interrupted sessions: `on_session_end(interrupted=True)` + persisted transcript (#50004/#50003/#50312).
- `t_3b8fe3a1` — Verify memory `on_session_end` fires on `/exit` now native (#49315); drop any workaround.
- `t_12c8b256` — Post-compaction pinned-anchor survival audit and selective re-assertion.

Combined design: `docs/brainstorm/session-lifecycle-capture-durability/design.md`.
Full variant audit: `docs/brainstorm/session-lifecycle-capture-durability/variants.md`.

Drive these cards **one at a time** on the shared branch. Each worker MUST
`git log` and `git status` before editing, build on the commits previously-driven
in-scope cards already landed, and must not duplicate or conflict with sibling
tasks. Follow each section under TDD (write the failing test first).

Recommended drive order: `t_c181f92b` first (lands the `interrupted` field that
the other two reason about), then `t_3b8fe3a1` (verification, smallest), then
`t_12c8b256` (the new audit module, largest, builds on the pinned/continuity
substrate the first two also touch).

## t_c181f92b — Capture interrupted sessions: on_session_end(interrupted=True) + persisted transcript

### Files

- `plugins/hermes/provider.py`
- `src/core/brain/session-lifecycle.ts`
- `src/cli/brain/verbs/session-hook.ts` (typed access only; payload is read verbatim from stdin)
- Focused tests under `tests/`

### Plan

1. Add an optional `interrupted?: boolean` field to `NormalizedPayload`
   (`session-lifecycle.ts`), normalized from the host hook payload. Absent by
   default — when the host does not emit it, behaviour is byte-identical.
2. In `provider.py`, surface the `interrupted` kwarg from `on_session_end`
   (`**_kwargs`) onto the hook payload the provider emits, and forward the
   transcript path (`session-transcript.jsonl`). Python makes no capture decision.
3. In the `SessionEnd` branch of `captureSessionLifecycleEvent`, when
   `interrupted === true`: consume the pre-restart transcript (the `messages`
   list and/or the persisted `session-transcript.jsonl`) so in-flight turns
   reach marker/fact/handoff extraction like a clean close.
4. Reuse `resolveSessionLineage` to recognize a resume as a lineage child of the
   interrupted session; reuse the existing capture-boundary dedupe, signal `dedup_hash`, and
   continuity payload-level `dedupe_key` conventions (scoped to the same
   `sessionId`/turn range) so turns already captured by the pre-interrupt flush
   are not re-captured on resume.
5. Record the interrupted status honestly in the audit record: `interrupted:
   true` plus `transcript_consumed: true|false`. If the transcript cannot be
   consumed, surface `transcript_consumed: false` — never coerce to a clean
   `SessionEnd`.
6. Keep it fail-soft: a transcript read or extraction failure must never raise
   into Hermes.

### Acceptance (passing test)

- A test drives `captureSessionLifecycleEvent` with an `interrupted: true`
  `SessionEnd` payload carrying a transcript, and asserts:
  - the in-flight turns from the transcript are captured (markers/facts reach
    storage);
  - the audit record carries `interrupted: true` and `transcript_consumed: true`;
  - resuming the same `sessionId` does NOT create duplicate continuity records
    (same existing dedupe seams / payload-level `dedupe_key` pattern) and does
    not re-capture turns already captured by the interrupted close.
- A second test asserts an absent `interrupted` field leaves the clean-close
  path byte-identical (no audit `interrupted` key, existing tests unchanged).

### Depends on

- No in-scope card dependency. Land first; `t_3b8fe3a1` and `t_12c8b256` reason
  about the same field/substrate.

## t_3b8fe3a1 — Verify memory on_session_end fires on /exit now native (#49315); drop any workaround

### Files

- `plugins/hermes/provider.py` (delete any workaround/poll found at verification time)
- `plugins/hermes/_base.py` (only if the fallback ABC needs threading; likely no change)
- A regression test under `tests/`

### Plan

1. Confirm against merged Hermes #49315 that the provider's `on_session_end`
   now fires on CLI `/exit`. Static grep across `plugins/hermes/` and `src/`
   found no `atexit`/`poll`/workaround compensating for the missing hook —
   confirm at runtime that none exists and none is needed.
2. If a workaround/poll IS discovered during verification, delete it (it is now
   dead/misleading code that duplicates the native hook). Update any comment
   that referenced the missing hook.
3. Add a regression test that drives the provider's `on_session_end` hook
   directly (unit-level, no live Hermes required) and asserts the drain+flush
   capture path runs — guarding against a future regression of the `/exit`
   binding.

### Acceptance (passing test)

- A test constructs `OpenSecondBrainMemoryProvider` with a fake bridge, calls
  `on_session_end(messages=[...])`, and asserts the buffered turns are flushed
  to the bridge (`brain_pre_compact_extract` called) and the capture threads are
  drained — proving end-of-session capture runs on the path `/exit` now drives.
- `grep -rni "atexit\|poll\|workaround\|missing hook" plugins/hermes/` returns
  no compensating workaround code (or, if one is found and removed, the test
  passes without it).

### Depends on

- Ideally after `t_c181f92b` (shares the `on_session_end` surface), but no hard
  dependency — can land in either order on the shared branch.

## t_12c8b256 — [upstream:hermes-memlock] Post-compaction pinned-anchor survival audit and selective re-assertion

### Files

- `src/core/brain/post-compact-audit.ts` (new)
- `src/core/brain/pinned.ts` (expose read helper if needed; reuse `readPinnedContext`; no budget change)
- A CLI verb / host hook entry under `src/cli/brain/verbs/` for the post-compaction audit
- `src/core/config.ts` (add absent-by-default `post_compact_survival_audit` key) if config-gated
- Focused tests under `tests/`

### Plan

1. Create `post-compact-audit.ts` symmetric to `pre-compact-extract.ts`. It is
   deterministic and LLM-free. Reuse the continuity store (`ContinuityRecord`,
   `listContinuityRecords`) and `readPinnedContext`.
2. Compaction detection: scan the conversation for Hermes compressor handoff prefixes
   (`SUMMARY_PREFIX`, ASCII fallback, and legacy `[CONTEXT SUMMARY]:`); hash the
   summary body; compare against a per-session audited-compaction set (a
   `post_compact_audit` continuity record carrying a payload-level dedupe key
   derived from `sessionId + summaryHash`) so only a genuinely NEW compaction
   triggers an audit.
3. Survival audit: for each pinned anchor, run a keyword probe (derived from the
   anchor text, locale-agnostic) scoped to the ACTIVE (non-summary) region. An
   anchor whose probes hit only inside the summary block counts as drifted.
4. Selective re-assertion: re-inject only drifted anchors as a reminder block via
   `appendPinnedContext` (or a dedicated re-assertion entry). Survivors cost zero
   tokens. Re-injection is on-drift only, never a blanket per-turn injection.
5. Optional windowed-embedding probe: off by default (config flag
   `post_compact_survival_audit_embedding`); keyword probes are the default.
6. Fail-open: any probe or re-injection failure is logged to a bounded drift log
   and must never break a turn. Wire the audit behind an absent-by-default config
   flag (`post_compact_survival_audit`) so unchanged installs are byte-identical.

### Acceptance (passing test)

- A test seeds pinned anchors, feeds a conversation containing a Hermes
  compaction-prefix block with one anchor demoted into the summary and one still
  in the active region, runs the audit, and asserts:
  - the drifted anchor is re-asserted (a re-assertion record / reminder block is
    written);
  - the surviving anchor is NOT re-injected (zero tokens spent);
  - a second audit of the SAME summary (same hash) does not re-run the audit
    (idempotent via the per-session audited-compaction key);
  - a malformed/empty conversation does not raise (fail-open) and produces a
    bounded drift-log entry.

### Depends on

- After `t_c181f92b` (shared `session-lifecycle.ts` / continuity substrate). No
  dependency on `t_3b8fe3a1`. Reuse `pinned.ts` and the continuity store as-is.
