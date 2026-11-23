# kiro

`o2b install --target kiro --apply` writes the two Open Second Brain MCP servers
into `~/.kiro/settings.json` via JSON-merge. User-authored entries
are preserved.

## Install

On a fresh machine with the registry package, one command configures
the machine and the brain, runs this install and verifies it (see
[`install.md`](../install.md#install-from-the-registry)):

```bash
o2b setup --target kiro --vault /path/to/vault --agent-name "<agent-name>" --timezone UTC --apply --yes
```

On a machine that is already configured, the adapter alone:

```bash
o2b install --target kiro --apply --yes
```

Restart kiro to load the new servers.

## Verify

```bash
o2b install --check --target kiro
```

A successful check prints:

<!-- expected-output: o2b install --check --target kiro -->

```text
o2b install --check
--------------------
  kiro          ok                $HOME/.kiro/settings.json: both OSB keys match the canonical payload (configuration comparison; no MCP handshake attempted)
```

`$HOME` stands in for your home directory. This block is asserted
against the adapter's real `verify()` output by
`tests/docs/install-verify-conformance.test.ts`, so it cannot drift
from the code.

## Uninstall

```bash
o2b uninstall --target kiro --apply
```

## Notes

- Confirm the upstream kiro MCP config path against the project's
  current docs before adopting on a new release.
