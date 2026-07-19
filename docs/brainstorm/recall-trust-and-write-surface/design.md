# Trusted recall and memory write surface - one wave, ten tasks, two shared kernels

**Status:** approved
**Author:** wave orchestrator (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain stores recall primitives, trust signals, and write helpers that are not yet wired into the moments where they matter. Nothing recalls vault context at prompt time, retrieval cannot zero-rank quarantined material or explain pack composition, a supersede relation on a successor does not fade the superseded note, MCP agents can create notes but never update them, and multi-step memory writes have no atomic surface. Session-start output is flat prose without type or age cues, recurring knowledge gaps evaporate as one-shot diagnostics, budget clipping can strip session identity, and doctor never probes whether the LLM key, embedding provider, or runtime adapters actually work.

## Scope

Ten kanban tasks in four themes, one PR, one release (v1.35.0):

- A. Recall timing: t_2ce46130 (bounded fail-closed audited recall inject on UserPromptSubmit, opt-in), t_4adb0b8b (typed age-labeled session-start timeline), t_67d38036 (knowledge-gap loop: recurring gap to durable task to session-start agenda to auto-close).
- B. Retrieval trust: t_5f61130a (fail-closed retrieval gate zero-ranking quarantined material plus per-pack memory_trust_assessment and retrieval_decision_trace receipts), t_c4a9cef8 (relation-only supersede fade covering the lexical path), t_ac1d36ea (include_raw inline raw-beside-derived with a per-item extracted discriminator), t_5be0654d (clip-protected session_id and agent_id).
- C. Write lifecycle: t_3ff3fe77 (brain_update_note and brain_append_note), t_7718ab22 (general atomic batch write tool).
- D. Readiness: t_cc234ff5 (fail-fast doctor readiness probes: exit code, per-check timeouts, LLM key, embedding provider, adapter wiring).
- Rider: de-flake tests/core/brain/lifecycle/temporal-replace.test.ts (hardcoded log day 2026-07-18; derive the expected day from the operation result instead of the wall clock).

## Out of scope

- Telegram inbound capture bot (t_f8f5ef6a) and scheduled inbox drain (t_b0bba8cb): a separate capture-pipeline wave.
- Any LLM call inside the deterministic kernel; any natural-language word list (the trust gate classifies by structural markers, provenance flags, and existing contamination and self-approval signals only).
- A generalized injection framework across SessionStart and UserPromptSubmit (deliberate non-abstraction, see below).

## Chosen approach

Consultant Variant 3, two-kernel pragmatic. Extract exactly the two seams that have two concrete consumers inside this wave; keep the other two candidate seams as conventions.

Kernel 1, retrieval rank-adjustment sink: one deterministic stage between ranking and result emission where registered adjusters return a verdict per candidate (exclude with reason, multiply, keep). The trust gate contributes zero-rank verdicts (recorded, never silently dropped: excluded items are counted into the retrieval_decision_trace receipt) and the supersede fade contributes a fade multiplier from inbound supersedes and superseded_by relations. The sink sits on both the semantic and the pure-lexical paths. Rides in the t_5f61130a anchor commit; t_c4a9cef8 is its second consumer.

Kernel 2, atomic multi-operation write core: generalize the validate-project-commit shape of runPinnedContextBatch into a core that executes an ordered operation list all-or-nothing. brain_update_note and brain_append_note are single-operation batches over this core; t_7718ab22 exposes the multi-operation MCP surface and fixes the operation vocabulary (create note, update note body or frontmatter, append note, apply evidence, append log line). Rides in the t_3ff3fe77 anchor commit; t_7718ab22 is its second consumer.

Deliberate non-abstractions: theme A surfaces share only a small pure rendering helper (typed icon plus relative-age label) because SessionStart injection is fail-open while the prompt-time recall hook is fail-closed and audited; a shared surface would blur that guarantee. Budget discipline is a protected-fields contract in the token-impact clip path (session_id, agent_id survive any clip), enforced by regression tests, which include_raw responses respect.

## Design decisions

- Recall hook (t_2ce46130): opt-in via one env flag; reuses recall-hint and recall-sources primitives, no new retriever; hard caps (notes and characters) as named constants; abstains below a confidence floor; any internal error injects nothing and logs the decision; every decision (inject, abstain, error) is one audit log line. The hook process itself stays fail-open for the session.
- Trust gate (t_5f61130a): deterministic quarantine classification from structural and provenance signals already in the codebase (untrusted-source provenance, contamination entity signals, self-approval guardrail state); zero-ranked items keep zero prompt influence but are counted with reasons in the receipts; receipts are compact references consistent with the existing context-receipt model, never repeated payloads.
- Supersede fade (t_c4a9cef8): inbound supersedes or superseded_by relation on an unchanged note applies a fade multiplier through kernel 1 on both search paths; the existing superseded-non-tip tombstone drop is untouched; fade factor is a named constant beside the freshness multipliers.
- Update and append tools (t_3ff3fe77): target must exist (typed error otherwise); same safety envelope as create (path traversal, Brain machinery root, vault-scope exclusions); frontmatter patch merges keys, body update replaces, append appends; all through kernel 2 so a mid-write failure rolls back.
- Batch tool (t_7718ab22): whole batch validated and projected in memory before any disk write; first invalid operation aborts the batch with a typed error naming the operation index; fail-closed, no partial application.
- Timeline (t_4adb0b8b): presentation only over existing brief data; type marker derives from the existing eventType and item kind, age label from stored timestamps; a fixed structural marker vocabulary (config-free), no natural-language classification.
- Gap loop (t_67d38036): recurrence detection over existing gap_counts telemetry with a tunable threshold; promotion creates a durable vault task file at session end; agenda renders open gap tasks at session start through the same rendering helper; auto-close mirrors the dream freshness auto-resolve precedent; opt-in via env flag.
- Clip protection (t_5be0654d): agent_id joins session_id on pack and continuity identity; the clip routine preserves both under any output budget; regression test with a tiny budget.
- Doctor readiness (t_cc234ff5): new probes are additive checks with per-check timeout and a non-zero exit code contract behind an explicit flag so existing doctor output stays byte-identical without it; probes report pass, fail with reason, or skipped-not-configured, never a silent pass.
- Rider de-flake: the test derives the expected log day from the returned loggedAt, removing the wall-clock dependence.

## File changes

- New: src/core/search/rank-adjust.ts (kernel 1), src/core/brain/write-batch.ts (kernel 2), src/core/brain/trust/retrieval-gate.ts, src/core/brain/receipts (trust assessment and decision trace builders), src/core/brain/render/activity-line.ts (shared rendering helper), src/core/brain/gaps/gap-loop.ts, hooks/recall-inject.ts (or hooks/lib extension per existing hook layout), src/mcp/brain note update, append, and batch tool registrations, doctor readiness probe module.
- Modified: src/core/search/ranker.ts and result-filters.ts (mount kernel 1 on both paths), src/core/brain/session-recall.ts and src/mcp/brain/recall-tools.ts (include_raw plus discriminator), src/core/brain/token-impact.ts (protected fields), src/core/brain/morning-brief.ts (timeline render), src/core/doctor.ts and the doctor CLI verb (probes, exit code), hooks/hooks.json (UserPromptSubmit registration), src/mcp/brain/notes-tools.ts and context-tools.ts (ride kernel 2), tests beside every change, tests/core/brain/lifecycle/temporal-replace.test.ts (rider).
- Exact paths follow the codebase layout discovered during TDD; implementers adapt names to neighboring conventions and record deviations in the commit body.

## Risks and open questions

- Kernel 1 touches the hottest ranking path; mitigated by byte-identical behavior when no adjuster is registered and by regression tests on both paths.
- The operation vocabulary of kernel 2 must not leak MCP shapes into the core; the core takes typed operations, the MCP layer maps params.
- UserPromptSubmit hook latency budget: the recall path must stay within a small fixed time budget; on timeout it abstains and logs.
- Gap-loop task files must not trigger unrelated agents; they live under the vault Brain area as plain durable notes, not on the Hermes board.
- Registry guards cap tool description lengths; new tool descriptions are written to the 300 and 160 character limits from the start.
