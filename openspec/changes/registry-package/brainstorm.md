# Brainstorm

## Problem

Open Second Brain can be installed without a clone only through the plugin marketplaces of four agent hosts. Every other client is told to clone the repository and link launchers from it. The 2.0 README promises one install command, so the product is published to the npm registry. This change makes the package installable and runnable from the registry on Linux, macOS and Windows; setup in one verb and the publish step itself are the two changes after it.

## Related work

1. `openspec/changes/agent-neutral-dream` (in flight): it adds setup questions to first setup; the setup verb of the next change carries them. No file overlap with this change.
2. No open pull request touches `package.json` `bin` or `files`, the launchers under `scripts/` or the release workflow.

## Doubts

Put to the partner: which install line is honest about the Bun requirement; how `bin` can work on three systems when the launchers are bash; how a registry install coexists with a marketplace install and a clone; what the tarball must and must not hold; which lifecycle scripts are a supply-chain risk; what proves a packed tarball works.

## Approaches considered

### Evidence from the code

1. `package.json` declares `bin` for `o2b`, `o2b-mcp` and `vault-log`, all bash launchers that run `bun run src/cli/main.ts`. `o2b-hook`, which every hook registration calls, is not declared. The Windows launchers are separate `.cmd` files the package does not use.
2. The packed tarball today holds 1721 files (about 6 MB packed, 20 MB unpacked) and misses `hooks/` and `templates/`, which the runtime reads. (Partner; confirmed by a dry-run pack.)
3. `package.json` has a `prepare` script, which the registry would run on a consumer's machine for a git install and which publishes as metadata.
4. The bash launchers bootstrap the dependency tree of a checkout (`scripts/_bun-precheck.sh`) and resolve the active plugin root for hooks (`scripts/o2b-hook`); both are needed for clones and marketplace caches and wrong for a registry install.

### The launcher

1. Partner: one small JavaScript launcher per command with a Node shebang, sharing one module that finds Bun, checks its version and spawns it; Node becomes a second prerequisite, in exchange for a clear message when Bun is missing.
2. Author: the same launchers with a Bun shebang. Bun is the one stated prerequisite; `bun add -g open-second-brain` installs and links them on the three systems, and `npm install -g` works as well on a machine that has Bun. A missing Bun then shows the system's own "not found" for `bun`, which the README's prerequisite line explains.

### The install line

1. Partner: `npm install -g open-second-brain --ignore-scripts`, with Node, npm and Bun stated as prerequisites.
2. Author: `bun add -g open-second-brain`, with Bun as the only prerequisite. `bunx` and `npx` are not the README's line because their caches are disposable and hook registrations need a path that stays.

## Decision

1. JavaScript launchers under `bin/` for `o2b`, `o2b-mcp`, `o2b-hook` and `vault-log`, with a Bun shebang, sharing one module: resolve the package root from the launcher's own location, check the Bun version against `engines.bun`, apply the macOS SQLite library path rule the bash launcher applies, run the entry in the same process where possible, keep arguments, standard streams, signals and the exit code. The hook launcher never exits with a code that blocks the host and writes diagnostics only to standard error; the MCP launcher writes nothing but protocol to standard output.
2. The bash and `.cmd` launchers stay for clones and marketplace caches, unchanged. A registry launcher never installs dependencies at start.
3. The README's line is `bun add -g open-second-brain`; Bun is the only prerequisite. Reason against the partner's Node shebang: it adds a second runtime for every user to improve one error message.
4. The tarball is an explicit list: sources, the new launchers, `hooks/`, `templates/`, skills, schemas, the OpenClaw bundle and manifest, the plugin assets a host reads and the real Codex mirror, the decision model evaluation fixtures the runtime reads. Nothing else. A committed manifest of packed paths, a list of forbidden paths and a size budget are checked in CI.
5. No lifecycle script runs on install: `prepare` leaves the published package (the developer hook setup becomes an explicit command), and a check refuses `preinstall`, `install` and `postinstall`.
6. Acceptance on the three systems installs the packed tarball into an isolated prefix with an isolated home and runs every launcher, with no access to the repository checkout.

## Rejected

1. A Node shebang (partner): a second prerequisite for a better error message.
2. `bunx` or `npx` as the install line: disposable caches; registrations would point at paths that vanish.
3. A shell installer fetched over the network: a new attack surface and three installers to maintain.
4. Removing the bash launchers: clones and marketplace caches resolve them by path today.
5. A `create-` package: a second package that does not make the install persistent.

## Open questions

None.

## Process

The partner was an agent of a different model family than the author, run read-only against main, one round. It corrected three facts in the author's brief (three optional dependencies, what `update` does, the files missing from the tarball) and supplied the tarball, publishing and acceptance design. The author overruled it on one point, the launcher's shebang and the install line, for the reason given under Decision. Nothing was run beyond a dry-run pack.
