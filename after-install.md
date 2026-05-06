# Open Second Brain — after install

Thanks for installing Open Second Brain. The plugin is now on disk; finish
the setup with the steps below.

## 1. Initialise a vault

Pick (or create) the Obsidian-compatible folder you want as your second
brain, then bootstrap the agent-owned files:

```bash
o2b init --vault /path/to/vault --name "My Second Brain"
o2b doctor --vault /path/to/vault --repo .
```

`o2b doctor` should print `[OK]` for every check.

## 2. Register the MCP server (optional but recommended)

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

## 3. Updating

```bash
hermes plugins update open-second-brain
hermes gateway restart
```

`hermes plugins update` runs `git pull` inside the plugin directory. Your
MCP registration in `~/.hermes/config.yaml` is preserved across updates.

## 4. Uninstalling

Run a dry-run first to see exactly what will happen and which Hermes
commands you need to run:

```bash
o2b uninstall
```

Then deregister the MCP server and remove the plugin (Hermes-owned state):

```bash
hermes mcp remove open-second-brain
hermes plugins remove open-second-brain
hermes gateway restart
```

Optional: remove the machine-local config directory only:

```bash
o2b uninstall --apply-local
```

`--apply-local` only touches `~/.config/open-second-brain` (or the parent
of `$OPEN_SECOND_BRAIN_CONFIG`). Your vault, `Daily/`, `AI Wiki/`, and
Markdown notes are never removed by Open Second Brain — delete them
yourself with normal filesystem tools if that is what you want.

## More

- `README.md` — full feature description and CLI reference.
- `docs/mcp.md` — MCP tool server, registration, update/remove flows.
- `docs/architecture.md` — config model, vault layout, security rules.
