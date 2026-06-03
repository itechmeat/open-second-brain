You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

One release (target v0.38.0) ships eight kanban tasks in two theme clusters as a single PR on one feature branch.

## Cluster A - Workspace Reach (the Brain reachable from anywhere in the workspace)

### A1 (t_5f31b5f1, p3) Configurable wiki link path format (preserve/full/short)
Add a config option with three modes: preserve (keep links as typed), full (rewrite to full key path like [[folder/target]]), short (rewrite to shortest unambiguous suffix). Applied when Open Second Brain generates or normalizes notes (ADR candidates, decision notes, generated Brain content). The repo parses wiki links via src/core/brain/link-graph/parse-wikilink.ts (WikilinkParse, parseWikilinkRich) but has no configurable output format or link-builder; generated notes concatenate strings manually.

### A2 (t_1375e69f, p2) Project worktree links and read-only Brain sources
A repo, monorepo package, sibling worktree, or satellite project should discover the right Brain vault automatically, and optionally search selected external Brains as read-only sources without importing or mutating them.
Suggested design from the task:
- `o2b brain project link <path> --vault <vault>` writes a pointer file into a project directory.
- `o2b brain project list/remove/status` to inspect and repair linked project pointers.
- `o2b brain source add <vault-or-project> --alias <name> --read-only` for read-only recall sources.
- Source origin metadata in brain_search, context packs, and why_retrieved, distinguishing local results from shared/read-only sources.
- Refuse self-links, duplicate sources, malformed pointer files, circular source links.
- Write tools stay scoped to the active local Brain.
Acceptance: link a nested project dir to an existing vault without copying files; commands launched from the linked dir resolve the owning vault; read-only sources can be added/listed/removed/marked broken; search output shows origin labels; writes cannot mutate read-only sources; status/doctor reports malformed pointers.

### A3 (t_72a22658, p2) Global search mode for cross-vault memory access
Search is currently scoped to the active vault. Add a global/union mode: one query searches all registered vaults (multi-vault profile registry exists: src/core/brain/portability/profiles.ts, .profiles.json with {active, profiles:{name:{vault}}}). Writes remain scoped to the active vault. Complements A2: read-only sources and cross-vault union share the origin-label mechanism in result output.

### A4 (t_323a9a83, p2) Shell-native Brain profile and semantic grep surface
A shell-native surface so simple agents, scripts, and humans use ordinary filesystem reflexes without MCP:
- Generate a materialized `profile.md` (compact current-Brain digest: static facts, dynamic/recent context, source timestamps) without walking every file.
- `o2b brain sgrep <query> [path]` for semantic Brain search with path scoping and JSON output.
- `.o2bfs` marker metadata so wrappers can detect the Brain root safely.
Acceptance: profile generation, path-scoped semantic grep, exact-grep fallback preserved, marker detection, stale profile invalidation. Out of scope: FUSE/NFS mounts, hosted sync.

## Cluster B - Proactive Insight (the Brain says what needs attention, with memory of what it already said)

### B1 (t_04e94382, p3) Deep vault synthesis: cross-reference notes by topic for contradictions and gaps
Topic-scoped synthesis that crawls all notes mentioning a concept and produces a structured analysis of agreements, contradictions, stale claims, and knowledge gaps. Complements brain_health (preference-level contradictions) and brain_concept_synthesis (depth-1 wikilink clusters). Reuse FTS5 search for topic matching; keep candidate assembly deterministic (LLM synthesis stays outside core, consistent with project style).

### B2 (t_cd1fee79, p2) Grounded proactive trigger queue with anti-nag lifecycle
`Brain/triggers/` as a Markdown-first trigger queue for grounded proactive prompts. Trigger generation deterministic, source-linked, conservative - generated from existing health/retention/stale/reconcile data.
- Store each trigger with trigger_id, trigger_type, status, urgency, reason, suggested_action, source_artifacts, context_snippets, cooldown_key, created_at, expires_at, lifecycle timestamps.
- Statuses: pending, delivered, acknowledged, acted, dismissed, expired.
- Deduplicate with a stable cooldown key so the same issue does not reappear every run.
- CLI/MCP surfaces: list pending, acknowledge, dismiss, act-on, history.
- Feed pending triggers into morning brief or summary only once per cooldown window.
Acceptance: generate candidates from existing report data without duplicates; persisted triggers include source links and context snippets; acknowledged/dismissed/acted/expired triggers stop resurfacing until cooldown allows; morning brief includes pending without repeating dismissed; CLI and MCP expose pending/history + acknowledge/dismiss/act; tests cover cooldown dedup, expiry, transitions, idempotency. Out of scope: push notifications, valence tracking, LLM-generated triggers.

### B3 (t_8722a62a, p2) Idea discovery: rank next-direction candidates from open loops
Scan the vault for orphan research (low backlink count via link graph), unresolved open questions (pre-compact extraction), and undeveloped ideas/signals to produce 3-5 ranked next-direction candidates. Could feed the trigger queue from B2 rather than being a separate report.

