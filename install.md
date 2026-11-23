# Open Second Brain installation

Open Second Brain ships one CLI (`o2b`), two MCP servers (the full
server and the always-loaded writer server), lifecycle hooks, and an
install adapter for each supported agent host. This page is the router:
install the package once, then connect each host you use. No host is
preferred.

## Prerequisites

Read [`install/prerequisites.md`](install/prerequisites.md) first: Bun,
vault discovery, the agent name and timezone, and the checks every install
ends with. On native Windows, read [`install/windows.md`](install/windows.md)
as well.

## Install from the registry

Bun 1.1 or later is the only prerequisite.

1. Install the package. It puts `o2b`, `o2b-mcp` and `o2b-hook` on `PATH`:

   ```bash
   bun add -g open-second-brain
   ```

2. Configure the machine, create or connect the brain, connect one host
   and verify, in one command:

   ```bash
   o2b setup --target cursor --vault /path/to/vault --agent-name "<agent-name>" --timezone UTC --apply --yes
   ```

   Replace `cursor` with your host (table below), the vault path and the
   agent name with your own values. A machine with no Obsidian vault uses
   `--no-vault` instead of `--vault <path>`:

   ```bash
   o2b setup --target cursor --no-vault --agent-name "<agent-name>" --timezone UTC --apply --yes
   ```

   Aider is the exception: its context file lives in the vault, so setup
   for `aider` on a machine with no vault stops with an error that asks for
   `--vault <path>`.

3. Restart the host so it loads the new servers.
4. Run `o2b setup --target <host> ...` again for every other host on this
   machine. The second run finds the machine configured and only connects
   the host.

Without `--apply`, setup prints its plan and writes nothing. On a fresh
machine `--apply` needs a vault choice (`--vault` or `--no-vault`), an agent
name and a timezone; `--yes` supplies consent and nothing else. An
interactive run asks for consent instead.

On a fresh machine, setup creates the brain store outside the vault, binds
the vault to it, and makes this installation the brain's dream owner and the
writer of the human view. From a registry install it registers the absolute
Bun path and the launcher inside the installed package, so the host does not
depend on the `PATH` it starts with. After registering, it runs an MCP probe
and the store self-test.

Setup exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Setup and verification passed |
| `1` | A runtime or self-test failure |
| `2` | Invalid usage or a missing choice |
| `3` | Verification found drift |
| `4` | A user-edited managed block needs attention |
| `5` | The host could not be reached |
| `6` | Consent was refused |
| `7` | A host step remains for you: installing a host plugin, or merging the printed configuration |

## Supported clients

| Client | How it connects | Guide |
| --- | --- | --- |
| Claude Code | Marketplace plugin: MCP servers and hooks. `o2b setup --target claude-code` prepares the machine and names the plugin step (exit `7`) | [`install/claudecode.md`](install/claudecode.md) |
| OpenAI Codex | `o2b setup --target codex`, or `o2b install --target codex --apply`; the marketplace plugin adds the hooks | [`install/codex.md`](install/codex.md) |
| ChatGPT desktop | Reads the shared Codex config: `o2b install --target codex --apply` | [`install/codex.md`](install/codex.md) |
| Hermes Agent | Plugin and memory provider. `o2b setup --target hermes` names the plugin step (exit `7`) | [`install/hermes.md`](install/hermes.md) |
| OpenClaw | Native plugin, no MCP. `o2b setup --target openclaw` names the plugin step (exit `7`) | [`install/openclaw.md`](install/openclaw.md) |
| opencode | `o2b setup --target opencode`: MCP servers and a native plugin | [`install/opencode.md`](install/opencode.md) |
| Grok Build | `o2b setup --target grok`: MCP servers and hooks | [`install/grok.md`](install/grok.md) |
| Cursor | `o2b setup --target cursor` | [`install/cursor.md`](install/cursor.md) |
| kiro | `o2b setup --target kiro` | [`install/kiro.md`](install/kiro.md) |
| GitHub Copilot CLI | `o2b setup --target copilot-cli` | [`install/copilot-cli.md`](install/copilot-cli.md) |
| Gemini CLI | `o2b setup --target gemini-cli` | [`install/gemini-cli.md`](install/gemini-cli.md) |
| ZCode | MCP servers added to its config by hand. `o2b setup --target zcode` names the step (exit `7`) | [`install/zcode.md`](install/zcode.md) |
| Aider | `o2b setup --target aider`: context file, no MCP | [`install/aider.md`](install/aider.md) |
| Pi | `o2b setup --target pi`: a skill over the CLI | [`install/pi.md`](install/pi.md) |
| Any other MCP host | `o2b setup --target generic` prints the server entries to merge (exit `7`) | [`install/generic.md`](install/generic.md) |

