# Unattended maintenance and MCP fault guards - scheduler recipes for the lane, install-owned lane tasks, and an MCP server that survives a stray rejection

**Status:** draft
**Author:** release orchestrator (via feature-release-playbook)
**Audience:** implementation
**Target release:** 1.65.0 (the `package.json` bump happens in PR preparation, not in implementation)

## Problem statement

Open Second Brain has an unattended maintenance lane (`o2b brain maintenance run`) whose own docblock calls it the cron entry point, yet the CLI prints a scheduler recipe for `search reindex` and `partner codegraph resync` but not for the lane, and the only verb that writes a schedule (`o2b discipline install`) hardcodes a Hermes jobs file under `/root`. The lane runs a fixed set of four built-in tasks, so an install cannot put its own upkeep under the lane's window, busy, pressure, lease and streak gates. Separately, the `o2b mcp` server registers no process-level fault handler: one stray promise rejection anywhere in core ends the server with the runtime default and no named line, and Claude Code and Codex never restart a dead MCP server mid-session.

## Premise verification

Every card was checked against the live source at `4499698c` (v1.64.0) before the brainstorm. Two of the four premises were corrected, one was confirmed, one was narrowed.

| Card | Verdict | Correction that shapes this design |
|---|---|---|
| portable cron/systemd scheduling | partly false | A print-never-install recipe kernel already exists (`src/cli/cron-recipe.ts`, `renderCronRecipe`) with a native crontab path and two consumers. The real gap is that `brain maintenance run` (the cron entry point, `src/cli/brain/verbs/maintenance.ts:15-17`) has no `--cron-template`. Dream is a lane task and needs no separate recipe. An installer and `--scheduler` contradict the print-never-install rule. The `/root` default jobs path (`src/cli/discipline-install.ts:17`) is real. |
| MCP fault guards | confirmed | Zero `unhandledRejection`/`uncaughtException` listeners in `src`, `hooks`, `plugins`, `scripts`, `bin`. Anchor `src/mcp/server.ts:294` is stale (the cited function is at `:418`). The trigger is a rejection escaping tool handlers or core, not a specific server loop (`src/mcp/stdio.ts` already catches per line). The Hermes bridge restarts the child once; Claude Code and Codex do not. |
| deployment-owned lane routines | partly false | The lane kernel is not a fixed pipeline: `runMaintenance` (`src/core/brain/maintenance/lane.ts:313`) runs whatever tasks the caller passes, and the journal keys on plain strings. The blockers are the duplicated inline task lists (CLI `maintenance.ts:306-375`, MCP `admin-tools.ts:476-545`), `isLaneTask` validation and the four-entry cap on `--retry`/`retry_tasks`, the `OPERATION`-keyed safeguard, and a 295 of 300 character MCP description. "Max retries" in the card is `failure_streak_limit`. |
| branch-local schedule discovery | narrowed, discovery refused | The kernel renders intervals only and has no systemd form. Open Second Brain has no per-repository config convention, and the kernel's script body is consumer-authored shell, so a discovery verb would carry repository-authored commands into a recipe the operator pastes. Only the systemd timer rendering survives (see the refusal below). |

Spot checks repeated during design (all confirmed at HEAD): `DEFAULT_JOBS_FILE` at `discipline-install.ts:17`; `renderCronRecipe` at `cron-recipe.ts:229` and `ParsedInterval` carrying only `cron`, `human`, `hermesSchedule`; the timeout rule in `consecutiveTaskFailures` (`journal.ts:271`, a timed-out row neither counts nor ends a streak); `resolveMaintenanceEmbeddings` via `resolveConfigFlag` (`config.ts:1102-1119`, `:669`); `shellArgv` private at `command-bridge.ts:38`; `MAINTENANCE_LEASE_TTL_MS = 30 min` (`lane.ts:75`); `installMcpSignalDrain` call sites in `cmdMcp` (`main.ts:880`, `:903`); `HEALTH_PATH` at `http.ts:166`; the current `brain_maintenance` description measures 295 characters. zg queries for systemd rendering and process fault handlers returned no source hits (`cli-output/zg-*.txt`).

## Scope

