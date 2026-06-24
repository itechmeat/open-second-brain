# Session Lifecycle Capture Durability — not losing or distorting memory at session boundaries

**Status:** implementation-ready
**Author:** product-tech-lead (via Phase 0 brainstorm)
**Audience:** implementation
**Branch:** `feat/session-lifecycle-capture-durability`

## Problem statement

Open Second Brain captures memory at session boundaries — when the agent's
host runtime (Hermes CLI/TUI/gateway) fires `on_session_end` and
`on_pre_compress`. Three real durability gaps exist at exactly those
boundaries:

1. **Interrupted sessions were silently dropped.** Before Hermes PRs
   #50004/#50003/#50312 (now merged), a SIGHUP/SIGTERM/force-quit/restart-drain
   never flushed the in-flight transcript and never fired `on_session_end`.
   The conversation that was interrupted mid-way left no memory trace. Now that
   Hermes flushes the transcript and fires `on_session_end(interrupted=True)`,
   OSB must (a) honour the flag, (b) consume the now-available pre-restart
   transcript, and (c) avoid double-counting turns when the same session is
   resumed later. Today OSB swallows `interrupted` into `_kwargs` and ignores it.

2. **End-of-session capture silently did not fire on `/exit`.** Hermes #49315
   (merged) restored the memory-provider `on_session_end` hook on CLI `/exit`
   (a Phase 4 god-file refactor had rebound the atexit `_active_agent_ref` to
   the wrong module, so the hook never ran). OSB may carry a local
   workaround/poll that compensated for the missing hook; that workaround must
   be verified-unnecessary and removed, otherwise it is dead/misleading code.

3. **No post-compaction survival check for pinned anchors.** OSB owns the
   pinned-context store (`pinned.ts`) and a PRE-compaction capture pass
   (`pre-compact-extract.ts` that pulls decisions/rules out before compaction).
   It has no symmetric POST-compaction survival audit: nothing verifies a
   pinned fact still lives in the ACTIVE (non-summary) region after Hermes
   summarizes the conversation, and nothing re-asserts the ones that drifted
   into the summary. This is the exact long-conversation failure mode pinned
   context exists to fight.

These three share one substrate (`provider.py`, `session-lifecycle.ts`,
`pinned.ts`, `pre-compact-extract.ts`, the continuity store) and fold into one
release: "do not lose and do not distort memory at session boundaries."

## Grounding: what already exists (do NOT rebuild)

- The hook contract already hands `messages` to `on_session_end`; `interrupted`
  arrives as a kwarg. The Python provider is a thin orchestrator — deterministic
  logic belongs in the TS core, not Python.
- `sync_turn` already persists every turn durably to
  `hermes_home/open-second-brain/session-transcript.jsonl` (`_persist_turn`),
  so an interrupted session's turns are recoverable from disk independent of
  the in-memory `messages` list.
- The capture boundary in `session-lifecycle.ts` already dedupes sessions and
  suppresses repeated message text; double-counting protection has a substrate.
- `resolveSessionLineage` + `recordLineageObservation` +
  `isCompressionEvidenceEvent` already exist — a resume after an interrupt is
  already detectable as a lineage child.
- The continuity store's generic `recordId()` is content-derived over
  `kind + createdAt + sourceRefs + payload`; `extractPreCompactRecords` also
  carries an explicit payload-level `dedupe_key` built from
  `sessionId + turnStart + turnEnd + type + contentHash`. Reuse those existing
  idempotency seams instead of inventing a new ledger.
- `extractPreCompactRecords` (kind `pre_compact_extract`) is the symmetric
  pre-compaction pass that this release's survival audit complements.
- `on_pre_compress` already exists as a seam; `pre-compress-pack.ts` is a
  read-only bundle that the host runtime injects before compression.
- All bridge calls go through `_safe_call` (fail-soft: hooks never raise into
  Hermes).

## Scope

- **t_c181f92b — interrupted-session capture.** Surface `interrupted` from the
  Python `on_session_end` kwarg as an explicit, absent-by-default field on the
  host hook payload; thread it into `NormalizedPayload`. On an interrupted
  `SessionEnd`, consume the pre-restart transcript (the `messages` list and/or
  the persisted `session-transcript.jsonl`) so the in-flight turns reach the
  same extraction as a clean close. Record the interrupted status honestly in
  the audit record. Suppress double-counting on resume by reusing the existing
  capture-boundary dedupe, signal `dedup_hash`, and continuity payload-level
  `dedupe_key` conventions scoped to the same `sessionId`/turn range. Fail-soft throughout.