`o2b install --target <name> --apply --yes` connects a host on a machine
that is already configured, as before; `setup` runs the same adapter after
the machine steps. The capability overview of every surface is in
[`docs/features.md`](docs/features.md).

## Other ways to install

1. **From a clone.** Clone the repository and publish the launchers with
   `scripts/o2b install-cli`; see
   [`install/prerequisites.md`](install/prerequisites.md#get-the-o2b-cli).
   Do not mix a clone install and a registry install on one machine:
   doctor reports several different `o2b` on `PATH`.
2. **Through a host plugin.** Claude Code, Codex, Hermes and OpenClaw ship
   the launcher with their plugin; each guide shows how to publish it.
3. **Guided.** `o2b init --interactive` prints the full plan, asks for an
   explicit `yes`, then runs `o2b init` and the chosen `o2b install`
   targets.

## The dream owner and the dream agent

Dream is the pass that turns what agents recorded into rules and topics.
It runs on one installation, the dream owner, and starts by itself at the
first session of the day on that machine. The installation that creates
the brain becomes the owner when its agent name is known; check it with
`o2b dream owner`.

Model work in dream (summaries, topic wording, closed questions no decision
model answers) is done by your own agent in a short session. No preset
commands ship: set the command for your agent and verify it with a real
short call on the owner's machine:

```bash
o2b dream agent set '["/path/to/agent", "--your-flags", "{prompt}", "--mcp-config", "{mcp_config}"]'
o2b dream agent check
```

The command is a JSON array; nothing is split or quoted. Only a verified
command is used. Until one is set, that work waits in the dream queue and
doctor says so. Placeholders, isolation and drafts:
[`docs/dream.md`](docs/dream.md).

## Verify

```bash
o2b doctor --vault /path/to/vault --repo .
o2b install --check
o2b dream status
```

`o2b install --check` verifies each connected host (managed block or MCP
registration): exit `0` when every target is ok or not installed, `3` on
drift, `5` when a target is configured but proved unreachable. It needs a
vault: on a `--no-vault` machine it exits `2` before it checks a host, so
check the host in its own MCP listing instead.
`o2b doctor` covers the machine, the store and the vault; on a `--no-vault`
machine run it without `--vault`. `o2b dream status` shows whether
automatic dream is on and whether this machine is the dream owner. Every
exit code is in [`docs/cli-reference.md`](docs/cli-reference.md).

## Uninstall

For MCP-aware hosts:

```bash
o2b uninstall --target <name> --apply
```

Removes exactly what `o2b install --target <name>` wrote (recorded in the
install manifest). For hosts that ship their own plugin uninstall command,
see the matching `install/<host>.md`. Uninstall never deletes the vault,
its Markdown files or the brain store. Finishing steps and the local
cleanup are in [`after-install.md`](after-install.md#uninstall).

When every host is disconnected, remove the registry package, which takes
`o2b`, `o2b-mcp` and `o2b-hook` off `PATH`:

```bash
bun remove -g open-second-brain
```

A clone install removes its launchers with `o2b uninstall --remove-cli`
instead.

## Installation readiness criteria

The installation is complete only when all of the following hold:

1. The host integration is installed (plugin, managed block, symlink or
   printed entries merged).
2. The host was restarted to pick up the change.
3. `o2b install --check` reports `ok` (or `installed` for `generic`) for
   the target, or `o2b setup` exited `0` with host verification `ok`.
4. `o2b doctor` reports no failure.
5. `o2b status` shows the chosen `agent_name`, and a test signal recorded
   without an explicit agent carries that name, not the literal `agent`.
6. For MCP hosts (Cursor, opencode, Grok Build, kiro, Copilot CLI, Gemini
   CLI, Claude Code, Codex, Hermes, ZCode; not Aider, Pi or `generic`):
   the host's MCP listing shows the Open Second Brain tools.

If any item is missing, the install is incomplete: report that to the user
and do not mark the workflow as successful.
