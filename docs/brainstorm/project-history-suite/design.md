# Project History Suite - git history as Second Brain memory

**Status:** accepted
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation
**Kanban:** epic t_41c34987; children t_c812752c (git history memory, p2), t_929da8a2 (arch docs generator, p2), t_93d299bb (commit-decision miner, p1), t_405b8053 delta (brain_query telemetry, p0)

## Problem statement

A linked project's git history is the largest source of durable project memory, yet none of it is visible to the Brain: an agent cannot answer "why did this file change", "which release carried that change", or "which commits were decisions". Separately, code projects have no vault-native architecture documentation that survives regeneration, and `brain_query` is the one remaining recall surface without telemetry after the v0.39.0 observability contract.

## Scope

- **Git history ingest** (`o2b brain git ingest`): sanitized read-only `git log` reader over a project worktree; commit, tag, and release-range records appended to a per-repo JSONL store inside the vault; incremental re-runs via a SHA-validated watermark; per-repo digest note rendered into the vault so FTS and context packs can discover history.
- **Git history query** (`o2b brain git find` / `o2b brain git status`): deterministic query path over the JSONL store - by free text, touched file, author, or time range; status reports per-repo watermark and record counts.
- **Region merge engine** (`src/core/brain/regions.ts`): HTML-comment sentinel regions (`<!-- o2b:begin <id> -->` / `<!-- o2b:end <id> -->`); regeneration replaces only generated region bodies, preserves everything else byte-for-byte, appends new regions, fails closed on corrupted markers.
- **Architecture docs generator** (`o2b brain architect <path>`): deterministic stdlib-only project scanner (module inventory, language mix, entry points, manifest summary, test layout) rendering an overview note plus one note per core module into the vault through the region engine; idempotent re-runs.
- **Commit-decision miner** (`o2b brain git mine`): deterministic heuristics over ingested commit records (conventional-commit markers, breaking-change footers, decision keywords, revert shape) producing draft ADR candidate notes with stable SHA-derived identity; re-runs never duplicate and never clobber operator edits.
- **brain_query telemetry**: extend `RecallTelemetryMode` with `"query"`; wire the `brain_query` MCP handler through `emitGatedTelemetry` with per-call opt-in args mirroring `brain_search` (success and error paths); query argument values are never persisted - only the query kind.

## Out of scope

- No new MCP tools: every new surface is CLI-only; the MCP contract stays at 65 advertised tools. The only MCP change is additive - `brain_query` gains optional telemetry arguments mirroring `brain_search` (operator/batch workflows, same rationale as `bench` and `continuity export` in v0.39.0).
- No daemon watches / filesystem watchers: incremental ingest is invoked explicitly (operator, cron, or agent); the upstream "watch" concept reduces to cheap idempotent re-runs.
- No LLM anywhere: no commit-message classification by model, no prose synthesis in arch docs. Generated notes carry deterministic facts; agent- or operator-authored prose lives outside generated regions.
- No import-graph analysis in the scanner (per-language parsing is a later task); module facts come from directory structure, file extensions, and manifests.
- No per-commit vault notes: selective promotion only (ADR candidates). The JSONL store is the only per-commit representation.
- No cross-repo analytics or author identity resolution beyond the recorded name/email string.

## Chosen approach

Consultant Variant 3 (hybrid kernel), accepted as recommended. A per-repo JSONL store inside the vault is the canonical source of truth for commits, tags, and release ranges, with structured fields as the edge representation. The vault sees only rendered markdown: one digest note per repo (FTS-discoverable anchor with hot files, recent commits, releases) and selectively promoted ADR candidate notes. One shared kernel serves all three code-facing tasks: the sanitized git reader (modelled on `activity-git.ts`), the JSONL record store with watermark, and the region merge engine that both the arch-docs generator and the ADR candidate renderer use for regeneration safety. Wikilinks in rendered notes are always derived from store records, never hand-maintained, which contains the dual-representation drift risk the consultant flagged. Task 4 stays independent and additive on the v0.39.0 telemetry seam.

## Design decisions

