# Unattended maintenance and MCP fault guards - implementation plan

Feature branch: `feat/unattended-maintenance-mcp-guards` (already checked out; never create or switch branches). Target release 1.65.0; the `package.json` bump and `sync-version.ts` run during PR preparation, not here.

Four lanes run in parallel in one worktree, one implementer each. File ownership is disjoint: a lane edits only the files listed under its "Owns" line. When a lane needs a line in a file it does not own, it hands the exact text to the owner through the "Hands to lane 4" list below, and the owner applies it. Shared files (`src/cli/main.ts`, `src/cli/command-manifest.ts`, every doc, `CHANGELOG.md`) have exactly one owner.

Rules for every lane:
- TDD: write the test file and its cases first, watch them fail for the right reason, then implement.
- `git add` by file name only, format only your own files (`bunx biome format --write <your files>` or the project formatter via `bun run fmt` restricted to your paths), retry on `index.lock`. One commit per task, English conventional subject, no AI markers, no card ids.
- Test runs set `TMPDIR` to the wave scratch directory. Gates use the CI Bun 1.4.0 binary when present.
- `bun run typecheck` is global. An error in a file you do not own is reported to its lane owner, not fixed by you.
- Errors surface by name; no silent skips. All user-facing strings English.

## Lane contracts (pinned so lanes can test against them before they land)

Lane 1 exports from `src/cli/cron-recipe.ts`:
```ts
export const RECIPE_FORMATS: readonly ["cron", "systemd"];
export type RecipeFormat = (typeof RECIPE_FORMATS)[number];
export function parseRecipeFormat(raw: string | undefined): RecipeFormat; // undefined -> "cron"; unknown -> CronTemplateError
export function renderSystemdTimer<T extends CronRecipeOptions>(spec: CronRecipeSpec<T>, interval: string, opts: T): string;
```
Lane 1 exports from `src/cli/maintenance-cron.ts`:
```ts
export const MAINTENANCE_CRON_NAME = "osb-maintenance";
export const DEFAULT_MAINTENANCE_INTERVAL = "1h";
export interface MaintenanceCronOptions extends CronRecipeOptions { readonly vault: string; readonly window?: string; readonly tz?: string; }
export const MAINTENANCE_RECIPE: CronRecipeSpec<MaintenanceCronOptions>;
export function renderMaintenanceCronTemplate(interval: string, opts: MaintenanceCronOptions & { readonly format?: RecipeFormat }): string; // throws CronTemplateError
```

Lane 2 exports from `src/mcp/http.ts`:
```ts
export interface McpFaultCounts { readonly unhandled_rejection: number; readonly uncaught_exception: number; readonly last_fault_at: string | null; }
// ServeHttpOptions gains: readonly faultCounts?: () => McpFaultCounts;  /health then carries `faults`
```
and from `src/cli/mcp-fault-guard.ts`: `EXIT_INTERNAL_FAULT = 70`, `FAULT_KIND`, `REJECTION_LOG_BURST = 5`, `REJECTION_LOG_WINDOW_MS = 60_000`, `installMcpFaultGuard(opts?: { stderr?; exit?; now? }): { counts(): McpFaultCounts; release(): void }`.

