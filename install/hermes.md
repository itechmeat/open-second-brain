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

On native Windows (Hermes desktop app or `install.ps1`), Hermes keeps its
home in `%LOCALAPPDATA%\hermes`; the plugin, the provider and the steps
below are the same, with the Windows paths from
[`windows.md`](windows.md).

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

The dashboard's Memory Provider panel reads those same three values
back from the provider, so a vault configured in step 3 shows there as
already set and the panel reports the provider as ready. Saving from
the panel writes the Open Second Brain config, not the Hermes one.
Clearing a field is the one edit the panel cannot make - the host
resubmits the current value in place of an empty one - so unset a key
with `hermes memory setup` or by editing the config file.

### Activation lifecycle

Hermes activates memory providers through the `memory.provider` config
key, not at install time — `hermes plugins install` only makes the
provider *available*. This is by design (exactly one provider is active
at a time), so activation is one explicit command:

| Action | What happens | What you run |
|---|---|---|
| First install | Not auto — install only makes it available | `hermes memory setup open-second-brain` |
| Plugin update | **Automatic** — `memory.provider` persists in `config.yaml` | nothing |
| Deactivate / uninstall | Not auto | `hermes memory off` (reverts to built-in) |

### Multiple Hermes profiles

A Hermes gateway with `gateway.multiplex_profiles: true` serves several
profiles from one process, and that process's environment belongs to
the profile that launched it. Since v1.70.0 the plugin then reads its
profile-scoped settings from each turn's own profile scope - the
profile's `.env`, as Hermes composes it - and never from the gateway
process environment:

| Variable | Setting |
|---|---|
| `VAULT_DIR` | vault |
| `VAULT_AGENT_NAME` | agent name |
| `VAULT_TIMEZONE` | timezone |
| `OPEN_SECOND_BRAIN_CONFIG` | config file path |
| `OPEN_SECOND_BRAIN_MCP_TIMEOUT` | MCP request timeout |

Set these in each profile's `.env`. A variable the profile does not set
falls through to the Open Second Brain config chain (the project
pointer, the active profile, the config file, the default), not to the
gateway environment. Each profile gets its own `o2b mcp` child, started
with its own vault, agent name, timezone and config path, so two
profiles that share a vault but not an agent name write under their own
names. Without multiplexing nothing changes: the plugin reads the
process environment as before.

When one of these variables is also set in the gateway process
environment, the gateway log names it once per process with a WARNING
from the plugin's config module, never its value:

```
open-second-brain: ignoring VAULT_AGENT_NAME from the gateway process environment on a multiplexed gateway; set it in the profile's .env instead
```

If the gateway bound no profile scope for a call, the plugin refuses to
guess: the provider reports a `ProfileScopeError` naming the variable
and the remedy (`hermes gateway restart`), and a turn in that state
runs without the vault reminder instead of failing.

What stays process-wide on a multiplexed gateway:

- `HOME`, `PATH` and `PATHEXT` describe the machine, not the profile,
  and are read from the process environment in both modes.
- `XDG_CONFIG_HOME` and `LOCALAPPDATA`, which locate the config file,
  are read from the profile's `.env` first; a profile that does not set
  one uses the gateway process environment's value, so a value set in
  the launch profile's `.env` is seen by every profile that sets none.
- Other variables the `o2b mcp` child reads - the search settings,
  `OPEN_SECOND_BRAIN_MCP_API_KEY`, embedding provider keys and the
  `TELEGRAM_*` settings - are still inherited from the gateway process
  environment.
- A gateway that serves a routed profile home without multiplexing
  reads the process environment, as Hermes's own memory providers do.

One install pitfall: Hermes looks for a memory provider in its own
bundled `plugins/memory/open-second-brain/` before
`$HERMES_HOME/plugins/open-second-brain/`. A copy left in the bundled
location shadows the plugin `hermes plugins install` and
`hermes plugins update` manage, so an update appears to change nothing.
Remove such a copy and restart the gateway.

### How Hermes discovers the provider

