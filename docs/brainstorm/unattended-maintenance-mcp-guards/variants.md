# Unattended maintenance and MCP fault guards - brainstorm audit trail

Consultant: Claude Code (`claude -p`), primary path, exit 0, parseable variants for all four items (3 per item). Fallback (Codex) not needed. Prompt: `cli-output/prompt.md`, raw output: `cli-output/claude.md`. Reconnaissance queries: `cli-output/zg-*.txt`.

The prompt carried the verified premises, not the raw cards, and stated that repository-declared schedule discovery was already refused, so item 4 covers only the systemd rendering.

## Variants (consultant verbatim)

### Item 1 / Variant 1: Dedicated spec module beside the other two consumers
- **Approach**: Add `src/cli/brain/maintenance-cron-template.ts` exporting a `CronRecipeSpec` (title, `cronName` `osb-maintenance`, `operatorScriptPath`, script body that runs `o2b brain maintenance run --vault <resolved> [--window H-H --tz ZONE]`, verify command `o2b brain maintenance status`), mirroring `search-cron-template.ts` and `partner-codegraph-cron.ts`. The verb gains `--cron-template [--interval]`, prints the rendered recipe before any vault or lease work, and maps `CronTemplateError` to usage exit 2. The Hermes jobs default becomes `join(homedir(), ".hermes", "cron", "jobs.json")` with an optional `HERMES_HOME` override.
- **Trade-offs**:
  - Pro: identical shape to the two existing consumers, so the lane owner touches only the verb, one new file and the manifest.
  - Pro: spec body is unit-testable without the lane; existing reindex fixtures untouched.
  - Con: a third near-identical spec file; the three consumers still share nothing beyond the kernel.
- **Complexity**: small
- **Risk**: low

### Item 1 / Variant 2: Spec inlined in the maintenance verb
- **Approach**: Build the `CronRecipeSpec` inline inside `src/cli/brain/verbs/maintenance.ts` where the resolved vault, `--window` and `--tz` are already parsed, and call `renderCronRecipe` directly. Same Hermes path fix.
- **Trade-offs**:
  - Pro: fewest files; the recipe body sits next to the flags it embeds.
  - Con: the verb file is already large and owns exit-code logic; recipe text mixed in hurts readability and the byte-pinned fixture test would import the verb.
  - Con: breaks the one-consumer-one-module pattern the other two recipes established.
- **Complexity**: small
- **Risk**: low

### Item 1 / Variant 3: Generic self-recipe helper on the kernel
- **Approach**: Extend `cron-recipe.ts` with `specFromCommand({cronName, argv, verify})` that turns any `o2b` argv into a spec, then have all three consumers call it. Maintenance passes its own argv (vault, window, tz).
- **Trade-offs**:
  - Pro: removes future duplication for any verb that wants a recipe.
  - Con: refactoring the two existing consumers risks the byte-pinned search fixtures and widens the lane's file ownership into files other lanes may touch (item 4 also edits the kernel).
  - Con: over-general for a wave whose kernel is already being changed by item 4.
- **Complexity**: medium
- **Risk**: medium

### Item 1 / Recommended: Variant 1
**Rationale**: It matches the proven consumer pattern exactly, keeps the byte-pinned search fixtures out of the diff, and stays inside files only this lane owns. Variant 3 collides with item 4's kernel edits in the same worktree; Variant 2 buries operator-facing text in an already dense verb file.

### Item 2 / Variant 1: Fault state in `src/mcp`, installer in `src/cli`, mirroring the drain split
- **Approach**: Add `src/mcp/fault-state.ts` with a small `FaultCounter` (rejections survived, suppressed-by-rate-limit count, last fault summary) that `http.ts` reads into the `/health` body as `faults: {rejections, suppressed}`. Add `src/cli/mcp-fault-guard.ts` with `installMcpFaultGuard({counter, stderr, exit})`: `unhandledRejection` logs one named line (`o2b mcp: unhandled rejection survived: <message>`), rate-limited to N per minute with a periodic "suppressed K more" line; `uncaughtException` logs and calls `exit(EXIT_FAULT = 70)` so WAL checkpoint and lock unlink hooks run. `cmdMcp` installs it next to `installMcpSignalDrain` and uninstalls on normal close. Tests: in-process with injected stderr/exit; spawned-process test runs a tiny Bun script that imports the installer and throws asynchronously, asserting exit 70 and the stderr line (no production inject seam).
- **Trade-offs**:
  - Pro: respects `src/mcp` never importing `src/cli` while letting `/health` see the count; same seam style as `mcp-drain.ts`.
  - Pro: exit via `process.exit` keeps the existing exit-hook ordering guarantee.
  - Con: two small modules and a shared counter object to thread through `serveHttp`.
  - Con: rate-limit window and cap are new constants to name and document.
