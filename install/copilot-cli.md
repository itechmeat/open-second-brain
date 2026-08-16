# GitHub Copilot CLI

`o2b install --target copilot-cli --apply` registers the two OSB
MCP servers with the GitHub Copilot CLI. The primary path calls
`copilot mcp add` per server name; if the CLI is missing or its
`add` step fails, the adapter falls back to writing
`${XDG_CONFIG_HOME:-$HOME/.config}/github-copilot/mcp.json`
directly and prints a stderr note.

## Install

```bash
o2b install --target copilot-cli --apply
```

The adapter records which mode it used (`subprocess` or
`json-merge` fallback) in the sidecar manifest so `uninstall`
mirrors the same path.

## Verify

```bash
o2b install --check --target copilot-cli
```

Verify always asks `copilot mcp list` what this host has registered - the
probe is declared on the `copilot-cli` row of the runtime fact table, it
needs no API key and starts no model turn. When the binary is absent or
exits non-zero, the check says so by name ("host probe skipped: `copilot`
is not on PATH") rather than reporting a handshake it never attempted.

What the answer is worth depends on how the install was applied. In
subprocess mode the host CLI holds the only record, so a probe that
cannot run leaves nothing verified and the check exits `5`. In
file-fallback mode the config file is compared as well, so a skipped
probe still leaves a verified configuration - and a probe that ANSWERS
without listing the servers means the host has not loaded that file,
which is also exit `5`.

A successful check prints:

<!-- expected-output: o2b install --check --target copilot-cli -->

```text
o2b install --check
--------------------
  copilot-cli   ok                `copilot mcp list` reports both OSB servers registered
```

`$HOME` stands in for your home directory. This block is asserted
against the adapter's real `verify()` output by
`tests/docs/install-verify-conformance.test.ts`, so it cannot drift
from the code.

### Exit code 5 (since v1.46.0)

This is currently the only target whose verify can exit `5`. Because it
asks `copilot mcp list` rather than reading a file, it is the one adapter
that can prove a runtime unreachable, and that verdict is now its own exit
code instead of sharing `0` with `not-installed`. A script that gates on
`o2b install --check` and treated a zero exit as "everything is fine" will
now see a failure here where it previously saw success. The full table of
codes is in
[`docs/cli-reference.md`](../docs/cli-reference.md#o2b-install-exit-codes).

## Uninstall

```bash
o2b uninstall --target copilot-cli --apply
```

## Notes

- Upstream reference:
  `docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers`.
- The exact `copilot mcp add` flag names are pinned to the CLI
  version current at v0.10.11 implementation time. If a Copilot CLI
  release renames flags, expect the adapter to fall back to the
  file-merge path automatically — `o2b install --check` will
  surface the change.