Lane 3 exports from `src/core/brain/maintenance/custom-tasks.ts`:
```ts
export const CUSTOM_TASK_PREFIX = "custom:";
export const CUSTOM_TASK_NAME_PATTERN: RegExp; // ^[a-z][a-z0-9-]{0,31}$
export const CUSTOM_TASK_MAX = 8;
export const CUSTOM_TASK_TIMEOUT_DEFAULT_SECONDS = 600;
export type CustomLaneTask = `custom:${string}`;
export function isCustomLaneTask(value: unknown): value is CustomLaneTask;
export interface CustomTaskSpec { readonly name: string; readonly id: CustomLaneTask; readonly command: string; readonly cwd?: string; readonly timeoutSeconds: number; }
export interface CustomTaskResolution { readonly enabled: boolean; readonly specs: ReadonlyArray<CustomTaskSpec>; readonly errors: ReadonlyArray<string>; readonly declared: number; }
export function resolveCustomTasks(configPath?: string): CustomTaskResolution;
export function createCustomLaneTask(spec: CustomTaskSpec, ctx: { vault: string; signal?: AbortSignal }): MaintenanceTask;
```
from `src/core/brain/maintenance/lane.ts`: `export type LaneTaskId = LaneTask | CustomLaneTask;` and `isLaneTaskId(value)`; `MaintenanceTask.name`, `RunMaintenanceOptions.retryTasks`, `MaintenanceTaskResult.name` widened to `LaneTaskId`.
from `src/core/brain/maintenance/lane-tasks.ts`:
```ts
export interface LaneTaskBuildOptions {
  readonly vault: string; readonly configPath?: string; readonly searchConfig: SearchConfig; readonly now: Date;
  readonly forceCost: boolean; readonly safeguardFor: (operation: LaneTask) => Safeguard;
  readonly signal?: AbortSignal; readonly onProgress?: ProgressSink;
  readonly onBanner?: (preview: EmbeddingSpendPreview) => void;
}
export interface LaneTaskSet {
  readonly tasks: ReadonlyArray<MaintenanceTask>; readonly reindex: LaneReindex;
  readonly taskNames: ReadonlyArray<LaneTaskId>; readonly custom: CustomTaskResolution;
}
export function buildLaneTasks(opts: LaneTaskBuildOptions): LaneTaskSet;
```
from `src/core/config.ts`: `MAINTENANCE_CUSTOM_TASKS_ENV = "OPEN_SECOND_BRAIN_MAINTENANCE_CUSTOM_TASKS"`, `MAINTENANCE_CUSTOM_TASKS_CONFIG_KEY = "maintenance_custom_tasks"`, `resolveMaintenanceCustomTasks(configPath?)`.

## Lane 1: recipes, systemd timer, Hermes jobs path

**Owns**: `src/cli/cron-recipe.ts`, `src/cli/maintenance-cron.ts` (new), `src/cli/search-cron-template.ts`, `src/cli/partner-codegraph-cron.ts`, `src/cli/search/verbs/indexing.ts`, `src/cli/partner.ts`, `src/cli/discipline-install.ts`, `tests/cli/cron-recipe.test.ts`, `tests/cli/maintenance-cron.test.ts` (new), `tests/cli/search-cron-template.test.ts`, `tests/cli/partner-codegraph-resync.test.ts`, `tests/cli/discipline-install.test.ts`.

**Gate**: `bun test tests/cli/cron-recipe.test.ts tests/cli/maintenance-cron.test.ts tests/cli/search-cron-template.test.ts tests/cli/partner-codegraph-resync.test.ts tests/cli/discipline-install.test.ts && bun run typecheck`

### Task 1.1: `renderSystemdTimer` and recipe formats in the kernel
- **Tests first** (`tests/cli/cron-recipe.test.ts`, new cases; existing cases unchanged):
  - `renderSystemdTimer(SPEC, "30m", {})` contains the same script heredoc as `renderCronRecipe(SPEC, "30m", {})` (extract the section between the markers and compare).
  - It contains `~/.config/systemd/user/<cronName>.service` and `.timer`, `OnUnitActiveSec=30m`, `OnBootSec=`, `Persistent=true`, `systemctl --user daemon-reload`, `systemctl --user enable --now <cronName>.timer`, the `loginctl enable-linger` note and the spec's verify command.
  - It contains no crontab line and no `hermes cron create`.
  - `"6h"` gives `OnUnitActiveSec=6h`; `"1d"` gives `OnUnitActiveSec=1d`; `"90m"`, `"30s"`, `"24h"`, `"28d"`, `"nonsense"` throw `CronTemplateError` with the same messages as `renderCronRecipe`.
  - `parseRecipeFormat(undefined)` is `"cron"`, `"systemd"` passes, `"launchd"` throws `CronTemplateError` naming `cron` and `systemd`.
  - `renderCronRecipe` output for the synthetic spec is byte-identical to a snapshot taken before the refactor (pin it in the test).
