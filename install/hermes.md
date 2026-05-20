# Hermes

Hermes installs OSB through its native plugin / MCP machinery,
not through `o2b install --target hermes`. The flow below assumes
a working Hermes Agent with `hermes` on PATH.

## 1. Install the plugin

```bash
hermes plugins install itechmeat/open-second-brain --enable
hermes gateway restart
```

Or paste `https://github.com/itechmeat/open-second-brain` into the
Hermes Dashboard → Plugins → Install from GitHub URL. Do not pin
a tag — the CLI resolves to the latest released version on its
own.

## 2. Publish the `o2b` CLI on PATH

```bash
~/.hermes/plugins/open-second-brain/scripts/o2b install-cli
```

Creates symlinks for `o2b`, `vault-log`, and `o2b-hook` in
`~/.local/bin`. Survives `hermes plugins update`.

## 3. Initialize the vault

```bash
o2b init --vault /path/to/vault --name "My Second Brain" \
    --agent-name "<chosen-agent-name>" --timezone "<chosen-tz>"
o2b brain init --vault /path/to/vault \
    --primary-agent "<chosen-agent-name>"
```

`--primary-agent` declares this Hermes install as the vault's
dream-running host. Multi-device setups (Syncthing) benefit from
a single dream-runner.

## 4. Register the MCP server

Edit `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  open-second-brain:
    command: o2b
    args: [mcp, --vault, /path/to/vault]
    env:
      VAULT_AGENT_NAME: <chosen-agent-name>
    enabled: true
```

Then restart the gateway:

```bash
hermes gateway restart
```

## 5. Verify

```bash
o2b doctor --vault /path/to/vault --repo .
```

Run the daily-identity check described in `install/prerequisites.md`.

## Update

```bash
hermes plugins update open-second-brain
hermes gateway restart
o2b doctor --vault /path/to/vault --repo .
```

## Uninstall

```bash
hermes mcp remove open-second-brain
o2b uninstall --apply-local --remove-cli
hermes plugins remove open-second-brain
hermes gateway restart
```

The vault and its Markdown files are never deleted.
