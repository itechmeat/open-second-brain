You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

One pull request about the agent's automatic context channel in Open Second Brain: who receives it (deliver context into delegated subagent turns), what it carries (surface pending Brain hygiene findings once per change at turn end on the proven Stop-hook channel), and how it degrades (deterministic headline tiers between section-intact and section-dropped in the shared budget core). Three kanban cards, verbatim:

## Card t_047277c5: Deliver session memory context into subagent turns (priority 4)

**What**: Upstream delivers vault session context as an instruction file the agent runtime loads the way CLAUDE.md is loaded: it survives /compact and /clear intact, keeps its own character budget, and, the part Open Second Brain lacks, is visible inside general-purpose subagent turns. A delivery gate asks the model what context it actually received at startup, after compaction, and from a subagent, so the claim is measured rather than assumed.

**Why useful**: Open Second Brain's learned preferences, lessons and standing rules are injected at session start, but a delegated subagent never sees them; the agent that performs the actual writes can be exactly the one running without its learned rules. Closing that gap keeps the preference set authoritative across delegation instead of only in the main session.

**Status in Open Second Brain**: present_weaker. Delivery exists and survives compaction: hooks/hooks.json SessionStart matcher "startup|resume|clear|compact" drives hooks/active-inject.ts (Brain/active.md digest as additionalContext), with the injection ledger in hooks/lib/injection-ledger.ts. But the only context-emitting events are SessionStart and UserPromptSubmit (hooks/lib/context-events.ts:26), SubagentStop is capture-only (hooks/hooks.json SubagentStop; hooks/README.md:31), and queued re-grounding parts explicitly skip calls carrying an agent_id (hooks/README.md:28), so sub-agent turns reach memory only retroactively via o2b brain import-session. Not found - no hook or instruction-file path injects Open Second Brain context into a subagent's own context window.

**Validator comment**: No hook injects context when a delegated subagent stops (hooks/lib/context-events.ts:26) and every anchor verified exact, leaving a concrete delivery-channel task on an in-repo hook surface. Anchors verified against live source this run.

## Card t_6b500bed: Surface pending Brain hygiene findings to the agent at turn end (priority 4)

**What**: A vault check runs at the end of each turn and reports findings, for example notes marked done that still sit in the active folder, as one short line under the answer; the agent receives the full report with the next message, once per change, and it survives resume. The user sees a one-line summary while the agent gets the actionable detail.

**Why useful**: Open Second Brain already computes hygiene findings (contested, duplicate, stale and unused memories) but only when someone runs the scan or the status snapshot. Surfacing a once-per-change digest at turn end would let the agent fold small maintenance into its normal flow instead of waiting for an explicit hygiene request, without blocking the reply.

**Status in Open Second Brain**: not_in_osb_useful. Findings exist on demand: src/core/brain/hygiene/scan.ts:53 (runHygieneScan), the brain_hygiene MCP tool (src/mcp/brain/hygiene-tools.ts:375), and the pull-based status snapshot that composes hygiene and stale scan (src/mcp/brain/health-tools.ts:449). The Stop hook exists but only nudges about unrecorded artifacts (hooks/stop-log-guardrail.ts:1-9), using the same one-line additionalContext channel upstream's report uses. Not found - no hook delivers pending Brain hygiene findings automatically at turn end or with the next prompt.

**Validator comment**: Hygiene findings are pull-only while the Stop hook already proves the one-line additionalContext channel (hooks/stop-log-guardrail.ts:1-9), so turn-end surfacing needs no design decision. Anchors verified against live source this run.

## Card t_d96e3e54: Tiered shrink of injected session context under the budget (priority 4)

**What**: When the hook budget is tight, upstream's session context degrades in ordered tiers instead of vanishing: full text, then current focus only, then one headline per goal, then as many goals as fit, then a pointer to the file, and the size line names the tier that was applied. Thirty long goals arrive as thirty headlines instead of a bare pointer.

