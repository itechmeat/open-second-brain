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

## 2. Choose a Daily log agent name

Pick the identity used in `Daily/*.md` for event log entries. Suggested
defaults (any can be replaced with a custom string):

- `hermes-main`, `hermes-vps-agent`, `hermes-server`
- `<hostname>-hermes` (substitute the real hostname)
- `second-brain-agent`

The chosen name appears in daily notes as
`- HH:MM — @agent-name — event message`. Pass it as `--agent-name` to
`o2b init` in the next step so it is written into
`AI Wiki/identity/agents.md` and replaces the template placeholder.

## 3. Initialise a vault

Pick (or create) the Obsidian-compatible folder you want as your second
brain, then bootstrap the agent-owned files:

```bash
o2b init --vault /path/to/vault --name "My Second Brain" --agent-name "<chosen-agent-name>"
o2b doctor --vault /path/to/vault --repo .
```

`o2b doctor` should print `[OK]` for every check.

## 4. Register the MCP server (optional but recommended)

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

Set `VAULT_AGENT_NAME=<chosen-agent-name>` in the environment that
launches the MCP server so `event_log_append` defaults to the chosen
name when called without an explicit `agent` argument.

The CLI works on its own; the MCP server is opt-in. See `docs/mcp.md` for
tool schemas, per-tool arguments, and Claude Code / Codex notes.

## 5. Verify the daily log identity

After registering the MCP server, run the **daily identity** check before
declaring the install complete:

1. Call `event_log_append` **without** an explicit `agent` argument:

   ```bash
   o2b tool-call event_log_append --vault /path/to/vault \
       --tool-arg message="install verification"
   ```

2. Open `/path/to/vault/Daily/YYYY.MM.DD.md` and confirm the newest entry
   shows `@<chosen-agent-name>`, **not** the `@agent` placeholder.
3. If `@agent` appears instead, the install is **incomplete**: the
   runtime did not pick up the agent name. Re-check that
   `VAULT_AGENT_NAME` is exported (Hermes / Codex / Claude) or that
   `plugins.entries.open-second-brain.config.agentName` is set
   (OpenClaw).

## 6. Updating

```bash
hermes plugins update open-second-brain
hermes gateway restart
```

`hermes plugins update` runs `git pull` inside the plugin directory. Your
MCP registration in `~/.hermes/config.yaml` is preserved across updates.
The CLI symlinks do not need to be recreated — they point into the same
checkout that gets updated.

## 7. Uninstalling

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

To configure the vault path, instance name, and agent identity:

```bash
openclaw config set plugins.entries.open-second-brain.config.vault '"/path/to/vault"'
openclaw config set plugins.entries.open-second-brain.config.instanceName '"My Second Brain"'
openclaw config set plugins.entries.open-second-brain.config.agentName '"<chosen-agent-name>"'
```

`agentName` is a separate field from `instanceName`. The plugin reads it
when `event_log_append` is called without an explicit `agent` argument
and writes entries to `Daily/*.md` as
`- HH:MM — @<agentName> — event message`.

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
