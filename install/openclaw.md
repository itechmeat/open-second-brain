# OpenClaw

OpenClaw installs OSB through its native plugin system. Tools are
registered by the bundled JS plugin entry, not via a separate MCP
server.

## 1. Install the plugin

From Git:

```bash
openclaw plugins install git:github.com/itechmeat/open-second-brain
```

Or from a local checkout:

```bash
openclaw plugins install ./open-second-brain
```

Then:

```bash
openclaw gateway restart
```

## 2. Publish the `o2b` CLI on PATH

Run from the plugin checkout directory:

```bash
./scripts/o2b install-cli
```

If you don't know the checkout path, the absolute-path variant works
from anywhere (OpenClaw stores installed plugins under `~/.openclaw/`
by default):

```bash
"$(find ~/.openclaw -path '*open-second-brain*/scripts/o2b' -type f 2>/dev/null | head -1)" install-cli
```

## 3. Initialize the vault

```bash
o2b init --vault /path/to/vault --name "My Second Brain" \
    --agent-name "<chosen-agent-name>" --timezone "<chosen-tz>"
o2b brain init --vault /path/to/vault
```

## 4. Configure vault path, agent name, timezone

OpenClaw reads from its own per-plugin config store:

```bash
openclaw config set plugins.entries.open-second-brain.config.vault '"/path/to/vault"'
openclaw config set plugins.entries.open-second-brain.config.instanceName '"My Second Brain"'
openclaw config set plugins.entries.open-second-brain.config.agentName '"<chosen-agent-name>"'
openclaw config set plugins.entries.open-second-brain.config.timezone '"<chosen-tz>"'
```

The values are stored as JSON, so string values must be valid JSON
(hence the inner double quotes). The outer single quotes are shell
escaping so bash does not consume the doubles. That's why the
arguments look like `'"...".`

The configured `agentName` is the operator base name; OpenClaw does not log
under it verbatim. The per-turn identity reminder derives an
**openclaw-specific identity** from it: the host segment is kept and the vendor
token is swapped to `openclaw` (`claude-vps-agent` -> `openclaw-vps-agent`; a
name outside the `<vendor>-<host>-agent` shape is prefixed with `openclaw-`).
So OpenClaw activity is distinguishable per runtime - and, in a shared
multi-device vault, per device.

## 5. Verify

```bash
o2b doctor --vault /path/to/vault --repo .
openclaw plugins inspect open-second-brain --runtime --json
```

Run the daily-identity check from `install/prerequisites.md`.

## Update

```bash
openclaw plugins update open-second-brain
openclaw gateway restart
```

## Uninstall

```bash
openclaw plugins uninstall open-second-brain
openclaw gateway restart
o2b uninstall --apply-local --remove-cli
```