**Why useful**: Open Second Brain's injected Brain/active.md digest is the agent's only automatic view of its learned preferences; under budget pressure whole sections are evicted at once, so a session can lose an entire rule group that a headline tier would have kept. Ordered within-section degradation would preserve more signal per character on large vaults.

**Status in Open Second Brain**: present_weaker. src/core/brain/active-budget.ts:3-19 (budgetActiveBody drops whole Brain/active.md sections in a fixed priority order), src/core/brain/active-budget.ts:49 (activeTruncationNotice names the dropped sections, the characters kept, and points at brain_context), src/core/brain/active-budget.ts:73 (drop priority map), hooks/active-inject.ts:573-576 (per-lane EXEMPT/BUDGETED/UNBUDGETED caps), hooks/README.md:28 (opt-in reground_parts_enabled splits an oversized session-start payload across later prompts). Not found - no summarization tier: sections are kept or dropped whole, never reduced to per-item headlines before eviction.

**Validator comment**: refresh drifted anchors, correct the keep-or-drop-whole evidence since single-section tail-trim exists at text-budget.ts:131-142. The shared budget core evicts oversized sections whole with no intermediate tier (src/core/brain/active-budget.ts:161), and the headline tier is specified as deterministic text extraction, an internal mechanical fix. Anchors verified against live source this run.

# Project context

Open Second Brain: TypeScript on Bun 1.4.0. An Obsidian-compatible Markdown vault with an agent-owned memory layer, shipped as a Claude Code plugin (hooks + MCP server), a CLI (`o2b`), and install targets for other coding agents. No external runtime dependencies added lightly.

Recent commits:

```
542d214b fix(opencode): support both plugin APIs (v1.74.1) (#190)
0cbb60b8 feat: near-duplicate defense across the fact lifecycle (v1.74.0) (#237)
23090696 chore(deps-dev): bump the bun-minor-and-patch group with 2 updates (#231)
d531f950 chore(deps): bump hashgraph-online/ai-plugin-scanner-action (#230)
c39dd67a ci: parallel tests, sharded Windows and a prose-only filter, with input-handling fixes (v1.73.1) (#236)
0f0c9a76 feat: honest query embeds and drift-checked upgrades (v1.73.0) (#235)
2b424d9a feat: honest embedding spend and a semantic belief order (v1.72.0) (#234)
2353cb1e feat: recall injection that arrives once and survives compaction (v1.71.0) (#232)
39c2f225 feat: scoped operator rules per project, harness and host, per-profile Hermes settings on a multiplexed gateway and readers that answer at the caller's reach (v1.70.0) (#229)
d49c4697 feat: ingest that reads CSV, TSV and HTML into table and parts sections, names the formats it skips and previews with o2b brain extract (v1.69.0) (#228)
f5c46615 feat: dependency facts from project manifests, Terraform seeds in the pre-extractor and readers that answer at the caller's reach (v1.68.0) (#227)
400b20ea feat: distillation pages that prove what they quote and say how much of their source the vault holds (v1.67.0)
3ec2334a feat: stable error codes on the MCP wire, typed rerank degradation and a rerank doctor check (v1.66.0) (#225)
a1ecfe7b feat: unattended maintenance recipes, install-owned lane tasks and an MCP fault guard (v1.65.0) (#224)
4499698c feat: search that honours pins and event time, diagnostics that prove action, writes that name their residue (v1.64.0) (#223)
a0b3c2e0 feat: exactly-one binding for mentions and imports, once-only write receipts, selectable search breadth and per-device ledgers (v1.63.0) (#222)
f4f9e3e6 feat: silent failures surface by name in redaction, receipts, ingest, search store, doctor (v1.62.0) (#220)
eb3c4c85 docs: concise README, ZCode client page, CLI reference and safety notes moved to child pages (#219)
f22df2c5 chore(apb): zg search, code-ranker and OpenCodeReview before push, scope-scan hardening (#218)
83979b9d fix: MCP startup off the upgrade path, fair ingest locks, inline plugin MCP manifest, inbox archive (v1.61.0) (#217)
```