### B4 (t_65036e02, p2) Recall gate telemetry (follow-up to PR #54)
The pure recall gate (brain_recall_gate with stable skip/retrieve reasons) shipped in v0.27.0; the Hermes provider calls it every turn since v0.32.0. Remaining scope: (1) automatic context-injection telemetry - record gate decisions and surfaced/suppressed context for observability and tuning; (2) host-hook wiring for non-Hermes hosts where feasible. There is an existing telemetry kernel: src/core/brain/recall-telemetry.ts (emitRecallTelemetry -> Brain/continuity/ records with mode/status, listRecallTelemetry, summarizeRecallTelemetry).

# Project context

Open Second Brain - a local-first, Markdown/Obsidian-first second brain for AI agents. TypeScript on Bun; CLI (`o2b`) + MCP server; Python provider plugin for Hermes. Core principles: deterministic state transitions (no LLM inside core), fail-soft reads, behavior-changing features ship off by default, Markdown stays the record.

Recent commits:
707197a feat: Agent Surface Suite - skills over MCP, two-pass tool catalog, surface profiles, session lifecycle (#68)
eda202d feat: Embedding Provider Suite - local embedder, provider registry, cost gate, RRF fusion (#67)
dee5ab7 feat: Memory Integrity Suite - canonical entities, conflict-free log shards, capture boundaries, fact extraction (#66)
5066e71 feat: Token Diet - budgeted injection, reminder cadence, consolidated MCP surface (#65)
c494fd8 feat(search): Recall Trust Suite - relation polarity, learned weights, time-aware and verified recall (#64)

Related files:
- src/core/brain/link-graph/parse-wikilink.ts - WikilinkParse (target/anchor/block/alias), parseWikilinkRich, extractWikilinkRichBodies. Parser only; no link builder/normalizer.
- src/core/brain/portability/profiles.ts - VaultProfile registry (.profiles.json beside config.yaml), listProfiles/createProfile/switchProfile/resolveActiveProfileVault. Resolution chain: profiles -> config "vault" key -> env var.
- src/core/config.ts - resolve* helper convention for config keys (config key, env var override, default), e.g. resolveSessionHandoff, resolveSkillAutoAttach.
- src/core/search/search.ts (search entry), src/core/search/types.ts (SearchOptions: semantic, keywordOnly, sessionFocus, properties, visibility, since/until, mmrLambda, maxHops), query-plan.ts. Results carry reasons[] ("lane:lex/fts5", "lane:vec/semantic", "intent:..."), so an origin label fits the existing reasons mechanism.
- src/core/brain/context-pack.ts - packContext with tiers core/supporting/peripheral, char budgets, skipped reasons, receipts/telemetry ids.
- src/core/brain/digest.ts, morning-brief.ts - compact digest surfaces that could feed a generated profile.md.
- src/core/brain/recall-gate.ts, recall-telemetry.ts - gate decision logic + continuity-record telemetry kernel (Brain/continuity/, JSONL).
- src/core/brain/health.ts, retention.ts (RetentionReviewReport: summary keep/improve/park/prune + recommendations[]), stale scan, watchdog.ts (BrainWatchdogResult with remediation_plan), morning-brief.ts - deterministic report generators that a trigger queue can consume.
- src/core/brain/link-graph/backlinks.ts (buildLinkGraph inbound counts), pre-compact-extract.ts (open-question extraction), Brain/inbox/sig-*.md signals - inputs for idea discovery.
- src/core/brain/session-scope.ts - resolveSessionScope slug kernel (lowercase, non-alnum -> dash, cap 64).
- src/core/brain/intentions.ts / handoff.ts - frontmatter writing pattern with JSON.stringify quoting.
- src/cli/command-manifest.ts + src/cli/brain/verbs/*.ts - CLI verb registration; src/mcp/brain-tools.ts + src/mcp/tools.ts + registry-guard.ts + tests/mcp/mcp.test.ts - MCP tool registration with preview budgets and a contract test asserting the advertised tool list.

Conventions:
- Deterministic core; LLM work stays outside (agents/consultants), core produces candidate data.
- Every behavior-changing feature is gated by a config key, default off; resolve* helper + env var override.
- New CLI verbs registered in verbs/index.ts + brain.ts dispatch + command-manifest.ts; CLI handlers wrap errors in try/catch boundaries.
- New MCP tools added to BRAIN_TOOLS (or a dedicated module spread into the table), with preview budgets, registry-guard entries, and mcp.test.ts contract updates.
- Frozen return objects, code-point sorts (not localeCompare), plain toLowerCase, JSON-quoted frontmatter values.
- Tests: bun test, TDD per feature; lint oxlint (baseline 111 warnings), fmt oxfmt; tsc --noEmit.
- Markdown stays the record: durable artifacts are .md files under Brain/ with frontmatter, JSONL sidecars only as derived indexes.

Constraints:
- Do not change existing public APIs (existing CLI verbs, MCP tool shapes, search result fields stay backward compatible; additive only).
- No new external runtime dependencies.
- Writes always stay scoped to the active local vault; external vaults/sources are strictly read-only.
- The full/writer MCP scopes must stay byte-identical except for deliberately added tools.
- Eight features in one PR: prefer a small number of shared kernels over eight isolated implementations - that is what keeps the PR coherent.

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
