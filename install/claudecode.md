# Claude Code

Claude Code installs OSB through its marketplace subsystem. The
bundled `.mcp.json` auto-registers the MCP server so there is no
explicit `claude mcp add` step.

## 1. Install the plugin

```bash
claude plugin marketplace add itechmeat/open-second-brain
claude plugin install open-second-brain@open-second-brain
```

## 2. Publish the `o2b` CLI on PATH

Claude caches the plugin at a versioned path; locate the script:

```bash
O2B_SCRIPT="$(find ~/.claude/plugins/cache -path '*open-second-brain*/scripts/o2b' -type f 2>/dev/null | head -1)"
[ -n "$O2B_SCRIPT" ] || { echo "o2b installer not found in Claude plugin cache" >&2; exit 1; }
"$O2B_SCRIPT" install-cli
```

## 3. Initialize the vault

```bash
o2b init --vault /path/to/vault --name "My Second Brain" \
    --agent-name "<chosen-agent-name>" --timezone "<chosen-tz>"
o2b brain init --vault /path/to/vault
```

`o2b init` persists `vault`, `agent_name`, and `timezone` into
`~/.config/open-second-brain/config.yaml`. The auto-registered
`.mcp.json` calls `o2b mcp` with no flags; the server reads the
persisted config at spawn time.

## 4. Verify

```bash
o2b doctor --vault /path/to/vault --repo .
claude plugin list
claude mcp list
```

`claude mcp list` must show
`plugin:open-second-brain:open-second-brain` with `✓ Connected`.
Run the daily-identity check from `install/prerequisites.md`.

## Lifecycle hooks (auto-enabled)

The bundled `hooks/hooks.json` registers a `PostToolUse` hook
(matcher `Write|Edit|MultiEdit|apply_patch`). To watch the hook
fire end-to-end use
`--output-format=stream-json --verbose --include-hook-events`.

## Machine-enforce write protection (optional)

```bash
o2b brain protect --target claudecode --vault /path/to/vault --apply
o2b brain unprotect --target claudecode --vault /path/to/vault
```

The sidecar manifest at
`<vault>/.open-second-brain/protect.lock.json` records exactly the
`permissions.deny` / `permissions.allow` entries OSB owns.

## Update

```bash
claude plugin marketplace update open-second-brain
claude plugin update open-second-brain@open-second-brain
```

## Uninstall

```bash
claude plugin uninstall open-second-brain@open-second-brain
claude plugin marketplace remove open-second-brain
o2b uninstall --apply-local --remove-cli
```
