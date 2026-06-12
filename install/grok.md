# Grok Build

`o2b install --target grok --apply` performs a native [Grok Build](https://docs.x.ai/build/overview)
integration in one pass, writing to grok's own primary config locations:

- **MCP servers** - registers `open-second-brain` and `open-second-brain-writer`
  in `${GROK_HOME:-$HOME/.grok}/config.toml` under `[mcp_servers.*]` (grok's
  highest-priority MCP source), each with an absolute command
  (`bun run <repo>/src/cli/main.ts mcp …`). User-authored `[mcp_servers.*]`
  and other config sections are preserved.
- **Lifecycle hooks** - writes `${GROK_HOME:-$HOME/.grok}/hooks/open-second-brain.json`
  (grok's native, always-trusted hooks dir), again with absolute `bun` commands.

Why an absolute command rather than a bare `o2b`: verified against live grok
0.2.45 (the session debug log), grok spawns MCP servers and hook scripts with a
restricted PATH that excludes `~/.local/bin`, so a bare `o2b` fails to spawn and
no tools load. The absolute `bun run …/main.ts` form is what grok actually
launches and handshakes in a session (71 + 5 tools registered, hooks dispatched).

## Install

```bash
o2b install --target grok --apply
```

Start grok (or press `r` in the `/mcps` and `/hooks` modals) to load them.
Confirm with `grok inspect` and, for a live check, `grok mcp doctor
open-second-brain`.

## What it provides

- **MCP servers** - `open-second-brain` (full Brain surface) and
  `open-second-brain-writer` (the always-loaded writer set). grok namespaces
  the tools as `open-second-brain__<tool>` / `open-second-brain-writer__<tool>`
  and the model reaches them through grok's `search_tool` / `use_tool`.
- **Active context inject** - `SessionStart` runs `hooks/active-inject.ts`,
  appending the rendered `Brain/active.md` digest so the agent sees live
  preferences without calling `brain_query` first.
- **Post-write reminder** - after a file-mutating tool (grok's `search_replace`,
  plus the Claude-style `Write` / `Edit` / `MultiEdit` / `apply_patch` aliases)
  `hooks/post-write-reminder.ts` appends the logging nudge.
- **Session capture and the stop-log guardrail** - the `Stop` / `SessionEnd`
  hooks capture the session and check that an artifact turn logged a Brain
  event, mirroring the Claude Code behavior.

Every hook is fail-soft: a missing vault or runtime error never breaks the grok
session.

grok's Brain writes (hook captures and tool calls) attribute to a **grok-specific
identity** derived from your configured `agent_name`: the host segment is kept and
the vendor token is swapped to `grok` (`claude-vps-agent` -> `grok-vps-agent`; a
name that does not fit the `<vendor>-<host>-agent` shape is prefixed with `grok-`).
So grok activity is distinguishable per runtime - and, in a shared multi-device
vault, per device - rather than logged under the shared identity. Both the MCP
env (`config.toml`) and the hooks file carry this same derived name.

## Importing grok sessions

grok stores each session as
`${GROK_HOME:-$HOME/.grok}/sessions/<encoded-cwd>/<id>/updates.jsonl` (an ACP
session-update stream). Import one session, or a directory of them, into the
Brain:

```bash
o2b brain import-session \
  ~/.grok/sessions/<encoded-cwd>/<session-id>/updates.jsonl \
  --vault /path/to/vault
```

Autodetect resolves the `grok` format; pass `--format grok` to force it. The
importer extracts `@osb` markers from messages and replays `brain_feedback`
tool calls (grok's `open-second-brain__brain_feedback` is normalized to the
bare name first).

## Verify

```bash
o2b install --check --target grok
```

Reports drift when the `config.toml` MCP tables or the hooks file differ from
canonical (for example after an Open Second Brain upgrade, or if `bun`/the repo
moved - re-run apply to refresh the absolute paths).

## Uninstall

```bash
o2b uninstall --target grok --apply
```

Removes the two `[mcp_servers.*]` tables from `config.toml` and deletes the
hooks file. Unrelated grok configuration (other MCP servers, `[cli]`,
`[marketplace]`) is left intact.

## Relationship to the Claude Code integration

Grok reads Claude Code configuration for compatibility (MCP from
`~/.claude.json`, hooks from `~/.claude/settings.json`). An operator who already
runs the Open Second Brain Claude Code integration may see some of it picked up
that way. The native `grok` target exists so that operators who run only grok
get a first-class, in-session-working install, and so grok sessions import
**into** the Brain (no compatibility path covers that direction). The
integration uses grok's own `config.toml` and hooks dir - it does not write into
the `~/.claude/` namespace.

## Notes

- Verified against grok 0.2.45 and its bundled docs (`~/.grok/docs/user-guide/`).
- `GROK_HOME` overrides the `~/.grok` base directory; the adapter honors it.
- The absolute `bun`/repo paths are resolved at install time. If you move the
  Open Second Brain checkout or change the `bun` binary, re-run
  `o2b install --target grok --apply`.
- Rules: grok reads `AGENTS.md` and `CLAUDE.md` natively, so vault-level rules
  can travel as project instructions without any Open Second Brain involvement.
