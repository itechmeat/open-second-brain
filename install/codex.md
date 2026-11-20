# Codex

Codex installs OSB through its marketplace + MCP subsystems. The MCP
registration is driven by the `codex` install adapter, so the steps below
are the same two commands every other adapter-backed runtime uses.

## 1. Install the plugin

```bash
codex plugin marketplace add itechmeat/open-second-brain
```

Then enable it by adding to `~/.codex/config.toml`:

```toml
[plugins."open-second-brain@open-second-brain"]
enabled = true
```

## 2. Publish the `o2b` CLI on PATH

`codex plugin marketplace add` clones the whole repository into
`$CODEX_HOME/.tmp/marketplaces/open-second-brain/`, and that clone holds
the launcher. The installed plugin in `$CODEX_HOME/plugins/cache/` holds
only the `plugins/codex` subtree (manifest, `hooks/hooks.json`, skills),
not `scripts/`. The hooks run `o2b-hook` from PATH, so this step is also
what turns them on. Locate the script in the clone (under `CODEX_HOME`
when it is set):

```bash
O2B_SCRIPT="$(find "${CODEX_HOME:-$HOME/.codex}/.tmp/marketplaces" -path '*open-second-brain*/scripts/o2b' -type f 2>/dev/null | head -1)"
[ -n "$O2B_SCRIPT" ] || { echo "o2b launcher not found in the Codex marketplace clone" >&2; exit 1; }
"$O2B_SCRIPT" install-cli
```

The clone arrives without `node_modules`, and the launcher heals that
itself: the first time it runs, it notices the missing dependency tree and
executes `bun install --frozen-lockfile` inside the clone once, announced
by a one-line notice on stderr. Every later run finds the tree present and
boots straight into the CLI. If that install cannot run - no network, or a
clone the launcher cannot write - the launcher exits nonzero and names the
manual command instead of dying with a module-not-found trace. Running
`bun install --frozen-lockfile` inside the clone yourself repairs the same
state.

## 3. Initialize the vault

```bash
o2b init --vault /path/to/vault --name "My Second Brain" \
    --agent-name "<chosen-agent-name>" --timezone "<chosen-tz>"
o2b brain init --vault /path/to/vault
```

## 4. Register the MCP servers

```bash
o2b install --target codex --vault /path/to/vault
o2b install --target codex --vault /path/to/vault --apply --yes
```

The first command plans and writes nothing; the second applies. With the
`codex` binary on PATH the adapter registers both servers through
`codex mcp add`, which persists them into `$CODEX_HOME/config.toml`.
Without it, the adapter merges the same two `[mcp_servers.*]` tables into
that file directly, leaving every other table - including the
`[plugins."..."]` and `[marketplaces....]` blocks above - byte-for-byte
intact.

`$CODEX_HOME` is written that way throughout this page rather than as
`~/.codex`, because the variable is what the adapter resolves and
`~/.codex` is only its default. Setting `CODEX_HOME` relocates the whole
Codex configuration directory, and the adapter follows it on every path:
the file it merges, the `CODEX_HOME` it exports to the `codex mcp add`
subprocess, the `codex mcp list` it runs to verify, and the session roots
`o2b` sweeps for transcripts.

The adapter sets `VAULT_AGENT_NAME` for you, to Codex's own
host-qualified identity: it keeps the host segment of your configured
`agent_name` and substitutes `codex` as the vendor token, so an
`agent_name` of `claude-vps-agent` registers as `codex-vps-agent`. That
makes Codex's Brain writes distinguishable per runtime, and in a shared
multi-device vault also per device - the same derivation the `grok` and
`opencode` adapters apply.

## ChatGPT desktop

ChatGPT desktop has no MCP registration of its own: it reads the shared
Codex configuration at `$CODEX_HOME/config.toml` (default
`~/.codex/config.toml`), the same file the `codex` target writes. One
registration serves both, so the install command is the codex one from
step 4 (add `--vault`, `--apply` and `--yes` as there):

```bash
o2b install --target codex --apply
```

Steps 1 and 2 need the `codex` binary - they drive the marketplace
clone it creates. A desktop-only machine without the Codex CLI skips
both and installs the `o2b` CLI by hand instead, exactly as
`install/prerequisites.md` describes (`scripts/o2b install-cli` links
`o2b` into `~/.local/bin`); with `o2b` on PATH, the install command
above is all that remains of this page.

Install writes the two `[mcp_servers.*]` tables into that shared file -
through `codex mcp add` when the `codex` binary is on PATH, otherwise
through the direct TOML merge. In the merge case the detect output of
`o2b install` names ChatGPT desktop as a reader of the file. ChatGPT
desktop picks the servers up on its next session start, and `$CODEX_HOME`
relocates the file for both hosts exactly as documented above.

`o2b uninstall --target codex --apply` removes the shared registration,
which undoes it for ChatGPT desktop at the same time. Uninstall resolves
the vault through the same chain install does, so aim it at the vault
the install wrote: pass the same `--vault` (or set `VAULT_DIR` the same
way), because the install manifest it reads lives there. Only the two
Open Second Brain tables are removed; every other table in the file
stays.

## 5. Verify

```bash
o2b install --check --target codex --vault /path/to/vault
o2b doctor --vault /path/to/vault --repo .
```

A successful check prints:

<!-- expected-output: o2b install --check --target codex -->

