You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Release wave "Unattended maintenance and MCP fault guards" for Open Second Brain (target v1.65.0). Four items ship in one pull request. Each item below is the verified premise (the original upstream-inspired card corrected against the live source), not the raw card.

## Item 1: Cron recipe for the maintenance lane

`o2b brain maintenance run` is documented as "the cron entry point" (it runs dream, reindex, bridges and clusters under a lease and a `--window H-H --tz ZONE` gate) but has no `--cron-template`. A shared print-never-install kernel already exists in `src/cli/cron-recipe.ts` (`CronRecipeSpec`, `parseInterval` for `<N>m|h|d`, `renderCronRecipe` printing a watchdog script, a native crontab line and a `hermes cron create` line, `operatorScriptPath`). Two verbs consume it: `search reindex --cron-template` (default 30m) and `partner codegraph resync --cron-template` (default 6h). Add `--cron-template [--interval <N>m|h|d]` to `brain maintenance run`, default interval 1h, embedding the resolved vault and the optional `--window/--tz`; a bad interval exits with the lane's usage code 2. Also fix `src/cli/discipline-install.ts`, whose default Hermes jobs file is hardcoded to `/root/.hermes/cron/jobs.json`: derive it from the home directory. No installer, no `--scheduler` flag.

## Item 2: Process-level fault guard for the MCP server

Nothing registers `unhandledRejection` or `uncaughtException`, so a stray rejection kills `o2b mcp` with the runtime default and no named line; Claude Code and Codex never restart a dead MCP server mid-session (the Hermes bridge restarts once). Signal draining already lives CLI-side in `src/cli/mcp-drain.ts` (`installMcpSignalDrain`, injected `stderr`/`exit`). Exit hooks exist: WAL checkpoint (`src/core/search/store-exit.ts`), lock unlink (`src/core/brain/sync-lockfile.ts`). HTTP transport has a `/health` endpoint that reports drain state. Desired: rejections are survived (rate-limited named stderr log, counted), an uncaught exception logs and exits with a distinct code (70) through the normal exit hooks, the fault count is visible on `/health`, with an in-process test and a spawned-process regression test.

## Item 3: Install-owned custom tasks in the maintenance lane

The lane kernel `runMaintenance` (src/core/brain/maintenance/lane.ts) already runs whatever task array the caller passes; the journal and streak logic key on plain strings. Blockers: the CLI verb (src/cli/brain/verbs/maintenance.ts) and the MCP tool (src/mcp/brain/admin-tools.ts) each build the four built-in tasks inline (duplicated); `--retry`/`retry_tasks` validate with `isLaneTask` and cap at four; each built-in task's safeguard timeout is keyed by an `OPERATION` member; the MCP tool description is 295 of 300 allowed characters. Config is a flat `key: value` machine file (no nested lists). Precedent for operator-configured shell commands exists (`bench_judge_cmd`, shared `shellArgv` in src/core/reliability/command-bridge.ts) and an output redactor exists. Desired: an operator declares their own recurring command so it runs under the lane's window, busy, pressure, lease and streak gates. Security constraint: the vault is synced and writable by MCP write tools, so commands must never come from the vault.

## Item 4: Repository-declared schedules (narrowed)

Upstream lets a repository declare background schedules that the tool discovers. Open Second Brain has no per-repository config convention, and a discovery verb fed by repository content would carry foreign shell commands into a printed recipe. The orchestrator has already refused the discovery part. What survives: a systemd user timer rendering (`.service` + `.timer`) in the shared recipe kernel, offered as `--format cron|systemd` on the recipe surfaces.

# Project context

Open Second Brain: TypeScript on Bun (CI pins Bun 1.4.0), CLI `o2b` plus an MCP server (stdio and HTTP), Obsidian-compatible Markdown vault, SQLite index.
Recent commits:
4499698c feat: search that honours pins and event time, diagnostics that prove action, writes that name their residue (v1.64.0) (#223)
a0b3c2e0 feat: exactly-one binding for mentions and imports, once-only write receipts, selectable search breadth and per-device ledgers (v1.63.0) (#222)
f4f9e3e6 feat: silent failures surface by name in redaction, receipts, ingest, search store, doctor (v1.62.0) (#220)
Related files:
src/cli/cron-recipe.ts, src/cli/search-cron-template.ts, src/cli/partner-codegraph-cron.ts, src/cli/discipline-install.ts, src/cli/brain/verbs/maintenance.ts, src/cli/command-manifest.ts, src/cli/main.ts (cmdMcp), src/cli/mcp-drain.ts, src/mcp/http.ts, src/core/brain/maintenance/lane.ts, src/core/brain/maintenance/journal.ts, src/core/config.ts (maintenance_embeddings flag pattern), src/core/reliability/command-bridge.ts, src/mcp/brain/admin-tools.ts, src/mcp/registry-guard.ts
Conventions:
- Recipes print and never install; the operator copies them into their scheduler.
- Errors surface by name; no silent skips. Every flag declared in the command manifest (a completeness test enforces it).
- MCP tool descriptions capped at 300 characters, property descriptions at 160.
- `src/mcp` imports nothing from `src/cli`.
- Version bump and CHANGELOG ride inside the feature PR.
Constraints:
- No new dependencies. No plugin system. All user-facing strings English.
- Existing byte-pinned recipe fixtures (search reindex) must stay byte-identical.
- Implementation runs as four parallel lanes with disjoint file ownership in one worktree.

# Required output format

For EACH of the four items produce 2 or 3 distinct variants (fewer than the usual three is fine where the space is narrow). For each variant:

### Item K / Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the variants of each item, add exactly one recommendation for that item:

### Item K / Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
