# Design

## Context

From `inventory.md` (each claim with its code reference there), corrected for what `registry-package` already changed:

1. The steps exist: `init` and its store-only branch (`cmdInit`, `initWithoutVault` in `src/cli/main.ts`), the interactive wizard (`src/cli/install/init-interactive.ts`), `install --target` with its plan-by-default, `--apply`, `--yes`, `--check` and exit codes 0 to 6 (`src/cli/install/install.ts`), the in-process MCP probe (`o2b mcp --probe`), the store self-test (`o2b doctor selftest`).
2. Every adapter's MCP command comes from `buildPayload` in `src/core/install/payload.ts`: the bare `o2b` (on Windows `cmd /d /c o2b`). Grok is the exception: `process.execPath run <root>/src/cli/main.ts` and `bun run <root>/hooks/<name>.ts` (`grok-asset.ts`), with the root from the module's own location.
3. Verification rebuilds the expected bytes from the install environment alone (`payload-equals.ts`); the readiness probe grades the registered command (`command-probe.ts`).
4. There is no record of where the code runs from. The one heuristic is the substring `plugins/cache` (`install-cli.ts`).
5. The install manifest tolerates unknown keys in an entry; `payload_hash` is written by `update`.
6. Host kinds are encoded in `src/cli/bootstrap/targets.ts` (adapter, verify-only, print) and separately in the adapter registry and the target vocabulary (`src/core/runtime/host-facts.ts`); `claude-code` and `zcode` exist only in the first.
7. `InstallEnv` (`src/core/install/types.ts`) carries the vault, home, cwd, environment and time; `buildInstallEnv` (`env.ts`) is its builder, and four places build it by hand (`src/core/doctor-readiness.ts`, `src/cli/install/init-interactive.ts`, `src/cli/update.ts`, `src/cli/install/uninstall-target.ts`). Two more places rebuild the registered command with a bare `buildPayload`: `src/core/install/update.ts` (the hash `o2b update` compares) and `src/cli/bootstrap/run.ts`.
8. `cliArgs` in `payload.ts` strips only the exact Windows head; Grok builds `run <main.ts>` plus `cliArgs(entry)`. `command-probe.ts` checks a second file only for the shape `run <script>`.
9. `install --check` exits 0 for a host that is not installed, by design. An adapter's `verify(env)` returns a status. The init functions in `src/cli/main.ts` are private to the module and print to standard output, as do the install renders, the MCP probe and the self-test. The store self-test writes a temp vault on every call. `underPluginCache` exists twice, in `src/cli/install-cli.ts` and `install-cli-windows.ts`.
10. Adapter payload bytes are pinned by the tests listed in `inventory.md` section 8 and by the expected-output blocks of the install guides.

## Goals / Non-Goals

**Goals:**

1. One command, headless when told everything, that ends in a verified connection.
2. A registration from a registry install that does not depend on PATH.
3. No byte changed for a checkout or a plugin cache.

**Non-Goals:**

1. Publishing, the README, `update`'s meaning, a hook dry run, new host discovery.

## Decisions

### D1. The origin

`src/core/install/origin.ts` exports the pure `classifyOrigin(root)` and `installOrigin()`: `{ kind, root, version }`. `root` is the package root found from the module's own location (the directory holding `package.json` with the product's name). `kind`, checked in this order:

1. `runner-cache` when the root is under a known package runner's temporary cache: a path segment `_npx` (npm's runner keeps `~/.npm/_npx/<hash>/node_modules/<package>`, whose parent is also `node_modules`, so this must be checked first) or Bun's install cache (`install/cache`). The list is one constant with a test per entry. A runner the list does not know is not detected; the spec says "known".
2. `plugin-cache` when the `plugins/cache` rule matches. That rule moves here from its two copies under `src/cli/`, which import it, so core does not import from the command line layer.
3. `registry` when the root's parent directory is named `node_modules` (Bun: `~/.bun/install/global/node_modules/<package>`; npm: `<prefix>/lib/node_modules/<package>`, on Windows `<prefix>/node_modules/<package>`).
4. `checkout` otherwise. A marketplace snapshot that has no `plugins/cache` segment is a checkout for this purpose: its bytes do not change.

Tests build each layout in a temp directory and call `classifyOrigin`.

### D2. The registered command

`InstallEnv` gains `origin`. `buildInstallEnv` sets it from `installOrigin()`, and the four places that build the environment by hand go through the builder. Tests pass an origin explicitly.

`payload.ts` gains `launcherCommand(env)`, the only place that decides the head of the registered command. For `registry` it returns `[process.execPath, "run", <root>/bin/o2b.js]`: the `run <script>` shape is the one `command-probe.ts` already grades by checking both files, so a stale launcher reads as stale with no change to the probe, and there is no `cmd /d /c` on Windows because Bun's executable is run directly. For every other kind it returns what is returned today.

