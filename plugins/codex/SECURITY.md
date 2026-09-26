# Security Policy

## Supported versions

Open Second Brain ships from `main`. Fixes land in the latest release; earlier
releases do not receive backports. Update with the steps in
[`docs/updating.md`](https://github.com/itechmeat/open-second-brain/blob/main/docs/updating.md) before reporting an issue you found on an
older version.

## Reporting an issue

Please report security issues privately through GitHub's private vulnerability
reporting:
<https://github.com/itechmeat/open-second-brain/security/advisories/new>

Include the version (`o2b version`), the platform, and the steps that reproduce
the behaviour. Please do not open a public issue or pull request for a report
that is not yet resolved.

Once a fix is released, the advisory is published with credit to the reporter
unless they ask otherwise.

## Scope

Open Second Brain runs locally. It reads and writes Markdown in the vault it is
configured for, keeps its state under the user's data directory, and makes
network calls only to the embedding, rerank or research endpoints the operator
configures. Reports about how those boundaries hold are in scope. Issues in
third-party agent hosts (Claude Code, Codex, Hermes, OpenClaw, opencode) belong
with their maintainers.
