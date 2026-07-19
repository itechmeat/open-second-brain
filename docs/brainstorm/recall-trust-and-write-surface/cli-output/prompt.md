You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

One release wave for Open Second Brain: "trusted recall and memory write surface". Ten kanban tasks ship together as one PR. The wave has four sub-themes:

A. Recall reaching the agent at the right time
1. t_2ce46130 (p4) Bounded vault recall injected at UserPromptSubmit. A hook that relevance-recalls a small bounded brief of vault notes into every prompt (cap ~4 notes / ~900 chars), abstains when confidence is low, fail-closed, opt-in via env flag, logs every recall decision for audit. Anchors: hooks/hooks.json (UserPromptSubmit registers session-capture only), hooks/lib/context-events.ts:19 (UserPromptSubmit is additionalContext-eligible), hooks/active-inject.ts (SessionStart preferences digest only), src/core/search/recall-hint.ts (RecallHintInput), src/core/brain/portability/recall-sources.ts (RecallSource). Build atop existing recall primitives, no new retriever.
2. t_4adb0b8b (p3) Render session-start recalled memories as a typed, age-labeled recent-activity timeline. Presentation layer over existing session-start injection: per-item type marker and relative-age label ("2h ago") instead of flat bullets. Anchors: src/core/brain/morning-brief.ts:178-189 (buildMorningBrief plain bullets), src/core/brain/active.ts:246-287, src/mcp/brain/brief-tools.ts:367-372 (brain_brief view=morning). Entries already carry eventType and timestamps.
3. t_67d38036 (p3) Self-directing knowledge-gap loop: detect recurring low-confidence recall gaps, promote each into a durable vault task at session end, surface open gap-tasks as session-start agenda, auto-close when the topic is later recalled with sufficient confidence. Opt-in via env flags, no new deps. Anchors: src/core/brain/doctor.ts:223,499,565,587,604 (conceptGaps signal only), src/core/brain/recall-telemetry.ts:23-120 (gap_counts recurrence data), src/core/brain/dream.ts:318 (auto-resolve precedent), src/core/brain/agenda.ts is CALENDAR-based, do not conflate.

