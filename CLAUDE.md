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

### WHEN to bump: inside the feature PR, before the first push

The version bump is part of the change itself, NOT a separate later step.
Bump `package.json` (and run `sync-version.ts`) on the feature branch and
include it in the SAME pull request as the feature, before you push. Every
release-bearing squash commit on `main` carries its version in the title -
e.g. `feat: … (v1.5.0) (#NN)` - because the bump rode in with the feature.

Concretely, for any feature/fix PR that ships a release:

1. Add the `CHANGELOG.md` entry under the new `## [X.Y.Z] - <date>` heading
   AND its `[X.Y.Z]: …/compare/…` link-reference at the bottom of the file.
2. Bump `package.json` to `X.Y.Z` and run `bun run scripts/sync-version.ts`.
3. Commit both, then push the branch and open the PR.

Do this even though `main` is protected (direct pushes are rejected; all
changes go through a PR) - which is exactly why the bump cannot be a
post-merge step: a forgotten bump means `package.json` and the `CHANGELOG`
heading disagree on `main` and a second PR is needed to reconcile them.

This OVERRIDES the generic `feature-release-playbook` default ("do not bump
version mid-PR; bump once in the release phase"). That default assumes a
maintainer can push the bump straight to `main` at release time; this repo
cannot, so the bump belongs in the feature PR. The GitHub release
(`gh release create vX.Y.Z`) is published AFTER that PR merges and only tags
the already-bumped commit - it never changes the version.