Every place that builds or rebuilds the command uses it: `buildPayload`, `payload-equals.ts` (so a fresh install does not drift against itself), `src/core/install/update.ts` (or `o2b update` would rewrite a registry registration back to the bare name) and `src/cli/bootstrap/run.ts`. `cliArgs` learns to strip the registry head as it strips the Windows one, so Grok keeps building its own shape (`run <main.ts>` plus the arguments) from a clean argument list for every origin.

`runner-cache` is refused at the top of `install --apply` and of `setup` with the permanent install command in the message.

**A machine with no vault.** The payload builder refuses a missing vault today, and verification rebuilds the same payload, so a store-only machine could not connect an adapter host at all. For a machine configured without a vault the registered command carries no `--vault` argument: the server resolves its brain from the machine configuration, as a store-only machine's server already does. With a vault the argument and the bytes are today's. Apply and verification use the same rule, so a fresh no-vault install does not drift against itself. Found by the implementer, who stopped as the task rules require; decided by the author.

### D3. The record

A manifest entry gains `origin: { kind, root, version }`. It is stamped in one place, `recordEntry` in `manifest.ts`, from the environment, so no adapter changes for it. An entry without it is read as `checkout` with an unknown version: that is every existing installation, and nothing about it is reported.

### D4. `o2b setup`

`src/cli/setup.ts`, dispatched from `main.ts`, with a manifest entry. It does not go through `main()`: it calls functions and reads what they return.

1. Parse flags. Target absent: with a terminal run the wizard and return its code; without one, usage error.
2. Checks that never write: the target is known; the origin is not `runner-cache`.
3. Without `--apply`: print the plan (the steps that would run, the install plan of the target, and, on an unconfigured machine, which of `--vault` or `--no-vault`, `--agent-name` and `--timezone` an apply will need) and return 0. A plan needs no choices.
4. With `--apply`, before any write: on an unconfigured machine each missing choice is a usage error that names the flag; without `--yes`, a terminal must be present to ask, else the consent code; a `--vault` that contradicts the configuration is a usage error that names both.
5. Configure and create or connect the brain. The two init functions are exported from `main.ts` for this (or moved to a module of their own if that is cleaner; say which in the report). Skipped when the machine is configured.
6. Host step by kind (D5). An adapter host is satisfied when `adapter.verify(env)` answers `ok`; otherwise the adapter is applied with consent passed and verified again. A plugin host prints its own step. A print host (`generic`) prints the payload as `install` does.
7. Verify: the adapter's `verify` status, the MCP probe, and, only when a step of this run wrote something, the store self-test (it writes a temp vault on every call, and a second run must leave no trace).
8. Report as text or as one JSON document: steps with outcomes, written paths, the registered command, verification, remaining actions. Exit 7 when what is left is a step for the host or for the user (plugin and print hosts); otherwise the worst code of the steps, on the install's scale.

Output of the composed steps: every function that prints is called through one helper that captures standard output for the duration of the call and restores it in `finally`. In text mode the captured text is printed under the step's heading; with `--json` it goes into that step's `output` field, so standard output holds one document.

A second run finds every step satisfied, writes nothing to the configuration, the brain or the host, and skips the self-test.

### D5. One table of host kinds

`src/core/install/host-kinds.ts`: for every target of the vocabulary plus `claude-code`, `zcode`, `hermes`, `openclaw`: `adapter`, `plugin` (with the text of the host's own step and the guide it points to) or `print`. Only `setup` reads it. `bootstrap` keeps its own list of targets and modes unchanged; a test holds the two tables to the same kind for every target both name. The vocabulary census (`tests/core/architecture/host-facts-census.test.ts`) is not changed: the four plugin hosts are not in the vocabulary, and the new table's own test says so.

### D6. Doctor

In `doctor-readiness.ts`, beside the registered command probe:

1. `stale_registration`: the manifest entry's origin is `registry` and the existing probe grades its command as not resolving. Fix line: `o2b setup --target <t> --apply --yes`.
2. `registration_version`: the entry's version is older than the running one. Same fix line. Information, not a failure.
3. `path_providers`: every `o2b` on PATH resolved to its real file; more than one distinct file is listed with the one that runs first. Information.

## Risks / Trade-offs

1. A package manager that relocates its global directory makes the registered path stale. Doctor says so and the repair is one command.
2. The absolute Bun is the one that ran `setup`; a later Bun upgrade in place keeps the path, a reinstall elsewhere makes it stale, same repair.
3. The origin rule is positional. The four layouts are tested, and the acceptance test of `registry-package` (a real install into a scratch prefix) gains one case: setup from the installed package registers an absolute pair for a host whose configuration lives in the scratch home.
4. The wizard and `setup` are two entries to the same steps. The wizard is not rewritten here.
