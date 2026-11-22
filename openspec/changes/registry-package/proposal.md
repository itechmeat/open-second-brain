# Proposal

## Why

Installing Open Second Brain for most clients means cloning the repository, and the launchers the package declares do not run on Windows and do not include the hook entry point. The 2.0 README promises one install command; that needs a package that works from the registry.

## What Changes

1. Three cross-platform launchers (`o2b`, `o2b-mcp`, `o2b-hook`) replace the bash scripts in `package.json` `bin`. `vault-log` is omitted because it passes `append-event` to a CLI dispatcher with no such command. Bun stays the one prerequisite. The bash and `.cmd` launchers stay for clones and marketplace caches.
2. The package contents become an explicit, checked list: `hooks/` and `templates/` are added, tests and development files are left out, and CI fails when the packed file list, a forbidden path or the size budget changes without review.
3. No lifecycle script runs on a consumer's machine: the `prepare` script leaves the published package.
4. CI installs the packed tarball on Linux, macOS and Windows and runs every launcher.

Not in this change: the one-step `setup` verb, registrations that survive an upgrade, doctor reporting of mixed installs, the publish step and the README (the next two changes: `setup-verb`, `registry-publish`).

## Capabilities

### New Capabilities

- `registry-package`: what the published package contains, which commands it provides on each system, what they require, and what an install is forbidden to run.

### Modified Capabilities

None.

## Impact

1. `package.json` (`bin`, `files`, `scripts`, `engines`), new `bin/*.js` and their shared module, `scripts/prepare.ts` and the developer hook setup, a new packed-manifest file and its check script, `.github/workflows/ci.yml` (a pack job on three systems).
2. No change for an existing clone or marketplace install: their launchers and paths are untouched.
3. The Windows shard timings may need a refresh for the new test files.
