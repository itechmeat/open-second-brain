# Aider

Aider has no native MCP client at the time this file was written.
`o2b install --target aider --apply` instead writes a marker-fenced
managed block into `~/.aider.conf.yml` that points at a generated
context file under the vault. Aider auto-includes that file as
read-only context on every chat turn.

## Install

```bash
o2b install --target aider --apply
```

The command:

1. Renders `templates/install/aider-context.md.tmpl` to
   `<vault>/.open-second-brain/aider-context.md` with the current
   `@agent_name` and vault path substituted in.
2. Appends a managed block to `~/.aider.conf.yml` under `read:`
   listing the generated file.

The block is fenced by
`# >>> open-second-brain managed >>>` /
`# <<< open-second-brain managed <<<`. Anything outside those
markers is preserved byte-for-byte.

## Verify

```bash
o2b install --check --target aider
```

Confirms both the managed block and the sidecar context file are
on disk.

## Uninstall

```bash
o2b uninstall --target aider --apply
```

Removes the managed block plus the generated context file. Your
own `~/.aider.conf.yml` content above and below the block stays.

## Notes

- If you also set a project-local `read:` list elsewhere in
  `~/.aider.conf.yml`, Aider's YAML loader treats duplicate
  top-level keys as ambiguous. Merge the two `read:` lists by hand
  if you keep your own.
- Aider was tracked as a potential MCP host in the v0.10.11
  design. If a future Aider release ships native MCP, this adapter
  will switch to JSON-merge transparently — the CLI surface stays
  the same.
