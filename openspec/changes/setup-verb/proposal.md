# Proposal

## Why

Installing the package gives commands and connects nothing. A user, or an agent following the README, needs one command that takes a fresh machine to a working, verified connection between Open Second Brain and one agent host, without questions when the choices are given. And what gets registered in the host must keep working from a registry install: an absolute path, not a bare name that depends on PATH.

## What Changes

1. `o2b setup --target <host>` with `--vault <path>` or `--no-vault`, `--agent-name`, `--timezone`, `--config`, `--apply`, `--yes`, `--json`: configures the machine if needed, creates or connects the brain, connects the host, verifies, reports.
2. From a registry install, hosts are registered with the absolute Bun and the launcher inside the installed package. From a checkout or a plugin cache the registered command is unchanged.
3. The install manifest records where each registration came from (origin, package root, version); verification uses it.
4. Doctor reports a registered command that no longer exists, a registration older than the running version, and several different `o2b` on PATH, each with its repair command.
5. Hosts that install through their own plugin mechanism get instructions and a distinct exit code.

This is the second of the three package changes: `registry-package`, `setup-verb`, `registry-publish`.

## Capabilities

### New Capabilities

- `setup`: the one command after installation: what it does in order, what it asks, what it registers depending on the origin, what it verifies, and how it ends.

### Modified Capabilities

None.

## Impact

1. Code: a new `src/cli/setup.ts` and its dispatch and manifest entry; a new `src/core/install/origin.ts`; `src/core/install/payload.ts` (the command for the registry origin), `payload-equals.ts`, `command-probe.ts`, `grok-asset.ts` (same origin rule), `manifest.ts` and `types.ts` (the origin fields), `src/core/doctor-readiness.ts`, `src/cli/bootstrap/targets.ts` (the one table of host kinds), `docs/cli-reference.md`, `install.md`.
2. Existing installs: unchanged bytes for checkout and plugin cache origins.
3. Depends on `registry-package` (the launchers under `bin/`).
4. Risks: an origin misread; a registered absolute path that goes stale when the package manager moves its directory; Windows command shape.
5. Not in this change: publishing, the README, any change to `update`.