- **Implementation**: extract the header and script section of `renderCronRecipe` into a private helper; add `renderSystemdTimer`, `RECIPE_FORMATS`, `RecipeFormat`, `parseRecipeFormat`. Update the module docblock: systemd output is also print-only.
- **Acceptance**: new cases green; `tests/cli/search-cron-template.test.ts` (byte-pinned) green without edits.
- **Depends on**: none

### Task 1.2: maintenance lane recipe spec
- **Tests first** (`tests/cli/maintenance-cron.test.ts`, new):
  - `renderMaintenanceCronTemplate("1h", { vault: "/v" })` renders `0 */1 * * *` and the script path `~/.local/bin/osb-maintenance.sh`.
  - The body runs `o2b brain maintenance run --vault '/v' --json`; `--window 3-5 --tz Europe/Berlin` appear only when given.
  - A vault containing a single quote is escaped the way `discipline-install.ts` escapes it.
  - The body keeps the exit code: silent on 0, prints the captured JSON and exits with the same code otherwise (assert the shell text).
  - The verify footer reads `o2b brain maintenance status`.
  - `format: "systemd"` yields `OnUnitActiveSec=1h` and the same script body.
  - `"30s"` throws `CronTemplateError`.
  - Rendering writes nothing: a temp vault tree listing is unchanged before and after.
- **Implementation**: `src/cli/maintenance-cron.ts` per the lane contract, `operatorScriptPath(MAINTENANCE_CRON_NAME)`, scheduler note "(when Hermes owns the schedule)" in the same style as the reindex recipe.
- **Acceptance**: tests green.
- **Depends on**: Task 1.1

### Task 1.3: `--format` on the two existing recipe verbs
- **Tests first**:
  - `tests/cli/search-cron-template.test.ts`: `renderCronTemplate("30m", { format: "systemd" })` contains `OnUnitActiveSec=30m`; the existing byte-pinned fixture case stays as it is.
  - `tests/cli/partner-codegraph-resync.test.ts`: `resync --cron-template --format systemd` prints a timer pair; `--format launchd` exits `EXIT_INTERVAL_REFUSED` (1) with the named message; no `--format` prints today's output.
  - Same two checks through `o2b search reindex --cron-template --format ...` in whichever existing CLI test drives that verb (`search-cron-template.test.ts`).
- **Implementation**: `renderCronTemplate` and `renderCodegraphResyncTemplate` accept an optional `format` and dispatch to `renderCronRecipe` or `renderSystemdTimer`; `indexing.ts` and `partner.ts` add `format: { type: "string" }` to their flag schemas, call `parseRecipeFormat`, and keep their existing exit code (1) for a `CronTemplateError`. Usage strings mention `[--format cron|systemd]`.
- **Acceptance**: tests green; byte-pinned fixture unchanged.
- **Depends on**: Task 1.1

### Task 1.4: Hermes jobs path from the home directory
- **Tests first** (`tests/cli/discipline-install.test.ts`): export a pure `resolveJobsFilePath(env, home)`; with `OSB_HERMES_JOBS` unset and `home = "/home/op"` it returns `/home/op/.hermes/cron/jobs.json`; with `OSB_HERMES_JOBS` set it returns that value; with `home = ""` it throws a named error whose message mentions `OSB_HERMES_JOBS`. Never touch the live jobs file.
- **Implementation**: replace `DEFAULT_JOBS_FILE` with `join(homedir(), ".hermes", "cron", "jobs.json")` resolved at call time through `resolveJobsFilePath(process.env, homedir())`; the verb maps the named error to its existing error exit with the message on stderr.
- **Acceptance**: tests green; existing discipline-install cases green.
- **Depends on**: none

**Hands to lane 4**:
- Manifest: under `search reindex` add `flag("format", "string")`; under `partner codegraph resync` add `flag("format", "string")`.
- `docs/cli-reference.md`: `search reindex` and `partner codegraph resync` rows gain `[--format cron|systemd]`; the discipline install row says the default jobs file is `~/.hermes/cron/jobs.json` of the running user, `OSB_HERMES_JOBS` overrides.
- `docs/hermes-cron.md`: one paragraph that `o2b brain maintenance run --cron-template` is the alternative to a hand-chained dream job, and that every recipe also prints a systemd user timer with `--format systemd`.
- `CHANGELOG.md` lines: systemd timer format on all recipes; maintenance recipe; Hermes jobs path fix (non-root Hermes hosts now work; root hosts see no change).