B. Trust in what retrieval returns
4. t_5f61130a (p4) Per-pack retrieval receipts (memory_trust_assessment + retrieval_decision_trace as compact references) plus a fail-closed retrieval gate that zero-ranks quarantined material (prompt overrides, secret exfiltration, encoded instructions, destructive claims, self-awarded trust). Legitimate bounded runbooks stay usable. Anchors: src/core/brain/untrusted-source.ts:120 (wrapUntrustedSource, structural read-time only), src/core/brain/truth/contamination.ts, src/core/brain/trust/self-approval-guardrail.ts:41, src/core/search/evidence-verification.ts:67. Build the gate as a retrieval-stage sink feeding the pack builder; receipts consistent with the existing context-receipt model.
5. t_c4a9cef8 (p3) Relation-only supersede fade: a typed supersedes:[[B]] relation authored on A down-ranks unchanged B in search, covering the pure-lexical path too. Anchors: src/core/brain/lifecycle/tombstone.ts:113 (isTombstoned uses B's own status only), src/core/search/result-filters.ts:72 (applyStatusFilter), result-filters.ts:~104 (attachTrustMetadata stamps but does not rerank), src/core/search/ranker.ts:55-86 (freshness multipliers), src/core/graph/relation-vocab.ts:35 (superseded_by).
6. t_ac1d36ea (p3) Inline raw-capture-beside-derived-fact in recall responses: an include_raw flag carries the original raw capture alongside the derived record in one payload, and every returned item gets an extracted/derived boolean discriminator. Anchors: src/core/brain/session-recall.ts:460,464-486,513 (source_record_ids join, collectRawRecords only via separate brain_session_expand), src/mcp/brain/recall-tools.ts.
7. t_5be0654d (p3) Make session_id and agent_id clip-protected under output-budget truncation: a clipped context pack retains identity fields; add agent_id alongside session_id. Anchors: src/core/brain/token-impact.ts:189 (session_id conditional), src/core/brain/continuity/store.ts, continuity/types.ts. Regression test: tiny-budget clip retains identity.

C. Memory write lifecycle over MCP
8. t_3ff3fe77 (p4) brain_update_note and brain_append_note MCP tools: update an existing note's body and/or frontmatter in place (and append), complementing create-only brain_create_note. Preserve the safety envelope (refuse path traversal, Brain machinery root, vault-scope-excluded paths) but require the target to exist; reuse atomic-write semantics. Anchors: src/mcp/brain/notes-tools.ts:79-110 (brain_create_note strictly create-new), src/mcp/brain/feedback-tools.ts:724.
9. t_7718ab22 (p3) General atomic all-or-nothing batch write tool spanning memory write operations (create note, update frontmatter, apply evidence, append log lines): validate and project the whole batch in memory first, then commit or roll back as a unit. Anchors: src/mcp/brain/context-tools.ts:251-264 (runPinnedContextBatch, PinnedBatchError, the pattern to generalize), src/mcp/brain/admin-tools.ts:36,151 (writeFrontmatterAtomic per-file). Decide the batch-eligible operation vocabulary.

D. Operator readiness
10. t_cc234ff5 (p3) Fail-fast doctor readiness probes: non-zero exit code on any failed check, short per-check timeouts, three functional probes (LLM key configured and resolvable, embedding provider loadable with model+dims reachable, runtime-adapter wiring connected). Anchors: src/core/doctor.ts:354-372 (CheckResult[], structural checks only), src/core/search/embeddings/{provider-resolve,contract,registry,local-provider,openai-compat,configured-provider}.ts, adapter verify at grok.ts:161 / opencode.ts:182. Distinct from the already-shipped doctor --repair and brain status.

Plus one rider outside the board: fix a date-flaky test on main (tests/core/brain/lifecycle/temporal-replace.test.ts hardcodes log day 2026-07-18 while the event logs under the current wall-clock UTC date; derive the expected day from the result instead).

The architectural question: how to sequence these ten tasks and which shared kernels to extract so each concern has exactly one home. Candidate shared seams: (1) a retrieval-stage rank-adjustment layer that both the trust gate (zero-rank) and the supersede fade (fade multiplier) plug into; (2) an atomic multi-operation write core generalized from runPinnedContextBatch that brain_update_note/brain_append_note and the batch tool all ride on; (3) a session-start/prompt-time injection surface shared by the recall hook, the typed timeline, and the gap agenda; (4) response-shape/budget discipline shared by include_raw and clip-protected identity.

# Project context

Open Second Brain (o2b): TypeScript on Bun, CLI plus MCP server over an Obsidian-compatible Markdown vault, bun:sqlite with sqlite-vec. Deterministic kernel: the algorithm calls no LLM.
Recent commits:
426d06f8 fix(vault): parse block-style YAML lists in frontmatter (not just inline arrays) (#142)
4b8100ca feat: source pipeline integrity and operator tooling (v1.34.0) (#143)
77513f2b feat: belief lifecycle and decision memory (v1.33.0) (#141)
61e93d24 fix(config): derive vault store reference from a keyed installation secret (#140)
9a649dd6 feat: memory write-path integrity and store safety wave (v1.32.0) (#139)
f2a037eb feat: today operator surface - dashboard, open loops, marker write-back (v1.31.0) (#138)
13bde6c3 refactor: remove all import cycles, decompose search.ts (v1.30.1) (#137)
fd5661f9 feat: governance visibility - vitals scorecard + batch-inflation lint (v1.30.0) (#136)
Related files: listed per task above.
Conventions:
- TDD, one atomic conventional commit per task on one feature branch, all ten in one PR and one CHANGELOG version.
- MCP registry guards: tool descriptions <= 300 chars, property descriptions <= 160 chars; current surface 103 tools.
- Byte-identical opt-out: every new surface must leave behavior exactly unchanged when its flag/param is omitted.
- Errors surface explicitly; no do-nothing fallbacks; no stubs.
- Language-agnostic: no built-in natural-language word lists anywhere (the trust gate must classify by structural signals, provenance, and config vocabularies, never by hardcoded phrases).
- No import cycles (v1.30.1 removed all; CI-guarded).
Constraints:
- Do not change existing public API semantics; new MCP params optional.
- No new external dependencies.
- Hooks are fail-open for the session (a broken hook must not block the user) but the recall hook's CONTENT decisions are fail-closed (abstain on low confidence, inject nothing on any internal error) and audited.
- The trust-gate quarantine classification must be deterministic and language-agnostic (structural markers, provenance flags, existing contamination/self-approval signals), not keyword lists.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
