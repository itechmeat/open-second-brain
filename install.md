# open-second-brain — Agent Installation Guide

> **Version 0.5.2**
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

### 2. Initialize the vault

Replace `/path/to/vault` with the actual vault path.

```bash
o2b init --vault /path/to/vault --name "My Second Brain"
```

### 3. Register the MCP server

```bash
hermes mcp add open-second-brain --command o2b --args mcp --vault /path/to/vault
hermes gateway restart
```

### 4. Verify the installation

```bash
o2b doctor --vault /path/to/vault --repo .
```

All checks must pass. If any check fails, report the failure output to the user before continuing.

### 5. Update

```bash
hermes plugins update open-second-brain
hermes gateway restart
o2b doctor --vault /path/to/vault --repo .
```

### 6. Uninstall

Run in this order:

```bash
# Step 1 — dry-run review
o2b uninstall

# Step 2 — deregister MCP and remove plugin
hermes mcp remove open-second-brain
hermes plugins remove open-second-brain
hermes gateway restart

# Step 3 — optionally remove local config directory
o2b uninstall --apply-local
```

The vault and its Markdown files are never deleted by the uninstall process.

---

## Branch B — OpenClaw

### 1. Install the plugin

From Git (pin to a version tag):

```bash
openclaw plugins install git:github.com/itechmeat/open-second-brain@v0.5.4
```

Or from a local checkout:

```bash
openclaw plugins install ./open-second-brain
```

After install, restart the gateway:

```bash
openclaw gateway restart
```

### 2. Initialize the vault

Replace `/path/to/vault` with the actual vault path.

```bash
o2b init --vault /path/to/vault --name "My Second Brain"
```

### 3. Configure the vault path

Tools are registered natively by the JS plugin entry — no MCP registration is needed. Set the vault path in the OpenClaw plugin config:

```bash
openclaw config set plugins.entries.open-second-brain.config.vault '"/path/to/vault"'
openclaw config set plugins.entries.open-second-brain.config.instanceName '"My Second Brain"'
```

### 4. Verify the installation

```bash
o2b doctor --vault /path/to/vault --repo .
openclaw plugins inspect open-second-brain --runtime --json
```

Both commands must succeed. If any check fails, report the failure output to the user before continuing.

### 5. Update

```bash
openclaw plugins update open-second-brain
openclaw gateway restart
o2b doctor --vault /path/to/vault --repo .
```

### 6. Uninstall

```bash
openclaw plugins uninstall open-second-brain
openclaw gateway restart
```

Optionally remove the local config directory:

```bash
o2b uninstall --apply-local
```

The vault and its Markdown files are never deleted by the uninstall process.