## Lane 2: MCP fault guard

**Owns**: `src/cli/mcp-fault-guard.ts` (new), `src/cli/main.ts`, `src/mcp/http.ts`, `tests/cli/mcp-fault-guard.test.ts` (new), `tests/cli/mcp-fault-guard-spawn.test.ts` (new), `tests/fixtures/mcp-fault-guard/serve-with-rejection.ts` (new), `tests/fixtures/mcp-fault-guard/serve-with-throw.ts` (new), `tests/mcp/http-health-faults.test.ts` (new).

**Gate**: `bun test tests/cli/mcp-fault-guard.test.ts tests/cli/mcp-fault-guard-spawn.test.ts tests/mcp/http-health-faults.test.ts tests/mcp/http-drain.test.ts tests/mcp/http-transport.test.ts tests/cli/o2b-mcp-launcher.test.ts && bun run typecheck`

### Task 2.1: the guard module
- **Tests first** (`tests/cli/mcp-fault-guard.test.ts`, in-process, injected `stderr`/`exit`/`now`, `release()` in every `finally`):
  - An unhandled `Promise.reject(new Error("probe"))`: wait until `counts().unhandled_rejection === 1`; the stderr line is `[mcp] unhandled_rejection #1: Error: probe (server keeps serving)` plus the first stack frame; `exit` not called.
  - A non-Error rejection reason (a string, `undefined`) is still named (`non-error reason: "x"`).
  - Rate limit: 8 rejections in one window give 5 full lines and one summary line `[mcp] unhandled_rejection: 3 more suppressed in the last 60000ms`; advancing `now` past the window logs in full again; the count is 8 either way.
  - `process.emit("uncaughtException", new Error("boom"))` gives `exits == [70]` and a line naming `uncaught_exception: Error: boom` and the exit code.
  - A throwing `stderr.write` does not escape the handler (rejection still counted, exception still exits 70).
  - `release()` restores `process.listenerCount("unhandledRejection")` and `("uncaughtException")` to their values before install; a second `release()` is a no-op.
  - `last_fault_at` is the ISO time from `now` of the latest fault, `null` before any.
- **Implementation**: `src/cli/mcp-fault-guard.ts` per the lane contract, reusing `DrainReportStream` from `mcp-drain.ts`; `process.on` (not `once`); re-entrant throw in the exception handler goes straight to `exit`; no drain on an uncaught exception. Docblock explains why the guard lives CLI-side and why an exception exits.
- **Acceptance**: tests green; no listener leaks.
- **Depends on**: none

### Task 2.2: `/health` carries the fault counts
- **Tests first** (`tests/mcp/http-health-faults.test.ts`): start the HTTP transport on port 0 with a `faultCounts` getter returning fixed counts; `GET /health` JSON has `faults` equal to them; without the getter, `faults` is absent (existing clients unaffected); the drain fields are unchanged.
- **Implementation**: `McpFaultCounts` type and the optional `faultCounts` option in `src/mcp/http.ts`; the health body adds `faults` only when the getter is present.
- **Acceptance**: tests green; `tests/mcp/http-drain.test.ts` and `tests/mcp/http-transport.test.ts` green unedited.
- **Depends on**: none

### Task 2.3: wiring in `cmdMcp` and the spawned-process regression
- **Tests first** (`tests/cli/mcp-fault-guard-spawn.test.ts`, modelled on `tests/cli/o2b-mcp-launcher.test.ts`, temp vault under `TMPDIR`):
  - Fixture `serve-with-rejection.ts` imports `installMcpFaultGuard` and `serveStdio`, installs the guard, rejects a detached promise after `onStart`, then serves. Send `initialize`, `tools/call brain_context`, then `tools/list`: both later responses arrive, stderr contains `unhandled_rejection #1`, the process is still alive, then close stdin and expect exit 0.
  - Fixture `serve-with-throw.ts` acquires a sync lock through the real lock module, then throws from `setTimeout`: exit code 70, stderr names `uncaught_exception`, and the lock file is gone (proves the exit hooks ran). Skip on win32 if exit hooks differ there, with the reason in the skip message.
