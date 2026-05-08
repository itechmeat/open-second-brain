# Open Second Brain — after install

Thanks for installing Open Second Brain. The plugin is now on disk; finish
the setup with the steps below.

## 1. Publish CLI commands to PATH

`hermes plugins install` clones the repository but does not pip-install it,
so the `o2b` and `vault-log` commands are not on PATH yet. Create symlinks:

```bash
~/.hermes/plugins/open-second-brain/scripts/o2b install-cli
```

This creates symlinks in `~/.local/bin` pointing to the wrapper scripts inside
the plugin checkout. The symlinks survive `hermes plugins update` because they
point into the git-managed checkout. After this step, `o2b` and `vault-log`
will be available as bare commands.

## 2. Initialise a vault

Pick (or create) the Obsidian-compatible folder you want as your second
brain, then bootstrap the agent-owned files:

```bash
o2b init --vault /path/to/vault --name "My Second Brain"
o2b doctor --vault /path/to/vault --repo .
```

`o2b doctor` should print `[OK]` for every check.

## 3. Register the MCP server (optional but recommended)

Open Second Brain ships an optional stdio MCP server. Register it with
Hermes so the deterministic tools are routable:

```bash
hermes mcp add open-second-brain --command o2b --args mcp --vault /path/to/vault
hermes gateway restart
```

`--args` is a single flag whose value is the remaining tokens on the line
(here: `mcp --vault /path/to/vault`). Hermes hands those tokens to the MCP
server's command line as-is. Do not wrap all of those arguments into one
quoted shell string, and do not repeat `--args` per token — both forms make
Hermes pass a single concatenated argument to the MCP server. Edit
`~/.hermes/config.yaml` instead if you prefer YAML.

The CLI works on its own; the MCP server is opt-in. See `docs/mcp.md` for
tool schemas, per-tool arguments, and Claude Code / Codex notes.

## 4. Updating

```bash
hermes plugins update open-second-brain
hermes gateway restart
```

`hermes plugins update` runs `git pull` inside the plugin directory. Your
MCP registration in `~/.hermes/config.yaml` is preserved across updates.
The CLI symlinks do not need to be recreated — they point into the same
checkout that gets updated.

## 5. Uninstalling

Run a dry-run first to see exactly what will happen and which Hermes
commands you need to run:

```bash
o2b uninstall
```

Then deregister the MCP server, clean up the CLI symlinks, and remove the plugin:

```bash
hermes mcp remove open-second-brain
o2b uninstall --apply-local --remove-cli
hermes plugins remove open-second-brain
hermes gateway restart
```

> **Order matters:** run `o2b uninstall --remove-cli` *before* `hermes plugins remove`,
> because the plugin directory (and its `scripts/o2b`) must still exist for the symlink
> removal to verify its targets.

`--apply-local` removes the machine-local config directory
(`~/.config/open-second-brain`). `--remove-cli` removes the `o2b` and
`vault-log` symlinks from `~/.local/bin`.

Your vault, `Daily/`, `AI Wiki/`, and Markdown notes are never removed by
Open Second Brain — delete them yourself with normal filesystem tools if
that is what you want.

## More

- `README.md` — full feature description and CLI reference.
- `docs/mcp.md` — MCP tool server, registration, update/remove flows.
- `docs/architecture.md` — config model, vault layout, security rules.

## OpenClaw

If you are using OpenClaw instead of (or in addition to) Hermes, the plugin
is now installed as a **native OpenClaw plugin**. Tools are registered
automatically by the JS entry (`openclaw/index.js`) — no MCP server setup is
required.

The `package.json` at the project root declares `openclaw.extensions` pointing
to the JS entry. The `openclaw.plugin.json` manifest provides static discovery
metadata (plugin ID, configuration schema, declared tool names).

To configure the vault path:

```bash
openclaw config set plugins.entries.open-second-brain.config.vault '"/path/to/vault"'
openclaw config set plugins.entries.open-second-brain.config.instanceName '"My Second Brain"'
```

Run the doctor to verify the OpenClaw manifest and packaging are valid:

```bash
o2b doctor --vault /path/to/vault --repo .
```

The doctor output should include `[OK] openclaw_manifest`, `[OK] openclaw_package_json`, and `[OK] openclaw_package_json_extensions`.

If you want to also expose an MCP stdio server (e.g. for another runtime),
the `o2b mcp` command is still available:

```bash
o2b mcp --vault /path/to/vault
```
