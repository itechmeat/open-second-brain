# open-second-brain — Agent Installation Guide

> **Version 0.6.0**
> Repository: https://github.com/itechmeat/open-second-brain

This guide is written for an **AI agent**, not a human. It contains the exact commands and decision logic needed to install and configure the **open-second-brain** plugin autonomously. Follow exactly one of the branches below based on the target runtime (Hermes, OpenClaw, Codex, or Claude). Complete every step in the chosen branch.

If at any point you are missing information — for example, the vault path is unknown, a required tool is not installed, or the runtime version is unclear — stop and ask the user for clarification. Offer concrete options where possible (e.g. suggest a default vault path, list supported Python versions, or propose an alternative runtime).

---

## Branch A — Hermes

### 1. Install the plugin

```bash
hermes plugins install itechmeat/open-second-brain --enable
```

Alternatively, use the Hermes Dashboard: open **Plugins → Install from GitHub URL** and paste:

```
https://github.com/itechmeat/open-second-brain
```

After install, restart the gateway:

```bash
hermes gateway restart
```

### 2. Publish CLI commands to PATH

`hermes plugins install` clones the repository but does not pip-install the package, so the `o2b` and `vault-log` commands are not on PATH yet. Run this step to create symlinks:

```bash
~/.hermes/plugins/open-second-brain/scripts/o2b install-cli
```

This creates symlinks in `~/.local/bin` pointing to `scripts/o2b` and `scripts/vault-log` inside the plugin checkout. The symlinks survive `hermes plugins update` because they point into the git-managed checkout.

After this step, the bare commands `o2b` and `vault-log` will be available on PATH.

### 3. Choose Daily log agent name

Ask the user to choose the agent name used in Daily event log entries.
Offer these defaults plus a custom value:

- `hermes-main`
- `hermes-vps-agent`
- `hermes-server`
- `second-brain-agent`
- `<hostname>-hermes`

Resolve `<hostname>` from `hostname` on the target system before showing the
list (e.g. `vps-techmeat-hermes`).

Explain that this name appears in `Daily/*.md` as

```
- HH:MM — @agent-name — event message
```

Do not continue until the value is known. Pass it as `--agent-name` to
`o2b init` in the next step.

### 4. Initialize the vault

Replace `/path/to/vault` and `<chosen-agent-name>` with the actual values.

```bash
o2b init --vault /path/to/vault --name "My Second Brain" --agent-name "<chosen-agent-name>"
```

`--agent-name` writes the chosen name into `AI Wiki/identity/agents.md` and
removes the template placeholder.

### 5. Register the MCP server

```bash
hermes mcp add open-second-brain --command o2b --args mcp --vault /path/to/vault
hermes gateway restart
```

Set the agent name in the environment passed to the MCP server so
`event_log_append` can default to it when no explicit `agent` argument is
given. The simplest way is to add `VAULT_AGENT_NAME=<chosen-agent-name>` to
the gateway environment (or to the MCP server entry in
`~/.hermes/config.yaml`).

### 6. Verify the installation

```bash
o2b doctor --vault /path/to/vault --repo .
```

All checks must pass. If any check fails, report the failure output to the
user before continuing.

Then run the **daily identity** check (see § Verification — daily identity
below). Installation is incomplete until that check passes.

### 7. Update

```bash
hermes plugins update open-second-brain
hermes gateway restart
o2b doctor --vault /path/to/vault --repo .
```

The CLI symlinks created in step 2 do not need to be recreated after an update — they point into the git checkout, which `hermes plugins update` refreshes via `git pull`.

### 8. Uninstall

Run in this order:

```bash
# Step 1 — dry-run review
o2b uninstall

# Step 2 — deregister MCP, clean up CLI symlinks, remove plugin
hermes mcp remove open-second-brain
o2b uninstall --apply-local --remove-cli
hermes plugins remove open-second-brain
hermes gateway restart
```

The vault and its Markdown files are never deleted by the uninstall process.

---

## Branch B — OpenClaw

### 1. Install the plugin

From Git (pin to a version tag):

```bash
openclaw plugins install git:github.com/itechmeat/open-second-brain@v0.6.0
```

Or from a local checkout:

```bash
openclaw plugins install ./open-second-brain
```

After install, restart the gateway:

```bash
openclaw gateway restart
```

### 2. Publish CLI commands to PATH

The `o2b` and `vault-log` commands are not on PATH after OpenClaw plugin
install. Run this step to create symlinks:

```bash
./scripts/o2b install-cli
```

This creates symlinks in `~/.local/bin`. After this, bare `o2b` and
`vault-log` work on PATH.

### 3. Choose Daily log agent name

Ask the user to choose the agent name used in Daily event log entries.
Offer these defaults plus a custom value:

- `openclaw-main`
- `openclaw-server`
- `server-agent`
- `second-brain-agent`
- `<hostname>-openclaw`

Resolve `<hostname>` from `hostname` on the target system before showing the
list (e.g. `vps-techmeat-openclaw`).

Explain that this name appears in `Daily/*.md` as

```
- HH:MM — @agent-name — event message
```

Do not continue until the value is known. The chosen name is stored in the
plugin config in step 5 as `agentName` and is written into
`AI Wiki/identity/agents.md` by `o2b init` in step 4.

### 4. Initialize the vault

Replace `/path/to/vault` and `<chosen-agent-name>` with the actual values.

```bash
o2b init --vault /path/to/vault --name "My Second Brain" --agent-name "<chosen-agent-name>"
```

### 5. Configure the vault path and agent name

Tools are registered natively by the JS plugin entry — no MCP registration
is needed. Set the vault path, instance name, and agent name in the
OpenClaw plugin config:

```bash
openclaw config set plugins.entries.open-second-brain.config.vault '"/path/to/vault"'
openclaw config set plugins.entries.open-second-brain.config.instanceName '"My Second Brain"'
openclaw config set plugins.entries.open-second-brain.config.agentName '"<chosen-agent-name>"'
```

The resulting plugin entry must contain `agentName` as a separate field
alongside `instanceName` (do not merge the two):

```json
{
  "enabled": true,
  "config": {
    "vault": "/path/to/vault",
    "instanceName": "My Second Brain",
    "agentName": "<chosen-agent-name>",
    "mcpEnabled": false
  }
}
```

### 6. Verify the installation

```bash
o2b doctor --vault /path/to/vault --repo .
openclaw plugins inspect open-second-brain --runtime --json
```

Both commands must succeed. If any check fails, report the failure output
to the user before continuing.

Then run the **daily identity** check (see § Verification — daily identity
below). Installation is incomplete until that check passes.

### 7. Update

```bash
openclaw plugins update open-second-brain
openclaw gateway restart
o2b doctor --vault /path/to/vault --repo .
```

The CLI symlinks created in step 2 do not need to be recreated after an update.

### 8. Uninstall

```bash
openclaw plugins uninstall open-second-brain
openclaw gateway restart
```

Optionally remove the local config directory and CLI symlinks:

```bash
o2b uninstall --apply-local --remove-cli
```

The vault and its Markdown files are never deleted by the uninstall process.

---

## Branch C — Codex

### 1. Install the plugin

Codex consumes the bundled `.codex-plugin/plugin.json` manifest. Install
the plugin from Git through the Codex CLI:

```bash
codex plugins install git:github.com/itechmeat/open-second-brain@v0.6.0
```

### 2. Publish CLI commands to PATH

```bash
./scripts/o2b install-cli
```

### 3. Choose Daily log agent name

Ask the user to choose the agent name used in Daily event log entries.
Offer these defaults plus a custom value:

- `codex-main`
- `codex-vps-agent`
- `codex-server`
- `second-brain-agent`
- `<hostname>-codex`

Resolve `<hostname>` from `hostname` on the target system before showing
the list. Explain that this name appears in `Daily/*.md` as
`- HH:MM — @agent-name — event message`. Do not continue until the value
is known.

### 4. Initialize the vault

```bash
o2b init --vault /path/to/vault --name "My Second Brain" --agent-name "<chosen-agent-name>"
```

### 5. Wire up the agent name for the Codex runtime

Codex consumes Open Second Brain through the optional MCP stdio server.
Export `VAULT_AGENT_NAME=<chosen-agent-name>` in the environment that
launches the MCP server so `event_log_append` defaults to that name when
called without an explicit `agent` argument.

A minimal Codex `mcp_servers` entry:

```yaml
mcp_servers:
  open-second-brain:
    command: o2b
    args: ["mcp", "--vault", "/path/to/vault"]
    env:
      VAULT_AGENT_NAME: "<chosen-agent-name>"
```

### 6. Verify the installation

```bash
o2b doctor --vault /path/to/vault --repo .
```

Then run the **daily identity** check (see § Verification — daily identity
below). Installation is incomplete until that check passes.