- **Implementation**: in `src/cli/main.ts` `cmdMcp`, install the guard before `startHttp` (passing `faultCounts: () => guard.counts()`) and before `serveStdio`, release it in the same `finally` blocks as the signal drain; `runMcpProbe` does not install it.
- **Acceptance**: tests green; launcher test green unedited.
- **Depends on**: Tasks 2.1, 2.2

**Hands to lane 4**:
- `docs/mcp.md`: new section `## Background faults (since v1.65.0)` after "Shutdown and draining": rejections survived, named, rate-limited (5 lines per 60 s, then one summary line), counted; an uncaught exception logs and exits 70 so the exit hooks checkpoint the index and release locks; no drain on an exception and why; `/health` `faults` fields; the Hermes bridge restarts the server once, Claude Code and Codex do not; guard only on the served transports.
- `docs/cli-reference.md`: exit code 70 in the `o2b mcp` exit list.
- `CHANGELOG.md` lines for the guard and the `/health` field.

## Lane 3: custom lane tasks core, config, shared builder

**Owns**: `src/core/brain/maintenance/custom-tasks.ts` (new), `src/core/brain/maintenance/lane-tasks.ts` (new), `src/core/brain/maintenance/lane.ts`, `src/core/brain/maintenance/journal.ts`, `src/core/config.ts`, `src/core/reliability/command-bridge.ts`, `tests/core/brain/maintenance/custom-tasks.test.ts` (new), `tests/core/brain/maintenance/lane-tasks.test.ts` (new), `tests/core/brain/maintenance/maintenance.test.ts`.

**Gate**: `bun test tests/core/brain/maintenance tests/core/reliability && bun run typecheck`

### Task 3.1: master switch and config resolution
- **Tests first** (`tests/core/brain/maintenance/custom-tasks.test.ts`, temp config file):
  - `resolveMaintenanceCustomTasks` is false by default, true with `maintenance_custom_tasks: true`, and the env `0` overrides config `true`.
  - `resolveCustomTasks` reads `maintenance_custom_tidy: ./tidy.sh`, `maintenance_custom_tidy_cwd: /srv/x`, `maintenance_custom_tidy_timeout_seconds: 120` into one spec with id `custom:tidy`; sorted by name.
  - Each of these is a named error and the others still resolve: name `Bad`, name with `_` (`maintenance_custom_a_b` without a matching command reads as a dangling suffix or a bad name, named either way), an empty command, timeout `0`, `abc`, `1800` or above (`MAINTENANCE_LEASE_TTL_MS`), a `_cwd` key without its command, more than 8 tasks (the ninth onward named).
  - Switch off with keys declared: `enabled: false`, `specs` empty, `declared` counts them.
- **Implementation**: config constants and resolver in `src/core/config.ts` next to `maintenance_embeddings`; `resolveCustomTasks` in `custom-tasks.ts` reading the flat config through the existing config loader.
- **Acceptance**: tests green.
- **Depends on**: none

### Task 3.2: the custom task runner
- **Tests first** (same file):
  - Exit 0: task resolves; cwd defaults to the vault; `O2B_VAULT` is set in the child env; stdin is closed.
  - Exit 3: throws `Error` whose message starts `exit 3:` and carries the stderr tail, redacted (a fake token in stderr is masked) and capped at 4096 bytes.
  - A command that sleeps past `timeoutSeconds` (use 1 s) is killed and throws `SafeguardTimeoutError`.
  - An aborted `signal` kills the child and rejects.
  - The shell form comes from the exported `shellArgv` (Windows form covered by the existing command-bridge tests).
- **Implementation**: export `shellArgv` from `command-bridge.ts`; `createCustomLaneTask` with async `spawn`, `redactRawOutput` before `capOutput`, no receipt, no model call.
- **Acceptance**: tests green.
- **Depends on**: Task 3.1