- **Complexity**: medium
- **Risk**: low

### Item 2 / Variant 2: Everything inside `src/mcp/fault-guard.ts`
- **Approach**: One module in `src/mcp` owns the counter, the handlers and the exit call; `cmdMcp` calls `installFaultGuard()` and `http.ts` imports the counter from the same module.
- **Trade-offs**:
  - Pro: single file, trivial `/health` wiring.
  - Con: a transport-layer module registering process-global handlers is exactly the "two signal conventions" smell `mcp-drain.ts` documents avoiding; exit codes would be defined outside `src/cli/interrupt.ts` where the project's exit vocabulary lives.
  - Con: harder to inject `exit` from a CLI-side test without exporting the seam from `src/mcp`.
- **Complexity**: small
- **Risk**: medium

### Item 2 / Variant 3: Extend `installMcpSignalDrain` to cover faults
- **Approach**: Widen `McpSignalDrainOptions` with fault handling so one installer registers signals, `unhandledRejection` and `uncaughtException`; on uncaught exception it runs the same drain-then-exit path with code 70.
- **Trade-offs**:
  - Pro: one install/uninstall call site, and an uncaught exception could drain in-flight requests before exiting.
  - Con: draining after an uncaught exception runs code in a possibly corrupted process; the premise asks for log-and-exit, not drain.
  - Con: couples two unrelated concerns in a module whose docblock is precise about its narrow job; existing drain tests must be revisited.
- **Complexity**: medium
- **Risk**: medium

### Item 2 / Recommended: Variant 1
**Rationale**: It reproduces the architecture the project already chose for signals, keeps the import direction rule intact, and gives `/health` the count through a plain shared object. It also avoids draining inside a process that just threw, which is the one behaviour Variant 3 would add that the premise explicitly does not want.

### Item 3 / Variant 1: Prefix keys in the install-owned config, shared task builder
- **Approach**: Declare custom tasks as `maintenance_task_<name>: <shell command>` in the flat config file (XDG config dir, never the vault), with the existing `safeguard_timeout_<name>_seconds` convention supplying the per-task deadline. Add `src/core/brain/maintenance/tasks.ts` with `buildLaneTasks(vault, config)` returning built-ins plus custom tasks, used by both the CLI verb and the MCP tool; widen `LaneTask` to `string` (keep `BUILTIN_LANE_TASK` for the four), validate `--retry`/`retry_tasks` against the built list and cap at its length. Custom tasks run via `shellArgv` with the vault path in env, captured output capped and redacted, non-zero exit or timeout recorded as a named failure.
- **Trade-offs**:
  - Pro: reuses the per-operation timeout key pattern and `discoverConfig` that already returns every key; no new file, no new parser.
  - Pro: removes the CLI/MCP duplication as a side effect.
  - Con: name validation (`^[a-z][a-z0-9_-]{0,31}$`, no collision with built-ins) and key scanning need tests; a reserved prefix in a flat namespace is slightly implicit.
  - Con: MCP tool description must be trimmed to mention custom tasks within 300 characters.
- **Complexity**: medium
- **Risk**: medium

### Item 3 / Variant 2: Separate install-owned tasks file
- **Approach**: Read `maintenance-tasks.yaml` from the same config directory, one `name: command` line per task through the existing flat parser; the rest (shared builder, widened `LaneTask`, retry validation) as in Variant 1.
- **Trade-offs**:
  - Pro: clean separation from the main config; the file's sole purpose is obvious to an operator and to `doctor`.
  - Con: a second discovery path to document, test for env/XDG precedence, and surface in `doctor`; more lane-owned files touched (config discovery).
  - Con: the per-task timeout still has to live in the main config or grow a second syntax.
- **Complexity**: medium
- **Risk**: medium

### Item 3 / Variant 3: CLI-only custom tasks, MCP keeps built-ins
- **Approach**: Same prefix-key declaration and shared builder, but the MCP tool passes `customTasks: false` so `brain_maintenance` runs and retries only the four built-ins; the cron lane via CLI is the only runner of operator commands.
- **Trade-offs**:
  - Pro: no MCP description change; operator commands never run from an agent-triggered call.
  - Con: the two surfaces disagree on what the lane is, and a streak refusal visible in the journal cannot be retried from MCP.
  - Con: security gain is nominal since the command source is the install-owned config either way.
- **Complexity**: small
- **Risk**: low

### Item 3 / Recommended: Variant 1
**Rationale**: It satisfies the security constraint by construction (commands come only from the install-owned config, never from vault or tool arguments) while reusing two existing conventions, the flat config and the per-operation timeout key. Variant 2 adds a discovery surface for little gain, and Variant 3 leaves the two lane surfaces inconsistent.

