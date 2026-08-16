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

Codex caches the plugin at a version-hashed path; locate the
script:

```bash
O2B_SCRIPT="$(find ~/.codex -path '*open-second-brain*/scripts/o2b' -type f 2>/dev/null | head -1)"
[ -n "$O2B_SCRIPT" ] || { echo "o2b installer not found in Codex plugin cache" >&2; exit 1; }
"$O2B_SCRIPT" install-cli
```

## 3. Initialize the vault

```bash
o2b init --vault /path/to/vault --name "My Second Brain" \
    --agent-name "<chosen-agent-name>" --timezone "<chosen-tz>"
o2b brain init --vault /path/to/vault
```

## 4. Register the MCP servers

```bash
o2b install --target codex --vault /path/to/vault
o2b install --target codex --vault /path/to/vault --apply
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

## Lifecycle hooks (auto-enabled)

The bundled `hooks/hooks.json` registers a `PostToolUse` hook
(matcher `Write|Edit|MultiEdit|apply_patch`) that invokes
`o2b-hook` from PATH after every file-mutating tool succeeds. Step
2 above wires it.

## Machine-enforce write protection (optional)

```bash
o2b brain protect --target codex --vault /path/to/vault --apply
o2b brain unprotect --target codex --vault /path/to/vault
```

The sidecar manifest at
`<vault>/.open-second-brain/protect.lock.json` records exactly
what was added; `unprotect` removes the same.

## Update

```bash
codex plugin marketplace upgrade open-second-brain
```

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
