# Context injection pipeline - deliver, digest and degrade the agent's automatic context channel

**Status:** draft
**Author:** ZCode orchestrator (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain injects its learned preferences at session start, but the automatic context channel has three gaps. A delegated subagent turn never sees the standing rules, so the agent that performs the actual writes can be exactly the one running without them. Brain hygiene findings (contested, duplicate, stale, unused memories, dangling links) are computed only on demand, so small maintenance waits for an explicit request. And under budget pressure the injected digest drops whole sections at once, so one oversized section erases an entire rule group that a per-item headline tier would have kept.

## Premise verification

Verdicts from targeted reads against this tree at 542d214b, on top of the three recon reports for this run.

- **t_047277c5 — premise_confirmed.** `CONTEXT_EVENT_NAMES` is exactly `["SessionStart", "UserPromptSubmit"]` (hooks/lib/context-events.ts:26, with the SubagentStop rationale in the docblock); the SubagentStop registration is capture-only (hooks/hooks.json:125); reground-deliver skips calls with a non-empty `agent_id` (hooks/reground-deliver.ts:170); a PostToolUse hook emitting `additionalContext` is proven (hooks/post-write-reminder.ts:123); `INSTALL_TARGET_ID` has no claude target and the writeback contract audits `AGENT_INSTRUCTION_FILES` read-only (src/core/brain/writeback-contract.ts:72-76).
- **t_6b500bed — premise_confirmed.** `runHygieneScan` is a pure, unpersisted scan with a deterministic per-finding id and an `info|warning|action` severity vocabulary (src/core/brain/hygiene/scan.ts:53, types.ts:68-80); the Stop channel is proven end to end by stop-log-guardrail (skip on `stop_hook_active` :43, one-line stdout emit :58, per-runtime output shape hooks/lib/messages.ts:119-126), and the only Stop content today is the unrecorded-artifact nudge (`STOP_GUARDRAIL_TEXT`).
- **t_d96e3e54 — premise_corrected.** Core premise confirmed: there is no intermediate headline tier; eviction is whole-section, least-important-first (src/core/brain/text/text-budget.ts:149, drop loop :163-167, "Intermediate sections are never partially kept" :160-162). Correction (flagged by the validator, re-verified here): the card's "kept or dropped whole" evidence overstates, because a deterministic tail-trim of the single last surviving section already exists (`trimToLines` :131-142) with a `headLines` guard (:37-39) that no caller sets today. One more reading-shaped fact: Most-applied bullets render without principle text by design (src/core/brain/active.ts), so a headline tier must keep the id-tag group, not assume a principle follows. The build proceeds on the corrected premise.

One recon correction found during verification: `scripts/o2b-hook` resolves `hooks/<name>.ts` by name against candidate roots, so a new hook needs NO dispatcher change; the recon sketch's "map the new name" step is void.

## Scope

- A subagent carrier - SubagentStart primary, PostToolUse write-shaped fallback - that delivers the context payload (standing rules, scoped rules, the budgeted active digest) into subagent turns, once per subagent per session-scope ledger, always on, silent only when the whole payload is empty.
- A Stop hook that surfaces pending Brain hygiene findings as one line, once per change, behind an opt-in config flag, running the full default detector sweep plus the index-backed dangling-link count, gated to turns that wrote an artifact.
- A deterministic headline tier between section-intact and section-dropped in the shared budget core, mirrored in the doctor pressure probe, with the truncation notice naming tiered sections.
- Documentation rows for both new hooks and the new flag, plus the tier wording (integrator task).

## Out of scope

- The instruction-file route (managed block in CLAUDE.md/AGENTS.md) and any new install target: deferred until workspace-CLAUDE.md delivery into Task-subagent turns is verified against the host; the writeback contract and instruction-file ceiling stay untouched.
- The upstream delivery-gate self-check (asking the model what context it received): deferred; delivery verification for this PR happens externally during QA.
- Model-based summarization: tiers are deterministic text extraction only.
- Any semantic change to `applySectionBudget` for its existing consumers (standing-rules, scoped-rules).
- Budget enforcement on the MCP surfaces (`brain_context`, `osb://preferences/active` stay un-budgeted).
- A detector-subset config key: only a named in-repo constant exists; a fallback key would be scope creep.
- Changes to `CONTEXT_EVENT_NAMES`, `reground_parts_enabled`, or the reground pipeline.

## Chosen approach

Variant 3 from the brainstorm (tiered hybrid), recommended by the consultant and confirmed by the orchestrator. Delivery is split by audience: the full session-start composition (the standing-rules digest plus scoped rules and the budgeted active context) rides the official SubagentStart hook into subagent turns, delivered at the subagent start and again if the subagent compacts (the PostToolUse write carrier stays registered as the fallback for runtimes without that event, once per sub-agent per session), while SessionStart keeps serving the main thread and re-injects through its `compact` matcher. Hygiene findings ride the proven Stop channel as a one-line digest, computed by the full default sweep only on turns that wrote an artifact, deduplicated once per change by a vault-level hash ledger. Budget degradation gains a deterministic headline tier in the shared section-budget core, applied before whole-section eviction, with the doctor pressure probe mirroring the tier step so the two surfaces never disagree.

Orchestrator rationale (agreeing with the consultant): every delivery claim lands on a channel verified in this tree, while the instruction-file route rests on a host behavior (workspace CLAUDE.md reaching Task-subagent turns) that cannot be verified from this repo and would write into files the writeback contract audits read-only. Against the hook-only variant, this approach keeps full hygiene coverage instead of permanently dropping the detectors behind the card's own example, and solves ranking locally with a constrained parse instead of changing the shared budget signature that lessons.md also consumes. Its residual risks are measurable during QA; the instruction-file route's core assumption is not.

## Design decisions

- **Carrier audience and timing.** The carrier registers primarily on SubagentStart, the official Claude Code event fired when the Task tool spawns a sub-agent: delivery lands at the subagent conversation start, before its first prompt, and the host re-injects the context if the subagent compacts. Runtimes without that event are covered by the fallback registration: PostToolUse with the `Write|Edit|MultiEdit|apply_patch` matcher (the post-write-reminder precedent), which fires on write-shaped tool calls - the moments learned rules govern - and skips read-only subagents. On both events a payload without a non-empty `agent_id` exits silently before any work (`agent_type` alone is not a sub-agent marker; reground-deliver.ts:170 precedent).
- **Carrier content.** The full context payload, not the standing rules alone: the standing-rules block, the scoped operator rules for this project and device, and the budgeted active context (`Brain/active.md` + `Brain/lessons.md`, runtime notices ahead of them), all through the assembly extracted into `hooks/lib/active-context.ts` and shared with the session-start lane, so the carrier's payload and the session preamble can never disagree about what the operator's context says. Rationed by the same `active.inject_budget_chars` - the tier ladder degrades oversized sections automatically. Silence only when the ENTIRE payload is empty, so a vault without a rules file still delivers its learned digest; a failed rules read still yields the explicit failure block, never a fake "no rules" (the distinction renderStandingBlock already owns), and a memory assembly that throws degrades the memory lane to empty rather than taking the rules lanes down. The carrier emits no per-source receipt: the meter feeds the session-start receipt, not the carrier.
- **Delivery ledger.** A new ledger key `osb.subagent_inject.delivered` holds a capped set of agent ids in the existing per-session-scope hook-state file (24h TTL, atomic writes, fail-soft readers — the injection-ledger pattern; cap constant mirrors the `RECALL_SET_MAX` rationale). Both registrations record into the same key, but only the fallback consults it: SubagentStart re-delivers on every event (the host re-fires it when a subagent compacts, and only the hook's answer re-injects the post-compaction context), while the fallback stays once per sub-agent per session. The id is recorded after emission: lose-not-duplicate.
- **Renderer extraction.** `renderStandingBlock` (module-private, hooks/active-inject.ts:800) moves with its failure-render helper and the `InjectionMeter` type into `hooks/lib/standing-block.ts`, meter parameter optional; `hooks/active-inject.ts` imports it and existing active-inject tests pass unchanged. The carrier passes no meter: the meter feeds the session-start context receipt, not the carrier.
- **Carrier output shape.** Runtime-agnostic, following the shape the shipped post-write-reminder proves is injected developer-side: every runtime gets `hookSpecificOutput.additionalContext`, with `hookEventName` naming the delivery event - `"SubagentStart"` on the primary channel, `"PostToolUse"` on the fallback - because the host validates hook output against a per-event schema and rejects a payload under the wrong event name. A `decision: "block"` is never a context channel on these events (on PostToolUse it flags the completed write as rejected). The helper is local to `hooks/subagent-inject.ts` so `hooks/lib/messages.ts` stays untouched by both lanes (cross-lane ownership). `CONTEXT_EVENT_NAMES` is untouched: that list governs the session-context hooks that consult it; the carrier follows the post-write-reminder precedent.
- **Hygiene gate.** The Stop hook copies the stop-log-guardrail skeleton: silent when `stop_hook_active === true`, silent without a readable transcript, silent when `resolveVault` returns null. It runs only when `summarizeTurn` reports the turn wrote an artifact, so "once per change" means once per artifact-writing turn (an artifact write anywhere counts - code outside the vault included). The line is emitted only on runtimes with a non-blocking Stop channel (Claude Code); everywhere else a Stop block would force a continuation turn, and an opt-in digest must never buy one, so those runtimes exit silently before the transcript work. The flag `hygiene_digest_enabled` (default off, `resolveRegroundPartsEnabled` precedent) is checked before vault resolution so the off path costs one config read.
- **Hygiene content and change detection.** On an eligible turn: `runHygieneScan` with the default sweep plus the dangling-link measurement from the existing search index (`link_integrity`). A pure composer folds findings into ONE line under a named length cap: counts by detector, `warning` and `action` severities only, deterministic detector order, full name "Open Second Brain" prefix, pointer to `o2b brain hygiene scan`. Zero eligible findings means emit nothing. The per-runtime output helper (Stop shape: `hookSpecificOutput.additionalContext` on claudecode, portable one-line block elsewhere) is local to `hooks/hygiene-digest.ts`; `hooks/lib/messages.ts` stays untouched. Change detection is `sha256Hex(canonicalJson(...))` over the sorted finding ids plus the dangling count, stored as a single overwrite-only file `<vault>/.open-second-brain/hygiene-digest.hash` beside `hook-state/` (un-synced derived state, size-1, no cleanup path). Hash differs: emit, then write. Hash equal: exit 0.
- **No dispatcher change.** `scripts/o2b-hook` resolves hooks by name; both new hooks are wired purely through `hooks/hooks.json` entries.
- **Tier ladder.** Inside `budgetActiveBody` only, applied before `applySectionBudget` and only when the split body exceeds the budget, so within-budget byte-identity is preserved. Sections at `KEEP_GUARD_PRIORITY` (preamble, Confirmed) are exempt. A tiered section keeps its heading, its non-bullet lead-in lines, and the top-N bullets (named constant, default 3); `headLines` is set to the kept non-bullet line count so a headlines-only remnant that still overflows drops cleanly through the existing `trimToLines` guard. `applySectionBudget` itself is untouched.
- **Bullet ranking.** Deterministic parse of the rendered line: only the first parenthesized group after the `` `id` `` prefix is read; principle text is never parsed, so nested parentheses like `(confidence: high (0.95))` cannot misrank. Ranking keys: `applied_in_window` descending (Most-applied), confidence value descending (Confirmed), `applied` descending then `violated` ascending (Quarantine). Lines without a recognizable id-tag prefix rank last in original render order (fail-open, deterministic — this is also the lessons.md path, which shares the entry point).
- **Notice.** When tiering fired, the notice names the tiered sections ("headlines kept") through the existing notice composer; when tiering alone brought the body within budget (no drops), `budgetActiveBody` emits the tier notice itself, so a reduction is never silent. Wording lives in named constants alongside `activeTruncationNotice`.
- **Probe mirror.** `computeActiveBudgetPressure` models the tier step (same exemptions, same top-N) so the doctor pressure probe and the reactive truncation keep their never-disagree contract; the docblock contract wording is updated with it.

## File changes

New:

- `hooks/subagent-inject.ts` — the PostToolUse subagent carrier (lane A).
- `hooks/lib/standing-block.ts` — extracted standing-rules renderer with optional meter (lane A).
- `hooks/lib/active-context.ts` — the payload assembly (limits, scoped block, budgeted active context) shared by the session-start lane and the subagent carrier (review-fix round, H2).
- `hooks/lib/hygiene-digest-text.ts` — pure one-line digest composer with wording constants (lane B).
- `hooks/lib/hygiene-digest-state.ts` — hash-ledger read/compare/write helpers (lane B).
- `hooks/hygiene-digest.ts` — the Stop hygiene-digest hook (lane B).
- `tests/hooks/standing-block.test.ts`, `tests/hooks/subagent-inject.test.ts`, `tests/hooks/hygiene-digest.test.ts`, `tests/hooks/hygiene-digest-ledger.test.ts`, `tests/hooks/hygiene-digest-text.test.ts` (lanes A and B).
- Extended: `tests/core/brain/text-budget.test.ts`, `tests/core/brain/active-budget.test.ts`, `tests/core/brain/active-budget-pressure.test.ts`, `tests/hooks/active-inject.test.ts`, `tests/hooks/hooks-json-shape.test.ts` (lanes A, B, C).

Modified:

- `hooks/active-inject.ts` — import the extracted renderer, delete the private copy (lane A).
- `hooks/lib/injection-ledger.ts` — new ledger key constant and capped-set helpers (lane A).
- `hooks/hooks.json` — one PostToolUse entry (lane A) and one Stop entry (lane B); see the cross-lane contract in plan.md for the exact JSON.
- `src/core/config.ts` and `src/core/brain/config-template.ts` — `hygiene_digest_enabled` resolver and template entry (lane B only).
- `src/core/brain/text/text-budget.ts` — bullet-split, first-group tag extraction and ranking primitives (lane C).
- `src/core/brain/active-budget.ts` — tier ladder, tier notice constants (lane C).
- `src/core/brain/active-budget-pressure.ts` — probe mirrors the tier step (lane C).
- `hooks/README.md`, `docs/how-it-works.md`, `docs/mcp.md` — integrator/docs task only.
- `CHANGELOG.md` — written inside the release PR per the playbook, not by the lanes.

Docs impact (from recon, landed by the integrator task): hooks/README.md event-table rows for both hooks; docs/how-it-works.md config-key list (`hygiene_digest_enabled`), the "sections drop deterministically" passage reworded for the headline tier, and the additionalContext description; docs/mcp.md note on the `brain_hygiene` row that the pull surface is now also pushed at turn end when enabled.

## Risks and open questions

- **Subagent delivery end to end.** The primary channel rests on the host's official SubagentStart contract (fires when the Task tool spawns a sub-agent, before its first prompt; the context is re-injected after a subagent compaction); whether the carrier line surfaces inside the subagent's own window is verified during QA with a delivery-gate style check on a live Task subagent. If it fails, the fallback decision (matcher scope, or the instruction-file route) is a new design conversation, not a silent change. The PostToolUse fallback stays registered for runtimes without SubagentStart, where the in-tree evidence (PostToolUse fires inside subagent turns with `agent_id`, and the post-write-reminder proves the channel) applies unchanged.
- **Scan latency against the 10-second Stop timeout.** The sweep runs only on artifact-writing turns and amortizes through the hash ledger, but a very large vault could still approach the timeout. QA measures a realistic large fixture; if it breaches, the sanctioned follow-up is a documented detector-subset constant — an explicit, named change in a follow-up, never an automatic degradation.
- **Display grammar drift.** The parse reads only the first parenthesized group after the id; if the render model changes shape, the tier degrades to render-order ranking (deterministic, never wrong, just unranked). The render functions and the parser share a docblock contract pointing at each other.
- **Ledger growth.** The agent-id set cap bounds the scope file; TTL expiry prunes entries on the next write, matching the existing ledger contract.
- **Instruction-file route.** Deliberately deferred. Once host behavior for workspace CLAUDE.md in Task-subagent turns is measured, a follow-up can add the adapter without touching this PR's surfaces.
