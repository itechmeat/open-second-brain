# Open Second Brain after install

Open Second Brain works with any supported agent. Finish setup for your vault,
choose the agent identity that writes to it, and verify the connection.

## 1. Check the installation

```bash
o2b install --check
o2b brain doctor --vault /path/to/vault
```

The setup check verifies the host integration. Doctor reports vault and store
health.

## 2. Choose the dream agent and owner

Set the primary agent name when initializing Brain:

```bash
o2b brain init --vault /path/to/vault --primary-agent "<agent-name>"
```

The dream owner is one device and agent. Check the current owner with
`o2b dream owner`. To assign this device, run:

```bash
o2b dream owner --here --agent "<agent-name>"
```

Dream runs for its owner. Other devices can preview a pass and request a
transfer from the current owner.

## 3. Read the human view

Open the vault in Obsidian or another Markdown editor. `Brain/_BRAIN.md` links
to the generated views, active preferences, lessons, and recent activity.

## 4. Schedule optional maintenance

Dream starts through the configured owner flow. No scheduler entry is needed
for dream. For periodic reindexing or maintenance, print a recipe and choose a
scheduler for the host:

```bash
o2b brain maintenance run --vault /path/to/vault --cron-template
```

The recipe prints shell and systemd options. It does not install a schedule.

## Agent guides

- Hermes: [install/hermes.md](install/hermes.md)
- Claude Code: [install/claudecode.md](install/claudecode.md)
- Codex: [install/codex.md](install/codex.md)
- Cursor: [install/cursor.md](install/cursor.md)
- OpenClaw: [install/openclaw.md](install/openclaw.md)
- Other supported runtimes: [install.md](install.md)

## Uninstall

Review the detected integrations before removing local files:

```bash
o2b uninstall
```

Add `--apply-local` to remove the local Open Second Brain config directory.
Your vault and Markdown notes are kept.