1. **Maintenance lane cron recipe.** `o2b brain maintenance run --cron-template [--interval <N>m|h|d] [--window H-H --tz ZONE] [--format cron|systemd]` prints a recipe and writes nothing. Backed by a new `src/cli/maintenance-cron.ts` (`MAINTENANCE_CRON_NAME = "osb-maintenance"`, `DEFAULT_MAINTENANCE_INTERVAL = "1h"`, `MAINTENANCE_RECIPE`, `renderMaintenanceCronTemplate`). The script body runs `o2b brain maintenance run --vault '<vault>' [--window H-H --tz ZONE] --json`, keeps the exit code, stays silent on exit 0 and prints the JSON on any other exit so cron mail or a Hermes job surfaces it. A bad interval, a bad window, a bad format, or `--cron-template` on `status` exits with the lane's usage code 2. Flags are declared in the command manifest.
2. **Hermes jobs path from the home directory.** `discipline-install.ts` derives the default jobs file from `homedir()` joined with `.hermes/cron/jobs.json`; `OSB_HERMES_JOBS` still overrides. When the home directory cannot be resolved (empty `homedir()`), the verb fails with a named error naming `OSB_HERMES_JOBS` as the way out.
3. **systemd user timer rendering.** A shared `renderSystemdTimer(spec, interval, opts)` in `src/cli/cron-recipe.ts`, a sibling of `renderCronRecipe` that takes the same `CronRecipeSpec`, so a recipe cannot say one thing in cron and another in systemd. `renderCronRecipe` keeps its output byte for byte; the only edit to it is extracting the header and the script section into a private helper both renderers call. `--format cron|systemd` (default `cron`) selects the renderer. `systemd` prints the same watchdog script section plus a `.service`/`.timer` pair (`OnBootSec=`, `OnUnitActiveSec=<N><unit>`, `Persistent=true`) to save under `~/.config/systemd/user/`, the `systemctl --user daemon-reload` and `enable --now` commands, the `loginctl enable-linger` note, and the same verify footer. Offered on all three recipe surfaces: the new maintenance recipe, `search reindex --cron-template` and `partner codegraph resync --cron-template` (a small change: each consumer exports a format-aware render function and its verb forwards one flag).
4. **MCP fault guard.** New `src/cli/mcp-fault-guard.ts` with `installMcpFaultGuard`, `EXIT_INTERNAL_FAULT = 70`, `FAULT_KIND`, rate-limited logging (`REJECTION_LOG_BURST = 5` full lines per `REJECTION_LOG_WINDOW_MS = 60_000`, then one summary line per window). An unhandled rejection is logged by name with its first stack frame, counted, and the server keeps serving. An uncaught exception is logged by name and exits 70 through `process.exit`, so the existing exit hooks (WAL checkpoint, lock unlink) run; no drain is attempted. Installed in `cmdMcp` next to both drain installs and released in the same `finally` blocks; probe mode does not install it. The HTTP `/health` response carries `faults: { unhandled_rejection, uncaught_exception, last_fault_at }` through a getter injected from the CLI, so `src/mcp` still imports nothing from `src/cli`.
5. **Install-owned custom lane tasks.** Declared in the machine config file only, as flat keys: `maintenance_custom_<name>: <command>`, optional `maintenance_custom_<name>_cwd` and `maintenance_custom_<name>_timeout_seconds`. Master switch `maintenance_custom_tasks` (default off) with env override `OPEN_SECOND_BRAIN_MAINTENANCE_CUSTOM_TASKS`, the `maintenance_embeddings` pattern. Identity `custom:<name>`, `<name>` matching `^[a-z][a-z0-9-]{0,31}$`. A custom task spawns the command through the shared `shellArgv` form, with cwd defaulting to the vault, stdin closed, `O2B_VAULT` set, a default timeout of 600 s, and a non-zero exit reported as `exit <N>: <redacted, capped stderr tail>`. It never calls the model and records no spend receipt. A timeout of a custom task counts toward its failure streak.
6. **One shared lane task builder.** `src/core/brain/maintenance/lane-tasks.ts` builds the four built-in tasks plus the declared custom tasks once, used by both the CLI verb and the MCP tool. The two duplicated inline lists are removed. `--retry`/`retry_tasks` accept custom identities and validate against the registered task names; the cap becomes the number of declared tasks.
7. Tests, docs (`docs/cli-reference.md`, `docs/mcp.md`, `docs/updating.md`, `docs/hermes-cron.md`) and a `CHANGELOG.md` entry under `## [1.65.0] - 2026-10-01`.

## Out of scope