### Task 3.3: identity widening and the custom timeout streak rule
- **Tests first** (`tests/core/brain/maintenance/maintenance.test.ts`, extended):
  - A `custom:x` task that fails `failure_streak_limit` times is refused by name while the built-in tasks still run.
  - A `custom:x` task that times out `failure_streak_limit` times is refused (timeout counts for custom identities).
  - A built-in task that times out the same number of times is still not refused (rule unchanged).
  - `retryTasks: ["custom:x"]` passes the refusal; stale-first ordering includes custom ids.
- **Implementation**: `LaneTaskId`, `isLaneTaskId` and the widened signatures in `lane.ts` (`LANE_TASK`, `LANE_TASKS`, `isLaneTask` unchanged); in `journal.ts` `consecutiveTaskFailures`, a `timed_out` row counts when `isCustomLaneTask(entry.task)`; update the comment that describes the rule.
- **Acceptance**: tests green; existing maintenance tests green.
- **Depends on**: Task 3.1

### Task 3.4: one shared lane task builder
- **Tests first** (`tests/core/brain/maintenance/lane-tasks.test.ts`):
  - With the switch off, `taskNames` is exactly `LANE_TASKS` in order.
  - With two declared custom tasks and the switch on, `taskNames` is the four built-ins followed by `custom:a`, `custom:b`; `custom.errors` passes through.
  - `safeguardFor` is called lazily with the operation of the task being run, once per run.
  - Running the built `custom:a` task executes its command (fixture script) and returns no spend receipt (`reindex.spendBlock` ignores it).
- **Implementation**: `buildLaneTasks` per the lane contract; move the dream, bridges and clusters bodies (including the metrics writes) from the two surfaces into it unchanged.
- **Acceptance**: tests green.
- **Depends on**: Tasks 3.2, 3.3