Related files (all anchors verified against this tree at 542d214b):

- hooks/hooks.json - 8 events registered through the `o2b-hook` shim: PostToolUse (brain_feedback capture, post-write-reminder on `Write|Edit|MultiEdit|apply_patch`, reground-deliver on `*`), SessionStart (active-inject, gap-agenda, session-capture), UserPromptSubmit (session-capture, recall-inject, nav-inject, reground-deliver), PreToolUse (pretool-orient), Stop (session-capture, stop-log-guardrail, 10s timeout), SubagentStop (session-capture only), SessionEnd, PostCompact.
- hooks/lib/context-events.ts:26 - `CONTEXT_EVENT_NAMES = ["SessionStart", "UserPromptSubmit"]`: only these two events get stdout from context-injecting hooks that consult the list. SubagentStop is deliberately absent: the host accepts additionalContext there but it fires at close, too late to seed the subagent.
- hooks/post-write-reminder.ts:123 - precedent: a PostToolUse hook emitting `hookSpecificOutput.additionalContext`; PostToolUse fires inside subagent turns and its payload carries `agent_id` (hooks/reground-deliver.ts:165-170 skips calls with a non-empty agent_id, `agent_type` alone is not a sub-agent marker).
- hooks/active-inject.ts - session-start composition: standing rules block first (renderStandingBlock, module-private at :800, from Brain/standing-rules.md via src/core/brain/standing-rules.ts, capped by resolveStandingRulesMaxChars), then scoped rules, then the budgeted memory body assembled by assembleActiveContext (:876) and budgeted via src/core/brain/active-budget.ts; wrapped fail-open; emits on SessionStart/UserPromptSubmit.
- hooks/lib/injection-ledger.ts - per-session-scope ledger with namespaced keys (`osb.recall_inject.injected`, `osb.active_inject.emitted`, `osb.reground.queue`), 24h TTL, capped sets (RECALL_SET_MAX = 2000), fail-soft readers, atomic writes, stored under `<vault>/.open-second-brain/hook-state/<scopeSlug>.json`.
- hooks/stop-log-guardrail.ts - the proven Stop channel: skips `stop_hook_active === true` (:43), gates on transcript summary (`summarizeTurn` from hooks/lib/detect.ts:142, returns hadArtifact/hadBrainEvent tool-level booleans, no paths), writes ONE line of JSON to stdout (:58), never deadlocks (:61-63). Output shape hooks/lib/messages.ts:119-126: claudecode gets `{ hookSpecificOutput: { hookEventName: "Stop", additionalContext } }`, every other runtime gets `{ decision: "block", reason }`. STOP_GUARDRAIL_TEXT is deliberately one line (token diet; Codex turns it into the continuation prompt).
- scripts/o2b-hook - dispatcher resolves `hooks/<name>.ts` by name against CLAUDE_PLUGIN_ROOT / its own realpath / OSB_PLUGIN_ROOT. Adding a hook requires NO dispatcher change.
- src/core/brain/hygiene/ - read-only scan pipeline: `runHygieneScan` (scan.ts:53) runs detectors (conflicts, dedup, freshness, usefulness, slug-collisions, capture-scope; tags opt-in) over the vault, returns `HygieneScanReport { generated_at, detectors_run, findings, counts, errors }`; `HygieneFinding` (types.ts:68-80) has a deterministic id, severity "info"|"warning"|"action", title, targets, proposed_action, evidence. Not persisted anywhere. Dangling links are a separate additive `link_integrity` key measured from the existing search index (src/mcp/brain/hygiene-tools.ts:156-201). Pull-only today: MCP `brain_hygiene`, CLI `o2b brain hygiene scan|apply`.
- src/core/brain/active-budget.ts:161 - `budgetActiveBody(body, budgetChars)`: within budget byte-identical; over budget, `applySectionBudget(splitSections(body), budgetChars, { notice: activeTruncationNotice })`. Static heading-derived priorities: Confirmed 0, Most-applied 1, unknown 2, Quarantine 3, Recently retired 4; KEEP_GUARD_PRIORITY = 0.
- src/core/brain/text/text-budget.ts:149 - `applySectionBudget`: phase 1 drops whole sections least-important-first (:163-167; comment at :160-162: "Intermediate sections are never partially kept"); phase 2 tail-trims the single surviving last section via `trimToLines` (:131-142) with a `headLines` guard (:37-39, set by no caller today) that drops the section when a trim would keep only the heading. Shared by standing-rules.ts:165 and scoped-rules.ts:265, which rely on current semantics.
- src/core/brain/active.ts:419-498 - item render model: one bullet per item with INLINE metadata tags: Confirmed `- \`id\` (scope?, confidence: high (0.95), pinned?) — principle`; Most-applied `- \`id\` (scope?, applied_in_window: N)` (no principle text, one-liner by design); Quarantine `- \`id\` (scope?, applied: n / violated: m, conf: x.xx, pinned?) — principle`. At budget time only the rendered string exists (frontmatter stripped upstream); lessons.md shares the same budget entry point.
- src/core/brain/active-budget-pressure.ts:104-150 - proactive probe mirrors the reactive drop order (reuses splitSections/priorityFor/leastImportantIndex), wired into doctor with exit code active-budget-pressure; the two surfaces must never disagree.
- Install surface: src/core/install/registry.ts, INSTALL_TARGET_ID (aider, codex, copilot-cli, cursor, gemini-cli, generic, grok, kiro, opencode, pi) - NO claude-code target (Claude Code installs via marketplace plugin). Managed-block editor src/core/install/managed-block.ts (marker-fenced insertManagedBlock, used by the aider adapter). AGENT_INSTRUCTION_FILES = [AGENTS.md, CLAUDE.md, GEMINI.md] audited read-only by the writeback contract (src/core/brain/writeback-contract.ts:72-76) and line-ceiling-checked (src/core/brain/trust/instruction-file-ceiling.ts:22).
- Config: src/core/config.ts resolveVault (:344), opt-in flag precedent resolveRegroundPartsEnabled (:1210, default off); template entries in src/core/brain/config-template.ts.
- Tests: tests/hooks/ (spawn-based hook tests, hooks-json-shape.test.ts derives expectations from hooks/hooks.json), tests/core/brain/ (active-budget, text-budget, active-budget-pressure, hygiene-*), tests/core/install/.

