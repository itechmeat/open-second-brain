# OpenSecondBrain

OpenSecondBrain gives Hermes Agent a small, filesystem-first second brain for Obsidian-compatible Markdown vaults.

It is built for Hermes first: install it as a Hermes plugin, point it at a vault, and let Hermes use deterministic commands for the parts that should not depend on model reasoning — setup checks, vault bootstrap, daily event logging, safe config export, and wiki indexing.

Claude Code, OpenAI Codex, and OpenClaw are supported through lightweight adapter manifests and the MCP tool server. Hermes is the primary runtime.

## What it does today

- Bootstraps an agent-owned area inside your vault: `AI Wiki/` plus `_OPEN_SECOND_BRAIN.md`.
- Appends agent events to daily Markdown notes without editing your manual notes above `## Raw events`.
- Regenerates a simple Markdown page index from frontmatter and wikilinks.
- Exports config snapshots with secret-like values redacted.
- Runs health checks for the vault, config file, Hermes plugin, and Claude/Codex manifests.
- Ships with dependency-free CLI wrappers: `scripts/o2b` and `scripts/vault-log`.

OpenSecondBrain does not run a daemon, replace your vault, or write hidden background state outside the configured vault/config paths.

## Installation

> **Agent-assisted install (recommended):** The easiest way to install this plugin is to send your agent the following prompt with a link to the installation guide. <ins>Replace `[your_agent_name, Hermes for example]` with the runtime you are installing into</ins> — for example `Hermes`, `Claude Code`, `Codex`, or `OpenClaw`. The agent uses that name to pick the correct branch in the install guide.
>
> ```
> Install the open-second-brain plugin for [your_agent_name, Hermes for example] following the instructions at https://raw.githubusercontent.com/itechmeat/open-second-brain/main/install.md
> ```
>
> The guide at `install.md` contains exact commands for both Hermes and OpenClaw runtimes. Below are the same instructions for manual installation.

### Install in Hermes

In the Hermes Dashboard:

1. Open Plugins.
2. Choose Install from GitHub / Git URL.
3. Paste this repository URL:

```text
https://github.com/itechmeat/open-second-brain
```

4. Install and enable the plugin.
5. Restart Hermes or start a fresh session if the plugin list was already loaded.

Hermes also supports the same flow from the CLI:

```bash
hermes plugins install itechmeat/open-second-brain --enable
hermes gateway restart
```

Then publish the CLI commands to PATH, initialize the vault, register the MCP server, and verify:

```bash
~/.hermes/plugins/open-second-brain/scripts/o2b install-cli
o2b init --vault /path/to/vault --name "My Second Brain"
hermes mcp add open-second-brain --command o2b --args mcp --vault /path/to/vault
hermes gateway restart
o2b doctor --vault /path/to/vault --repo .
```

### Install in OpenClaw

OpenClaw supports this project through the **Native plugin format**: a root `package.json` with `openclaw.extensions` pointing to a JS entry that registers tools natively inside OpenClaw's Node.js process. The JS entry spawns the Python CLI as a subprocess, so no MCP server is needed for basic operation.

Install from Git (always installs the latest from `main`; do not append `@v...`):

```bash
openclaw plugins install git:github.com/itechmeat/open-second-brain
```

Or from a local checkout:

```bash
openclaw plugins install ./open-second-brain
```

After installing, configure the vault path, instance name, and agent identity:

```bash
openclaw config set plugins.entries.open-second-brain.config.vault '"/path/to/vault"'
openclaw config set plugins.entries.open-second-brain.config.instanceName '"My Second Brain"'
openclaw config set plugins.entries.open-second-brain.config.agentName '"openclaw-main"'
```

`agentName` is the identity used in `Daily/*.md` event log entries
(`- HH:MM — @openclaw-main — message`). Pick a name that makes the host
or runtime obvious — `openclaw-main`, `openclaw-server`,
`<hostname>-openclaw`, etc.

