# opencode

`o2b install --target opencode --apply` performs a native integration
in one pass:

1. **MCP servers** - merges the two Open Second Brain servers
   (`open-second-brain`, `open-second-brain-writer`) into
   `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json` under the
   `mcp` key, using opencode's entry schema
   (`{"type": "local", "command": [...], "environment": {...},
   "enabled": true}`). User-authored entries are preserved.
2. **Plugin** - copies the bundled Open Second Brain plugin into
   `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/open-second-brain.ts`.
   opencode auto-loads it at startup.
3. **Legacy cleanup** - releases before v1.4.0 wrote
   `~/.config/opencode/mcp.json`, a file opencode never reads. Apply
   removes the two Open Second Brain keys from it (and deletes the file
   when nothing else remains).

## Install

```bash
o2b install --target opencode --apply
```

Restart `opencode` to load the MCP servers and the plugin.

## What the plugin does

- **Active context inject** - appends the rendered `Brain/active.md`
  digest to the system prompt of each chat request (cached, 5 minute
  TTL), so the agent sees live preferences without calling
  `brain_query` first. Uses the same `o2b-hook active-inject` shim as
  the Claude Code and Codex hook layers; if the shim or the vault is
  missing the inject silently skips.
- **Session capture** - on `session.idle` / `session.compacted` /
  `session.deleted` the plugin snapshots the session as a JSONL spool
  under `${XDG_DATA_HOME:-$HOME/.local/share}/open-second-brain/opencode/`.
  Import captured sessions with:

  ```bash
  o2b brain import-session ~/.local/share/open-second-brain/opencode/ \
    --vault /path/to/vault
  ```

- **Post-write reminder** - after file-mutating tools (`write`,
  `edit`, `multiedit`, `patch`, `apply_patch`) the standard logging
  nudge is appended to the tool output so the agent considers
  `brain_feedback` / `brain_apply_evidence` / `brain_note` before its
  final reply.

Every plugin hook is fail-soft: a missing vault, missing `o2b-hook`
binary, or SDK error never breaks the opencode session.

## Verify

```bash
o2b install --check --target opencode
```

Reports drift when the MCP entries differ from canonical or the
installed plugin copy differs from the bundled version (for example
after an Open Second Brain upgrade - re-run apply to refresh it).

## Uninstall

```bash
o2b uninstall --target opencode --apply
```

Removes the two `mcp` keys from `opencode.json` and deletes the
installed plugin file. User-authored config is untouched.

## Known gaps relative to Claude Code / Codex

- **No stop-log guardrail.** opencode exposes no blocking stop hook,
  so the guardrail that vetoes an unlogged artifact turn cannot be
  reproduced; the post-write reminder still fires.
- **Context inject rides an experimental hook**
  (`experimental.chat.system.transform`). If a future opencode release
  changes it, the inject degrades to no-op while capture and the MCP
  servers keep working.

## Notes

- Upstream is `anomalyco/opencode` (formerly hosted under
  `sst/opencode`); config schema verified against
  https://opencode.ai/docs 2026-06-10.
- Rules: opencode reads `AGENTS.md` natively, so vault-level rules can
  also travel as project instructions without any Open Second Brain
  involvement.
