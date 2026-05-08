# open-second-brain — Agent Installation Guide

> **Version 0.5.5**
> Repository: https://github.com/itechmeat/open-second-brain

This guide is written for an **AI agent**, not a human. It contains the exact commands and decision logic needed to install and configure the **open-second-brain** plugin autonomously. Follow exactly one of the two branches below based on the target runtime (Hermes or OpenClaw). Complete every step in the chosen branch.

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

### 3. Initialize the vault

Replace `/path/to/vault` with the actual vault path.

```bash
o2b init --vault /path/to/vault --name "My Second Brain"
```

### 4. Register the MCP server

```bash
hermes mcp add open-second-brain --command o2b --args mcp --vault /path/to/vault
hermes gateway restart
```

### 5. Verify the installation

```bash
o2b doctor --vault /path/to/vault --repo .
```

All checks must pass. If any check fails, report the failure output to the user before continuing.

### 6. Update

```bash
hermes plugins update open-second-brain
hermes gateway restart
o2b doctor --vault /path/to/vault --repo .
```

The CLI symlinks created in step 2 do not need to be recreated after an update — they point into the git checkout, which `hermes plugins update` refreshes via `git pull`.

### 7. Uninstall

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
openclaw plugins install git:github.com/itechmeat/open-second-brain@v0.5.5
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

### 3. Initialize the vault

Replace `/path/to/vault` with the actual vault path.

```bash
o2b init --vault /path/to/vault --name "My Second Brain"
```

### 4. Configure the vault path

Tools are registered natively by the JS plugin entry — no MCP registration is needed. Set the vault path in the OpenClaw plugin config:

```bash
openclaw config set plugins.entries.open-second-brain.config.vault '"/path/to/vault"'
openclaw config set plugins.entries.open-second-brain.config.instanceName '"My Second Brain"'
```

### 5. Verify the installation

```bash
o2b doctor --vault /path/to/vault --repo .
openclaw plugins inspect open-second-brain --runtime --json
```

Both commands must succeed. If any check fails, report the failure output to the user before continuing.

### 6. Update

```bash
openclaw plugins update open-second-brain
openclaw gateway restart
o2b doctor --vault /path/to/vault --repo .
```

The CLI symlinks created in step 2 do not need to be recreated after an update.

### 7. Uninstall

```bash
openclaw plugins uninstall open-second-brain
openclaw gateway restart
```

Optionally remove the local config directory and CLI symlinks:

```bash
o2b uninstall --apply-local --remove-cli
```

The vault and its Markdown files are never deleted by the uninstall process.
