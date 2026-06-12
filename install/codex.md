# Codex

Codex installs OSB through its marketplace + MCP subsystems.

## 1. Install the plugin

```bash
codex plugin marketplace add itechmeat/open-second-brain
```

Then enable it by adding to `~/.codex/config.toml`:

```toml
[plugins."open-second-brain@open-second-brain"]
enabled = true
```

## 2. Publish the `o2b` CLI on PATH

Codex caches the plugin at a version-hashed path; locate the
script:

```bash
O2B_SCRIPT="$(find ~/.codex -path '*open-second-brain*/scripts/o2b' -type f 2>/dev/null | head -1)"
[ -n "$O2B_SCRIPT" ] || { echo "o2b installer not found in Codex plugin cache" >&2; exit 1; }
"$O2B_SCRIPT" install-cli
```

## 3. Initialize the vault

```bash
o2b init --vault /path/to/vault --name "My Second Brain" \
    --agent-name "<chosen-agent-name>" --timezone "<chosen-tz>"
o2b brain init --vault /path/to/vault
```

## 4. Register the MCP server

```bash
codex mcp add open-second-brain \
    --env VAULT_AGENT_NAME=codex \
    --env VAULT_TIMEZONE=<chosen-tz> \
    -- o2b mcp --vault /path/to/vault
```

`VAULT_AGENT_NAME=codex` makes Codex attribute its Brain writes to its own
name (matching the `codex` session-import identity), rather than the shared
operator name - so Codex activity is distinguishable and never logs under
another runtime's identity.

## 5. Verify

```bash
o2b doctor --vault /path/to/vault --repo .
codex mcp list
```

Run the daily-identity check from `install/prerequisites.md`.

## Lifecycle hooks (auto-enabled)

The bundled `hooks/hooks.json` registers a `PostToolUse` hook
(matcher `Write|Edit|MultiEdit|apply_patch`) that invokes
`o2b-hook` from PATH after every file-mutating tool succeeds. Step
2 above wires it.

## Machine-enforce write protection (optional)

```bash
o2b brain protect --target codex --vault /path/to/vault --apply
o2b brain unprotect --target codex --vault /path/to/vault
```

The sidecar manifest at
`<vault>/.open-second-brain/protect.lock.json` records exactly
what was added; `unprotect` removes the same.

## Update

```bash
codex plugin marketplace upgrade open-second-brain
```

## Uninstall

```bash
codex mcp remove open-second-brain
codex plugin marketplace remove open-second-brain
o2b uninstall --apply-local --remove-cli
```
