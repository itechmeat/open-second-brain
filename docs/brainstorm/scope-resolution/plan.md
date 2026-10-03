# Per-context scope resolution - implementation plan

Design: `docs/brainstorm/scope-resolution/design.md` (decision ids S*, I*, B*, H*, D* below refer to its "Design decisions").

## How to run this plan

Five lanes with DISJOINT file ownership run concurrently in the one worktree. Lane A (TypeScript substrate) commits first; lane B waits only on the lane A file named in its task's "Depends on"; lanes C, D and E wait on nothing. A lane edits only the files listed for it under "File ownership".

Every task is TDD: write the named test first, run it and see it fail for the stated reason, implement, see it pass, then format and lint the lane's own files only (`bunx oxfmt <files>` and `bunx oxlint -c oxlint.json <files>` for TypeScript; `python3 -m compileall -q plugins/hermes` for Python (this machine has Python 3.14 and no 3.11; CI runs 3.11, so use no syntax newer than 3.11)), then ONE step `git commit --only <own paths> -m "<conventional message>"`. Retry on `index.lock`; after five pre-commit rejections caused by another lane's files, check your own files and commit with `--no-verify`.

Shared settings for every lane:

- `export TMPDIR=$HOME/.cache/osb-wave-20261003a/tmp` (mkdir -p) and `PATH="$HOME/.cache/osb-pr-prepare/bun-1.4.0/bun-linux-x64:$PATH"` (Bun 1.4.0, the CI pin).
- Per-task gates: `bun test <the task's test files>` and, for TypeScript lanes, `bun run typecheck`. Never the whole suite; the integrator runs the full gates once.
- Tests compare vault-relative POSIX paths and basenames, never absolute paths (Windows CI); a path embedded in JSON is normalised with `replaceAll("\\\\", "/")`.
- No identifier containing `secret`, `token`, `api_key` or `password` before `=` or `:` and a quoted literal, in TypeScript and Python. Reserved-page fixtures are named `PRIVATE_PATH`, `PRIVATE_BODY`, `privateBody`; credential-shaped literals come from `fakeCredential()`.
- No new runtime dependency. No `os.hostname()`.

Dependency-wait rule for lane B: before a task that depends on a lane A file, poll `git log --oneline -- <file>` every 30 s, up to 15 min, until lane A's commit of that file appears; if it does not, stop and report the wait as the failure.

Dependencies:

