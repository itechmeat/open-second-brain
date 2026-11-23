# Google Gemini CLI

`o2b install --target gemini-cli --apply` writes the two Open Second Brain MCP
servers into `~/.gemini/settings.json` under the `mcpServers` key
(documented at
`github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md`).
Existing entries are preserved.

## Install

On a fresh machine with the registry package, one command configures
the machine and the brain, runs this install and verifies it (see
[`install.md`](../install.md#install-from-the-registry)):

```bash
o2b setup --target gemini-cli --vault /path/to/vault --agent-name "<agent-name>" --timezone UTC --apply --yes
```

On a machine that is already configured, the adapter alone:

```bash
o2b install --target gemini-cli --apply --yes
```

## Verify

```bash
o2b install --check --target gemini-cli
```

A successful check prints:

<!-- expected-output: o2b install --check --target gemini-cli -->

```text
o2b install --check
--------------------
  gemini-cli    ok                $HOME/.gemini/settings.json: both OSB keys match the canonical payload (configuration comparison; no MCP handshake attempted)
```

`$HOME` stands in for your home directory. This block is asserted
against the adapter's real `verify()` output by
`tests/docs/install-verify-conformance.test.ts`, so it cannot drift
from the code.

## Uninstall

```bash
o2b uninstall --target gemini-cli --apply
```

## Notes

- A liveness check for the runtime itself is `gemini --version`
  exit-code 0. `o2b mcp --probe` covers the MCP-side handshake.