- Any installer: no verb writes a crontab, a systemd unit, a launchd plist or a Task Scheduler entry. No `--scheduler` flag.
- A recipe for `discipline report`: its value is the Hermes `deliver` field, which a plain crontab cannot reproduce. Hermes stays its only installer.
- A time-of-day field in the recipe kernel (`--at HH:MM`): `--window` already gives time-of-day semantics, and widening `parseInterval` risks the byte-pinned reindex fixture.
- Persisting MCP fault counts for `o2b doctor`: writing to the vault from a fault handler risks the lock the guard protects. stderr plus `/health` only.
- Giving up after N rejections per minute: count and expose them; revisit only if a real loop shows up.
- A plugin system, a JSON protocol for custom tasks, or custom tasks declared in the vault `_brain.yaml`.
- Repository-declared schedules and a discovery verb (refused, see below).

## Refusal: repository-declared schedules and the discovery verb

The card asked for project branches or worktrees to declare background schedules (an upstream `.daemon/schedule.json` pattern) that Open Second Brain discovers and surfaces as proposals. This wave refuses that part, for three reasons:

1. **No per-repository config convention exists.** Open Second Brain reads no project file of its own today: configuration lives in the vault and in the machine config, and cross-project wiring is a managed block the operator pastes into the project's agent instructions. A `.o2b/schedule.json` would be a new public file format that the stability policy then binds the project to supporting indefinitely, on the strength of one upstream release and no user signal.
2. **A print-only verb fed by repository content would carry foreign shell commands.** A recipe's script body is shell the operator pastes into a scheduler. Feeding it from a file in a repository the operator merely checked out turns "print only" into a copy-paste path for code someone else wrote. An allowlist of Open Second Brain verbs would make it safe, but then every allowed job already has its own `--cron-template` (the reindex, codegraph and, from this release, the maintenance lane recipes), so the discovery verb would add a file format without adding a capability.
3. **The kernel could not render the upstream schedule anyway.** The upstream example is a calendar slot ("Sunday 04:00"); the kernel renders intervals only, and calendar slots are out of scope for the reason given above.

What survives is the part with standalone value: the systemd user timer rendering (`renderSystemdTimer` and `--format cron|systemd`), shared by every recipe surface. A future card can revisit discovery if users ask for it, starting from the allowlist design recorded in the premise report.

## Chosen approach

The consultant's recommended variant was taken for every item, with three overrides where an orchestrator decision binds the detail (recorded in `variants.md`): the maintenance spec lives at `src/cli/maintenance-cron.ts`, not under `src/cli/brain/`; the custom task keys are `maintenance_custom_<name>` with their own `_timeout_seconds` and a `custom:<name>` identity, not `maintenance_task_<name>` with the `OPERATION` timeout key and a widened `string` type; and the `/health` fault count reaches `src/mcp/http.ts` through an injected getter typed in `src/mcp`, not through a new shared counter module. In prose:

- **Recipes** extend the existing kernel instead of adding a second one: the maintenance lane becomes a third `CronRecipeSpec` consumer, and systemd is a second renderer over the same spec (same script body, same verify footer), so a recipe can never say one thing in cron and another in systemd.
- **The fault guard** is a CLI-side sibling of `mcp-drain.ts` with the same injection shape (`stderr`, `exit`, `now`), installed only by the two served transports of `o2b mcp`. Foreground verbs keep failing loudly.
- **Custom tasks** reuse the lane kernel untouched except for widened identity types and one journal rule; the new code is a config resolver, a spawning task factory and the shared builder that both front doors call.

## Design decisions

Orchestrator decisions (binding, recorded here as decided before the brainstorm):

