# Project: Open Second Brain

A local-first memory layer for coding agents: a Bun and TypeScript CLI
(`o2b`), an MCP server, agent plugins (Claude Code, Codex, Hermes,
OpenClaw) and skills. `CLAUDE.md` and `AGENTS.md` at the repository root
are the map of versioning, plugin mirrors and gates; read them before any
change.

This `openspec/` directory is committed with the code. Changes use the
project schema `osb` (`openspec/schemas/osb/`): brainstorm with an
independent agent, proposal, specs, design, tasks, independent review of
the artifacts, then apply. `tasks.md` is a self-contained brief for the
agent that implements the change, which may be a different agent than
the author; implementation starts only on the review's "Ready for
implementation: yes". Each change maps to one pull request. Before the
pull request of a change is pushed, the change is archived (`openspec archive <change> --yes`) and the archive and
the updated `openspec/specs/` ship in that pull request, so
`openspec/specs/` always describes main. The multi-phase change
`brain-store-and-topics` predates these rules: it keeps the schema it was
written with and is archived once all its phases are released; its
remaining tasks move into changes of their own.

Conventions that apply to every change here:

1. English only in code, docs, comments and commit messages. No
   exclamation marks in docs. The product is written "Open Second Brain"
   in full, never abbreviated, in anything public.
2. Test first: write the failing test, run it and see it fail, then the
   code. A test proves behaviour through public seams; no test-only
   production seams beyond the existing hook patterns.
3. Never read or write the real user state in tests: not
   `~/.config/open-second-brain/config.yaml`, not `~/vault`, not the real
   `~/.local/state/open-second-brain`. Tests get temp directories (the
   preload in `tests/` isolates the state dirs).
4. No personal settings in the repository: no machine paths, host names,
   model preferences or account names in code, docs, examples or tests.
5. Every path must work on Linux, macOS and Windows (path separators,
   locks, fsync, case folding). CI runs the suite on Windows.
6. Source files stay under 700 lines; split a module before it grows past
   that.
7. Version bumps: `package.json` only, then `bun run scripts/sync-version.ts`,
   inside the pull request that ships the release (see `CLAUDE.md`).
8. After changing a skill or `hooks/hooks.json`, run
   `bun run sync-plugin-mirrors`; never edit the mirrored copies.

The local gate, run before a change is called done:

```sh
bun run test
bunx tsc --noEmit -p .
bun run lint
bun run fmt:check
bun run check:paths
bun run sync-plugin-mirrors:check
bun run scripts/sync-version.ts --check
```

When `src/` code that the OpenClaw bundle includes changes, rebuild it with
`bunx bun@1.4.0 run build:openclaw` and commit `openclaw/index.js`.
