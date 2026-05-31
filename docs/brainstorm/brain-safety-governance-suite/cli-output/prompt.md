You are brainstorming architectural variants for the following multi-task feature release. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Implement a Brain Safety & Governance Suite for Open Second Brain, based on these kanban tasks exported locally by `.ai-notes/export_triage_snapshot.py` into `.ai-notes/tasks.json`.

## t_24b16920 - [upstream:ClawMem] Prompt-injection guard for surfaced Brain context (priority 4)

Open Second Brain stores operator-authored and agent-authored Markdown, then surfaces selected content through MCP tools, context packs, pre-compress packs, session briefs, and future host hooks. Privacy redaction and private-region stripping protect secrets, but they do not address a different failure mode: a note, transcript, tool output, or imported document can contain instructions aimed at the agent rather than facts about the world. Add an OSB context-safety guard that runs on automatically injected or MCP-rendered Brain snippets. It should classify risky content, sanitize or suppress unsafe snippets, expose deterministic reasons, preserve deterministic behavior, and avoid mutating the source note.

Acceptance criteria:

- Prompt-injection-like vault content is not injected verbatim by context-pack or MCP preview paths.
- Filtered results include deterministic reasons inspectable by the operator.
- Legitimate trusted instruction files can be explicitly allowed without weakening the default guard for ordinary notes.
- Existing private-region and secret redaction behavior remains unchanged.
- Tests cover direct phrases, delimiter spoofing, metadata/title injection, Unicode-obfuscated variants, and false-positive-safe ordinary notes.

Out of scope:

- LLM-based security classification.
- Deleting or rewriting source vault files automatically.
- Treating all Markdown instructions as malicious; protect automatic surfacing, not intentional instruction surfaces.

## t_e7d99f39 - [upstream:signetai] Agent-blind secret references for Brain integrations (priority 2, child of t_24b16920)

Support secret references such as `$secret:GITHUB_TOKEN` in source connector config, hook config, and future provider settings. OSB should store only references in Brain/config files, resolve values only in trusted local process boundaries, redact known resolved values from logs/results, and never include decrypted values in agent-facing prompts, MCP output, task cards, or Brain Markdown.

Acceptance criteria:

- OSB config can reference a secret by name without storing the raw value.
- Agents can trigger connector operations that require a secret without seeing the decrypted value.
- Secret list/status commands never reveal secret values.
- Logs, diagnostics, and command outputs redact known secret values.
- Missing/disabled secret provider failures are explicit and do not fall back to prompting the model.
- Tests cover storage, lookup, connector resolution, redaction, missing-secret errors, and audit logging.

## t_e5e067dc - [upstream:hermes-agentmemory] Source-scoped hard forget with derived-artifact cleanup (priority 3, child of t_24b16920)

Add a dry-run-first forget workflow that computes a dependency closure from a source session, event, file, artifact, or imported connector record to derived Brain artifacts and search/cache/index entries. Applying the plan should remove or retire source-owned derived records, decrement support for multi-source records, invalidate affected caches, and emit an audit receipt without re-exposing private content.

Acceptance criteria:

- A dry-run forget plan shows every source and derived artifact that would be affected.
- Applying a forget plan removes source-only derived artifacts from recall, context packs, graph traversal, and search indexes.
- Multi-source facts lose the forgotten source as support and are quarantined or retired only when policy requires it.
- Query cache, context cache, vector/FTS index rows, generated hints, and context receipts are invalidated when they reference forgotten material.
- Audit output proves the operation occurred without storing deleted private content.
- Tests cover single-event forget, full-session forget, multi-source support decrement, cache invalidation, dry-run output, and permission failure paths.

## t_d037251c - [upstream:plur] Privacy-scanned portable Brain knowledge packs (priority 2, child of t_24b16920)

Add portable Brain knowledge packs for selected confirmed memories, rules, runbooks, and project conventions. Packs should be local-first, human-readable, previewable before install, privacy-scanned before export/import, and removable without touching unrelated Brain content.

Acceptance criteria:

- OSB can export a selected subset of Brain knowledge as a portable pack without exporting the whole vault.
- Export runs a privacy scan and blocks or strips unsafe/private content by default.
- Pack preview shows manifest, count, sample entries, integrity, conflicts, and privacy warnings before install.
- Installed pack entries are source-marked and removable as a unit.
- Search/context packs can surface installed pack entries with clear provenance.
- Tests cover export filtering, privacy scan, integrity hash, install preview, conflict detection, uninstall, and search provenance.

## t_35440e83 - [upstream:hermes-lcm] Lossless externalized payload registry for oversized session content (priority 2, related safety/session task)