- **D1. Four cards, four features, one pull request, version 1.65.0.** The bump is done during PR preparation, not during implementation.
- **D2. No new dependencies, no plugin system, errors by name, no silent skips, English user-facing strings.**
- **D3. The recipe lives on `brain maintenance run`, not a new verb.** Default interval `1h`: the lane's window, busy and lease gates decide whether work happens and a gate skip exits 0, so hourly plus `--window` is the intended pattern. Bad interval exits 2 (`MAINTENANCE_EXIT.usage`), unlike the other two recipe surfaces whose `1` predates the lane's exit vocabulary; in the lane `1` means "attempted and failed".
- **D4. The Hermes jobs path is derived from the home directory**, with a named error when it cannot be resolved. Root hosts see no change; non-root hosts, which today write to `/root` and fail, start working. Named in the CHANGELOG.
- **D5. Fault guard semantics:** rejections survived, logged by name with rate limiting, counted; uncaught exceptions logged and exit 70 through the existing exit hooks; count on `/health`; in-process tests plus one spawned-process test; a section in `docs/mcp.md`.
- **D6. Custom tasks are machine config, never vault config.** The vault syncs between devices and is writable through MCP write tools, so a command stored there would let an agent or a synced edit plant code the lane then runs. No MCP parameter can add, edit or read a command.
- **D7. Master switch `maintenance_custom_tasks`, default off, env override.** A declared task runs only when the switch is on; `OPEN_SECOND_BRAIN_MAINTENANCE_CUSTOM_TASKS=0` turns it off on one host.
- **D8. Identity `custom:<name>`, `<name>` matching `^[a-z][a-z0-9-]{0,31}$`.** A colon never occurs in an `OPERATION` value, so a custom identity cannot collide with a built-in one, and underscores are banned in `<name>` so the `_cwd` and `_timeout_seconds` suffixes are unambiguous. `LANE_TASK`, `LANE_TASKS`, `isLaneTask` and `OPERATION` stay unchanged.
- **D9. One shared task builder used by both the CLI verb and the MCP tool**; `--retry`/`retry_tasks` accept custom identities; the retry cap is the number of declared tasks.
- **D10. A timeout of a custom task counts toward its failure streak.** The premise report named the risk: a command that always hangs would otherwise never be streak-refused and would cost its full timeout of lease time on every pass. Built-in tasks keep today's rule (a timeout neither counts nor ends a streak), because their budgets are per-operation and a slow vault is not a broken task.
- **D11. The MCP tool description stays under 300 characters, measured in a test.** Proposed text (263 characters): "Quiet-window, lease-guarded maintenance lane: run executes dream, reindex, bridges, clusters and declared custom:<name> tasks behind window, busy, pressure and streak gates; status renders lease and journal. Reindex embeds only with config maintenance_embeddings." The `retry_tasks` property description names the built-ins plus "custom:<name>" and never the configured names (they vary per install and the property cap is 160); proposed text measures 159 characters.
- **D12. Repository-declared schedule discovery is refused this wave**; only `renderSystemdTimer` and `--format` ship (see the refusal section).
- **D13. Parallel implementation in four lanes with disjoint file ownership** (see `plan.md`). Shared files have exactly one owner.

Design choices made here:

- **systemd is a sibling renderer over the same spec, not a branch inside `renderCronRecipe`** (consultant item 4, Variant 1). The default path stays the code the byte-pinned fixtures cover. `renderSystemdTimer` validates the interval with `parseInterval` (so the same refusals apply: seconds, 60 minutes or more, 24 hours or more, 28 days or more) and renders `OnUnitActiveSec=` from the normalised `<N><unit>` (systemd reads `m`, `h`, `d` natively). An unknown `--format` value throws `CronTemplateError` (`unknown recipe format "<x>": expected cron or systemd`), which every consumer already maps to its usage exit. The kernel exports `RECIPE_FORMATS = ["cron", "systemd"]` and `parseRecipeFormat(raw)`.
- **The maintenance recipe embeds the resolved vault**, single-quote escaped the way `discipline-install.ts` does: cron runs without the operator's environment. The `--cron-template` branch resolves the vault as `run` does and fails with usage when none is configured, rather than printing a recipe that cannot run. It returns before the lease, the gates, the journal and the metrics, and a test asserts the journal and the lease stay empty.
- **The custom task timeout is enforced by the task itself**, not by the `OPERATION`-keyed safeguard (a custom identity is not an operation): the factory kills the child on `timeout_seconds` and throws `SafeguardTimeoutError`, so the journal row carries `timed_out: true` exactly as for built-ins. The journal's streak rule then counts a timed-out row when its task is a custom identity (`isCustomLaneTask(entry.task)`), which keeps the verdict honest on the row and changes nothing for built-in rows. The timeout must stay below `MAINTENANCE_LEASE_TTL_MS` (30 min); a declared value at or above 1800 s is a named config error.
- **Config errors are named, never dropped.** A bad name, an empty command, a non-integer or out-of-range timeout, a `_cwd`/`_timeout_seconds` key without its command, or more than `CUSTOM_TASK_MAX = 8` tasks each produce an error string. The CLI prints each on stderr as `custom task refused: <reason>`; the MCP tool returns them in a `custom_task_errors` field. A refused declaration journals nothing; valid declarations still run. With the master switch off, declared keys are reported once as `custom tasks declared but maintenance_custom_tasks is off` in `status`, never run.
- **The shared builder lives in core** (`src/core/brain/maintenance/lane-tasks.ts`) and takes the surface-specific parts by injection: `safeguardFor(op)`, `signal`, `progress`, `onBanner`, `forceCost`. Its output is `{ tasks, reindex, taskNames, customErrors }`. The metrics writes and store handling move unchanged from the two inline lists.
- **Fault guard listeners use `process.on`, not `once`**: with `once`, a second rejection would fall back to the default handler and kill the process. A throw inside the exception handler goes straight to `exit`. Every stderr write is wrapped in try/catch (a closed stderr must not turn the guard into a crash). The guard is released before `cmdMcp` returns, so the top-level `main().catch` still crashes loudly once the server has stopped.
- **`EXIT_INTERNAL_FAULT = 70` lives in the guard module** (sysexits `EX_SOFTWARE`), distinct from 1 (generic CLI error) and 130/143 (signals), so a wrapper can tell a crash from a stop.