**Hands to lane 4**:
- `docs/cli-reference.md` paragraph after the v1.64.0 lane paragraph: the keys, the master switch and env override, the identity pattern, cwd default, timeout default and cap, the no-spend rule (the lane cannot police spend inside an operator's command), that a timeout counts toward a custom task's streak, and that commands are never read from the vault.
- `docs/updating.md` near the maintenance section: new opt-in, existing installs see no change.
- `CHANGELOG.md` lines for custom tasks and the shared builder.

## Lane 4: CLI and MCP surfaces, command manifest, docs and CHANGELOG

**Owns**: `src/cli/brain/verbs/maintenance.ts`, `src/mcp/brain/admin-tools.ts`, `src/cli/command-manifest.ts`, `tests/cli/brain-maintenance.test.ts`, `tests/cli/brain-maintenance-progress.test.ts` (only if the refactor requires it), `tests/mcp/maintenance-parity-census.test.ts`, `tests/cli/manifest-completeness.test.ts`, `docs/cli-reference.md`, `docs/mcp.md`, `docs/updating.md`, `docs/hermes-cron.md`, `CHANGELOG.md`.

Lane 4 writes its tests first against the pinned contracts and wires each surface once the exporting lane has committed (Task 4.2 after lane 1 Task 1.2; Tasks 4.3 and 4.4 after lane 3 Task 3.4).

**Gate**: `bun test tests/cli/brain-maintenance.test.ts tests/cli/brain-maintenance-progress.test.ts tests/mcp/maintenance-parity-census.test.ts tests/cli/manifest-completeness.test.ts tests/mcp/brain-tools-parity.test.ts && bun run typecheck`

### Task 4.1: command manifest
- **Tests first** (`tests/cli/manifest-completeness.test.ts`): the completion token list gains `--format`; a new case asserts `brain maintenance` declares `run` and `status` with `run` carrying `cron-template`, `interval`, `format`, `window`, `tz`, `retry`, `force`, `force-cost`.
- **Implementation**: declare the maintenance subcommands and flags in `command-manifest.ts:306`; apply lane 1's two `format` flags.
- **Acceptance**: tests green.
- **Depends on**: none

### Task 4.2: `brain maintenance run --cron-template`
- **Tests first** (`tests/cli/brain-maintenance.test.ts`):
  - `run --cron-template` exits 0, prints a recipe naming `osb-maintenance` and the vault, and leaves the lease (`currentLease` null) and the journal empty.
  - `--interval 30s` and `--interval 90d` exit 2 with the kernel message; `--format launchd` exits 2.
  - `--window 25-3 --cron-template` exits 2; `--window 3-5 --tz Europe/Berlin` appear in the printed body.
  - `status --cron-template` exits 2.
  - `--format systemd` prints `OnUnitActiveSec=1h`.
- **Implementation**: add `cron-template`, `interval`, `format` to the flag schema; under `op === "run"` branch before the lease and gates, call `renderMaintenanceCronTemplate`, map `CronTemplateError` to `MAINTENANCE_EXIT.usage`; extend `USAGE`.
- **Acceptance**: tests green.
- **Depends on**: lane 1 Task 1.2, Task 4.1

### Task 4.3: CLI verb on the shared builder, custom retries
- **Tests first** (`tests/cli/brain-maintenance.test.ts`, temp config with a fixture command):
  - With the switch on, `run --json` reports a `custom:tidy` row; `--retry custom:tidy` passes its streak refusal; `--retry custom:nope` exits 2 naming the registered tasks.
  - A bad declaration prints `custom task refused: <reason>` on stderr, the valid tasks still run, and the exit code is the lane's verdict code.
  - `status` shows custom journal rows and, with the switch off but keys declared, the line `custom tasks declared but maintenance_custom_tasks is off`.
- **Implementation**: replace the inline task list with `buildLaneTasks`; `--retry` validates against `taskNames`; usage says `--retry <task|custom:name>`.
- **Acceptance**: tests green; `brain-maintenance-progress.test.ts` green.
- **Depends on**: lane 3 Task 3.4, Task 4.2

### Task 4.4: MCP tool on the shared builder, description budget
- **Tests first** (`tests/mcp/maintenance-parity-census.test.ts`):
  - `retry_tasks` accepts a declared custom name on both surfaces; an undeclared `custom:nope` is refused on both by name.
  - More entries than declared tasks is refused with the declared count in the message; the schema `maxItems` is `LANE_TASKS.length + CUSTOM_TASK_MAX`.
  - The tool description is under 300 characters and the `retry_tasks` property description under 160 (measured); the description mentions `custom:<name>` and names no configured task.
  - The "neither surface spells a lane task by hand" check still passes; config errors surface as `custom_task_errors` in the MCP result.
- **Implementation**: `toolBrainMaintenance` uses `buildLaneTasks`; retry checks against `taskNames`; description per design decision D11; property description reads "Tasks to retry past their streak refusal, this run only; gates still apply. Known: ${LANE_TASKS.join(", ")}, custom:<name>. Unknown names are refused." (159 characters, measured).
- **Acceptance**: tests green; `tests/mcp/brain-tools-parity.test.ts` green.
- **Depends on**: lane 3 Task 3.4

### Task 4.5: docs and CHANGELOG for all lanes
- **Files**: `docs/cli-reference.md` (maintenance synopsis at the lane row: `run --cron-template [--interval N] [--format cron|systemd]`, prints and installs nothing; "usually cron'd" points at the recipe; plus every line handed over by lanes 1, 2, 3), `docs/mcp.md` (lane 2 section; long-running table row "the four built-ins plus declared custom tasks"; bullet near the maintenance tool section), `docs/updating.md`, `docs/hermes-cron.md`, `CHANGELOG.md` under a new `## [1.65.0] - 2026-10-01` heading with `### Added`, `### Changed`, `### Fixed` as needed and the `[1.65.0]: https://github.com/itechmeat/open-second-brain/compare/v1.64.0...v1.65.0` link reference at the bottom. No `package.json` change.
- **Acceptance**: `bun run check:paths` and `bun run fmt:check` green on the changed docs; no exclamation marks, no card ids, no machine paths, "Open Second Brain" spelled out.
- **Depends on**: hand-overs from lanes 1, 2, 3

## Integration (after all lanes)

### Task 5.1: full gate
- **Commands**: `bun run typecheck`, `bun run lint`, `bun run fmt:check`, `bun run sync-plugin-mirrors:check`, `bun test` (the known `dedup-index-cache` flake on an ext4 `TMPDIR` is the only accepted failure).
- **Acceptance**: all green; `git status --short` clean after the lane commits.
- **Depends on**: every task above