Tools are registered natively by the JS plugin entry — no MCP registration is needed. The five tools (`second_brain_status`, `second_brain_query`, `second_brain_capture`, `event_log_append`, `vault_health`) are available immediately after install and gateway restart. The optional MCP server (`o2b mcp`) can still be enabled for runtimes that prefer the MCP protocol.

## First run

Create or update the OpenSecondBrain profile inside a vault. Pass
`--agent-name` to register the identity used in Daily event log entries:

```bash
scripts/o2b init --vault /path/to/vault --name "My Second Brain" --agent-name "openclaw-main"
```

Check that the vault and runtime adapters are healthy:

```bash
scripts/o2b doctor --vault /path/to/vault --repo .
```

Append an agent event:

```bash
scripts/o2b append-event --vault /path/to/vault --as hermes "initialized OpenSecondBrain"
```

Refresh the Markdown page index:

```bash
scripts/o2b index --vault /path/to/vault
```

## CLI commands

```text
o2b status                    Show config/vault status
o2b init                      Bootstrap the vault profile
o2b install-cli               Symlink o2b and vault-log into ~/.local/bin
o2b doctor                    Run vault and adapter checks
o2b append-event              Append one daily event-log entry
o2b index                     Rebuild the Markdown page index
o2b export-config             Write a redacted config snapshot
o2b mcp                       Run the optional MCP tool server (stdio)
o2b uninstall                 Print an uninstall plan; --apply-local removes config; --remove-cli removes symlinks
o2b init-pay-memory           Bootstrap AI Wiki/{policies,payments,assets,drafts,reports}/
o2b append-payment-receipt    Save a Markdown receipt for a paid API call
o2b capture-asset             Save a Markdown note for a generated asset
o2b payment-report            Aggregate a date's receipts into a Markdown report
o2b check-payment-policy      Evaluate a paid call against policies/spending.json
o2b request-payment-approval  Create a pending payment request (human must approve)
o2b approve-payment-request   Mark a pending request as approved (human action)
o2b reject-payment-request    Mark a pending request as rejected (human action)
o2b consume-payment-request   Link an approved request to its resulting receipt
o2b list-pending-payments     List pending/approved/etc. requests
o2b payment-digest            Render a 4-line digest for a date (Hermes cron-friendly)
vault-log                     Compatibility wrapper around append-event
```

After running `o2b install-cli`, the bare `o2b` and `vault-log` commands are available on PATH. The local checkout can also be used without installing the Python package — run commands through `scripts/o2b` and `scripts/vault-log`, or set `PYTHONPATH=src` for module execution.

## Optional MCP tool server

OpenSecondBrain ships an optional Model Context Protocol server that exposes the same deterministic operations as MCP tools. Register it through Hermes from the CLI:

```bash
hermes mcp add open-second-brain --command o2b --args mcp --vault /path/to/vault
```

Or edit `~/.hermes/config.yaml` directly:

```yaml
mcp_servers:
  open-second-brain:
    command: o2b
    args: ["mcp", "--vault", "/path/to/vault"]
```

Tools: `second_brain_status`, `second_brain_query`, `second_brain_capture`, `event_log_append`, `vault_health`, plus the four Pay Memory tools described below. See `docs/mcp.md` for full setup, tool schemas, and Claude Code/Codex notes. The CLI remains the supported baseline; the MCP server is opt-in.

## Pay Memory

