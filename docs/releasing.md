# Releasing Open Second Brain

## One-time owner steps

1. Create or select the Open Second Brain package owner's npm account and enable two-factor authentication.
2. On the first version only, download the tarball attached to that version tag's workflow run. Publish that checked file from the account's trusted machine:

   ```sh
   npm publish <downloaded-file.tgz> --access public --provenance=false --ignore-scripts
   ```

   This bootstrap publish has no provenance attestation because it runs outside supported CI. Later workflow publishes require provenance through `publishConfig.provenance` and GitHub trusted publishing.
3. Create the `npm-publish` deployment environment in the repository.
4. Immediately before the first release intended to publish from CI, bind the package on npm to this GitHub repository, workflow file `release.yml`, and environment `npm-publish`. Select **Allow npm publish** for the binding; the workflow uses direct `npm publish`. Leave **Allow npm dist-tag** disabled. Set repository variable `NPM_PUBLISH` to `enabled` at the same time. Do not create this binding earlier: a new binding expires if no publish succeeds through it within two days. If it expires, delete it and create it again immediately before the release.

## Later releases

The version bump rides in the feature pull request. After merge, tag that commit with the matching `v<version>` tag. The release workflow verifies the commit, checks and publishes the packed tarball, then installs and smoke-tests that exact version on Linux, macOS and Windows.

If publishing fails after the GitHub release exists, rerun the workflow for that tag after fixing the cause. If the version already reached npm, the publish plan skips it and the workflow skips `publish-smoke`, so that rerun does not verify the installed release. After a smoke failure, use the failed-jobs rerun to run `publish-smoke` again with the successful publish job's outputs. If a publish step failed, `publish-smoke` remains skipped.

To verify a version already on npm, run this command from the release checkout on Linux, macOS and Windows, replacing `<version>` with the released version:

```sh
bun run scripts/registry-smoke.ts "open-second-brain@<version>" "<version>"
```
