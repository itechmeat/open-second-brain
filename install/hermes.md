# Hermes

Hermes installs Open Second Brain through its native plugin and
memory-provider machinery, not through `o2b install --target hermes`.
The flow below assumes a working Hermes Agent with `hermes` on PATH.

Open Second Brain registers as a native Hermes **memory provider**:
one mechanism that injects `Brain/active.md` into the system prompt,
recalls context before each turn, captures turns for the deterministic
`dream` pass, mirrors Hermes built-in memory writes into `Brain/`, and
exposes the `brain_*` tools - all over a single internal `o2b mcp`
bridge. There is no separate `mcp_servers` entry to maintain.

## 1. Install the plugin

```bash
hermes plugins install itechmeat/open-second-brain --enable
hermes gateway restart
```

Or paste `https://github.com/itechmeat/open-second-brain` into the
Hermes Dashboard -> Plugins -> Install from GitHub URL. Do not pin
a tag - the CLI resolves to the latest released version on its own.

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

## 4. Enable the memory provider

Run the setup wizard and choose `open-second-brain`:

```bash
hermes memory setup
```

Or set it directly in `~/.hermes/config.yaml`:

```yaml
memory:
  provider: open-second-brain
```

Then restart the gateway:

```bash
hermes gateway restart
```

Only one external memory provider can be active at a time; selecting
`open-second-brain` makes it the active provider. The provider reads
the vault, agent name, and timezone from the Open Second Brain config
written in step 3 (`~/.config/open-second-brain/config.yaml`), so no
vault path is duplicated in the Hermes config.

## 5. Verify

```bash
o2b doctor --vault /path/to/vault --repo .
hermes open-second-brain status
```

`status` reports the provider name, whether a vault is configured, and
the resolved vault path. Run the daily-identity check described in
`install/prerequisites.md`.

## Update

```bash
hermes plugins update open-second-brain
hermes gateway restart
o2b doctor --vault /path/to/vault --repo .
```

## Uninstall

```bash
o2b uninstall --apply-local --remove-cli
hermes plugins remove open-second-brain
hermes gateway restart
```

Unset `memory.provider` in `~/.hermes/config.yaml` (or pick a different
provider via `hermes memory setup`) before removing the plugin. The
vault and its Markdown files are never deleted.