### Item 4 / Variant 1: Sibling renderer sharing the spec
- **Approach**: Add `renderSystemdRecipe(spec, interval, opts)` beside `renderCronRecipe` in `cron-recipe.ts`, reusing the same `CronRecipeSpec`, the heredoc script section and `parseInterval`'s human label, but emitting `~/.config/systemd/user/<cronName>.service` and `.timer` heredocs (`OnBootSec`/`OnUnitActiveSec=<interval>`, `Persistent=true`) plus `systemctl --user daemon-reload && enable --now`. A `--format cron|systemd` flag on the three recipe verbs dispatches between the two; default `cron`, unknown value exits with the verb's usage code.
- **Trade-offs**:
  - Pro: `renderCronRecipe` is not edited, so the byte-pinned search fixtures stay identical by construction.
  - Pro: `OnUnitActiveSec` takes `<N>m|h|d` directly, so the day-bound refusal in `parseInterval` is still honoured for consistency without any cron expression math.
  - Con: the shared script section is extracted into a helper, a small refactor of the existing renderer body.
  - Con: three verbs each gain a flag plus a manifest entry; item 1's new verb must adopt it too.
- **Complexity**: medium
- **Risk**: low

### Item 4 / Variant 2: Format parameter on `renderCronRecipe`
- **Approach**: Add an optional `format` argument to `renderCronRecipe`; when `systemd`, swap the crontab and Hermes sections for unit-file sections. Verbs pass the parsed `--format`.
- **Trade-offs**:
  - Pro: one entry point, minimal call-site change.
  - Con: branching inside the renderer that the byte-pinned fixtures cover; any slip in the default path breaks them.
  - Con: the name `renderCronRecipe` becomes misleading.
- **Complexity**: small
- **Risk**: medium

### Item 4 / Variant 3: Format-agnostic section table
- **Approach**: Rework the kernel into `renderRecipe(spec, interval, {format})` with a per-format table of section builders (`cron`, `systemd`), and re-express today's output as the `cron` entry.
- **Trade-offs**:
  - Pro: adding a future format (launchd) is one table entry.
  - Con: a wholesale rewrite of the renderer with byte-identical output as the acceptance test, in the same wave where item 1 adds a consumer.
  - Con: nothing in scope needs a third format.
- **Complexity**: large
- **Risk**: medium

### Item 4 / Recommended: Variant 1
**Rationale**: It leaves the existing renderer path untouched, which is the only way to guarantee the byte-pinned fixtures without a careful diff, and it reuses the spec so each consumer declares nothing new. Variant 2 saves little code while putting the fixtures at risk, and Variant 3 is a rewrite for a format count of two.

## Final decision

| Item | Consultant pick | Orchestrator decision | Override |
|---|---|---|---|
| 1. Maintenance lane recipe | Variant 1 (dedicated spec module) | Variant 1 | Path is `src/cli/maintenance-cron.ts` (binding decision), not `src/cli/brain/maintenance-cron-template.ts`. The optional `HERMES_HOME` override is dropped: the binding decision names only the home directory and `OSB_HERMES_JOBS`, and a second override would be a new public knob nobody asked for. |
| 2. MCP fault guard | Variant 1 (state in `src/mcp`, installer in `src/cli`) | Variant 1, simplified | No new `src/mcp/fault-state.ts`. `src/mcp/http.ts` declares a `McpFaultCounts` type and an optional `faultCounts` getter in its options; the guard in `src/cli` satisfies the type. Same import direction, one fewer module and no shared mutable object. `EXIT_INTERNAL_FAULT = 70` lives in `src/cli/mcp-fault-guard.ts` (binding decision), not `interrupt.ts`. |
| 3. Custom lane tasks | Variant 1 (prefix keys in machine config, shared builder) | Variant 1, with the binding details | Keys `maintenance_custom_<name>` plus `_cwd` and `_timeout_seconds`, not `maintenance_task_<name>` with `safeguard_timeout_<name>_seconds`: a custom identity is not an `OPERATION`, and reusing the operation key namespace would let a custom name shadow a built-in budget key. Identity `custom:<name>` with `^[a-z][a-z0-9-]{0,31}$` (no underscore, so the suffixes are unambiguous) instead of widening `LaneTask` to `string`, which would lose the compile-time check on built-in names. Master switch `maintenance_custom_tasks`, default off. A custom task timeout counts toward its streak. |
| 4. systemd rendering | Variant 1 (sibling renderer over the same spec) | Variant 1 | None. Named `renderSystemdTimer` (binding decision). Offered on all three recipe surfaces, because each consumer change is one forwarded flag. |

Rationale in short: the consultant's picks match the project's established seams (one module per recipe consumer, CLI-side process handlers, core-side lane kernel), and every override narrows a detail to a binding orchestrator decision without changing the architecture. The refusal of repository-declared schedule discovery, with its reasons, is recorded in `design.md`.