- **t_3b8fe3a1 — verify `/exit` hook, drop workaround.** Confirm the provider's
  `on_session_end` capture now fires on CLI `/exit` against the merged #49315,
  and remove any local workaround/poll that compensated for the missing hook
  (none was found by static grep across `plugins/hermes/` and `src/`, so this is
  primarily a verification + a guard against regressions). The work product is a
  regression test asserting end-of-session capture runs on the `/exit` path, plus
  deletion of any dead compensating code discovered during verification.
- **t_12c8b256 — post-compaction pinned-anchor survival audit.** A
  deterministic, no-LLM audit that detects a Hermes compaction event (scans the
  conversation for Hermes compressor handoff prefixes (`SUMMARY_PREFIX`, ASCII
  fallback, and legacy `[CONTEXT SUMMARY]:`), hashes the summary body to detect
  a NEW compaction vs. one already audited), then for each pinned
  anchor runs a keyword probe scoped to the ACTIVE (non-summary) region. An
  anchor whose probes hit only inside the summary block counts as drifted and is
  re-asserted as a reminder block via the existing pinned store; survivors cost
  zero tokens. Optional windowed-embedding probe is off by default. Fail-open;
  bounded drift log. Sits as a new module symmetric to `pre-compact-extract.ts`.

## Out of scope

- **No replacement of existing lifecycle/continuity idempotency seams**
  with a new ledger. Reuse capture-boundary suppression, signal `dedup_hash`,
  continuity `recordId()`, and existing payload-level `dedupe_key` patterns; a
  new append-only ledger would risk regressions in already-shipped capture paths
  and violates
  "additive where possible." (The honest slice of Variant 3, rejected.)
- **No new `SessionContinuityEvent` abstraction / unified pipeline.** Three
  parallel additive code paths are lower-risk than a core-store refactor for a
  single release. Unification is available as a later refactor if the parallel
  paths prove worth merging.
- **No preemptive / every-turn blanket re-injection.** Re-injection is a repair
  action (on-drift), not a per-turn injection — keeps prompt-cache stable.
- **No embedding index built eagerly.** The optional embedding probe, if ever
  added, stays behind a flag and off by default; the audit defaults to keyword
  probes only.
- **No changes to the host runtime's own compaction or transcript-flush
  behavior.** OSB consumes what Hermes emits; it does not alter Hermes.
- **No locale-specific keyword tables.** Anchor keywords/probes are derived from
  the pinned content itself, locale-agnostic.

## Chosen approach

**Variant 2 — Minimal seam-reuse, three independent additive diffs.** Each task
is a small diff against an existing seam, gated by an absent-by-default field or
flag, so unchanged installs are byte-identical.

- t_c181f92b: an optional `interrupted` boolean on the hook payload →
  `NormalizedPayload`, consumed by the existing `SessionEnd` branch. Resume
  detection reuses `resolveSessionLineage`; de-dup reuses capture-boundary
  suppression, signal `dedup_hash`, and existing continuity payload-level
  `dedupe_key` conventions rather than a new ledger.
- t_3b8fe3a1: verification + deletion of any local workaround in `provider.py`;
  a regression test for the `/exit` path.
- t_12c8b256: a new post-compaction audit module reusing
  `extractPreCompactRecords`-shaped continuity records and `readPinnedContext`,
  with a bounded drift log, behind an absent-by-default config flag.

This is the lowest-risk path because the release scope itself catalogues the
exact substrates each task needs, and the repo conventions explicitly require
additive / byte-identical-when-unused behaviour. It avoids both Variant 1's
premature TS consolidation (which pushes transcript bytes across the bridge even
when the flag is absent) and Variant 3's risky core-store replacement.

## Design decisions

1. **Python stays dumb.** `provider.py` only surfaces the `interrupted` kwarg
   onto the payload and forwards the transcript path; no capture decisions in
   Python. Deterministic logic, dedupe, and audit live in the TS core. This
   honours the "core is LLM-free and unit-testable" invariant and keeps the
   shim fail-soft by construction.
2. **`interrupted` is absent-by-default.** The payload field is optional; when
   Hermes does not set it, behaviour is byte-identical to today. No field is
   invented when the host does not emit it.
3. **Double-counting is prevented by existing idempotency seams, not by a
   new ledger.** A resumed session shares the original `sessionId`; turns
   captured by the pre-interrupt flush are suppressed on re-capture via
   capture-boundary message suppression, signal `dedup_hash`, and the same
   payload-level `dedupe_key` pattern already used by `pre_compact_extract`
   (`sessionId + turnStart + turnEnd + type + contentHash`). No new
   idempotency store.
