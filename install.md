# open-second-brain — Agent Installation Guide

> Repository: https://github.com/itechmeat/open-second-brain

This guide is written for an **AI agent**, not a human. It contains the exact commands and decision logic needed to install and configure the **open-second-brain** plugin autonomously. Follow exactly one of the branches below based on the target runtime: **A — Hermes**, **B — OpenClaw**, **C — Codex**, **D — Claude Code**, or **E — generic adapter** (any other runtime not covered by A–D). Complete every step in the chosen branch.

**Always install the latest released version.** When the user installs the plugin, they expect to receive the newest published release — for example, if `v0.6.1` is the most recent tag and `v0.6.0` was the previous one, the install **must** end up at `v0.6.1`, not at `v0.6.0`. Each runtime CLI in branches A–D below already resolves "latest" by default when handed a bare `owner/repo` identifier (or the runtime-specific equivalent). Manually appending a version specifier — `@v0.6.0`, `@v1.2.3`, `@<some-tag>`, `--ref v...`, etc. — **bypasses** that resolution and freezes the install at the literal value you typed, including back to an older release if you happen to know an outdated tag number. Do **NOT** add any version specifier to the install commands below; rely on the CLI's default-latest behavior. After install, the effective version is reported by `o2b status` / `o2b doctor` and by the runtime's own plugin listing — read it from there if you need to know what got installed, do not pre-suppose it.

**`o2b init` is idempotent.** Re-running it on an already-initialized vault only fills in missing scaffolding (`AI Wiki/identity/agents.md`, etc.) and never rewrites the user's notes or templates. Re-running with `--agent-name <name>` is the supported way to switch identities: it appends the new agent's entry to `AI Wiki/identity/agents.md` (without removing existing ones, so the registry grows correctly across multi-runtime installs) and updates the persisted `agent_name` in the plugin config (`~/.config/open-second-brain/config.yaml`). Use `--force` only when the user explicitly asks for a reset of the scaffolding files.