Add a storage-boundary payload registry for session ingestion and future session recall: large media blobs, base64 strings, and giant tool outputs should not bloat a searchable index or Brain log, but should remain recoverable when the operator explicitly asks for the exact source content.

Acceptance criteria:

- Session import externalizes configured oversized payloads before indexing while preserving a recoverable ref.
- Exact payload content can be retrieved in bounded pages by explicit ref, subject to the same vault/security policy as other Brain reads.
- Search results and extracted summaries include compact placeholders/metadata rather than raw media or base64 blobs.
- Doctor reports orphaned refs, missing payload files, and unexpectedly large inline indexed rows.
- Tests cover data URI payloads, long base64 runs, large tool outputs, redaction interaction, and missing-payload recovery errors.

# Project context

Project: Open Second Brain, TypeScript/Bun, Obsidian-native local-first Brain stored as Markdown under `Brain/`.

Recent commits:

- 794ee45 feat(search): ship recall control and trust surfaces (#54)
- 40d4e2b feat: cjk schema lifecycle recovery - CJK search, schema admin, lifecycle hooks, watchdog (#53)
- f62918c feat: runtime schema packs foundation - schema vocabulary, artifact taxonomy, schema inspection (#52)
- 14d1ee1 feat: brain model semantics foundation - typed preference relations, memory labels, dry-run backfill (#51)
- 3a5d5c3 feat: agent capability CLI integration - runtime MCP capabilities, inherited JSON, completions (#50)
- a085bfa feat: vault portability + session economy - codec, sources dashboard, vault-map tokens, multi-vault profiles, graph export/import (#49)
- 73e4a28 feat: brain lifecycle suite - mutation audit, multi-phase dream, reconcile domains, morning brief, temporal extraction, heal enrichment (#48)
- bd49cd5 feat: recall and ranking quality - Weibull recency, query intent, synonym expansion, recall budgets, query cache, pre-compress pack (#47)
- cbbe18f feat: typed graph semantics - typed relations, visibility scoping, MCP landscape (#46)
- 5fa7eb0 feat: MCP context economy - preview budget, artifact fetch, recall hint (#45)

Related files and current surfaces:

- `src/core/redactor.ts`: shared private-region stripping and secret-shaped redaction. Current behavior protects writes/logs but does not classify prompt injection.
- `src/core/brain/context-pack.ts`: collects preference/retired Markdown bodies for context-pack output; optional polarity lanes added in v0.27.0.
- `src/core/brain/pre-compress-pack.ts`: builds a system-prompt addendum from `Brain/active.md` and high-confidence preferences before host compression.
- `src/core/brain/export.ts` and `src/cli/brain/verbs/export.ts`: read-only active-preference export in JSON or llms-txt.
- `src/mcp/artifact-store.ts` and `src/mcp/tools.ts`: preview-overflow artifacts under `Brain/.artifacts/<run-id>/`, redacted before disk, retrievable by `brain_artifact_get`.
- `src/core/brain/sessions/import.ts`: imports agent session JSONL files and writes signals from inline markers and `brain_feedback` tool calls.
- `src/core/config.ts`, `src/cli/json-helpers.ts`: config/value redaction helpers already exist, but no secret-reference resolver/store.
- `src/core/graph/visibility.ts`: visibility token filtering exists for search; untagged pages remain visible.
- Docs: `README.md`, `docs/cli-reference.md`, `docs/mcp.md`, `CHANGELOG.md`.

Conventions:

- Local-first, Markdown-first. Avoid hidden services or opaque remote dependencies.
- Deterministic core behavior. No LLM-based classification in core safety paths.
- Prefer additive, opt-in surfaces that preserve existing public APIs unless task requires changes.
- CLI and MCP should expose machine-readable JSON for operators/agents.
- Existing full validation: `bun run typecheck`, `bun run lint`, `bun run test`, `bun run sync-version:check`.
- Before every commit, run formatter and linter from `package.json`.
- Version bump before GitHub push.

Constraints:

- Do not use Hermes kanban MCP tools. Task data comes from `.ai-notes/export_triage_snapshot.py` and `.ai-notes/tasks.json`.
- Keep the PR cohesive and useful. It may ship a foundation slice for the largest tasks if full scope would become an unsafe platform rewrite.
- No new external dependencies unless clearly necessary.
- No prompt-injection guard should rewrite or delete source Brain files.
- No secret value should be shown to agents or persisted in Brain Markdown.
- Any payload/pack/forget feature must be dry-run or preview-first where destructive behavior is possible.

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
