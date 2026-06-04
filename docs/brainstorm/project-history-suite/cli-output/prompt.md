You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

One PR ships the "Project History Suite" for Open Second Brain - four related kanban tasks that turn a linked project's git history and code structure into queryable Second Brain memory:

## Task 1 (t_c812752c, priority 2): Git history memory with commit, file, author, and release edges

Add optional Git history ingestion for linked project worktrees. It should create local Brain records for commits, tags, and releases, link commits to files and authors, and update incrementally from a per-repository watermark.

Suggested design from the upstream study (Keep):
- Use a sanitized non-interactive `git log --name-only` reader with bounded commit limits and strict SHA validation for watermarks.
- Store commit records with message, author, timestamp, repo identity, full SHA, touched files, and source path.
- Add typed edges from files to latest commit and from commits to touched files, authors, tags, and releases.
- Integrate with project/worktree registry and optional watches so new commits are indexed after branch switches or checkouts.
- Provide scoped search/report commands such as `brain git-history find` or include commit results in existing context packs when project scope matches.

Acceptance criteria:
- OSB can ingest commits from a linked Git repository without modifying the repository or Git index.
- Incremental re-runs use a validated watermark and do not duplicate commits.
- Commit, file, author, tag, and release relationships are represented as typed Brain edges.
- Search/context pack output can answer why/when a file changed using commit records.
- Tests cover initial ingest, incremental ingest, malformed watermark handling, branch/HEAD movement, and missing Git fallback.

## Task 2 (t_929da8a2, priority 2): Auto-generate architecture docs for code projects with sentinel markers

A command points at a software project and auto-generates a maintained set of architecture notes in the vault: an overview, one note per core module, and a key-decisions note. Sentinel markers (`<!-- @generated -->` / `<!-- @user -->`) ensure re-runs only update generated content without clobbering manual edits. A deterministic stdlib-only scanner produces facts.

IMPORTANT project constraint: Open Second Brain core NEVER calls an LLM internally. The upstream feature uses an LLM for prose synthesis; our version must be fully deterministic - the scanner produces structured facts (module inventory, dependency fan-in/out, entry points, file counts, languages), and the generated notes render those facts as structured markdown. LLM prose, if any, is the CALLING agent's job and would live in the @user regions or via future write surfaces.

Acceptance criteria (adapted):
- A CLI verb scans a project directory deterministically (no network, no LLM) and writes/updates architecture notes in the vault.
- Sentinel-marker regions: re-running regeneration replaces only @generated regions, preserves @user regions byte-for-byte.
- Re-run on an unchanged project is idempotent (no diff).
- Tests cover first generation, regeneration with user edits preserved, module add/remove, marker corruption handling.

## Task 3 (t_93d299bb, priority 1): Commit-decision miner - surface decision-shaped commits as ADR candidates

Scan commit messages (from the records Task 1 ingested) for decision-making language and propose them as draft ADR (Architecture Decision Record) candidate notes pending operator review. Deterministic heuristics only (conventional-commit markers, decision keywords/patterns), no LLM classification.

Acceptance criteria (adapted):
- A miner pass over ingested commit records produces draft decision-candidate notes in a dedicated vault area, each linking back to its source commit record.
- Deterministic scoring/matching: same input always yields the same candidates.
- Re-runs do not duplicate candidates (stable candidate identity derived from commit SHA).
- Tests cover marker-based detection, keyword detection, dedup on re-run, and empty-history behavior.

## Task 4 (t_405b8053 delta, priority 0): Close the query telemetry gap for brain_query

Open Second Brain v0.39.0 already ships recall telemetry for brain_search, context packs, pre-compress, and the recall gate, all routed through a lazy gated emit kernel (`emitGatedTelemetry`) into continuity records (`Brain/log/continuity/YYYY-MM.jsonl`). The one remaining query surface without telemetry is the `brain_query` MCP tool (preference/topic/log-since aggregations). Extend the existing `RecallTelemetryMode` union with a `"query"` mode and wire the brain_query handler through the same gate (`resolveRecallGateTelemetry`), mirroring the brain_search pattern (success and error paths, no raw query text persisted).

Acceptance criteria:
- With telemetry gate off (default): zero continuity writes, payload thunk never invoked.
- With gate on: brain_query emits one recall_telemetry record with mode "query", duration, result count, status.
- Raw query arguments (preference ids, topics) are hashed or summarized, never stored verbatim if they could contain private text - follow whatever brain_search does today.
- Tests: no-consumer regression test plus gated-emission test.

# Project context

Open Second Brain - TypeScript on Bun, an agent memory layer over Obsidian-compatible Markdown vaults. CLI (`o2b`) + MCP server. 3619 tests, strict tsc, oxlint.