Conventions:

- Hooks fail soft: never exit 2, never block the runtime, exit 0 on any internal error; new Stop hooks copy the stop-log-guardrail skeleton.
- Context texts are one line by design (Claude Code renders them in the user transcript; Codex turns them into continuation prompts). Wording lives in named constants, never inline literals.
- Cores are pure and deterministic with documented contracts (byte-identity within budget, deterministic drop order, stable tie-breaks).
- New automatic output channels are opt-in flags by precedent (reground_parts_enabled default off); the config flag is checked before any expensive work.
- Once-per-X state uses ledger keys or hash ledgers, written AFTER emission (lose-not-duplicate).
- No silent fallbacks: a degraded mode is named in the output or the docs, never silent.
- Docs live in docs/ and hooks/README.md; every user-visible key and surface gets a row or a paragraph; CHANGELOG entries land inside the release PR.

Constraints:

- One pull request covering all three cards; no unrelated changes.
- No new external dependencies.
- Additive changes only: do not change existing public APIs or the semantics of applySectionBudget for its current consumers (standing-rules, scoped-rules).
- Do not build on unverified host behavior: whether workspace CLAUDE.md content reaches Task-subagent turns cannot be verified in this repo.
- The branch will be implemented in three parallel lanes with disjoint file ownership; variants should note which parts are independent.

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
