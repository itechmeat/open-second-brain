# Grok Build

`o2b install --target grok --apply` installs a native [Grok Build](https://docs.x.ai/build/overview)
plugin in one pass:

- **Plugin** - copies the bundled Open Second Brain plugin tree into
  `${GROK_HOME:-$HOME/.grok}/plugins/open-second-brain/` (`plugin.json`,
  `.mcp.json`, `hooks/hooks.json`). A user-scope plugin under
  `~/.grok/plugins/` is auto-enabled and auto-trusted, so grok loads its MCP
  servers and hooks with no `config.toml` change.

The plugin's `.mcp.json` and `hooks/hooks.json` are rendered from the same
sources as the Claude Code plugin, so the two never drift; grok sets
`CLAUDE_PLUGIN_ROOT` as an alias of `GROK_PLUGIN_ROOT` and reads the
Claude-shape hook JSON, so the hook commands run unchanged.

## Install

```bash
o2b install --target grok --apply
```

Start grok (or press `r` in the `/plugins` modal) to load the plugin. Confirm
it with `grok inspect` and `grok mcp doctor open-second-brain`.

## What the plugin provides

- **MCP servers** - `open-second-brain` and `open-second-brain-writer`, each
  launched as `o2b mcp` (resolved from `PATH`). They are vault-agnostic: `o2b`
  resolves the vault from the persisted Open Second Brain config, so one plugin
  serves any vault. grok namespaces the tools as
  `open-second-brain__<tool>` / `open-second-brain-writer__<tool>`.
- **Active context inject** - on `SessionStart`, the `o2b-hook active-inject`
  shim appends the rendered `Brain/active.md` digest so the agent sees live
  preferences without calling `brain_query` first.
- **Post-write reminder** - after a file-mutating tool (grok's
  `search_replace`, plus the Claude-style `Write` / `Edit` / `MultiEdit` /
  `apply_patch` aliases) the standard logging nudge is appended so the agent
  considers `brain_feedback` / `brain_apply_evidence` / `brain_note`.
- **Session capture and the stop-log guardrail** - the `Stop` / `SessionEnd`
  hooks capture the session and check that an artifact turn logged a Brain
  event, mirroring the Claude Code behavior.

Every hook is fail-soft: a missing vault or `o2b-hook` binary never breaks the
grok session.

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

Reports drift when an installed plugin file differs from the bundled version
(for example after an Open Second Brain upgrade - re-run apply to refresh it).

## Uninstall

```bash
o2b uninstall --target grok --apply
```

Removes the installed plugin tree and the now-empty plugin directory.
Unrelated grok configuration is untouched.

## Relationship to the Claude Code integration

Grok reads Claude Code configuration for compatibility: MCP servers from
`~/.claude.json`, hooks from `~/.claude/settings.json`, and plugins from
`.claude/plugins/`. An operator who already runs the Open Second Brain Claude
Code integration may see some of it picked up that way. The native `grok`
target exists so that:

- operators who run **only** grok (no `~/.claude`) get a first-class install;
- grok sessions are imported **into** the Brain (no compatibility path covers
  that direction);
- the plugin is a self-contained, marketplace-publishable unit.

## Notes

- Verified against grok 0.2.45 and its bundled docs
  (`~/.grok/docs/user-guide/`).
- `GROK_HOME` overrides the `~/.grok` base directory; the adapter honors it.
- Rules: grok reads `AGENTS.md` and `CLAUDE.md` natively, so vault-level rules
  can also travel as project instructions without any Open Second Brain
  involvement.
