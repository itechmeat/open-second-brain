# CLAUDE.md

Guidance for agents working in this repository.

## Versioning

`package.json` `version` is the single source of truth. The version is
mirrored into several manifests (`plugin.yaml`, `plugins/hermes/plugin.yaml`,
`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
`plugins/codex/.codex-plugin/plugin.json`, `openclaw.plugin.json`) and
`pyproject.toml`.

Never hand-edit the version in those mirrored files. To bump the version,
edit `package.json` only, then propagate with:

```
bun run scripts/sync-version.ts
```

CI gates on `bun run scripts/sync-version.ts --check` (the `validate` job,
step "Verify manifest version sync"). Hand-editing one file leaves the
others drifted and fails that gate before any other check runs. Run the
`--check` form locally before pushing a version change.
