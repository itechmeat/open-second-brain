# Generic (printout)

Use this target when your runtime is not in the per-runtime list
above. `o2b install --target generic` never edits any external
config; it prints the canonical MCP server payload and leaves the
operator to wire it into whatever the runtime expects.

## Print to stdout

```bash
o2b install --target generic --apply --out -
```

Default format is JSON:

```json
{
  "mcpServers": {
    "open-second-brain": {
      "command": "o2b",
      "args": ["mcp", "--vault", "/path/to/vault"],
      "env": { "VAULT_AGENT_NAME": "...", "VAULT_TIMEZONE": "..." }
    },
    "open-second-brain-writer": {
      "command": "o2b",
      "args": ["mcp", "--writer-only", "--vault", "/path/to/vault"]
    }
  }
}
```

YAML is also available:

```bash
o2b install --target generic --apply --out - --format yaml
```

## Write to a file

```bash
o2b install --target generic --apply --out /path/to/snippet.json
```

The path is recorded in the sidecar manifest so `o2b install
--check --target generic` can confirm the file still exists.
`o2b uninstall --target generic --apply` will _not_ delete the
file — the consuming runtime may still depend on it. The
uninstall step prints the path so the operator can clean it up by
hand.

## Notes

- Detection always reports `not-installed` (there is no canonical
  config to probe for this target).
- The `generic` target is the right escape hatch when a new
  runtime appears between OSB releases. Per-runtime adapters land
  in subsequent releases as needed.