Recent commits:
8e8c0bc feat: Memory Observability Suite - versioned continuity contract, lazy telemetry, ATOF/ATIF export, recall benchmark (#70)
eb56c9f feat: Workspace Insight Suite - project pointers, cross-vault recall, trigger queue, proactive synthesis (#69)
707197a feat: Agent Surface Suite - skills over MCP, two-pass tool catalog, surface profiles, session lifecycle (#68)
eda202d feat: Embedding Provider Suite - local embedder, provider registry, cost gate, RRF fusion (#67)
dee5ab7 feat: Memory Integrity Suite - canonical entities, conflict-free log shards, capture boundaries, fact extraction (#66)

Related existing infrastructure:
- Project/worktree registry (v0.38): `.o2b-vault.json` pointer files + `projects.json` registry beside config; `src/core/brain/portability/pointer.ts` (writeVaultPointer, findVaultPointer, registerLinkedProject, listLinkedProjects); CLI `o2b brain project link|list|remove|status`.
- Existing git-reading code: `src/core/discipline/activity-git.ts` - `gitActivity()` shells out to `git log --since --until --no-merges --numstat`, fail-soft null on error. Pattern to follow for a sanitized non-interactive git reader.
- Inline markers: `src/core/brain/inline.ts` parses `@osb` feedback markers (inline + fenced block forms) with originText preservation - a related but different mechanism from HTML-comment sentinel regions; the arch-docs generator needs its own region merge engine.
- Note writing: notes are plain markdown with YAML frontmatter; `Brain/preferences/pref-<slug>.md` pattern; atomic writes via fs-atomic helpers; markdown Brain log + JSONL sidecar per day in `Brain/log/`.
- Typed links: schema packs expose `link_types` (e.g. contradicts, supersedes) configured in the vault schema; wikilinks `[[target]]` are the graph edge primitive, backlink index parses them.
- Search: SQLite FTS5 over vault markdown (tokens implicit-AND), plus optional vector index. New markdown notes under any Brain/ path are picked up by reindex; context packs (`brain_context_pack`) assemble budgeted evidence.
- Telemetry: `emitGatedTelemetry(gate, build)` kernel in `src/core/brain/continuity/emit.ts`; recall telemetry records in monthly continuity shards; config gate `resolveRecallGateTelemetry` (env `OPEN_SECOND_BRAIN_RECALL_GATE_TELEMETRY` || config key, default off).
- CLI verb registration: `src/cli/brain/verbs/index.ts` (export), `src/cli/brain.ts` (import+dispatch), `src/cli/brain/verbs/help-text.ts` (BRAIN_HELP + VERB_HELP), `src/cli/command-manifest.ts` (name+summary).

Conventions:
- Core logic in `src/core/brain/<area>/`, CLI wrappers in `src/cli/brain/verbs/`, MCP wrappers in `src/mcp/*-tools.ts`.
- Fail-fast for primary writes, fail-soft/fail-open for telemetry and external resources (git, pointers).
- Readonly types, pure functions where possible, domain errors with `code` property.
- MCP tool count is a watched contract (65 advertised tools in v0.39.0); CLI-only surfaces are preferred for operator/batch workflows; MCP additions need strong justification.

Constraints:
- No new external dependencies (no nodegit, no PDF libs - shell out to `git` binary like activity-git.ts does).
- Open Second Brain core never calls an LLM internally; everything in this PR must be deterministic.
- Do not change existing public APIs; additive only.
- Never modify the scanned repository or its git index; read-only `git log` / `git tag` style commands with strict argument sanitization (no user-controlled flags, validated SHAs, `--` separators).
- Private-region and visibility rules apply to anything that lands in vault notes or continuity records.
- The four tasks ship as ONE PR with atomic per-task commits; shared infrastructure should be designed once, not duplicated.

Key open design questions you should take a position on in each variant:
1. Where do commit records live: (a) one markdown note per commit in the vault (searchable via existing FTS, but potentially thousands of files), (b) a JSONL/SQLite sidecar store with a thin markdown summary layer (compact, but needs its own query path), or (c) hybrid - JSONL store as source of truth + per-repo digest notes that FTS can find?
2. How are typed edges represented: wikilinks in markdown, structured fields in JSONL records, or both?
3. How does the commit-decision miner consume Task 1's records, and where do ADR candidates live?
4. How does the arch-docs generator's region merge engine work (HTML comment sentinels, region ids, conflict behavior)?
5. What is the shared kernel across tasks 1-3 (git reader, record store, note renderer) and what stays per-feature?

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