### 7. Update

```bash
codex plugins update open-second-brain
```

The CLI symlinks created in step 2 do not need to be recreated after an
update — they point into the git checkout, which the plugin updater
refreshes.

### 8. Uninstall

```bash
codex plugins uninstall open-second-brain
o2b uninstall --apply-local --remove-cli
```

The vault and its Markdown files are never deleted by the uninstall process.

---

## Branch D — Claude Code

### 1. Install the plugin

Claude Code consumes the bundled `.claude-plugin/plugin.json` manifest.
Install the plugin from Git:

```bash
claude plugins install git:github.com/itechmeat/open-second-brain@v0.6.0
```

### 2. Publish CLI commands to PATH

```bash
./scripts/o2b install-cli
```

### 3. Choose Daily log agent name

Ask the user to choose the agent name used in Daily event log entries.
Offer these defaults plus a custom value:

- `claude-main`
- `claude-vps-agent`
- `claude-server`
- `second-brain-agent`
- `<hostname>-claude`

Resolve `<hostname>` from `hostname` on the target system before showing
the list. Explain that this name appears in `Daily/*.md` as
`- HH:MM — @agent-name — event message`. Do not continue until the value
is known.

### 4. Initialize the vault

```bash
o2b init --vault /path/to/vault --name "My Second Brain" --agent-name "<chosen-agent-name>"
```

### 5. Wire up the agent name for the Claude runtime

Claude Code talks to Open Second Brain over the optional MCP stdio server.
Export `VAULT_AGENT_NAME=<chosen-agent-name>` in the environment that
launches the MCP server so `event_log_append` defaults to that name when
called without an explicit `agent` argument.

A minimal Claude Code `mcp_servers` entry:

```yaml
mcp_servers:
  open-second-brain:
    command: o2b
    args: ["mcp", "--vault", "/path/to/vault"]
    env:
      VAULT_AGENT_NAME: "<chosen-agent-name>"
```

### 6. Verify the installation

```bash
o2b doctor --vault /path/to/vault --repo .
```

Then run the **daily identity** check (see § Verification — daily identity
below). Installation is incomplete until that check passes.

### 7. Update

```bash
claude plugins update open-second-brain
```

The CLI symlinks created in step 2 do not need to be recreated after an
update — they point into the git checkout, which the plugin updater
refreshes.

### 8. Uninstall

```bash
claude plugins uninstall open-second-brain
o2b uninstall --apply-local --remove-cli
```

The vault and its Markdown files are never deleted by the uninstall process.

---

## Verification — daily identity

`o2b doctor` and `vault_health` confirm that the vault is structurally
valid, but they do not verify that the agent will write under the chosen
identity. Run this extra check after every install:

1. Call `event_log_append` **without** an explicit `agent` argument.
   Through the MCP server:

   ```bash
   o2b tool-call event_log_append --vault /path/to/vault \
       --tool-arg message="install verification"
   ```

2. Open the daily note that was just written:

   ```
   /path/to/vault/Daily/YYYY.MM.DD.md
   ```

3. The newest entry must show `@<chosen-agent-name>`, **not** the
   `@agent` placeholder. Example:

   ```
   - 14:32 — @openclaw-main — install verification
   ```

4. If `@agent` appears instead, stop and report the install as
   **incomplete**: the runtime did not pick up the configured `agentName`.
   Re-check step 5 of the chosen branch (plugin config or MCP env).

---

## Installation readiness criteria

The installation is complete **only** when **all** of the following hold:

- [ ] plugin installed;
- [ ] gateway restarted;
- [ ] plugin runtime status is `loaded`;
- [ ] all tools registered;
- [ ] vault initialized (`o2b init` succeeded);
- [ ] `vault_health` (or `o2b doctor`) reports OK;
- [ ] for OpenClaw: `plugins.entries.open-second-brain.config.agentName` is
      set to the chosen name;
- [ ] for Hermes / Codex / Claude: `VAULT_AGENT_NAME` is exported in the
      environment that launches the MCP server;
- [ ] `AI Wiki/identity/agents.md` contains the chosen agent name and no
      longer contains the `(add your agents here, …)` template
      placeholder;
- [ ] `event_log_append` called **without** an explicit `agent` argument
      writes a `Daily/*.md` entry under the chosen name (see Verification
      — daily identity above), not under `@agent`.

If any single item is missing, the install is **incomplete** — report
that to the user and do not mark the workflow as successful.