4. **Honest surfacing of an un-honourable interrupted flag.** If the
   interrupted flag is present but the transcript cannot be consumed (empty
   `messages`, unreadable transcript path), the audit record records
   `interrupted: true` with a `transcript_consumed: false` detail rather than
   silently coercing to a clean `SessionEnd`. No misleading fallback.
5. **Survival audit is the symmetric complement to `extractPreCompactRecords`.**
   It reuses the continuity store and the same `pre_compact_extract`-shaped
   record (a new `post_compact_audit` kind where the lifecycle differs), a
   Hermes compaction-prefix scan (`SUMMARY_PREFIX`, ASCII fallback, and legacy
   prefix) + summary-body hash to detect a NEW compaction, and a keyword probe
   over the non-summary region. Re-injection is on-drift only.
6. **Deterministic, fail-open audit.** The survival audit never calls an LLM;
   the optional embedding probe is off by default. A probe or re-injection
   failure must never break a turn (fail-open), and the drift log is bounded.
7. **English-only, locale-agnostic.** Probe keywords are derived from the
   pinned anchor text itself; no hardcoded locale word lists.

## File changes (planned surface)

**t_c181f92b**
- `plugins/hermes/provider.py` — surface `interrupted` from the `on_session_end`
  kwarg onto the hook payload; forward the transcript path. (Thin adapter only.)
- `src/core/brain/session-lifecycle.ts` — add optional `interrupted` to
  `NormalizedPayload`; in the `SessionEnd` branch, when `interrupted` is true,
  consume the pre-restart transcript and record it honestly; reuse existing
  lineage + dedupe for resume de-dup.
- `src/cli/brain/verbs/session-hook.ts` — pass the field through (payload is
  already read-from-stdin verbatim; only typed access changes).
- Focused tests under `tests/`.

**t_3b8fe3a1**
- `plugins/hermes/provider.py` — delete any workaround/poll discovered during
  verification (static grep found none; verification will confirm at runtime).
- A regression test asserting end-of-session capture fires on the `/exit` path.
- `plugins/hermes/_base.py` — only if the fallback ABC needs the field threaded
  (likely no change; `_kwargs` already absorbs it).

**t_12c8b256**
- `src/core/brain/post-compact-audit.ts` (new) — compaction detection
  (Hermes compaction-prefix scan + summary-body hash), keyword-probe survival audit scoped
  to the non-summary region, selective re-assertion via `readPinnedContext`/
  `appendPinnedContext`, bounded drift log.
- `src/core/brain/pinned.ts` — expose any read helper the audit needs (reuse
  existing `readPinnedContext`); no budget change.
- A CLI verb / host hook entry that runs the audit post-compaction, behind an
  absent-by-default config flag (`post_compact_survival_audit`).
- Focused tests under `tests/`.

## Risks

- **Double-counting on a real interrupt→resume cycle.** Mitigated by reusing
  capture-boundary suppression, signal `dedup_hash`, and payload-level
  continuity `dedupe_key` patterns scoped to `sessionId`/turn range, plus an
  explicit test that resumes an interrupted session and asserts zero duplicate
  records and zero re-captured turns. Risk: low.
- **Transcript-consumption correctness under partial flush.** The pre-restart
  transcript may be partially flushed. Mitigated by treating the persisted
  `session-transcript.jsonl` as the source of truth (already durable) and
  recording `transcript_consumed` honestly when only a partial read is possible.
  Risk: low.
- **Compaction-detection false positives.** A Hermes compaction-prefix literal
  appearing in user text could masquerade as a compaction boundary. Mitigated by hashing
  the summary body and comparing against a per-session audited-compaction set, so
  only a genuinely NEW compaction triggers an audit. Risk: low-medium.
- **Survival-audit keyword-probe drift (recall/precision).** Keyword probes may
  miss a drifted anchor that was rephrased. Mitigated by fail-open behaviour
  (a missed re-assertion is a soft loss, not a turn-breaker) and the optional
  off-by-default embedding probe for users who want higher recall. Risk: low.
- **`/exit` verification flakiness.** The verification is runtime-dependent on
  the merged #49315; CI cannot run a live Hermes. Mitigated by a unit-level
  regression test that drives the provider hook directly, plus a static
  confirmation that no workaround code remains. Risk: low.
