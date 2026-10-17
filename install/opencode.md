# opencode

`o2b install --target opencode --apply` performs a native integration
in one pass:

1. **MCP servers** - merges the two Open Second Brain servers
   (`open-second-brain`, `open-second-brain-writer`) into the opencode
   config (`${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json`,
   or `opencode.jsonc` when that is the only config file present),
   using opencode's entry schema (`{"type": "local", "command": [...],
   "environment": {...}, "enabled": true}`; at the native V2
   `mcp.servers` shape the entry instead carries `"disabled": false`,
   since V2 replaces the `enabled` field with `disabled`).
   User-authored entries are preserved. Since v1.83.0 the entry lands
   under the native V2 `mcp.servers` key when the config already
   carries that object; everything else keeps the legacy top-level
   `mcp` key (see [Config shape](#config-shape-since-v1830)). A
   `.jsonc` config is edited through a comment-preserving editor, so
   operator comments survive byte for byte.
2. **Plugin** - copies the bundled Open Second Brain plugin into
   `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/open-second-brain.ts`.
   opencode auto-loads it at startup.
3. **Legacy cleanup** - releases before v1.4.0 wrote
   `~/.config/opencode/mcp.json`, a file opencode never reads. Apply
   removes the two Open Second Brain keys from it (and deletes the file
   when nothing else remains).

## Install

```bash
o2b install --target opencode --apply --yes
```

Restart `opencode` to load the MCP servers and the plugin.

The bundled plugin supports OpenCode V1 1.18.29+ and V2 from the same
installed file: V1 calls `server()` and V2 calls `setup()`. Older V1
releases do not support the shared object entrypoint. `--check` verifies
the installed files and MCP configuration, not whether the running host
loaded the plugin; on V2, check its state with `opencode api get /api/plugin`.

opencode's Brain writes attribute to an **opencode-specific identity** derived
from your configured `agent_name`: the host segment is kept and the vendor
token is swapped to `opencode` (`claude-vps-agent` -> `opencode-vps-agent`; a
name that does not fit the `<vendor>-<host>-agent` shape is prefixed with
`opencode-`). So opencode activity is distinguishable per runtime - and, in a
shared multi-device vault, per device - rather than logged under the shared
identity. `apply` stamps this on `VAULT_AGENT_NAME` in `opencode.json`; no
manual step is needed.

## Config shape (since v1.83.0)

OpenCode V2 hosts read the native `mcp.servers` shape and `.jsonc`
config files, and the adapter writes both without disturbing what is
already there. Which shape an install targets is a property of the
on-disk file, not of the host version: a config that carries an
`mcp.servers` object is written at the native path, and every other
config keeps the legacy top-level `mcp` key this integration has always
written. Apply and verify resolve the shape through the same rule, so a
fresh install never reports drift against itself.

- **File choice.** When only `opencode.jsonc` exists it is the config
  path, and edits preserve its comments and formatting byte for byte
  outside the changed entry (the editor splices at token offsets rather
  than re-serializing the file). When both files exist, or neither, the
  behavior is unchanged: `opencode.json` wins, and a fresh install
  still creates it - both host generations read it. With both files on
  disk, Open Second Brain services `opencode.json` alone and leaves
  `opencode.jsonc` untouched. Upstream does not document whether V2
  merges the two files or still reads the legacy top-level `mcp` key,
  so the install resolves the shape from the `.json` file alone and
  assumes that file is the one the host reads.
- **Legacy is never shadowed.** An existing healthy top-level
  registration is not migrated when `mcp.servers` appears: V2 hosts
  keep reading a legacy declaration, so migration would churn every
  install for zero benefit.
- **Uninstall is shape-aware.** The install manifest records the key
  each write actually used (`mcp.<name>` or `mcp.servers.<name>`), and
  uninstall removes exactly those keys - never user-authored entries -
  under either shape.
- **One-time drift on a shape change.** When an `mcp.servers` object
  appears in a config the adapter previously owned at the top level
  (typically the host writing its own object during an upgrade), the
  first `o2b install --check --target opencode` reports drift once, and
  the first re-apply is refused through the hand-edited-file guard.
  **Fix:** `o2b install --target opencode --apply --force --yes` (or
  `o2b update --force`). That re-apply registers the servers at the
  native path and cleans the shadowed legacy copies of its own two keys
  from the top-level block; user keys are never touched.

## What the plugin does

- **Active context inject** - appends the rendered `Brain/active.md`
  digest to the system prompt of each chat request (cached, 5 minute
  TTL), so the agent sees live preferences without calling
  `brain_query` first. Uses the same `o2b-hook active-inject` shim as
  the Claude Code and Codex hook layers; if the shim or the vault is
  missing the inject silently skips.
- **Session capture** - on `session.idle` / `session.compacted` /
  `session.deleted` (V1), or turn end / compaction / committed revert
  (V2: `session.execution.*`, `session.compaction.*`,
  `session.revert.committed`, `session.deleted`; opencode v2.0.24 emits
  the `execution` names, the v2 tree also still emits `session.idle`), the
  plugin snapshots the session as a JSONL spool
  under `${XDG_DATA_HOME:-$HOME/.local/share}/open-second-brain/opencode/`.
  Import captured sessions with:

  ```bash
  o2b brain import-session ~/.local/share/open-second-brain/opencode/ \
    --vault /path/to/vault
  ```

  V2 exposes only the active context to plugins, so snapshots merge
  across compactions. Its event subscription is live-only: a session
  already compacted before the plugin loads cannot recover older turns.
  Capture reconnects after a stream disconnect, but events missed during
  the gap cannot be replayed. Committed reverts remove the saved boundary
  and later messages; if the boundary was never captured, the spool is
  rebuilt from active context and older saved history is lost with a warning.

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

A successful check prints:

<!-- expected-output: o2b install --check --target opencode -->

```text
o2b install --check
--------------------
  opencode      ok                $HOME/.config/opencode/opencode.json: both OSB keys match the canonical payload (configuration comparison; no MCP handshake attempted)
```

`$HOME` stands in for your home directory. This block is asserted
against the adapter's real `verify()` output by
`tests/docs/install-verify-conformance.test.ts`, so it cannot drift
from the code.

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
- **V1 context inject rides an experimental hook**
  (`experimental.chat.system.transform`). V2 instead uses the session
  `context` hook. If a future V1 release changes the experimental hook,
  the inject degrades to no-op while capture and the MCP servers keep working.

## Notes

- Upstream is `anomalyco/opencode` (formerly hosted under
  `sst/opencode`); config schema verified against
  https://opencode.ai/docs 2026-06-10.
- Rules: opencode reads `AGENTS.md` natively, so vault-level rules can
  also travel as project instructions without any Open Second Brain
  involvement.