**The `o2b` CLI on PATH is shared across runtimes.** The first runtime to run `o2b install-cli` wires `~/.local/bin/o2b` (and `vault-log`) at its own checkout; subsequent runtimes' `install-cli` invocations detect the existing symlink and **deliberately refuse to overwrite it** (printing `warning: already points to ..., not overwriting`). This is by design: the `o2b` script is byte-identical across all runtime checkouts (they all clone the same repo at the same version), so a single symlink serves every runtime correctly, and overwriting silently would risk pointing at a stale-and-uninstalled checkout when one runtime updates faster than another. If you have a deliberate reason to point `o2b` at a specific runtime's checkout (e.g. you want CLI behavior to track that runtime's plugin update cycle), repoint with `ln -sfn <path> ~/.local/bin/o2b` manually — the plugin won't second-guess you. But the default state, with `o2b` pointing at whichever runtime got there first, is correct and does not need fixing.

If at any point you are missing information — for example, the vault path is unknown, a required tool is not installed, or the runtime version is unclear — stop and ask the user for clarification. Offer concrete options where possible (e.g. suggest a default vault path, list supported Python versions, or propose an alternative runtime).

---

## Prerequisites — Bun runtime (all branches)

**Open Second Brain v0.7+ runs on the [Bun](https://bun.sh) JavaScript runtime.** The `o2b` CLI, the MCP server (`o2b mcp`), and the OpenClaw native plugin all execute under Bun. Hermes still loads a small Python shim for the per-turn `pre_llm_call` hook, but every other runtime path is Bun-only.

**Before running any branch below, verify Bun is on PATH:**

```bash
command -v bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash
```

If the install runs, re-source your shell so `~/.bun/bin` lands on PATH:

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun --version
```

`bun --version` must report **1.1.0 or newer**. If it does not, stop and ask the user to upgrade Bun before continuing — older versions miss APIs the plugin relies on.

If the user is on a system where they cannot install Bun (locked-down environment, unsupported architecture), abort the install and tell them so explicitly. Do **not** try to work around the missing runtime by re-exporting Python sources — those were removed in v0.7.0 and there is no Python fallback for the CLI.

---

## Branch A — Hermes

### 1. Collect installation parameters (vault path + agent name + timezone)

Collect all three values before running any commands — step 4
(`o2b init`) and step 5 (MCP `env`) both depend on them.

**Vault path.** Locate (or have the user create) the directory that
will hold the Obsidian-compatible Markdown vault. Do **not** hard-code
a path; vault locations vary per user and per OS. Discover candidates
on the target machine in this order:

  1. Look for an existing Obsidian vault: any directory containing a
     `.obsidian/` subdirectory is a vault. Common roots to scan:
     `~/`, `~/Documents/`, `~/Sync/`, `~/Dropbox/`,
     `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/`
     (macOS iCloud), or — on this server — wherever Syncthing has
     mounted a shared `vault` folder.
  2. If multiple candidates exist, list them and ask the user to pick
     one.
  3. If none found, ask the user for a path (or for permission to
     create a new vault directory at a sensible default like
     `~/vault/`).

Confirm the chosen path with the user before passing it to `o2b init`:
show them the absolute path you resolved and wait for explicit
agreement. The plugin will refuse to write to the wrong place — but
catching a misclick at this step is much cheaper than after entries
have started accumulating.

**Agent name.** You **MUST ask the user** to choose this. Do **not**
silently pick a default value, do **not** assume the user wants
whichever runtime-prefixed name looks reasonable. The value will
appear as the `@agent-name` prefix in every single Daily event log
entry written from this runtime; it has to be the user's deliberate
choice, not the agent's guess.

**Before asking, check for a previously-set identity.** If the user
has installed Open Second Brain before — under another runtime, in a
prior session, or after a reset — there are likely traces on disk:

- `~/.config/open-second-brain/config.yaml` `agent_name` field — the
  authoritative persisted identity (written by any past
  `o2b init --agent-name` invocation, regardless of runtime).
- `<vault>/AI Wiki/identity/agents.md` — usually has a line like
  `- <name>: primary agent on this server`.
- `<vault>/Daily/*.md` — recurring `@<name>` lines hint at past
  identities the user has been writing under.

If any of these surfaces a name, **show it to the user first** with a
question like «This vault is already configured with `@<found-name>`.
Should I reuse that name for the Hermes runtime, or do you want a
different one for this runtime specifically?». Wait for an explicit
answer — do not assume "reuse" or "change" on the user's behalf.

Only when no prior identity is found, offer these defaults plus a
custom value:

- `hermes-main`
- `hermes-vps-agent`
- `hermes-server`
- `second-brain-agent`
- `<hostname>-hermes`

Resolve `<hostname>` from the `hostname` command on the target system
before showing the list (e.g. `vps-techmeat-hermes`).

**Timezone.** Ask the user for their local timezone. Accept a free-form
answer (city name, country, "my time", etc.) and translate it to a
canonical IANA name yourself before passing it to `o2b init` — the
plugin only accepts IANA. Examples of the translation you should do:

- `Belgrade` / `Serbia` → `Europe/Belgrade`
- `New York` / `EST` / `eastern` → `America/New_York`
- `UTC` / `none` / `server time` → `UTC`
- `Tokyo` / `JST` → `Asia/Tokyo`

If the answer is ambiguous, ask one clarifying question (e.g. "Belgrade
or somewhere else in Central Europe?"). If validation fails on the
chosen name, ask again — do not silently fall back.

Explain that the daily entry format is

```
- HH:MM — @agent-name — event message
```

…and that the `HH:MM` will be stamped in the timezone you collect here,
not in the host's clock. Do not continue until all three values
(vault path, agent name, timezone) are known. The vault path goes into
`o2b init --vault` (step 4) and the MCP entry `args` (step 5). The
agent name goes into `o2b init --agent-name` (step 4) **and** the MCP
server `env.VAULT_AGENT_NAME` block (step 5) — the two must match.
The timezone goes into `o2b init --timezone` (step 4) and is persisted
to the plugin config; the MCP server reads it from there.

### 2. Install the plugin

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

### 3. Publish CLI commands to PATH

`hermes plugins install` clones the repository but does not pip-install the package, so the `o2b`, `vault-log`, and `o2b-hook` commands are not on PATH yet. Run this step to create symlinks:

```bash
~/.hermes/plugins/open-second-brain/scripts/o2b install-cli
```

This creates symlinks in `~/.local/bin` pointing to `scripts/o2b`,
`scripts/vault-log`, and `scripts/o2b-hook` inside the plugin
checkout. The symlinks survive `hermes plugins update` because they
point into the git-managed checkout.

After this step, the bare commands `o2b`, `vault-log`, and
`o2b-hook` will be available on PATH. (`o2b-hook` is the launcher
that Claude Code and Codex use for lifecycle hooks; it is not used
by Hermes itself but installing it costs nothing.)

### 4. Initialize the vault

Replace `/path/to/vault`, `<chosen-agent-name>`, and `<chosen-timezone>`
with the values collected in step 1.

```bash
o2b init --vault /path/to/vault --name "My Second Brain" \
    --agent-name "<chosen-agent-name>" \
    --timezone "<chosen-timezone>"
```

`--agent-name` writes the chosen name into `AI Wiki/identity/agents.md`
and persists `agent_name` into the plugin config
(`~/.config/open-second-brain/config.yaml`). `--timezone` validates the
IANA name via stdlib `zoneinfo` and persists it to the same config; from
that moment on, every `event_log_append` call stamps Daily entries in
that timezone regardless of the host's clock.

### 5. Register the MCP server

**Recommended path — edit `~/.hermes/config.yaml` directly.** Add the
following entry under `mcp_servers:` (create the section if it does not
exist), then restart the gateway. Substitute `/path/to/vault` and
`<chosen-agent-name>` with the real values you collected in step 3 and
will use again in step 4.

```yaml
mcp_servers:
  open-second-brain:
    command: o2b
    args: [mcp, --vault, /path/to/vault]
    env:
      VAULT_AGENT_NAME: <chosen-agent-name>
    enabled: true
```

```bash
hermes gateway restart
```

The `env.VAULT_AGENT_NAME` value is what `event_log_append` falls back to
when the LLM omits the explicit `agent` argument. **It must be set in
this block** — without it, Daily entries will be written under the
literal `@agent` placeholder (or an unrelated value inherited from the
gateway's own environment), and the daily-identity check in step 6 will
fail.

**Alternative — `hermes mcp add` (CLI).** On older Hermes builds the
following one-liner is equivalent and may work:

```bash
hermes mcp add open-second-brain \
    --command o2b --args mcp --vault /path/to/vault \
    --env VAULT_AGENT_NAME=<chosen-agent-name>
hermes gateway restart
```

On the current Hermes release argparse stops collecting `--args [...]` as
soon as it sees a token starting with `--`, so `--vault /path/to/vault`
is rejected as an unknown top-level flag and the command fails with
`unrecognized arguments: --vault ...`. Use the YAML path above if that
happens. Do **not** also pass `--vault` as a top-level CLI flag — that
will not be forwarded to the `o2b mcp` subprocess.

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

### 1. Collect installation parameters (vault path + agent name + timezone)

Collect all three values before running any commands — step 4
(`o2b init`) and step 5 (OpenClaw config) both depend on them.

**Vault path.** Locate (or have the user create) the directory that
will hold the Obsidian-compatible Markdown vault. Do **not** hard-code
a path; vault locations vary per user and per OS. Discover candidates
on the target machine in this order:

  1. Look for an existing Obsidian vault: any directory containing a
     `.obsidian/` subdirectory is a vault. Common roots to scan:
     `~/`, `~/Documents/`, `~/Sync/`, `~/Dropbox/`,
     `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/`
     (macOS iCloud), or any Syncthing-mounted shared `vault` folder.
  2. If multiple candidates exist, list them and ask the user to pick
     one.
  3. If none found, ask the user for a path (or for permission to
     create a new vault directory at a sensible default like
     `~/vault/`).

Confirm the chosen path with the user (show them the absolute path you
resolved) before passing it to `o2b init` and `openclaw config set`.

**Agent name.** You **MUST ask the user** to choose this. Do **not**
silently pick a default value, do **not** assume the user wants
whichever runtime-prefixed name looks reasonable. The value will
appear as the `@agent-name` prefix in every single Daily event log
entry written from this runtime; it has to be the user's deliberate
choice, not the agent's guess.

**Before asking, check for a previously-set identity.** If the user
has installed Open Second Brain before — under another runtime, in a
prior session, or after a reset — there are likely traces on disk:

- `~/.config/open-second-brain/config.yaml` `agent_name` field — the
  authoritative persisted identity (written by any past
  `o2b init --agent-name` invocation, regardless of runtime).
- `<vault>/AI Wiki/identity/agents.md` — usually has a line like
  `- <name>: primary agent on this server`.
- `<vault>/Daily/*.md` — recurring `@<name>` lines hint at past
  identities the user has been writing under.

If any of these surfaces a name, **show it to the user first** with a
question like «This vault is already configured with `@<found-name>`.
Should I reuse that name for the OpenClaw runtime, or do you want a
different one for this runtime specifically?». Wait for an explicit
answer — do not assume "reuse" or "change" on the user's behalf.

Only when no prior identity is found, offer these defaults plus a
custom value:

- `openclaw-main`
- `openclaw-server`
- `server-agent`
- `second-brain-agent`
- `<hostname>-openclaw`

Resolve `<hostname>` from the `hostname` command on the target system
before showing the list (e.g. `vps-techmeat-openclaw`).

**Timezone.** Ask the user for their local timezone. Accept a free-form
answer (city name, country, "my time", etc.) and translate it to a
canonical IANA name yourself before passing it to `o2b init` — the
plugin only accepts IANA. Examples: `Belgrade` → `Europe/Belgrade`,
`New York` / `EST` → `America/New_York`, `UTC` / `none` → `UTC`,
`Tokyo` → `Asia/Tokyo`. If the answer is ambiguous, ask one clarifying
question. If validation fails on the chosen name, ask again — do not
silently fall back.

Explain that the daily entry format is

```
- HH:MM — @agent-name — event message
```

…and that the `HH:MM` will be stamped in the timezone you collect here,
not in the host's clock. Do not continue until all three values
(vault path, agent name, timezone) are known. On OpenClaw, the native
JS plugin entry reads its config exclusively from OpenClaw's own
per-plugin config store (`api.pluginConfig`, populated by
`openclaw config set`), **not** from
`~/.config/open-second-brain/config.yaml`. So vault path, agent name,
and timezone must all be set via `openclaw config set` in step 5; the
`o2b init` invocation in step 4 still runs (to scaffold the vault) but
the values it persists into the Python-side config there are read only
by the optional `o2b mcp` server, not by the OpenClaw plugin runtime.

### 2. Install the plugin

From Git (let the CLI resolve to the latest released version on its
own; do not append `@v...` — see the prelude on why pinning a tag
manually is the wrong move):

```bash
openclaw plugins install git:github.com/itechmeat/open-second-brain
```

Or from a local checkout:

```bash
openclaw plugins install ./open-second-brain
```

After install, restart the gateway:

```bash
openclaw gateway restart
```

### 3. Publish CLI commands to PATH

The `o2b` and `vault-log` commands are not on PATH after OpenClaw plugin
install (and `o2b-hook`, even though OpenClaw doesn't use it).
Run this step to create symlinks:

```bash
./scripts/o2b install-cli
```

This creates symlinks in `~/.local/bin` for `o2b`, `vault-log`, and
`o2b-hook`. After this, the bare commands work on PATH.

### 4. Initialize the vault

Replace `/path/to/vault`, `<chosen-agent-name>`, and `<chosen-timezone>`
with the values collected in step 1.

```bash
o2b init --vault /path/to/vault --name "My Second Brain" \
    --agent-name "<chosen-agent-name>" \
    --timezone "<chosen-timezone>"
```

`--agent-name` writes the chosen name into `AI Wiki/identity/agents.md`
and persists `agent_name` into the plugin config
(`~/.config/open-second-brain/config.yaml`). `--timezone` validates the
IANA name via stdlib `zoneinfo` and persists it to the same config; from
that moment on, every Daily entry is stamped in that timezone regardless
of the host's clock.

### 5. Configure the vault path, agent name, and timezone

Tools are registered natively by the JS plugin entry — no MCP
registration is needed. Set the vault path, instance name, agent name,
and timezone in the OpenClaw plugin config:

```bash
openclaw config set plugins.entries.open-second-brain.config.vault '"/path/to/vault"'
openclaw config set plugins.entries.open-second-brain.config.instanceName '"My Second Brain"'
openclaw config set plugins.entries.open-second-brain.config.agentName '"<chosen-agent-name>"'
openclaw config set plugins.entries.open-second-brain.config.timezone '"<chosen-timezone>"'
```

The resulting plugin entry must contain `agentName` and `timezone` as
separate fields alongside `instanceName` (do not merge them):

```json
{
  "enabled": true,
  "config": {
    "vault": "/path/to/vault",
    "instanceName": "My Second Brain",
    "agentName": "<chosen-agent-name>",
    "timezone": "<chosen-timezone>",
    "mcpEnabled": false
  }
}
```

`agentName` and `timezone` are read by the native JS plugin from
`api.pluginConfig` on every `event_log_append` call (with
`VAULT_AGENT_NAME` / `VAULT_TIMEZONE` env vars as fallbacks). Without
`timezone` set here, Daily entries fall back to the host's local
clock — which is rarely what the user wants.

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

### 1. Collect installation parameters (vault path + agent name + timezone)

Collect all three values before running any commands — step 4
(`o2b init`) and step 5 (Codex MCP `env`) both depend on them.

**Vault path.** Locate (or have the user create) the directory that
will hold the Obsidian-compatible Markdown vault. Do **not** hard-code
a path; vault locations vary per user and per OS. Discover candidates
on the target machine in this order:

  1. Look for an existing Obsidian vault: any directory containing a
     `.obsidian/` subdirectory is a vault. Common roots to scan:
     `~/`, `~/Documents/`, `~/Sync/`, `~/Dropbox/`,
     `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/`
     (macOS iCloud).
  2. If multiple candidates exist, list them and ask the user to pick
     one.
  3. If none found, ask the user for a path (or for permission to
     create a new vault directory at a sensible default like
     `~/vault/`).

Confirm the chosen path with the user (show them the absolute path you
resolved) before passing it to `o2b init` and the Codex MCP entry.

**Agent name.** You **MUST ask the user** to choose this. Do **not**
silently pick a default value, do **not** assume the user wants
whichever runtime-prefixed name looks reasonable. The value will
appear as the `@agent-name` prefix in every single Daily event log
entry written from this runtime; it has to be the user's deliberate
choice, not the agent's guess.

**Before asking, check for a previously-set identity.** If the user
has installed Open Second Brain before — under another runtime, in a
prior session, or after a reset — there are likely traces on disk:

- `~/.config/open-second-brain/config.yaml` `agent_name` field — the
  authoritative persisted identity (written by any past
  `o2b init --agent-name` invocation, regardless of runtime).
- `<vault>/AI Wiki/identity/agents.md` — usually has a line like
  `- <name>: primary agent on this server`.
- `<vault>/Daily/*.md` — recurring `@<name>` lines hint at past
  identities the user has been writing under.

If any of these surfaces a name, **show it to the user first** with a
question like «This vault is already configured with `@<found-name>`.
Should I reuse that name for the Codex runtime, or do you want a
different one for this runtime specifically?». Wait for an explicit
answer — do not assume "reuse" or "change" on the user's behalf.

Only when no prior identity is found, offer these defaults plus a
custom value:

- `codex-main`
- `codex-vps-agent`
- `codex-server`
- `second-brain-agent`
- `<hostname>-codex`

Resolve `<hostname>` from the `hostname` command on the target system
before showing the list.

**Timezone.** Ask the user for their local timezone. Accept a free-form
answer and translate it to a canonical IANA name yourself before passing
it to `o2b init` — the plugin only accepts IANA. Examples: `Belgrade`
→ `Europe/Belgrade`, `New York` / `EST` → `America/New_York`, `UTC` /
`none` → `UTC`, `Tokyo` → `Asia/Tokyo`. If the answer is ambiguous, ask
one clarifying question. If validation fails on the chosen name, ask
again — do not silently fall back.

Explain that this name and timezone appear in `Daily/*.md` as
`- HH:MM — @agent-name — event message` (HH:MM in the chosen timezone,
not the host's clock). Do not continue until all three values
(vault path, agent name, timezone) are known. The vault path goes
into `o2b init --vault` (step 4) and the Codex MCP entry's `args`
(step 5). The agent name goes into `o2b init --agent-name` (step 4)
and the `env.VAULT_AGENT_NAME` of the Codex MCP entry (step 5) — the
two must match. The timezone goes into `o2b init --timezone` (step 4)
and is persisted to the plugin config; the MCP server reads it from
there.

### 2. Install the plugin

Codex 0.129 and later install plugins via the **marketplace** subsystem.
This repository ships a single-plugin marketplace manifest at
`.agents/plugins/marketplace.json`, so the official command is:

```bash
codex plugin marketplace add itechmeat/open-second-brain
```

(The CLI resolves to the latest released version by default; do
**not** append `@v...` — see the prelude.) Codex clones the repo
somewhere under `~/.codex/`. The exact path varies by
CLI version: older builds use `~/.codex/plugins/cache/<marketplace>/<plugin>/<hash>/`;
Codex 0.129 stores it under `~/.codex/.tmp/marketplaces/<marketplace>/`.
Step 3 below uses a `find` to locate the plugin scripts regardless of
layout, so this difference is not user-visible. A
`[marketplaces.open-second-brain]` entry is added to
`~/.codex/config.toml`; the printed `Installed marketplace root: ...`
line shows the absolute path of the install for that run.

Then enable the plugin so its bundled skills/agents/commands become
available — there is no `codex plugin enable` subcommand on current
Codex, this is done by adding one stanza to `~/.codex/config.toml`:

```toml
[plugins."open-second-brain@open-second-brain"]
enabled = true
```

(The `<plugin>@<marketplace>` form here resolves to plugin
`open-second-brain` from marketplace `open-second-brain` — both names
come from the manifest.) The plugin's MCP tools (`event_log_append`,
`second_brain_capture`, `second_brain_query`, `second_brain_status`,
`vault_health`) become available **only** after step 5 below — Codex
treats MCP server registration as a separate concern from plugin
enablement.

### 3. Publish CLI commands to PATH

The `o2b`, `vault-log`, and `o2b-hook` scripts ship inside the plugin
checkout; this step symlinks them into `~/.local/bin` so they are
usable on PATH. (`o2b-hook` is the launcher that lifecycle hooks
invoke — see step 6b.)

The cached path differs across Codex versions (see step 2), so locate
the script by searching under `~/.codex/`:

```bash
"$(find ~/.codex -path '*open-second-brain*/scripts/o2b' -type f 2>/dev/null | head -1)" install-cli
```

If you installed the marketplace from a local path, run
`<that-path>/scripts/o2b install-cli` directly instead.

### 4. Initialize the vault

Replace `/path/to/vault`, `<chosen-agent-name>`, and `<chosen-timezone>`
with the values collected in step 1.

```bash
o2b init --vault /path/to/vault --name "My Second Brain" \
    --agent-name "<chosen-agent-name>" \
    --timezone "<chosen-timezone>"
```

`--timezone` validates the IANA name via stdlib `zoneinfo` and persists
it to the plugin config. From this moment on, every Daily entry is
stamped in that timezone regardless of the host's clock.

### 5. Register the MCP server

Codex consumes Open Second Brain's MCP tools through a stdio server
configured in `~/.codex/config.toml`. The official command is:

```bash
codex mcp add open-second-brain \
    --env VAULT_AGENT_NAME=<chosen-agent-name> \
    --env VAULT_TIMEZONE=<chosen-timezone> \
    -- o2b mcp --vault /path/to/vault
```

Note the `--` separator: everything before it is parsed by Codex,
everything after is passed verbatim to the MCP subprocess as
`command + args`. Codex writes the resulting block to `config.toml` in
the form

```toml
[mcp_servers.open-second-brain]
command = "o2b"
args = ["mcp", "--vault", "/path/to/vault"]

[mcp_servers.open-second-brain.env]
VAULT_AGENT_NAME = "<chosen-agent-name>"
VAULT_TIMEZONE = "<chosen-timezone>"
```

Both env vars are required for the daily-identity check in step 6 to
succeed under the chosen identity and the user's local timezone — the
MCP server reads them as the in-process default for `event_log_append`.

### 6. Verify the installation

```bash
o2b doctor --vault /path/to/vault --repo .
codex mcp list
```

The `codex mcp list` output must show `open-second-brain` with
`Status: enabled`. Then run the **daily identity** check (see
§ Verification — daily identity below). Installation is incomplete
until that check passes.

### 6b. Lifecycle hooks (auto-enabled)

The plugin ships a `hooks/hooks.json` that Codex loads automatically
from the bundled plugin tree. Two hooks fire per turn:

- `PostToolUse` (matcher `Write|Edit|MultiEdit|apply_patch`) — reminds
  the agent to call `event_log_append` when a durable artifact landed.
- `Stop` — blocks the turn at most once if the agent produced an
  artifact but did not log. The next Stop passes through, so the agent
  decides whether to log or just finish.

Both hooks invoke `o2b-hook` from PATH. That CLI was symlinked into
`~/.local/bin` by step 3, so no extra wiring is needed. If
`o2b-hook` is missing from PATH the hooks fail closed (turn proceeds
normally with a stderr trace) — re-run step 3 to fix.

### 7. Update

```bash
codex plugin marketplace upgrade open-second-brain
```

(Works only when the marketplace was added from a Git source. For a
local source, the marketplace tracks the path live — pulling latest
from upstream is up to whatever Git workflow you use on that path.)

The CLI symlinks created in step 3 do not need to be recreated after an
update — they point into the cached plugin checkout, which the
upgrade refreshes via `git fetch + reset`.

### 8. Uninstall

```bash
codex mcp remove open-second-brain
codex plugin marketplace remove open-second-brain
o2b uninstall --apply-local --remove-cli
```

Then remove the `[plugins."open-second-brain@open-second-brain"]`
stanza from `~/.codex/config.toml` if you added one in step 2. The
vault and its Markdown files are never deleted by the uninstall
process.

---

## Branch D — Claude Code

### 1. Collect installation parameters (vault path + agent name + timezone)

Collect all three values before running any commands — step 4
(`o2b init`) is the single point where they enter the system on Claude
Code. The plugin's bundled `.mcp.json` auto-registers the MCP server
with no flags or env vars, and the server reads vault path, agent
name, and timezone from the persisted plugin config that `o2b init`
writes — so there is no second place to keep in sync.

**Vault path.** Locate (or have the user create) the directory that
will hold the Obsidian-compatible Markdown vault. Do **not** hard-code
a path; vault locations vary per user and per OS. Discover candidates
on the target machine in this order:

  1. Look for an existing Obsidian vault: any directory containing a
     `.obsidian/` subdirectory is a vault. Common roots to scan:
     `~/`, `~/Documents/`, `~/Sync/`, `~/Dropbox/`,
     `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/`
     (macOS iCloud).
  2. If multiple candidates exist, list them and ask the user to pick
     one.
  3. If none found, ask the user for a path (or for permission to
     create a new vault directory at a sensible default like
     `~/vault/`).

Confirm the chosen path with the user (show them the absolute path
you resolved) before passing it to `o2b init`.

**Agent name.** You **MUST ask the user** to choose this. Do **not**
silently pick a default value, do **not** assume the user wants
whichever runtime-prefixed name looks reasonable. The value will
appear as the `@agent-name` prefix in every single Daily event log
entry written from this runtime; it has to be the user's deliberate
choice, not the agent's guess.

**Before asking, check for a previously-set identity.** If the user
has installed Open Second Brain before — under another runtime, in a
prior session, or after a reset — there are likely traces on disk:

- `~/.config/open-second-brain/config.yaml` `agent_name` field — the
  authoritative persisted identity (written by any past
  `o2b init --agent-name` invocation, regardless of runtime). On
  Claude Code specifically this field is what the bundled
  `.mcp.json` resolves at runtime, so a stale value here will
  silently become Claude's identity unless step 4 overwrites it.
- `<vault>/AI Wiki/identity/agents.md` — usually has a line like
  `- <name>: primary agent on this server`.
- `<vault>/Daily/*.md` — recurring `@<name>` lines hint at past
  identities the user has been writing under.

If any of these surfaces a name, **show it to the user first** with a
question like «This vault is already configured with `@<found-name>`.
Should I reuse that name for the Claude Code runtime, or do you want
a different one for this runtime specifically?». Wait for an explicit
answer — do not assume "reuse" or "change" on the user's behalf.

Only when no prior identity is found, offer these defaults plus a
custom value:

- `claude-main`
- `claude-vps-agent`
- `claude-server`
- `second-brain-agent`
- `<hostname>-claude`

Resolve `<hostname>` from the `hostname` command on the target system
before showing the list.

**Timezone.** Ask the user for their local timezone. Accept a free-form
answer and translate it to a canonical IANA name yourself before passing
it to `o2b init` — the plugin only accepts IANA. Examples: `Belgrade`
→ `Europe/Belgrade`, `New York` / `EST` → `America/New_York`, `UTC` /
`none` → `UTC`, `Tokyo` → `Asia/Tokyo`. If the answer is ambiguous, ask
one clarifying question. If validation fails on the chosen name, ask
again — do not silently fall back.

Explain that this name and timezone appear in `Daily/*.md` as
`- HH:MM — @agent-name — event message` (HH:MM in the chosen timezone,
not the host's clock). Do not continue until all three values
(vault path, agent name, timezone) are known. All three go into the
single `o2b init` call in step 4; the bundled `.mcp.json`
auto-registers the MCP server, and the server reads everything from
the persisted plugin config — no second config to set.

### 2. Install the plugin

Claude Code 2.x installs plugins through its **marketplace** subsystem.
This repository ships a single-plugin marketplace manifest at
`.claude-plugin/marketplace.json` plus the plugin manifest at
`.claude-plugin/plugin.json`, so the official two-step install is:

```bash
claude plugin marketplace add itechmeat/open-second-brain
claude plugin install open-second-brain@open-second-brain
```

(The marketplace step resolves to the latest released version on its
own; do **not** append `@v...` — see the prelude.) After install,
`claude plugin list` shows the plugin under user scope with
`Status: ✔ enabled`. Claude clones the repo
under `~/.claude/plugins/cache/<marketplace>/<plugin-name>/<version>/`
(the trailing `<version>` segment matches the installed plugin
manifest's `version`, e.g. `0.6.1`) and tracks the source via the
`claude-plugins` config block.

The plugin auto-registers its MCP server through the bundled `.mcp.json`
file at the repo root — **no `claude mcp add` step is needed**. After
step 4 below (vault init), `claude mcp list` will show
`open-second-brain` with `✓ Connected`.

### 3. Publish CLI commands to PATH

The `o2b`, `vault-log`, and `o2b-hook` scripts ship inside the plugin
checkout; this step symlinks them into `~/.local/bin` so they are
usable on PATH. (`o2b-hook` is the launcher that lifecycle hooks
invoke — see step 6b.)

The cached path includes the plugin version segment, so locate the
script by searching under the cache:

```bash
"$(find ~/.claude/plugins/cache -path '*open-second-brain*/scripts/o2b' -type f 2>/dev/null | head -1)" install-cli
```

### 4. Initialize the vault

Replace `/path/to/vault`, `<chosen-agent-name>`, and `<chosen-timezone>`
with the values collected in step 1.

```bash
o2b init --vault /path/to/vault --name "My Second Brain" \
    --agent-name "<chosen-agent-name>" \
    --timezone "<chosen-timezone>"
```

`o2b init` persists all three values (`vault`, `agent_name`, `timezone`)
into `~/.config/open-second-brain/config.yaml`. The `.mcp.json` that
Claude auto-registered is intentionally minimal — it points only at
`o2b mcp` with no flags, no env vars, no vault path. The MCP server
discovers everything it needs from the persisted config when it
spawns. This means the same `.mcp.json` works on every user's machine
without per-user customization.

### 5. (No separate MCP wiring step on Claude Code)

Skipped on this runtime — see step 2. Claude's `.mcp.json` auto-register
already covers what Hermes does in `mcp_servers:` and Codex does via
`codex mcp add`.

### 6. Verify the installation

```bash
o2b doctor --vault /path/to/vault --repo .
claude plugin list
claude mcp list
```

`claude plugin list` must show `open-second-brain@open-second-brain`
with `Status: ✔ enabled`. `claude mcp list` must show
`plugin:open-second-brain:open-second-brain` with `✓ Connected`. Then
run the **daily identity** check (see § Verification — daily identity
below). Installation is incomplete until that check passes.

### 6b. Lifecycle hooks (auto-enabled)

The plugin ships a `hooks/hooks.json` that Claude Code loads
automatically from the cached plugin tree. Two hooks fire per turn:

- `PostToolUse` (matcher `Write|Edit|MultiEdit|apply_patch`) — reminds
  the agent to call `event_log_append` when a durable artifact landed.
- `Stop` — blocks the turn at most once if the agent produced an
  artifact but did not log. The next Stop passes through, so the agent
  decides whether to log or just finish.

Both hooks invoke `o2b-hook` from PATH. That CLI was symlinked into
`~/.local/bin` by step 3, so no extra wiring is needed. To watch the
hooks fire end-to-end use `--output-format=stream-json --verbose
--include-hook-events`; you should see `hook_started` /
`hook_response` events around each `Write` / `Edit` and around `Stop`.

### 7. Update

```bash
claude plugin marketplace update open-second-brain
claude plugin update open-second-brain@open-second-brain
```

The CLI symlinks created in step 3 do not need to be recreated after
an update — they point into the cached plugin checkout, which the
update step refreshes via `git fetch + reset`.

### 8. Uninstall

```bash
claude plugin uninstall open-second-brain@open-second-brain
claude plugin marketplace remove open-second-brain
o2b uninstall --apply-local --remove-cli
```

Claude removes the plugin's MCP server registration automatically when
the plugin is uninstalled. The vault and its Markdown files are never
deleted by the uninstall process.

---

## Branch E — Generic adapter (other runtimes)

If the target runtime is **not** Hermes, OpenClaw, Codex, or Claude
Code — for example a new MCP-aware client, a different agent platform,
or one of the supported runtimes after a breaking CLI rename — use
this branch. It describes the install **contract** the plugin needs,
not literal commands. The agent doing the install must consult the
target runtime's own plugin / MCP documentation and translate each
step below into the equivalent runtime-specific operation. Where the
runtime has no equivalent for a step, ask the user before proceeding
rather than guessing.

The plugin's runtime contract is small:

- A directory tree on disk containing `scripts/o2b` (Python CLI) and
  `src/open_second_brain/` (the package). This is what the runtime's
  plugin install delivers.
- The `o2b` CLI on PATH (used for vault scaffolding, status, and
  doctor checks).
- The `o2b mcp` stdio server registered with the runtime as an MCP
  server (used by the LLM at runtime via the five tools
  `event_log_append` / `second_brain_capture` / `second_brain_query` /
  `second_brain_status` / `vault_health`).
- A persisted plugin config at `~/.config/open-second-brain/config.yaml`
  holding `vault` / `agent_name` / `timezone` (written by `o2b init`,
  read by `o2b mcp` when its CLI flags / env vars are absent).

### 1. Collect installation parameters (vault path + agent name + timezone)

Same three values as branches A–D collect, same discovery rules. Read
the "Collect installation parameters" subsection of any other branch
above and apply it as-is — the questions and defaults are runtime-
agnostic. For agent name, derive a runtime-appropriate prefix
(`<runtime>-main`, `<runtime>-vps-agent`, etc.) so multi-runtime users
can tell entries apart in Daily.

### 2. Install the plugin

Get the plugin source onto the target machine via whatever channel the
runtime supports. The repo ships several manifest formats so most
runtimes will find one they understand:

- `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json`
- `.codex-plugin/plugin.json` + `.agents/plugins/marketplace.json`
- `openclaw.plugin.json` + `package.json` `openclaw.extensions`
- Hermes `plugin.yaml` (root)
- A vanilla Git checkout (every runtime can clone a repo)

Pick whichever your runtime documents. Do **not** add a version pin
(`@v...`) — let the runtime CLI resolve to the latest released
version on its own (see the prelude on why manual pinning freezes you
to a stale release).

### 3. Publish CLI commands to PATH

Run `<plugin-checkout>/scripts/o2b install-cli`. It symlinks `o2b` and
`vault-log` into `~/.local/bin`. If your runtime caches plugins under
a content-addressed path with a version hash, glob it:
`<runtime-cache>/.../scripts/o2b install-cli`.

### 4. Initialize the vault

```bash
o2b init --vault /path/to/vault --name "My Second Brain" \
    --agent-name "<chosen-agent-name>" \
    --timezone "<chosen-timezone>"
```

This is identical across runtimes — the values are persisted into
`~/.config/open-second-brain/config.yaml` and read back by the MCP
server with no further wiring required.

### 5. Register the MCP server with your runtime

The exact mechanism depends on the runtime. The minimum spec the
plugin expects is a stdio MCP server invocation:

| field | value |
|---|---|
| `command` | `o2b` |
| `args` | `["mcp"]` (vault / agent / timezone resolved from the persisted plugin config; no flags needed) |
| `env` | optional. Set `VAULT_AGENT_NAME=<chosen-agent-name>` and `VAULT_TIMEZONE=<chosen-tz>` if your runtime cannot read the plugin config (e.g. a per-runtime override is desired); otherwise leave empty. |

If your runtime's MCP config is YAML (Hermes-style):

```yaml
mcp_servers:
  open-second-brain:
    command: o2b
    args: [mcp]
    env:
      VAULT_AGENT_NAME: "<chosen-agent-name>"
      VAULT_TIMEZONE: "<chosen-timezone>"
    enabled: true
```

If TOML (Codex-style):

```toml
[mcp_servers.open-second-brain]
command = "o2b"
args = ["mcp"]

[mcp_servers.open-second-brain.env]
VAULT_AGENT_NAME = "<chosen-agent-name>"
VAULT_TIMEZONE = "<chosen-timezone>"
```

If the runtime auto-registers MCP servers from a manifest at the
plugin root (Claude Code's `.mcp.json`-style), use that — the plugin
already ships `.mcp.json` with `${CLAUDE_PLUGIN_ROOT}/scripts/o2b mcp`
and no env, which auto-resolves everything from the persisted plugin
config at runtime.

If the runtime does **not** support stdio MCP servers at all, the
plugin's tools will not be available to that runtime; the user can
still run `o2b` / `vault-log` manually from the shell, but agent-side
integration is the runtime's missing capability, not the plugin's.

### 6. Verify the installation

```bash
o2b doctor --vault /path/to/vault --repo <plugin-checkout>
```

All checks must pass. Then run the **daily identity** check (see
§ Verification — daily identity below). Installation is incomplete
until that check passes.

### 7. Optional — surface plugin guidance to the LLM

The plugin's MCP `initialize` response carries a full identity +
workflow block in `serverInfo.instructions` (resolved per the
configured agent name). Runtimes that respect the MCP `instructions`
field show this to the LLM automatically. If yours does not — and the
runtime has a "system prompt injection" or "per-turn context" hook
analogous to Hermes's `pre_llm_call` — consider wiring the same
content (or a paraphrase) through that channel. Without it, the LLM
will still see the five tools but won't know when to call
`event_log_append`.

### 8. Update / Uninstall

Use the runtime's native plugin update / uninstall commands. The
plugin keeps no state outside the vault and
`~/.config/open-second-brain/config.yaml`; `o2b uninstall
--apply-local --remove-cli` cleans the latter and the PATH symlinks
created in step 3. Vault Markdown files are never deleted.

---

## Verification — identity registry

The plugin's MCP-side identity (what gets stamped in Daily as
`@<name>`) is one of two artifacts; the **vault's identity registry**
(the human-/agent-readable list of who is allowed to write) is the
other. Both must agree, and both must be checked. Past install
sessions have skipped this and silently ended up with the runtime
writing under one identity that the registry never recorded — the MCP
server happily logged events without complaint, and the gap only
surfaced later when someone audited the vault.

After step 4's `o2b init --agent-name <name>` finishes, open
`<vault>/AI Wiki/identity/agents.md` and confirm it contains a line
like:

```
- <chosen-agent-name>: primary agent on this server
```

Multi-runtime installs build this list incrementally: each
`o2b init --agent-name X` appends another entry under
`## Registered agents` if `X` isn't already there. So on a vault
that already has Hermes registered, a fresh Codex install should
result in **two** lines — one for `hermes-vps-agent`, one for
`codex-vps-agent` — not just one.

If your runtime's identity is missing from the registry after
`o2b init` ran without errors, treat the install as **incomplete**:
report it to the user, then either re-run `o2b init --agent-name <name>`
(it's idempotent and will append the missing entry), or add the line
by hand if you have a reason not to re-run init. Don't proceed to
the daily-identity check below without this in place.

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
- [ ] for Hermes / Codex: `VAULT_AGENT_NAME` is exported in the
      environment that launches the MCP server (or set in the runtime's
      MCP-config stanza);
- [ ] for Claude Code: `agent_name` is persisted in
      `~/.config/open-second-brain/config.yaml` by `o2b init --agent-name`.
      Claude Code's bundled `.mcp.json` reads from that config at server
      spawn, so no `VAULT_AGENT_NAME` env var is required;
- [ ] `AI Wiki/identity/agents.md` contains the chosen agent name and no
      longer contains the `(add your agents here, …)` template
      placeholder;
- [ ] `event_log_append` called **without** an explicit `agent` argument
      writes a `Daily/*.md` entry under the chosen name (see Verification
      — daily identity above), not under `@agent`.

If any single item is missing, the install is **incomplete** — report
that to the user and do not mark the workflow as successful.
