# Cursor

`o2b install --target cursor --apply` writes the OSB MCP servers
into `~/.cursor/mcp.json` via JSON-merge. The two registered names
are `open-second-brain` (the **`catalog` two-pass surface** - see
"The tool surface Cursor gets" below) and `open-second-brain-writer`
(always-loaded writer / `brain_context` subset, five tools).

## The tool surface Cursor gets

Cursor sends at most the **first 40 tools** across every enabled MCP
server to the model; anything past that is unreachable and the host
says nothing about it. The full Open Second Brain surface advertises
110 tools, so registering it here would silently strand most of them.

The generated `open-second-brain` entry therefore carries
`--tool-profile catalog`:

```json
"open-second-brain": {
  "command": "o2b",
  "args": ["mcp", "--vault", "/path/to/vault", "--tool-profile", "catalog", "--host-target", "cursor"]
}
```

`catalog` **advertises 7 tools** and keeps every one of the 110
registered verbs callable through `tool_hydrate`, which fetches a
verb's schema on demand. Nothing is withheld - the surface is narrowed,
not truncated - and `second_brain_capabilities` reports the ceiling
this server runs under, its published source, and whether the
advertised count fits inside it.

`--host-target cursor` is what lets the running server name that
ceiling; it carries no other behaviour.

To choose a different profile, set `install.tool_profile` in
`<vault>/Brain/_brain.yaml` (travels with the vault, and outranks the
machine-local `mcp_tool_profile` key), then re-apply. Raising it back to
`full` re-exposes the 110-tool surface **and the silent 40-tool cut**
that goes with it.

`OPEN_SECOND_BRAIN_MCP_TOOL_PROFILE` deliberately does not reach the
written registration. What `--apply` writes is verified by
re-construction, so every input has to survive to the next invocation:
a committed file and a machine-local file do, a shell variable does not,
and a registration fed by one would report drift against itself. The
variable still selects the surface of a server you start yourself.

## Prerequisites

See `install/prerequisites.md`. Then run `o2b init --vault <path>
--agent-name <name> --timezone <tz>` to persist identity that the
MCP servers will pick up at spawn time.

## Install

```bash
o2b install --target cursor --apply
```

This preserves any pre-existing `mcpServers.*` keys; only
`mcpServers.open-second-brain` and `mcpServers.open-second-brain-writer`
are owned by OSB.

After install, **restart the Cursor app** for the new MCP servers
to load. `o2b install --check --target cursor` confirms the file
state regardless of whether Cursor has reloaded yet.

## Verify

```bash
o2b install --check --target cursor
```

A successful check prints:

<!-- expected-output: o2b install --check --target cursor -->

```text
o2b install --check
--------------------
  cursor        ok                $HOME/.cursor/mcp.json: both OSB keys match the canonical payload (configuration comparison; no MCP handshake attempted)
```

`$HOME` stands in for your home directory. This block is asserted
against the adapter's real `verify()` output by
`tests/docs/install-verify-conformance.test.ts`, so it cannot drift
from the code.

## Uninstall

```bash
o2b uninstall --target cursor --apply
```

Removes exactly the two OSB keys from `mcpServers` (the sidecar
manifest at `<vault>/.open-second-brain/install.lock.json` records
which keys to remove). User-authored entries stay intact.

## Notes

- `--scope project` (writing into `<cwd>/.cursor/mcp.json`) is
  deferred to a follow-up release. v0.10.11 always targets the
  user-scope path.
- An install written before the profile existed reports `drift` on the
  next `--check`: its `args` carry no `--tool-profile`. Re-run
  `o2b install --target cursor --apply` to regenerate it.
- If a previous OSB version wrote to `.cursor/mcp.json` without
  recording a manifest entry, use
  `o2b uninstall --target cursor --apply --force-from-snippet`
  for a one-time cleanup.