Pay Memory is an audit layer for paid agent actions. The agent makes the
paid API call itself (typically through `pay` from
[solana-foundation/pay](https://github.com/solana-foundation/pay)); Open
Second Brain records the reason, the policy check, the receipt, and any
generated asset as plain Markdown inside the vault.

```bash
o2b init-pay-memory --vault /path/to/vault
# → AI Wiki/{policies,payments,assets,drafts,reports}/ and policies/spending.md

# After running `pay --sandbox curl …` and capturing the output:
o2b append-payment-receipt \
  --vault /path/to/vault \
  --service paysponge/fal \
  --status success \
  --reason "Generate one original blog header image" \
  --actual-amount 0.05 --currency USDC \
  --result-ref https://fal-cdn.example/img.png \
  --result-note "AI Wiki/assets/blog-header.md" \
  --raw-output-file /tmp/pay-output.txt

o2b capture-asset \
  --vault /path/to/vault \
  --title "Blog Header: Pay Memory" \
  --service paysponge/fal \
  --result-url https://fal-cdn.example/img.png \
  --source-receipt "AI Wiki/payments/2026-05-10/<receipt-slug>.md"

o2b payment-report --vault /path/to/vault --date 2026-05-10
```

Open Second Brain never executes payments and never holds wallet keys. The
spending policy at `AI Wiki/policies/spending.md` is read by the agent
before each paid call; this MVP does not enforce policy at runtime.

`--raw-output-file` is run through a redactor that masks values for
`api_key` / `token` / `secret` / `bearer` / `authorization` / `private_key` /
`password` / `passwd` / `pwd` / `credential` / `session_token` in env, YAML,
JSON, and HTTP-header shapes. Best-effort only — verify the saved receipt
before sharing it externally.

### Optional: machine-readable spending policy

Pay Memory's default policy is the Markdown document at
`AI Wiki/policies/spending.md` — read by the agent before each paid call,
enforced by convention. To enable runtime enforcement, drop a JSON
companion at `AI Wiki/policies/spending.json`:

```json
{
  "schema_version": 1,
  "currency": "USDC",
  "max_total_per_day": 0.10,
  "max_single_call": 0.07,
  "allowed_services": ["paysponge/fal"],
  "max_per_category": { "media_generation": 1 },
  "require_approval_above": 0.05
}
```

Then have the agent (or the user) run:

```bash
o2b check-payment-policy --service paysponge/fal --expected-amount 0.05
```

Exit codes are `0` (allowed), `1` (denied), `3` (approval required) so a
shell script can branch. The MCP tool `payment_policy_check` returns the
same structured decision.

If `spending.json` is absent, the check fails open (`has_policy: false`)
— existing flows that rely on the Markdown-only policy keep working.

### Optional: approval workflow

For paid calls that should not happen until a human signs off, Pay Memory
ships a pending-payment-request artifact under `AI Wiki/payments/_pending/`
with a `pending → approved/rejected → consumed` state machine.

Agent side:

```bash
o2b request-payment-approval \
  --service paysponge/fal \
  --reason "Generate one blog header image" \
  --expected-amount 0.05 --currency USDC
# → AI Wiki/payments/_pending/req-2026-05-10-1000-fal-...md
```

Human side, after reviewing the request file in Obsidian:

```bash
o2b approve-payment-request --id <id> --approved-by <name>
# or
o2b reject-payment-request  --id <id> --rejected-by <name> --reason "..."
```

Agent side, after the approved paid call succeeded and the receipt was
saved:

```bash
o2b consume-payment-request --id <id> \
  --receipt "AI Wiki/payments/2026-05-10/<receipt-slug>.md"
```

The MCP-server side mirrors `payment_request_approval`,
`payment_request_status` (poll for approval), and `payment_request_consume`.

### Optional: daily Telegram digest via Hermes cron

`o2b payment-digest --vault <vault> --date <YYYY-MM-DD>` renders a 4-line
Russian summary suitable for delivery via Hermes cron `--script --no-agent`
jobs. See [`docs/hermes-cron.md`](docs/hermes-cron.md) for the
ready-to-paste `hermes cron create` command.

### Installing the `pay` CLI on a Linux VPS

`pay` is the Solana-Foundation payment wrapper that turns a regular HTTP
client into one that handles HTTP 402 payment challenges. It is published
as a prebuilt static binary on GitHub Releases — no Rust toolchain or
Node.js is needed on the host:

```bash
TAG=pay-v0.16.0  # pin a specific release
gh release download "$TAG" -R solana-foundation/pay \
  -p 'pay-x86_64-unknown-linux-gnu.tar.gz' -p 'sha256sums.txt' -D /tmp
cd /tmp && sha256sum -c --ignore-missing sha256sums.txt
tar -xzf pay-x86_64-unknown-linux-gnu.tar.gz
sudo install -m 0755 pay /usr/local/bin/pay
pay --version
```

Sandbox mode (`pay --sandbox curl <url>`) does **not** require running
`pay setup` first — it generates an ephemeral Solana keypair and funds it
locally via the Surfpool sandbox RPC. That makes it safe to wire into a
CI / e2e test that exercises the full Pay Memory pipeline without spending
real funds. See `tests/e2e/pay-memory-sandbox.sh` for a reference run.

For non-sandbox use the local secure storage helper (macOS Keychain, GNOME
Keyring, Windows Hello, 1Password) is configured by `pay setup`. Open
Second Brain itself never holds wallet keys.

## Updating

OpenSecondBrain follows the standard Hermes plugin update flow.

```bash
hermes plugins update open-second-brain
hermes gateway restart
```

`hermes plugins update` runs `git pull` inside the installed plugin directory; it does not rewrite your `~/.hermes/config.yaml` MCP registration. After an update:

- The `o2b` CLI is upgraded automatically.
- The MCP entrypoint stays registered, so no `hermes mcp add` is needed for an in-place upgrade.
- Restart the gateway (or open a fresh Hermes session) so cached plugin metadata and the MCP subprocess are reloaded.
- Run `o2b doctor --vault /path/to/vault --repo .` to confirm the new manifest still validates.

The `version` field in `plugin.yaml` is informational — Hermes installs whatever the current `main` branch contains. Pin to a specific release by checking out a tag inside the plugin directory if you want stricter control.

## Uninstalling

OpenSecondBrain treats your vault as the source of truth and never removes Markdown notes, `Daily/`, or `AI Wiki/`. Uninstalling has three independent layers; do them in this order.

1. Print a plan and review the leftovers (read-only):

   ```bash
   o2b uninstall
   ```

   The plan tells you which Hermes commands to run yourself, where the machine-local config directory lives, and reminds you that the vault is untouched. The dry-run never modifies the filesystem.

2. Deregister the MCP server, clean up CLI symlinks, and remove the Hermes plugin (Hermes-owned state):

   ```bash
   hermes mcp remove open-second-brain
   o2b uninstall --apply-local --remove-cli
   hermes plugins remove open-second-brain
   hermes gateway restart
   ```

   `hermes mcp remove` deletes the MCP registration and any OAuth tokens. `o2b uninstall --remove-cli` removes the CLI symlinks — run it *before* `hermes plugins remove` so the plugin directory still exists for symlink verification. `hermes plugins remove` deletes the installed plugin directory. OpenSecondBrain itself never edits `~/.hermes/config.yaml` — these commands are run by you against Hermes.

3. Optionally remove the machine-local config directory (typically `~/.config/open-second-brain` or `$OPEN_SECOND_BRAIN_CONFIG`'s parent):

   ```bash
   o2b uninstall --apply-local
   ```

   `--apply-local` only removes that one config directory. It refuses to act outside its intended scope — it never touches the vault, Hermes config, or anything else.

To delete the vault you must do that yourself with normal filesystem tools — OpenSecondBrain will not do it for you, even with `--apply-local`.

## Safety model

- Your notes stay as plain Markdown.
- Secrets are not meant to be stored in the vault.
- Config export redacts secret-like keys and values.
- Daily logs are append-only below `## Raw events`.
- The current Hermes plugin only registers lightweight health checks; it does not start background jobs.

## Repository

GitHub: https://github.com/itechmeat/open-second-brain

License: MIT.
