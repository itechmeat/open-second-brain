# Design

## Context

1. The bash launchers under `scripts/` do three things besides starting Bun: check the Bun version and adopt `~/.bun/bin` when PATH is minimal (`_bun-precheck.sh`), bootstrap a missing dependency tree of a checkout (same file), and set the macOS SQLite library path so extension loading works (`_macos-sqlite.sh`). `scripts/o2b-hook` additionally resolves the active plugin root and never exits with a blocking code. Tests pin these: `tests/scripts/bun-precheck.test.ts`, `launcher-bootstrap.test.ts`, `macos-sqlite-shim.test.ts`, `windows-launchers.test.ts`.
2. `package.json` `files` is a list of directories; a dry-run pack gives 1721 files and misses `hooks/` and `templates/`.
3. `package.json` has a `prepare` script that sets the git hooks path for developers.
4. CI has a `validate` job on Linux and a sharded `windows` job; there is no macOS job that runs the suite.

## Goals / Non-Goals

**Goals:**

1. Three commands that run from a registry install on three systems with Bun as the only prerequisite. `vault-log` is omitted because it dispatches `append-event`, which `src/cli/main.ts` does not implement.
2. A tarball that holds what the runtime reads, checked by a committed manifest.
3. No script runs on install.
4. Proof in CI from the packed tarball, not from the checkout.

**Non-Goals:**

1. A setup verb, registrations that name the registry launcher, doctor reporting of mixed installs, the publish job, the README: later changes.
2. Removing the Bun requirement.
3. Changing the bash or `.cmd` launchers.

## Decisions

### D1. Launchers are JavaScript files with a Bun shebang that start one child

`bin/o2b.js`, `bin/o2b-mcp.js`, `bin/o2b-hook.js`, each a few lines that call one shared module, `bin/_launch.js`. Plain JavaScript (no TypeScript), so the files run as published. The shebang is `#!/usr/bin/env bun`: a global install by Bun or by npm creates the system's shim from it (symbolic links on Linux and macOS; on Windows npm writes shell, `.cmd` and `.ps1` wrappers and Bun writes an `.exe` shim, and neither needs a Unix `env`).

A launcher never imports the program. The entry modules guard their start with `import.meta.main` (`src/cli/main.ts`, `hooks/neighbour-updates.ts`, `hooks/answer-quote-check.ts`), other hooks start on import and may call `process.exit` with a blocking code, and an import can intercept neither. So every launcher starts exactly one child: `process.execPath run <entry> ...args`, with the arguments as an array (no shell), inherited standard streams, `SIGINT`, `SIGTERM` and `SIGHUP` forwarded to the child, and the child's exit code as its own (a child ended by a signal ends the launcher with 128 plus the signal number). This is the same shape as today's bash launchers (one small process, then Bun), so the cost does not change.

| Command | Child entry | Arguments |
|---|---|---|
| `o2b` | `src/cli/main.ts` | as given |
| `o2b-mcp` | `src/cli/main.ts` | `mcp`, then as given |
| `o2b-hook <name>` | `hooks/<name>.ts` | the rest, as given |

Before starting the child, `_launch.js`:

1. Resolves the package root from its own file location (`import.meta.url`), following symbolic links, so a linked global bin still finds `src/`.
2. Checks `Bun.version` against the minimum read from the root `package.json` `engines.bun` (this change adds the field; a test holds the bash precheck's constant equal to it). Older: one line on standard error naming the required version, exit 1, no child.
3. For `o2b` and `o2b-mcp` only (the two bash launchers that source `_macos-sqlite.sh` today), applies that file's rule to the child's environment: on Darwin, when the variable is absent (an empty value counts as set), the first existing directory of the same candidate list is used, otherwise nothing changes; the override variables of the bash file keep their meaning.
4. Never installs dependencies. A registry install has its dependency tree from the package manager; a missing module is reported by the child as it is.

The hook launcher differs in three ways, matching `scripts/o2b-hook`: a missing hook name, an unknown hook, an old Bun and a child that cannot start each write one line to standard error and exit 0; a child that exits non-zero (including the blocking code 2) is reported in one line on standard error and the launcher exits 0; nothing of its own goes to standard output. It resolves the hook file inside the package root only; the active-root resolution of the bash hook launcher is for marketplace caches and stays there.

Bun must be on PATH for these commands: a shebang is resolved before any JavaScript runs, so the recovery of `~/.bun/bin` under a minimal PATH that `_bun-precheck.sh` and `scripts/o2b-hook` do cannot be repeated here. The bash launchers keep that recovery. Registrations that an agent host runs with a minimal PATH name an absolute Bun and the launcher file; they belong to the change `setup-verb`, and until it lands the install adapters keep registering what they register today.

Alternatives rejected: a Node shebang (see `brainstorm.md`); importing the entry in the launcher's process (does not start the program, cannot contain a hook's exit); `Database.setCustomSQLite` in place of the environment rule (would put launcher knowledge into the program; the child's environment gives exact parity with the bash rule).

### D2. `bin` and `files`

`bin` points the three supported names at `bin/*.js`. `files` becomes an explicit list of paths and globs. The inventory, to be confirmed against the code in task 2.1 and committed as the manifest:

1. Launchers: `bin/*.js`.
2. The program: `src/`, `hooks/`, `schemas/`.
3. What it reads at run time: `templates/` (reminder, starter, explorer, Aider), `skills/`, `tests/fixtures/decision-model` (production evaluation reads it).
4. Host assets: `openclaw/index.js`, `openclaw.plugin.json`, `plugins/codex/`, `plugins/hermes/`, `plugins/opencode/open-second-brain.ts` (`src/core/install/opencode-plugin-asset.ts`), `.claude-plugin/`, `.codex-plugin/`, the root plugin manifests, the root `__init__.py` (the Hermes root loader).
5. The discipline report pair, while the verb exists: `bin/o2b-discipline-report` and `scripts/discipline-report.ts` (`src/cli/discipline-install.ts`).
6. The bash and `.cmd` launchers under `scripts/` with their sourced parts, because the hook manifests and install adapters name them.
7. `README.md`, `LICENSE`, `pyproject.toml`.

`bun.lock` is not packed: the package does not promise the checkout's dependency bootstrap, a registry install gets its tree from the package manager. An `.npmignore` is not used: one list, in `package.json`.

### D3. The packed manifest and its check

`scripts/pack-manifest.ts` runs `npm pack --dry-run --json --ignore-scripts`, normalizes the paths to forward slashes, sorts them by code unit (no locale), and either writes `package-files.txt` with LF line ends (`--write`) or compares the path set with it (`--check`). The check also fails on: a path matching the forbidden list (`.apb/`, `.ai-notes/`, `.claude/`, `.env`, `*.local.*`, `node_modules/`, `tests/` other than the allowed fixtures, `openspec/`, `docs/brainstorm/`, `docs/plans/`), a packed or unpacked size above the ceilings recorded at the top of the manifest (the measured size plus a tenth; ceilings, never equality), and any of the four lifecycle script names in `package.json`. A `package.json` script `pack:check` runs it; the `validate` job runs `pack:check`. CI pins the npm version next to the Bun pin (an exact version installed in the job), because the packed list depends on npm's own inclusion rules.

### D4. No lifecycle script

`prepare` is removed. It only set the git hooks path (`scripts/prepare.ts`); nothing is built by it, an already configured checkout keeps its hooks, and CI runs the checks on its own. Its work is the existing explicit script `hooks:install`; `scripts/prepare.ts` is deleted, the comment in `.githooks/pre-commit` that names it is corrected, and, since the repository has no contributor guide, a short section "Git hooks" in the root `CLAUDE.md` says to run `bun run hooks:install` once in a new checkout.

### D5. Acceptance from the tarball

A test helper packs the checkout once per test file into a temp directory (`npm pack --ignore-scripts --pack-destination`) and installs the tarball globally into a scratch root, then runs the commands from there with a working directory outside the checkout.

The child environment is built from an empty object, not inherited, and holds only: PATH reduced to the directory of the running Bun, the scratch bin directory and the system directories; `HOME`; `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`; on Windows `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `SystemRoot`, `PATHEXT`; `TMPDIR`, `TEMP`, `TMP`; `BUN_INSTALL`, `BUN_INSTALL_GLOBAL_DIR`, `BUN_INSTALL_BIN`, `BUN_INSTALL_CACHE_DIR`; `npm_config_prefix`, `npm_config_cache`, `npm_config_userconfig`, `npm_config_globalconfig`; and the application's own config and store path variables. Every one of them points inside the scratch root. Before any command runs, the helper asserts that the resolved install directory, bin directory and the application's config and state paths are inside the scratch root, and fails the file otherwise.

Cases:

1. Installed by Bun: `o2b version` prints the package version; `o2b init` in store-only mode creates a store under the scratch root; a session start hook through `o2b-hook` exits 0; `o2b-mcp` answers an initialize request and the first bytes on standard output are the protocol answer. `vault-log` is not published because its `append-event` dispatch has no corresponding CLI command.
2. Installed by npm into a second scratch prefix (`--ignore-scripts`): `o2b version`, to cover the shims npm generates.
3. A scratch root whose path holds a space and a non-ASCII character: `o2b version` and the hook.

The install needs the registry for the two dependencies, the three optional ones and what they pull in. Locally the file is skipped with a stated reason when the registry cannot be reached; in CI a variable set by the workflow turns that skip into a failure.

CI: the Linux `validate` job runs it as part of the suite; the `windows` job runs it in whichever shard the timings place it; a new small `package-macos` job runs only `pack:check` and this test file, since there is no macOS suite job.

## Risks / Trade-offs

1. `bun add -g` on Windows creates its own shim type for bins, and paths with spaces have had bugs across Bun versions. The acceptance case with a space and a non-ASCII character in the path is the guard, and it must pass on the pinned Bun: there is no fallback to a restricted path.
2. The explicit `files` list can miss a runtime file. The acceptance test runs init, a hook and MCP from the tarball, and the manifest makes every change to the list visible in review.
3. Removing `prepare` means a new contributor's git hooks are not set until they run one command. CI enforces the same checks, so nothing depends on the local hook.
4. A macOS job adds CI minutes. It runs two short steps.
5. A command started from a host with a minimal PATH does not find Bun. This change does not alter what hosts are registered with; the registration with an absolute Bun is the next change.
6. Every command is two processes. The bash launchers already are; measured start time goes into the report.