- A1 -> A2 -> A3 -> A4 (one lane, in order).
- A1 + A2 -> B1 -> B2; A3 -> B3; B2 + A4 + E1 -> B4 (B4 waits on lane E's E1 commit of `.claude-plugin/plugin.json`).
- C1 -> C2 -> C3 -> C4 (no dependency on A or B; C4 pins the argv from this contract).
- D1 -> D2 -> D3 -> D4 (independent).
- E1, E2, E3 (independent; they describe this contract, not the code).

The OpenClaw bundle (`openclaw/index.js`) belongs to no lane: the integrator runs `bun run build:openclaw` after the last `src/` change and commits it last if it changed.

## Cross-lane contract (pinned now; no lane renames or re-spells any of this)

### `src/core/brain/path-constants.ts` and `src/core/brain/paths.ts` (lane A, A1)

- `export const BRAIN_SCOPED_RULES_DIR = "standing-rules";` (a directory under `Brain/`, beside `BRAIN_STANDING_RULES_FILE = "standing-rules.md"`).
- `export function brainScopedRulesDir(vault: string): string` - absolute `<vault>/Brain/standing-rules`.
- `export function brainScopedRulePath(vault: string, axis: ScopedRuleAxis, key: string): string` - absolute `<vault>/Brain/standing-rules/<axis>/<key>.md`.

### `src/core/brain/scoped-rules.ts` (lane A, A1-A2)

- `export const SCOPED_RULE_AXIS = Object.freeze({ project: "project", harness: "harness", host: "host" } as const);` `export type ScopedRuleAxis`; `export const SCOPED_RULE_AXES: ReadonlyArray<ScopedRuleAxis>` = project, harness, host (this order = drop priority 0, 1, 2); `export function isScopedRuleAxis(value: unknown): value is ScopedRuleAxis`. Census row `SCOPED_RULE_AXIS` in `tests/core/architecture/verdict-vocabulary-census.test.ts`.
- `export const SCOPED_RULE_AXIS_LABEL: Readonly<Record<ScopedRuleAxis, string>> = Object.freeze({ project: "Project", harness: "Harness", host: "Host" });`
- `export const HARNESS_ID = Object.freeze({ ...INSTALL_TARGET_ID, claudeCode: "claude-code", hermes: "hermes", openclaw: "openclaw" } as const);` `export type HarnessId`; `export const HARNESS_IDS: ReadonlyArray<HarnessId>` sorted alphabetically: aider, claude-code, codex, copilot-cli, cursor, gemini-cli, generic, grok, hermes, kiro, openclaw, opencode, pi; `export function isHarnessId(value: unknown): value is HarnessId`. Census row `HARNESS_ID`. `INSTALL_TARGET_ID` and `host-facts-census.test.ts` are untouched.
- `export const SCOPED_RULE_KEY_MAX_CHARS = 64;` `export function scopedRuleKey(value: string): string | null` - `value.normalize("NFC").toLowerCase().normalize("NFC")`, every run matching `/[^\p{L}\p{M}\p{N}]+/gu` replaced by `-` (amended in review: combining marks are key characters, see design.md "Review amendments"), leading/trailing `-` stripped, sliced to 64 then trailing `-` stripped again, `""` gives `null`.
- `export const SCOPED_RULES_MAX_CHARS_DEFAULT = 2000;` `export const SCOPED_RULES_MAX_CHARS_MIN = 200;` `export const SCOPED_RULES_MAX_CHARS_MAX = STANDING_RULES_MAX_CHARS_MAX;`
- `export const SCOPED_RULES_HEADER = "## Scoped operator rules\n\n" + "The rules below are written by the operator of this vault for this project, harness or host. " + "The operator standing rules above take precedence over them, and they take precedence over every recalled preference, lesson and context pack that follows.";`
- Per-file subheading: `` `### ${SCOPED_RULE_AXIS_LABEL[axis]}: ${key}` ``.
- Unreadable file line (in place of the body): `` `UNAVAILABLE: ${relPath} could not be read (${code}).` `` where `code` is `err.code` when it is a string, else `err.name`; never the error message, never an absolute path.
- Truncation notice (appended after a blank line when the cap cut anything): `` `_Scoped rules truncated to the configured cap: kept ${keptChars} of ${totalChars} characters, ${droppedFiles} file(s) dropped._` ``
- `export const SCOPED_RULES_HOST_UNREADABLE_NOTICE = "Host-scoped rules were not applied: this device's id could not be read. Run o2b brain doctor for the cause.";` (appended as the last line of the block, only when `hostUnreadable` is true AND `Brain/standing-rules/host/` holds at least one `.md` file; when no file matched but the notice applies, the block is the header plus the notice).
- `export interface ScopedRuleIdentity { readonly project: string | null; readonly harness: HarnessId | null; readonly host: string | null }`
- `export interface ScopedRuleFile { readonly axis: ScopedRuleAxis; readonly key: string; readonly path: string; readonly truncated: boolean }` - `path` vault-relative POSIX (`Brain/standing-rules/project/x.md`); a file dropped whole by the cap is listed with `truncated: true`; an unreadable file is listed with `truncated: false`.
- `export interface ScopedRules { readonly identity: ScopedRuleIdentity; readonly files: ReadonlyArray<ScopedRuleFile>; readonly text: string }` - `text` is the rendered block (header, sections, optional truncation notice, optional host notice), `""` when nothing matched and no notice applies.
- `export interface ReadScopedRulesOptions { readonly maxChars?: number; readonly hostUnreadable?: boolean }`
- `export function readScopedRules(vault: string, identity: ScopedRuleIdentity, opts?: ReadScopedRulesOptions): ScopedRules` - never throws for a per-file read failure; budget through `applySectionBudget` with section keys `` `${axis}:${key}` `` and priority = index in `SCOPED_RULE_AXES`; the header and notices are not counted against the cap.

### `src/core/brain/standing-rules.ts` guard (lane A, A3)

- `assertStandingRulesNotTargeted(vault, notePath, surface)` keeps its signature and now also throws `StandingRulesWriteRefusedError(<absolute candidate path>, surface)` for any candidate equal to or inside `brainScopedRulesDir(vault)`, compared lexically and then canonically (canonicalise the nearest existing ancestor and re-append the missing tail). Error class, `name`, fields and message template unchanged.

### `src/core/brain/scope-identity.ts` (lane A, A2)

- `export function resolveProjectScope(workspaceDir: string | null, servingVault: string): string | null` - walks `findVaultPointer` up from `workspaceDir`; the first pointer whose vault has the serving vault's real path gives `scopedRuleKey(basename(probe.dir))`; a pointer naming another vault or a malformed one is skipped; `null` for a null dir or when none matches (amended in review, see design.md "Review amendments").
- `export interface HostScope { readonly host: string | null; readonly unreadable: boolean }`
- `export function resolveHostScope(configPath: string | undefined): HostScope` - `resolveDeviceId(configPath)`; `""` gives `{host: null, unreadable: false}`; a thrown `ConfigReadError` gives `{host: null, unreadable: true}`; any other throw propagates; a value gives `{host: scopedRuleKey(id), unreadable: false}`.
- `export function resolveHarnessScope(harness: HarnessId | undefined, hostTarget: InstallTargetId | undefined): HarnessId | null` - `harness ?? hostTarget ?? null`.

### Config knob (lane A, A4)

- YAML key `active.scoped_rules_max_chars`; `KNOWN_KEYS` gains `"scoped_rules_max_chars"`; parsed by `optionalCharCount` with `SCOPED_RULES_MAX_CHARS_MIN` and `SCOPED_RULES_MAX_CHARS_MAX`; `BrainActiveConfig.scoped_rules_max_chars?: number` in `types.ts`; `export function resolveScopedRulesMaxChars(cfg: BrainConfig | null): number` in `policy/blocks/active.ts`, re-exported from `policy.ts`; template entry `def("scoped_rules_max_chars", SCOPED_RULES_MAX_CHARS_DEFAULT)` with a comment that it is charged against `inject_budget_chars`; ratchet row `active_scoped_rules_max_chars`.

### Server and CLI (lane B)

- CLI flag `--harness <id>` on `o2b mcp` (`main.ts` option table `"harness": { type: "string" }`, `command-manifest.ts` `flag("harness", "string")`). Invalid value: stderr `` `o2b mcp: invalid --harness value: ${JSON.stringify(value)}; expected one of: ${HARNESS_IDS.join(", ")}\n` ``, exit 2 (amended in review: the value is JSON-quoted, as in the `--host-target` refusal).
- `MCPServerRuntimeOptions.harness?: HarnessId` and `MCPServerRuntimeOptions.workspaceDir?: string` (`main.ts` passes `process.cwd()` captured once).
- `ServerContext.ruleScope?: RuleScopeSources` with `export interface RuleScopeSources { readonly workspaceDir: string | null; readonly harness: HarnessId | null }` in `src/mcp/tool-contract.ts`; the server sets `harness` to `resolveHarnessScope(opts.harness, opts.hostTarget)`.
- `brain_context` output key (optional, present only when at least one file matched or the host notice applies): `scoped_rules: { scope: { project: string | null, harness: string | null, host: string | null }, files: Array<{ path: string, axis: "project" | "harness" | "host", truncated: boolean }> }`. Added to `BRAIN_CONTEXT_OUTPUT_SCHEMA`. No input property. Rendered only when `contextReach(ctx) === TRANSPORT_REACH.local`.
- Hook: meter source name `SOURCE_SCOPED_RULES = "scoped-rules"` on `LANE_BUDGETED`; receipt `budget` block gains `scoped_rules_chars: number` (the rendered scoped block length; `0` when absent) beside the unchanged `inject_budget_chars` and `budgeted_source_count`. `assembleActiveContext` receives `max(0, injectBudgetChars - scopedBlock.length)`; the scoped cap is `min(scopedRulesMaxChars, injectBudgetChars)`, amended by the review to `max(0, min(scopedRulesMaxChars, injectBudgetChars - SCOPED_RULES_HEADER.length - SCOPED_RULES_NOTICE_RESERVE))` so the header and the notices ride inside the budget (design S6 amended).
- Packaged args, `.claude-plugin/plugin.json` (written by lane E in E1, asserted by lane B in B4): `"args": ["mcp", "--harness", "claude-code"]` and `"args": ["mcp", "--scope", "writer", "--harness", "claude-code"]`.

### Hermes plugin (lane C)

- `config.PROFILE_SCOPED_ENV: tuple[str, ...] = (VAULT_DIR_ENV, AGENT_NAME_ENV, TIMEZONE_ENV, CONFIG_PATH_ENV, "OPEN_SECOND_BRAIN_MCP_TIMEOUT")` (the timeout name moves into config.py as `REQUEST_TIMEOUT_ENV`; bridge.py imports it).
- `config.is_multiplexed() -> bool`; `config.env_setting(name: str) -> str | None` (the one reader; empty counts as unset).
- `config.SCOPE_FIRST_ENV: tuple[str, ...] = (XDG_CONFIG_HOME_ENV, LOCALAPPDATA_ENV)` and `config.scope_first_setting(name: str) -> str | None` (review amendment): multiplexed, the bound scope's non-empty value, else `os.environ`; not multiplexed, `os.environ` only; unbound raises `ProfileScopeError`. `config_path()` and `_windows_local_app_data()` read through it, and the scoped MCP child env carries the scope's value for both names. `PATH`, `PATHEXT` and `HOME` stay process-global.
- `class ProfileScopeError(ConfigReadError)` with `__init__(self, name: str)`, attributes `name`, `path` (`""`), `reason` (`"no profile scope bound"`), message: `"{name} cannot be resolved: this multiplexed Hermes gateway bound no profile scope for the call, and Open Second Brain does not fall back to the gateway's process environment, which belongs to the launch profile. Restart the gateway (hermes gateway restart); if it persists, report it."`
- WARNING template (logger `plugins.hermes.config`): `"%s: ignoring %s from the gateway process environment on a multiplexed gateway; set it in the profile's .env instead"` with `PLUGIN_NAME` and the name; test reset `config._reset_scope_warnings_for_tests()`.
- `prefetch` degrade WARNING (logger `plugins.hermes.provider`, once per process): `"%s: no profile scope bound for this turn; the vault reminder is omitted"` with `PROVIDER_NAME`.
- Multiplexed `shadowing_source` text: `"the {env_key} setting in this Hermes profile's .env overrides the config file"`.
- `McpBrainBridge(..., timeout: float | None = None)`; `start` uses it when not `None`, else `resolve_request_timeout()` as today.
- `bridge.HARNESS_ARGV = ("--harness", "hermes")`; `_argv()` = command, then `--vault <v>` when set, then `--repo <r>` when set, then `--harness hermes`.
- `cli._config` prints `settings_source: profile scope (multiplexed gateway)` or `settings_source: process environment (this command; a gateway with gateway.multiplex_profiles reads each profile's .env)` (review amendment) as its FIRST line (it cannot raise), then `config_path:`; `config_path()` moves inside the `try`, because under multiplexing it reads `OPEN_SECOND_BRAIN_CONFIG` through `env_setting` and can raise `ProfileScopeError`.

### Lane D options (lane D)

- `ScanOpenLoopsOptions.readable?: (rel: string) => boolean`; `TodayDashboardOptions.readable?: (rel: string) => boolean`.
- `BuildMonthlyReviewOptions.eventAtReach?: (event: LogEvent) => LogEvent | null` (the same signature `TodayDashboardOptions.eventAtReach` uses today; copy its type, do not widen it).
- `RunDoctorOptions.readable?` and `DoctorCheckContext.readable?: (rel: string) => boolean`; `StaleDependencyOptions.readable?: (rel: string) => boolean`.
- `BuildOperatorSummaryOptions.keepIssue?: (issue: DoctorIssueNaming) => boolean`, `.readable?: (rel: string) => boolean`, `.keepAction?: (action: ActionItem) => boolean`.
- Every option is omitted at local reach; handlers pass `readableAtContextReachOrUndefined(ctx)` / `requestRefView(ctx)` only when it filters something.

### Docs vocabulary (lane E)

- Section headings: in `docs/how-it-works.md` `### Scoped operator rules`; in `install/hermes.md` `### Multiple Hermes profiles`; in `docs/updating.md` `## Upgrading to 1.70.0`; CHANGELOG `## [1.70.0] - 2026-10-03` and `[1.70.0]: https://github.com/itechmeat/open-second-brain/compare/v1.69.0...v1.70.0`.
- The docs never name the directory in any MCP tool description (lane B owns descriptions; they do not change).

## File ownership

Lane A (TypeScript substrate, commits first):

- `src/core/brain/path-constants.ts`, `src/core/brain/paths.ts`, `src/core/brain/scoped-rules.ts` (new), `src/core/brain/scope-identity.ts` (new), `src/core/brain/standing-rules.ts`
- `src/core/brain/policy/blocks/active.ts`, `src/core/brain/policy.ts`, `src/core/brain/types.ts`, `src/core/brain/config-template.ts`
- `tests/core/brain/scoped-rules.test.ts` (new), `tests/core/brain/scope-identity.test.ts` (new), `tests/core/brain/scoped-rules-guard.test.ts` (new), `tests/core/architecture/verdict-vocabulary-census.test.ts`, `tests/core/brain/policy-active.test.ts`, `tests/core/brain/config-template-ratchet.test.ts`

Lane B (TypeScript surfaces):

- `hooks/active-inject.ts`, `src/mcp/brain/context-tools.ts`, `src/mcp/server.ts`, `src/mcp/tool-contract.ts`, `src/cli/main.ts`, `src/cli/command-manifest.ts`
- `tests/hooks/active-inject-scoped-rules.test.ts` (new), `tests/mcp/brain-context-scoped-rules.test.ts` (new), `tests/core/architecture/harness-identity-census.test.ts` (new), `tests/cli/mcp-harness-flag.test.ts` (new), `tests/mcp/plugin-mcp-servers.test.ts`, `tests/mcp/brain-standing-rules-uneditable.test.ts`

Lane C (Hermes Python plugin):

- `plugins/hermes/config.py`, `plugins/hermes/bridge.py`, `plugins/hermes/provider.py`, `plugins/hermes/cli.py`
- `tests/python/test_profile_scope.py` (new), `tests/python/test_memory_provider.py`

Lane D (reach left-overs):

- `src/core/brain/open-loops.ts`, `src/core/brain/today-dashboard.ts`, `src/core/brain/monthly-review.ts`, `src/core/brain/trust/operator-summary.ts`, `src/core/brain/doctor/report.ts`, `src/core/brain/doctor/check.ts`, `src/core/brain/doctor.ts`, `src/core/brain/doctor/removed-tool-checks.ts`, `src/core/brain/stale-dependency.ts`, `src/mcp/brain/brief-tools.ts`, `src/mcp/brain/health-tools.ts`, `src/core/search/visibility-surface-registry.ts`
- `tests/mcp/today-open-loops-reach.test.ts` (new), `tests/mcp/brief-monthly-reach.test.ts` (new), `tests/mcp/doctor-counts-reach.test.ts` (new), `tests/mcp/brief-operator-reach.test.ts` (new), `tests/core/brain/today-dashboard.test.ts`

Lane E (docs and release):

- `docs/how-it-works.md`, `docs/mcp.md`, `docs/cli-reference.md`, `docs/observability.md`, `docs/stability.md`, `docs/updating.md`, `install/hermes.md`, `README.md`, `plugins/codex/README.md` (generated mirror), `CHANGELOG.md`, `package.json`, `.claude-plugin/plugin.json` (both the version that `sync-version.ts` writes and the packaged `--harness claude-code` args pinned in the contract, so one lane owns the whole file) and the other files `scripts/sync-version.ts` regenerates (`plugin.yaml`, `plugins/hermes/plugin.yaml`, `.codex-plugin/plugin.json`, `plugins/codex/.codex-plugin/plugin.json`, `openclaw.plugin.json`, `pyproject.toml`, `uv.lock`).

Integrator only: `openclaw/index.js`.

## Tasks

### Lane A - substrate

#### Task A1: Vocabularies, key normaliser and paths

- **Files**: `src/core/brain/path-constants.ts`, `src/core/brain/paths.ts`, `src/core/brain/scoped-rules.ts` (vocabularies, `scopedRuleKey`, constants only), `tests/core/brain/scoped-rules.test.ts`, `tests/core/architecture/verdict-vocabulary-census.test.ts`
- **Failing first**: `scopedRuleKey("プロジェクト 2")` is `"プロジェクト-2"` and `scopedRuleKey("Έργο Άλφα")` is `"έργο-άλφα"`, `scopedRuleKey("  My_Repo.v2  ")` is `"my-repo-v2"`, `scopedRuleKey("---")` is `null`, a 100-character name keys to at most 64 characters; `HARNESS_IDS` equals the alphabetical list and contains every `INSTALL_TARGET_IDS` member; `brainScopedRulePath(vault, "project", "x")` ends in `Brain/standing-rules/project/x.md` after separator normalisation; census rows `SCOPED_RULE_AXIS` and `HARNESS_ID` pass. Fails on the missing module.
- **Commands**: `bun test tests/core/brain/scoped-rules.test.ts tests/core/architecture/verdict-vocabulary-census.test.ts tests/core/architecture/host-facts-census.test.ts && bun run typecheck`
- **Commit**: `feat(brain): add the scoped-rule axis and harness vocabularies`
- **Depends on**: none

#### Task A2: Identity resolvers and the scoped reader

- **Files**: `src/core/brain/scope-identity.ts`, `src/core/brain/scoped-rules.ts` (reader and renderer), `tests/core/brain/scope-identity.test.ts`, `tests/core/brain/scoped-rules.test.ts`
- **Failing first**: (1) a temp project dir linked with `writeVaultPointer` resolves `resolveProjectScope(<subdir>)` to the key of its basename; no pointer gives `null`; a malformed pointer gives `null`. (2) `withDeviceId("aaaa0001", ...)` gives `{host: "aaaa0001", unreadable: false}`, `""` gives `{null, false}`, an unreadable config (directory in the file's place, `CHMOD_CANNOT_DENY`-safe) gives `{null, true}`. (3) `readScopedRules` with identity `{project: "x", harness: null, host: null}` and files `project/x.md` and `project/y.md` renders only x after `SCOPED_RULES_HEADER` with `### Project: x`; a null axis matches nothing; `maxChars: 200` with three files drops host first and the notice reports integers; an unreadable file renders the `UNAVAILABLE:` line with a vault-relative path; `hostUnreadable: true` with a `host/` file appends `SCOPED_RULES_HOST_UNREADABLE_NOTICE`; no rendered text contains the vault's absolute path.
- **Commands**: `bun test tests/core/brain/scope-identity.test.ts tests/core/brain/scoped-rules.test.ts && bun run typecheck`
- **Commit**: `feat(brain): resolve project, harness and host scope and read scoped rules`
- **Depends on**: A1

#### Task A3: Write guard covers the directory

- **Files**: `src/core/brain/standing-rules.ts`, `tests/core/brain/scoped-rules-guard.test.ts`
- **Failing first**: `assertStandingRulesNotTargeted(vault, "Brain/standing-rules/project/x.md", "test")` throws `StandingRulesWriteRefusedError`; so does a not-yet-existing file reached through a symlinked folder pointing at `Brain/standing-rules/` (guarded for platforms that cannot symlink); `Brain/standing-rules-notes.md` and `Notes/standing-rules/x.md` do not throw; the constitution path still throws with the unchanged message.
- **Commands**: `bun test tests/core/brain/scoped-rules-guard.test.ts tests/core/brain/standing-rules.test.ts tests/mcp/brain-standing-rules-uneditable.test.ts tests/core/brain/write-session tests/core/brain/attributes.test.ts && bun run typecheck`
- **Commit**: `feat(brain): refuse writes into the scoped standing-rules directory`
- **Depends on**: A2

#### Task A4: Config knob

- **Files**: `src/core/brain/policy/blocks/active.ts`, `src/core/brain/policy.ts`, `src/core/brain/types.ts`, `src/core/brain/config-template.ts`, `tests/core/brain/policy-active.test.ts`, `tests/core/brain/config-template-ratchet.test.ts`
- **Failing first**: `active: { scoped_rules_max_chars: 150 }` is refused with the range message naming `active.scoped_rules_max_chars`; `500` parses; `resolveScopedRulesMaxChars(null)` is 2000; the ratchet row `active_scoped_rules_max_chars` matches the template.
- **Commands**: `bun test tests/core/brain/policy-active.test.ts tests/core/brain/config-template-ratchet.test.ts && bun run typecheck`
- **Commit**: `feat(brain): add the active.scoped_rules_max_chars cap`
- **Depends on**: A3

### Lane B - surfaces

#### Task B1: `--harness` on `o2b mcp` and the server context

- **Files**: `src/cli/main.ts`, `src/cli/command-manifest.ts`, `src/mcp/server.ts`, `src/mcp/tool-contract.ts`, `tests/cli/mcp-harness-flag.test.ts`
- **Failing first**: `o2b mcp --harness nope` exits 2 with the pinned message listing `HARNESS_IDS`; a server built with `{harness: "codex", workspaceDir: dir}` exposes `ctx.ruleScope` `{workspaceDir: dir, harness: "codex"}`; with only `hostTarget: "cursor"` the harness is `cursor`; with neither it is `null`. Fails on `unknown flag: --harness`.
- **Commands**: `bun test tests/cli/mcp-harness-flag.test.ts tests/cli/mcp-scope-arg.test.ts && bun run typecheck`
- **Commit**: `feat(mcp): resolve the harness from a launch-time --harness option`
- **Depends on**: A1 (`src/core/brain/scoped-rules.ts`), A2 (`src/core/brain/scope-identity.ts`)

#### Task B2: `brain_context` renders the scoped layer at local reach

- **Files**: `src/mcp/brain/context-tools.ts`, `tests/mcp/brain-context-scoped-rules.test.ts`, `tests/core/architecture/harness-identity-census.test.ts`
- **Failing first**, all through the real `MCPServer` with normalised `generated_at`: (1) project A/B: vault with `project/x.md` (unique marker) called from workspace Y gives output identical to the vault without it, and from workspace X `content` holds the marker after `STANDING_RULES_HEADER` and before the memory body, plus `scoped_rules.files[0].path === "Brain/standing-rules/project/x.md"`; (2) harness A/B: `--harness codex` against `harness/cursor.md` identical with and without the file; `--harness cursor` renders it; (3) host A/B: `O2B_DEVICE_ID=aaaa0001` against `host/bbbb0002.md` identical; (4) remote reach (no reach minted) from workspace X with `project/x.md` is byte-identical to the vault without it; (5) census: no tool input schema property under `src/mcp/` is named `harness` or ends in `_harness`, and no tool description contains `` `${BRAIN_SCOPED_RULES_DIR}/` ``.
- **Commands**: `bun test tests/mcp/brain-context-scoped-rules.test.ts tests/mcp/brain-context-standing-rules.test.ts tests/core/architecture/harness-identity-census.test.ts tests/core/architecture/visibility-surface-census.test.ts && bun run typecheck`
- **Commit**: `feat(mcp): add scoped operator rules to brain_context at local reach`
- **Depends on**: B1, A2

#### Task B3: Uneditable matrix for the directory

- **Files**: `tests/mcp/brain-standing-rules-uneditable.test.ts`
- **Failing first**: the four caller-named write tools and `brain_labels` refuse `Brain/standing-rules/project/x.md` with bytes unchanged, and the substring check also rejects `` `${BRAIN_SCOPED_RULES_DIR}/` `` in tool names and descriptions. Fails until A3 lands (the labels row).
- **Commands**: `bun test tests/mcp/brain-standing-rules-uneditable.test.ts`
- **Commit**: `test(mcp): pin the scoped standing-rules directory as uneditable`
- **Depends on**: A3 (`src/core/brain/standing-rules.ts`)

#### Task B4: SessionStart hook lane and the packaged harness

- **Files**: `hooks/active-inject.ts`, `tests/hooks/active-inject-scoped-rules.test.ts`, `tests/mcp/plugin-mcp-servers.test.ts`
- **Failing first**: (1) two temp project dirs X and Y linked to one vault; run A with `project/x.md`, run B without, both with payload `cwd` Y: stdout identical and neither holds the marker; with `cwd` X the marker follows the standing header and precedes the active body; (2) a `harness/claude-code.md` file never renders in the hook; (3) budget: `inject_budget_chars: 500`, `scoped_rules_max_chars: 200` and a 5000-character `project/x.md`: the scoped block is capped, the active body is budgeted to `500 - scopedBlock.length`, the receipt's `budget` records `inject_budget_chars: 500` and `scoped_rules_chars` equal to the block length; (4) the plugin manifest test expects the two `--harness claude-code` arg lists.
- **Commands**: `bun test tests/hooks/active-inject-scoped-rules.test.ts tests/hooks/active-inject.test.ts tests/mcp/plugin-mcp-servers.test.ts && bun run typecheck && bun run sync-plugin-mirrors:check`
- **Commit**: `feat(hooks): inject project and host scoped rules at session start`
- **Depends on**: B2, A4 (`src/core/brain/policy/blocks/active.ts`), E1 (`.claude-plugin/plugin.json`)

### Lane C - Hermes plugin

#### Task C1: Two-mode reader and `ProfileScopeError`

- **Files**: `plugins/hermes/config.py`, `tests/python/test_profile_scope.py`, `tests/python/test_memory_provider.py` (`_CONFIG_ENV_KEYS` gains the timeout name)
- **Failing first**, with a fake `agent.secret_scope` injected through `patch.dict(sys.modules, {"agent": pkg, "agent.secret_scope": fake})`: (a) no stub: today's answers; (b) stub with multiplexing off: `os.environ` wins and `fake.get_secret` is never called; (c) multiplexing on with a scope: scoped values beat conflicting `os.environ` values for vault, agent name, timezone and config path; (d) empty scope: falls through to the config chain, not to `os.environ`; (e) `get_secret` raises: `resolve_vault` and `resolve_agent_name` raise `ProfileScopeError`, an instance of `ConfigReadError`, whose `__cause__` is the fake `UnscopedSecretError` and whose message holds no environment value.
- **Commands**: `cd tests/python && python3 -m unittest test_profile_scope test_resolver_parity -v`
- **Commit**: `feat(hermes): resolve profile-scoped settings from the Hermes profile scope`
- **Depends on**: none

#### Task C2: Warning, `shadowing_source` and CLI line

- **Files**: `plugins/hermes/config.py`, `plugins/hermes/cli.py`, `tests/python/test_profile_scope.py`
- **Failing first**: (c') one WARNING per ignored name from `plugins.hermes.config`, the value string absent from every record; (g) repeated calls log once (`_reset_scope_warnings_for_tests` between tests); the multiplexed `shadowing_source("agent_name")` names the profile `.env`, the non-multiplexed text is unchanged; `cli._config` prints `settings_source:` as its first line in both modes, and with no scope bound prints the `ProfileScopeError` naming `OPEN_SECOND_BRAIN_CONFIG` and exits 2.
- **Commands**: `cd tests/python && python3 -m unittest test_profile_scope test_memory_provider -v`
- **Commit**: `feat(hermes): warn once per ignored gateway variable and name the settings source`
- **Depends on**: C1

#### Task C3: Scoped child environment, bridge key and timeout

- **Files**: `plugins/hermes/provider.py`, `plugins/hermes/bridge.py`, `tests/python/test_profile_scope.py`
- **Failing first**: (f) under multiplexing the env passed to the patched `McpBrainBridge` has the launch `VAULT_AGENT_NAME` replaced by the scoped one and no other scoped name from `os.environ`; two scopes with the same vault and different agent names produce two bridges; without multiplexing `_resolve_env()` and sharing are unchanged; (h) a bridge built with `timeout=7.0` restarted from a bare `threading.Thread` never calls `get_secret`; `prefetch` with `get_secret` raising returns without the reminder and logs the degrade WARNING once.
- **Commands**: `cd tests/python && python3 -m unittest test_profile_scope test_memory_provider -v`
- **Commit**: `feat(hermes): give each profile its own MCP child identity on a multiplexed gateway`
- **Depends on**: C2

#### Task C4: `--harness hermes` in the bridge argv

- **Files**: `plugins/hermes/bridge.py`, `tests/python/test_memory_provider.py`
- **Failing first**: `_argv()` ends with `["--harness", "hermes"]` with and without `--vault` and `--repo` (extend the argv tests at `test_memory_provider.py:1709-1740`).
- **Commands**: `cd tests/python && python3 -m unittest test_memory_provider test_profile_scope test_resolver_parity -v && cd ../.. && python3 -m compileall -q plugins/hermes`
- **Commit**: `feat(hermes): launch the MCP bridge with --harness hermes`
- **Depends on**: C3

### Lane D - reach left-overs

#### Task D1: Today view open loops at reach

- **Files**: `src/core/brain/open-loops.ts`, `src/core/brain/today-dashboard.ts`, `src/mcp/brain/brief-tools.ts`, `tests/mcp/today-open-loops-reach.test.ts`, `tests/core/brain/today-dashboard.test.ts`
- **Failing first**: a `notes.read_paths: [Notes]` vault with `Notes/PRIVATE_PATH.md` (reserved visibility, `@osb loop zzreservedloopzz`) against the same vault without it: `brain_brief view=today` at remote reach gives identical normalised output (red today: the loop text, its path and `openLoopsCount`/`scannedFiles` 2 against 1); the local control lists the loop.
- **Commands**: `bun test tests/mcp/today-open-loops-reach.test.ts tests/core/brain/today-dashboard.test.ts && bun run typecheck`
- **Commit**: `fix(brief): list today's open loops at the caller's reach`
- **Depends on**: none

#### Task D2: Monthly view at reach

- **Files**: `src/core/brain/monthly-review.ts`, `src/mcp/brain/brief-tools.ts`, `tests/mcp/brief-monthly-reach.test.ts`
- **Failing first**: on `buildReachLogFixture` with and without the reserved records, `view=monthly` at remote reach gives identical normalised summaries (red today: 7/4/1/1 against 2/1/0/0); the local control keeps 7/4/1/1.
- **Commands**: `bun test tests/mcp/brief-monthly-reach.test.ts tests/mcp/brain-monthly.test.ts && bun run typecheck`
- **Commit**: `fix(brief): count the monthly view at the caller's reach`
- **Depends on**: D1

#### Task D3: Doctor removed-tool cap and stale-dependency count at reach

- **Files**: `src/core/brain/doctor/report.ts`, `src/core/brain/doctor/check.ts`, `src/core/brain/doctor.ts`, `src/core/brain/doctor/removed-tool-checks.ts`, `src/core/brain/stale-dependency.ts`, `src/mcp/brain/health-tools.ts`, `tests/mcp/doctor-counts-reach.test.ts`
- **Failing first**: vault A has a reserved page that sorts first plus 50 readable pages naming a removed tool, vault B only the 50: `brain_doctor` warning lists at remote reach are identical; a reserved retired record changes `states_changed` in A only today, and after the fix the uncertain note is identical.
- **Commands**: `bun test tests/mcp/doctor-counts-reach.test.ts tests/mcp/log-readers-reach-round3.test.ts tests/core/brain/doctor && bun run typecheck`
- **Commit**: `fix(doctor): cap removed-tool warnings and count stale dependencies at the caller's reach`
- **Depends on**: D2

#### Task D4: Operator view at reach and registry reasons

- **Files**: `src/core/brain/trust/operator-summary.ts`, `src/mcp/brain/brief-tools.ts`, `src/core/search/visibility-surface-registry.ts`, `tests/mcp/brief-operator-reach.test.ts`
- **Failing first**: `view=operator` at remote reach with and without the reserved records gives identical `digest_summary`, `doctor_summary`, `top_actions` and `trust_verdict` (red today: preference_count 2/1, warnings 11/3, investigate/watch); the local control is unchanged; the `brain_brief` and `brain_doctor` registry reasons name only `dream_summary` and `verification_delta` as the remaining whole-layer counts.
- **Commands**: `bun test tests/mcp/brief-operator-reach.test.ts tests/mcp/operator-summary-tool.test.ts tests/core/architecture/visibility-surface-census.test.ts && bun run typecheck`
- **Commit**: `fix(brief): answer the operator view at the caller's reach`
- **Depends on**: D3

### Lane E - docs and release

#### Task E1: Version and CHANGELOG

- **Files**: `package.json`, `CHANGELOG.md`, `README.md`, `plugins/codex/README.md`, `.claude-plugin/plugin.json` (version via the sync, plus the two `--harness claude-code` arg lists from the contract), and the other files `sync-version.ts` regenerates
- **Failing first**: `bun run scripts/sync-version.ts --check` and `bun test tests/version.test.ts` fail after `package.json` is set to 1.70.0 and before the sync; pass after. `tests/mcp/plugin-mcp-servers.test.ts` is lane B's and goes red on the new args until B4 lands; that is expected and not lane E's to fix.
- **Commands**: `bun run scripts/sync-version.ts && bun run sync-plugin-mirrors && bun test tests/version.test.ts && bun run sync-plugin-mirrors:check`
- **Commit**: `chore(release): 1.70.0 changelog and version` (README and `plugins/codex/README.md` in this first commit)
- **Depends on**: none

#### Task E2: Scoped rules and `--harness` docs

- **Files**: `docs/how-it-works.md` (constitution section, `### Scoped operator rules` with the precedence sentence and the hook/MCP split), `docs/mcp.md` (`brain_context` `scoped_rules` key, `--harness` on the server line, the today/monthly/operator/doctor residual sentences at :2180-2182 and :2218-2222 rewritten to what remains), `docs/cli-reference.md` (`o2b mcp --harness`), `docs/observability.md` (receipt `scoped_rules_chars`)
- **Failing first**: `bun test tests/docs` (docs conformance) stays green; grep shows no `standing-rules/` mention in any tool description string.
- **Commands**: `bun test tests/docs`
- **Commit**: `docs: describe scoped operator rules and the --harness option`
- **Depends on**: none

#### Task E3: Hermes and stability docs

- **Files**: `install/hermes.md` (`### Multiple Hermes profiles`: per-profile `.env`, the process environment ignored under `gateway.multiplex_profiles`, the WARNING, the residual variables, the install-shadowing pitfall), `docs/stability.md` (one sentence for the multiplexed environment layer, one for the scoped layer), `docs/updating.md` (`## Upgrading to 1.70.0`)
- **Failing first**: `bun test tests/docs/install-verify-conformance.test.ts` stays green.
- **Commands**: `bun test tests/docs`
- **Commit**: `docs: per-profile Hermes settings and the 1.70.0 upgrade notes`
- **Depends on**: none
