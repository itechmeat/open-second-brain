# Pi (pi.dev)

Pi intentionally chose "CLI-tool + README + skill" over MCP. OSB
installs as a thin skill that points at the `o2b brain *` CLI
verbs.

## Install

```bash
o2b install --target pi --apply
```

Creates a symlink at `${PI_HOME:-$HOME/.pi}/skills/brain-memory`
pointing at the bundled `skills/brain-memory/` directory inside
this plugin checkout. Override the destination with
`--pi-skill-dir <path>`.

## Verify

```bash
o2b install --check --target pi
```

Confirms the symlink is valid and the source `SKILL.md` is
readable.

## Uninstall

```bash
o2b uninstall --target pi --apply
```

Removes the symlink only. The bundled source directory is never
deleted.

## Notes

- If the Pi runtime stabilises a different convention for its
  skill directory in the future, `--pi-skill-dir` is the override
  knob until the adapter picks up the new path automatically.
- An existing non-symlink directory at the target path is refused
  without `--force`. This guards a user-authored folder under
  `~/.pi/skills/brain-memory/`.