## File changes

New files:
- `src/cli/maintenance-cron.ts`
- `src/cli/mcp-fault-guard.ts`
- `src/core/brain/maintenance/custom-tasks.ts`
- `src/core/brain/maintenance/lane-tasks.ts`
- `tests/cli/maintenance-cron.test.ts`
- `tests/cli/mcp-fault-guard.test.ts`
- `tests/cli/mcp-fault-guard-spawn.test.ts`
- `tests/fixtures/mcp-fault-guard/serve-with-rejection.ts`, `tests/fixtures/mcp-fault-guard/serve-with-throw.ts`
- `tests/mcp/http-health-faults.test.ts`
- `tests/core/brain/maintenance/custom-tasks.test.ts`
- `tests/core/brain/maintenance/lane-tasks.test.ts`

Modified files:
- `src/cli/cron-recipe.ts`, `src/cli/search-cron-template.ts`, `src/cli/partner-codegraph-cron.ts`, `src/cli/search/verbs/indexing.ts`, `src/cli/partner.ts`, `src/cli/discipline-install.ts`
- `src/cli/main.ts` (`cmdMcp` only), `src/mcp/http.ts`
- `src/core/brain/maintenance/lane.ts` (identity types), `src/core/brain/maintenance/journal.ts` (custom timeout rule), `src/core/config.ts`, `src/core/reliability/command-bridge.ts` (export `shellArgv`)
- `src/cli/brain/verbs/maintenance.ts`, `src/mcp/brain/admin-tools.ts`, `src/cli/command-manifest.ts`
- Tests: `tests/cli/cron-recipe.test.ts`, `tests/cli/search-cron-template.test.ts`, `tests/cli/partner-codegraph-resync.test.ts`, `tests/cli/discipline-install.test.ts`, `tests/core/brain/maintenance/maintenance.test.ts`, `tests/cli/brain-maintenance.test.ts`, `tests/mcp/maintenance-parity-census.test.ts`, `tests/cli/manifest-completeness.test.ts`
- Docs: `docs/cli-reference.md`, `docs/mcp.md`, `docs/updating.md`, `docs/hermes-cron.md`, `CHANGELOG.md`

No skill or `hooks/hooks.json` change, so `sync-plugin-mirrors` has nothing to regenerate.

## Risks and open questions

- **Byte drift in existing recipes.** Mitigation: the `cron` format path is the existing code path unchanged; the byte-pinned search fixture and the codegraph resync tests must pass unedited.
- **Process-global listeners in the shared test runner.** Every guard test releases in `finally` and asserts `process.listenerCount` before and after; the spawned-process test proves the real behaviour.
- **Bun 1.4.0 semantics.** Assumed: registering `unhandledRejection` suppresses the default exit as in Node. The spawned-process test fails if the process dies, so the assumption is checked, not trusted. If Bun differs, the implementer reports it rather than adding an env seam.
- **Swallowed rejections hiding bugs.** Each is named on stderr with its first stack frame, counted, and visible on `/health`.
- **Arbitrary command execution through an agent-triggered `brain_maintenance run`.** Mitigated by the machine-config-only source, the master switch (default off), the pattern-checked name, and no MCP input reaching a command line. The docs say the lane cannot police spend or side effects inside an operator's own command.
- **Secrets in a custom task's stderr reaching the journal.** `redactRawOutput` runs before `capOutput`.
- **Journal volume.** Up to eight more rows per pass against the 500-row cap shortens how far back built-in history reaches; the streak refusal row already preserves counts.
- **Lane 4 depends on exports from lanes 1 and 3.** The plan pins the exported signatures so lane 4 can write its tests first and wire last; integration is the last task of lane 4.
- **Open question for implementation:** whether `o2b doctor` should list declared custom tasks and their errors. Recommendation: not in this release; `status` reports them.
