# Open Second Brain — Installation

Open Second Brain ships one CLI (`o2b`), one always-loaded MCP
writer server, one full MCP server, and a runtime-specific install
adapter per supported runtime. This file is a router — pick the
runtime you use and read the corresponding `install/<runtime>.md`.

> **Always install the latest released version.** The runtime CLIs
> resolve `latest` from a bare `owner/repo` identifier by default.
> Do not append `@v...` — that freezes the install at a specific
> tag, including back to an older release if you happen to know an
> outdated number.

## Prerequisites

Read **`install/prerequisites.md`** first — Bun runtime, vault
discovery, identity (agent name + timezone), and the verification
pattern that every install path ends with.

## Quick install

For MCP-aware runtimes the v0.10.11 orchestrator handles install
in one command:

| Runtime              | Command                                            | Notes                                                                 |
|----------------------|----------------------------------------------------|-----------------------------------------------------------------------|
| Cursor               | `o2b install --target cursor --apply`              | `install/cursor.md` — JSON-merge; restart Cursor after apply         |
| Aider                | `o2b install --target aider --apply`               | `install/aider.md` — managed block + sidecar context; no native MCP   |
| opencode             | `o2b install --target opencode --apply`            | `install/opencode.md` — MCP servers + native plugin                                    |
| Grok Build           | `o2b install --target grok --apply`                | `install/grok.md` — bundled plugin (MCP + hooks); auto-enabled user-scope plugin       |
| kiro                 | `o2b install --target kiro --apply`                | `install/kiro.md` — JSON-merge                                        |
| GitHub Copilot CLI   | `o2b install --target copilot-cli --apply`         | `install/copilot-cli.md` — `copilot mcp add` with JSON fallback       |
| Google Gemini CLI    | `o2b install --target gemini-cli --apply`          | `install/gemini-cli.md` — JSON-merge in `~/.gemini/settings.json`     |
| Pi (pi.dev)          | `o2b install --target pi --apply`                  | `install/pi.md` — skill symlink, not MCP                              |
| Generic / other      | `o2b install --target generic --apply --out -`     | `install/generic.md` — prints payload; never edits external config    |

For runtimes that ship their own plugin/MCP install pipeline, OSB
hooks into that pipeline instead of `o2b install --target`:

| Runtime              | Doc                       |
|----------------------|---------------------------|
| Hermes Agent         | `install/hermes.md`       |
| OpenClaw             | `install/openclaw.md`     |
| Codex                | `install/codex.md`        |
| Claude Code          | `install/claudecode.md`   |

## Interactive setup

For a guided first-time setup that composes `o2b init`, optional
`o2b brain init`, and per-target `o2b install`:

```bash
o2b init --interactive
```

The wizard reads from stdin, prints the full action plan, and
requires an explicit `yes` before any side effects.

## Verify

After any install:

```bash
o2b doctor --vault /path/to/vault --repo .
o2b install --check
```

`o2b install --check` is the runtime-install health check
(per-target managed-block / MCP-ping verification). Exit code is
`0` for ok / not-installed, `3` if any target reports drift.

## Uninstall

For MCP-aware runtimes:

```bash
o2b uninstall --target <name> --apply
```

Removes exactly what `o2b install --target <name>` wrote (recorded
in `<vault>/.open-second-brain/install.lock.json`). For runtimes
that ship their own plugin uninstall command, see the
corresponding `install/<runtime>.md` for the full sequence.

The vault and its Markdown files are never deleted by the
uninstall process.

## Installation readiness criteria

The installation is complete only when all of the following hold:

Universal:

- [ ] plugin (or per-target managed block / symlink / printout)
      installed;
- [ ] runtime restarted to pick up the change;
- [ ] vault initialized (`o2b init` succeeded);
- [ ] `o2b doctor` reports OK;
- [ ] `o2b install --check` reports `ok` (or `installed` for `generic`)
      for the target;
- [ ] `AI Wiki/identity/agents.md` contains the chosen agent name;
- [ ] a test event written without an explicit `agent` argument
      stamps `@<chosen-agent-name>` in `Daily/`, not `@agent`.

MCP-driven runtimes only (Cursor, opencode, Grok Build, kiro,
Copilot CLI, Gemini CLI, Claude Code, Codex, Hermes — not `aider`,
`pi`, or `generic`):

- [ ] all OSB tools advertised by the runtime's MCP listing.

If any single item is missing, the install is incomplete — report
that to the user and do not mark the workflow as successful.