```text
o2b install --check
--------------------
  codex         ok                `codex mcp list` reports both OSB servers registered
```

That line is the host's own answer: the check runs `codex mcp list` and
reports what Codex says it has registered. When the binary is not on
PATH, or exits non-zero, or does not answer within the probe's timeout,
the check names that obstacle instead and falls back to what
`$CODEX_HOME/config.toml` declares - and it declares a table only where
the header stands on its own line, so a commented-out
`# [mcp_servers.open-second-brain]` reads as absent, which is what an
operator who commented it out meant. This block is asserted
against the adapter's real `verify()` output by
`tests/docs/install-verify-conformance.test.ts`, so it cannot drift from
the code.

Run the daily-identity check from `install/prerequisites.md`.

## Lifecycle hooks (trust them once)

The bundled `hooks/hooks.json` registers the same hooks as the Claude
Code plugin, on nine events: `SessionStart` (the session start digest),
`UserPromptSubmit` (the per-turn lanes such as neighbour updates and
recall), `PreToolUse` (orientation and the host-file backup before a
write), `PostToolUse` (the write reminders and re-grounding), `Stop`,
`SubagentStart`, `SubagentStop`, `SessionEnd` and `PostCompact` (session
capture, subagent context and the digest after a compaction). Each runs
`o2b-hook` from PATH, which step 2 above wires.

Codex runs a hook only after you have trusted it. Its hooks documentation
says that non-managed hooks (the plugin's, and a `hooks.json` in
`CODEX_HOME` or a project's `.codex`) must be reviewed and trusted before
they run, that trust is recorded against each hook's hash, and that a new
or changed hook, or a plugin update that changes a bundled script, is
skipped until it is trusted again. Hooks are on by default; `[features]
hooks = false` in `config.toml` turns them off.

- **Interactive Codex:** open `/hooks` in the CLI (in the desktop app,
  **Review hooks** in the composer or **Settings > Hooks**) and trust the
  Open Second Brain hooks. Do it again after a plugin update asks for it.
- **`codex exec`:** a non-interactive run never asks and skips an
  untrusted hook without a word (openai/codex issue 46210, open at the
  time of writing): the MCP tools work, but no digest and no neighbour
  updates reach the model. Trust the hooks once in an interactive session
  with the same `CODEX_HOME`, and later `codex exec` runs use them. For
  automation that vets its hook sources itself, `codex exec
  --dangerously-bypass-hook-trust` runs the enabled hooks for that one
  invocation without stored trust.
- **Without hooks** a session gets the Open Second Brain context only
  through the `brain_context` tool, and the MCP server's instructions tell
  a session whose context opened without the active-preferences digest to
  call it first. Neighbour updates have no tool form; such a session sees
  what other sessions recorded on a topic through `brain_topic` action
  `show`.

The Codex MCP server is not told which Codex session it serves, so the
topic records a Codex agent writes carry no session stamp, and another
session of the same agent name on the same machine counts them as its own
(see "Neighbour updates" in [`docs/how-it-works.md`](../docs/how-it-works.md)).
A launcher that knows the session can name it with
`OPEN_SECOND_BRAIN_SESSION_ID`. Set it in the environment Codex starts
with, where the hooks see it, and forward it to the Open Second Brain
servers with `env_vars = ["OPEN_SECOND_BRAIN_SESSION_ID"]` in their
`[mcp_servers.<name>]` tables: Codex gives an MCP server only a short
fixed list of variables otherwise (checked on codex-cli 0.169.0). Without
the forwarding the records stay unstamped, which is the old behaviour,
not a fault; never set it only in a server's `env` table, which the
hooks do not see. The writer and the hook both prefer this variable to
any host session id. Two mistakes give different results. A value shared
by several sessions (set machine-wide, or once for a launcher or bridge
that serves several) gives them all one stamp: each session takes the
others' records for its own, and none of them gets the others' neighbour
updates. A value that reaches only one side (the server stamps it while
the hooks resolve Codex's own session id, or the other way round) gives
the two sides different stamps: each session is shown its own records
once. Set it per session, in the environment both sides see. Use a value
nobody can guess, such as a UUID: the stamp is an unsalted hash of the
value and is synced with the record, so a short or predictable value can
be recovered from it.

## Machine-enforce write protection (optional)

```bash
o2b brain protect --target codex --vault /path/to/vault --apply --yes
o2b brain unprotect --target codex --vault /path/to/vault
```

The sidecar manifest at
`<vault>/.open-second-brain/protect.lock.json` records exactly
what was added; `unprotect` removes the same.

## Update

```bash
codex plugin marketplace upgrade open-second-brain
```

An upgrade replaces the clone, so its `node_modules` is gone afterwards.
No extra step is needed: the next launcher run notices the missing
dependency tree and reinstalls it, exactly as in step 2 (the same one-line
notice on stderr, and the same manual `bun install --frozen-lockfile`
fallback if the automatic install cannot run).

## Uninstall

```bash
o2b uninstall --target codex --vault /path/to/vault --apply
codex plugin marketplace remove open-second-brain
o2b uninstall --apply-local --remove-cli
```

`o2b uninstall --target codex` removes only the two OSB server
registrations - through `codex mcp remove` when the binary is present,
and by stripping the two tables from `~/.codex/config.toml` when it is
not. Every other table in that file is left alone.
