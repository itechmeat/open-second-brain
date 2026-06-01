You are brainstorming architectural variants for the following multi-task feature release. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

## Scope

Implement the Self-Learning Skill Proposal Queue scope for Open Second Brain. This scope combines three related board tasks:

### t_ee819f4b P4 - [upstream:Sibyl-Memory] Self-learning skill proposal review queue

Sibyl-Memory has a self-learning loop that scans its append-only journal for repeated agent behavior and creates reviewable skill proposals. The upstream implementation is intentionally deterministic by default: it scans new journal events since the last watermark, runs explainable detectors for `repeated_action`, `structural_similarity`, `co_occurrence`, and `temporal_routine`, deduplicates by slug, and writes pending proposals with confidence, evidence snippets, and a summarizer label. A human can accept or reject each proposal; accepted proposals become reference documents under `skill/<slug>`.

Open Second Brain already learns preferences from repeated correction signals, but it does not currently turn repeated successful work patterns into reusable operator-reviewed skills or runbooks. This would make Open Second Brain more useful as a Second Brain because the system would learn not only what the user prefers, but also how the agent repeatedly solves tasks for this user and project. Examples: recurring release-note workflows, common triage patterns, repeated CodeRabbit remediation steps, or project-specific debugging recipes.

Acceptance criteria:

- A deterministic learning run can scan Brain log/session events since the last watermark and create pending skill proposals without network calls.
- Proposals include pattern kind, confidence, evidence snippets, source event references, and a human-readable suggested skill body.
- Duplicate pending proposals are suppressed by stable slug or payload hash.
- Accepting a proposal creates an auditable skill/reference artifact and marks the proposal accepted.
- Rejecting a proposal records a review note and prevents the same proposal from reappearing unchanged.
- The workflow is covered by tests for repeated-action, structural-similarity, co-occurrence, temporal-routine, accept, reject, and watermark behavior.

### t_02e22d4e P3 - [upstream:signetai] Procedural memory graph for installed skills and runbooks

SignetAI treats installed skills as procedural memory. A reconciler scans installed `SKILL.md` files, parses frontmatter, creates graph entity nodes, stores skill metadata such as triggers/tags/permissions/source/version, generates embeddings for skill discovery, tracks usage fields, and can extract related entities from the skill body. Declarative memory answers what is true; procedural memory answers what should the agent do. Skills become searchable, inspectable, and eventually decayable graph nodes instead of passive files that only work when invoked by exact name.

Open Second Brain already has a skills directory, repo-local skills, a schema-author skill, and a self-learning skill proposal task. What is missing is the installed-skill side of the lifecycle: once a runbook/skill exists, Open Second Brain should know when it is relevant, what triggers it, which entities or projects it touches, whether it has been used recently, and whether it should be surfaced in a context pack or operator dashboard.

Acceptance criteria:

- Open Second Brain can list installed procedural memory entries with source path, triggers, tags, and last-used metadata.
- Skill metadata updates when the source file changes and removes stale entries when the file disappears.
- Usage tracking updates a sidecar/index without rewriting `SKILL.md`.
- Procedural entries can link to Brain entities/projects/tasks and appear in graph/export surfaces.
- Tests cover frontmatter parsing, reconciliation, deletion, usage tracking, and graph/entity linking.

### t_6d0fda95 P3 - [upstream:plur] Cross-scope recurrence promotion with reference-counted retirement

PLUR treats repeated learning across scopes as signal. If the same content hash is learned again in the same scope, it increments a reference count and records another source rather than creating a duplicate. If the same knowledge is learned in a different scope, PLUR records cross-scope recurrence, appends source metadata, increments recurrence/reference counters, and can broaden the memory toward global scope while escalating commitment from exploring to leaning, decided, and locked. Forgetting decrements the reference count first; the memory retires only when the supporting references are gone.

Open Second Brain is already multi-project and multi-agent. Some Brain knowledge should remain local to one project, while other lessons become global only after they recur in multiple places. Today Open Second Brain has source metadata, content hashing, visibility tags, and multi-vault/profile work, but the operator still needs to reason manually about when a repeated convention has become generally true.

Acceptance criteria:

- Same-scope duplicate writes increment support instead of creating duplicate Brain entries.
- Cross-scope duplicate writes are detected and recorded as recurrence evidence.
- Scope broadening and commitment escalation are thresholded, auditable, and configurable.
- Forget/source-removal decrements support before retirement.
- `why_retrieved` or diagnostics can show source/support/recurrence evidence.
- Tests cover same-scope duplicate, cross-scope recurrence, scope promotion, locked-memory behavior, reference-counted forget, and source purge interactions.

# Project context

Project: Open Second Brain, a Bun/TypeScript CLI and MCP server for an Obsidian-native AI memory layer. Runtime: Bun, TypeScript, Markdown vault files under `Brain/`.

Recent commits:

- 0162d13 feat(brain): add context continuity and receipts suite (#56)
- 3b7b3a5 feat(brain): add safety governance foundations (#55)
- 794ee45 feat(search): ship recall control and trust surfaces (#54)
- 40d4e2b feat: cjk schema lifecycle recovery - CJK search, schema admin, lifecycle hooks, watchdog (#53)
- f62918c feat: runtime schema packs foundation - schema vocabulary, artifact taxonomy, schema inspection (#52)
- 14d1ee1 feat: brain model semantics foundation - typed preference relations, memory labels, dry-run backfill (#51)
- 3a5d5c3 feat: agent capability CLI integration - runtime MCP capabilities, inherited JSON, completions (#50)
- a085bfa feat: vault portability + session economy - codec, sources dashboard, vault-map tokens, multi-vault profiles, graph export/import (#49)
- 73e4a28 feat: brain lifecycle suite - mutation audit, multi-phase dream, reconcile domains, morning brief, temporal extraction, heal enrichment (#48)
- bd49cd5 feat: recall and ranking quality - Weibull recency, query intent, synonym expansion, recall budgets, query cache, pre-compress pack (#47)

Related files and surfaces:

- `src/core/brain/log.ts` and `src/core/brain/log-jsonl.ts`: append-only Brain log and machine-readable JSONL reader.
- `src/core/brain/dream.ts`: deterministic batch mutation pipeline that promotes signals into preferences and writes audit log entries.
- `src/core/brain/paths.ts`: canonical Brain layout constants and path constructors.
- `src/core/brain/types.ts`: Brain frontmatter and event type contracts.
- `src/cli/brain.ts`, `src/cli/brain/verbs/index.ts`, `src/cli/brain/help-text.ts`: CLI verb dispatch/help/export patterns.
- `src/mcp/brain-tools.ts`: MCP Brain tool registry and handlers.
- `skills/brain-memory/SKILL.md`, `skills/open-second-brain/SKILL.md`: current installed procedural guidance files.
- `docs/idea.md`: explicitly separates event log as operational evidence from synthesized second-brain knowledge.
- `docs/plans/2026-05-15-brain-roadmap.md`: has a related but deferred `skill-codify` idea; this release should remain review-first and should not auto-edit active skills without operator approval.

Conventions:

- Open Second Brain writes only under `Brain/` inside the user's vault.
- Raw operational evidence belongs in `Brain/log/`; synthesized knowledge belongs in managed Brain artifacts.
- Default behavior should be deterministic, local-first, opt-in or preview-first where risk exists.
- No network calls or LLM calls in default learning/proposal paths.
- User-facing public docs must use the full project name, not unexplained abbreviations.
- CLI surfaces typically have `--json`, dry-run/preview behavior where writes could surprise the operator, and focused tests under `tests/cli/` plus core tests under `tests/core/brain/`.
- MCP full-scope tools are read/diagnostic unless a writer-scope behavior is explicitly justified.

Constraints:

- Keep changes SOLID, KISS, DRY.
- Do not auto-activate generated skills or mutate source `SKILL.md` files without explicit accept/review.
- Preserve existing preference-learning `dream` behavior; skill proposals are a companion workflow, not a replacement.
- Avoid adding external dependencies unless clearly necessary.
- Prefer local Markdown/JSONL artifacts over a daemon or hidden database.
- Keep the first release slice coherent; defer heavyweight embeddings or generic agent orchestration.

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