- **Store location `Brain/projects/git/<repo-key>/`** (`commits.jsonl`, `state.json`, `digest.md`): inside the vault so multi-device sync carries project memory with the Brain, unlike the device-local `projects.json` registry. FTS indexes only the `.md` digest; JSONL stays machine-facing. Namespace verified unused.
- **Repo key = `<sanitized-basename>-<8-hex of sha256(absolute path)>`**: human-readable, collision-safe across same-named repos, stable for a given checkout location.
- **Git reader uses `execFileSync` with fixed argv** (no shell, no user-controlled flags, `--` separators, `-C <path>`): the proven `activity-git.ts` pattern. Commit fields parsed from `git log` with NUL field separators (`%x00`) and a unique record sentinel; `--name-only` for touched files. Bounded by `--max-count` (default 1000 per run, flag-overridable).
- **Watermark = `state.json` with `last_sha` (40-hex validated) + `last_ingested_at`**: re-run ingests `<last_sha>..HEAD` only. A watermark SHA that no longer resolves (`git cat-file -e`, e.g. after force-push) triggers a clean full re-scan; store dedup by SHA keeps that idempotent.
- **Release attribution via tag ranges**: for chronologically ordered tags, `git rev-list <prev>..<tag>` assigns each commit its carrying release in one git call per tag - the standard changelog attribution, no per-commit ancestry walks.
- **Typed edges as structured record fields** (`files`, `author`, `release`, tag records with `target_sha`): queryable without graph scans; wikilink rendering happens only in digest/candidate notes and is always regenerated from records.
- **Region engine fails closed**: unbalanced or duplicated sentinels abort the write with a domain error naming the offending region; a corrupted file is never partially rewritten. Operator text outside regions and the exact bytes of `@user` content are preserved verbatim.
- **ADR candidate identity = commit SHA** (`Brain/decisions/candidates/adr-<shortsha>-<slug>.md`): re-runs skip existing candidate files entirely (strongest no-clobber guarantee for operator-curated drafts); frontmatter carries `status: candidate`, repo key, full SHA, matched signals.
- **Decision heuristics are transparent**: each candidate records which deterministic signals matched (conventional `feat!`/`BREAKING CHANGE`, keyword set: decide/decision/adopt/switch to/migrate to/instead of/ADR/rationale, revert shape). Same input, same candidates, same order.
- **Arch-docs notes live at `Brain/projects/arch/<repo-key>/`** (`overview.md`, `modules/<module>.md`): same repo-key namespace as git history, so one project's memory clusters under one prefix.
- **brain_query telemetry is per-call opt-in** (`telemetry: true` + `telemetry_host`/`session_id`/`turn_id`), exactly like `brain_search` - not config-gated, because the caller owns the session correlation. Payload stores the query kind (`preference`/`topic`/`since`), duration, result count, status; never the supplied preference id, topic slug, or timestamp value.

## File changes

New core: `src/core/brain/git/{identity,reader,store,ingest,digest,decisions}.ts`, `src/core/brain/regions.ts`, `src/core/brain/architect/{scan,generate}.ts`.
New CLI: `src/cli/brain/verbs/git.ts` (ingest/status/find/mine subcommands), `src/cli/brain/verbs/architect.ts`; registration in `verbs/index.ts`, `brain.ts`, `help-text.ts`, `command-manifest.ts`.
Modified: `src/core/brain/recall-telemetry.ts` (mode union + guard), `src/mcp/brain-tools.ts` (brain_query schema + handler telemetry).
New tests: `tests/core/brain/git/{reader,store,ingest,decisions}.test.ts`, `tests/core/brain/{regions,architect}.test.ts`, `tests/cli/{brain-git,brain-architect}.test.ts`, `tests/mcp/brain-query-telemetry.test.ts`, `tests/e2e/project-history.integration.test.ts`.
Docs: `README.md`, `CHANGELOG.md`, `docs/cli-reference.md`, `docs/how-it-works.md`, `docs/observability.md` (mode list), this brainstorm directory.

## Risks and open questions

- Git output parsing must survive commit messages containing the field sentinel; mitigated by NUL separators plus a low-collision record sentinel and tests with adversarial messages.
- Large repos: first ingest bounded by `--max-count` default; digest renders only bounded sections (recent N commits, top N hot files) so note size stays flat.
- Tag ranges assume tags are reachable from HEAD's history; commits outside any range simply carry no release field (correct for unreleased work).
- Module detection heuristics (src/ vs packages/ vs flat layouts) need a fixture matrix; the scanner must degrade to "one module: project root" rather than guessing.
- The region engine is new shared infrastructure consumed by two features in the same PR; it lands first with exhaustive tests before either consumer.