The primary route needs no packaging metadata at all: `hermes plugins
install` git-clones the repo into `~/.hermes/plugins/open-second-brain/`,
and Hermes discovers the provider by scanning that plugin directory -
the `plugins/hermes` package ships `plugin.yaml` declaring
`memory_provider: true`, and the loader imports `plugins.hermes` and
finds the `register` callable there. A git clone registers no Python
entry-point metadata, so this path never consults the entry point.

The declared `hermes_agent.memory_providers` entry point group - the
`open-second-brain` entry names the same `plugins.hermes` module - is an
extra discovery route for pip or wheel installs only: entry-point
metadata exists when the package has been installed into the
environment, not when a checkout is cloned. That route presumes a clean
environment - the target rides the top-level `plugins` package name,
which only an operator-controlled install environment guarantees - so it
is a convenience layered on top of the directory scan, never a
requirement for the plugin install in step 1.

Registering the provider is automatic; running it is not entirely. The
provider serves memory by driving the Open Second Brain CLI over an
internal `o2b mcp` bridge, and Bun is required in every context: the
`o2b` wrapper on PATH (step 2 creates the links) is itself a bash script
that checks `command -v bun` first and refuses to run without it, and
the checkout fallback launches the repo's TypeScript entry point through
`bun run` directly. With Bun installed, either context - `o2b` on PATH
or a checkout - needs nothing beyond the install above. When Bun is
missing, or neither an `o2b` binary nor a checkout is present,
registration still succeeds and the failure surfaces later as a bridge
start error in the gateway log, so keep step 2 in place and Bun
installed.

## 5. Verify

```bash
o2b doctor --vault /path/to/vault --repo .
hermes memory status
```

`hermes memory status` shows `Provider: open-second-brain` with
`available ✓` once active. Run the daily-identity check described in
`install/prerequisites.md`.

On a fresh gateway start the log shows
`Memory provider 'open-second-brain' registered (10 tools)` - the
provider advertises its curated `brain_*` tool set at registration
time, before the internal `o2b mcp` bridge starts. A `(0 tools)`
registration line indicates a version older than 1.0.1.

> A provider-specific `hermes open-second-brain` subcommand is not
> surfaced on current Hermes. Use `hermes memory status` for provider
> state and `o2b doctor` for the full readiness suite - together they
> cover the same ground.

## 6. Recall what Hermes wrote

Hermes built-in memory writes are mirrored into the Open Second Brain
continuity ledger, and `o2b brain continuity promote` is what makes
those mirrored facts recallable: each becomes an ordinary preference
page under `Brain/preferences/`, so page search finds it and the
context pack and its confirm flow treat it like any imported host
memory. Promote does not restore Hermes built-in memory - the ledger
stays the durable copy, and `o2b brain continuity export` remains the
full-fidelity audit path.

Promote is dry-run by default and writes nothing. Run it, read the
per-record plan, then apply with the approval digest it prints:

```bash
o2b brain continuity promote --vault /path/to/vault
o2b brain continuity promote --vault /path/to/vault --apply \
    --approval-digest <digest-from-the-dry-run>
```

`--apply` lands exactly the plan the digest seals or nothing at all; a
non-interactive apply must carry the digest. Promoted pages land
unconfirmed and stay under the trial window
(`dream.unconfirmed_window_days`) until the confirm flow accepts them,
like any other preference.

## Update

```bash
hermes plugins update open-second-brain
hermes gateway restart
o2b doctor --vault /path/to/vault --repo .
```

`memory.provider` persists across updates, so the provider stays active
with no re-activation step.

Keep the `o2b` on PATH at the plugin's version. The links step 2
creates point into the plugin and follow it; an `o2b` installed some
other way must be updated too. Since v1.70.0 the plugin launches its
bridge with `o2b mcp --harness hermes`, and an older `o2b` refuses
`--harness` as an unknown flag, so the bridge does not start; the
gateway log shows the flag in the bridge's stderr.

## Uninstall

Deactivate first (reverts to built-in memory), then remove:

```bash
hermes memory off
hermes plugins remove open-second-brain
o2b uninstall --apply-local --remove-cli
hermes gateway restart
```

`hermes memory off` is the native way to switch back to built-in memory
(or use `hermes memory setup` to pick a different provider). The vault
and its Markdown files are never deleted.
