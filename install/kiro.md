# kiro

`o2b install --target kiro --apply` writes the two OSB MCP servers
into `~/.kiro/settings.json` via JSON-merge. User-authored entries
are preserved.

## Install

```bash
o2b install --target kiro --apply
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
  kiro          ok                $HOME/.kiro/settings.json: both OSB keys present
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
