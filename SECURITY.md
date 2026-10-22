# Security Policy

## Supported versions

Open Second Brain ships from `main`. Fixes land in the latest release; earlier
releases do not receive backports. Update with the steps in
[`docs/updating.md`](docs/updating.md) before reporting an issue you found on an
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

## What shared exports carry

Every export that writes a file an operator names runs the shared redactor
over its bytes before they land. Since v1.92.0 the shared exports also apply
a content-class policy: pages whose `content_class` frontmatter carries the
server-stamped value `prompt-derived` - material an agent produced from a
prompt - are left out of the export by default, and each omission is named
on stderr. The per-verb `--include-prompt-derived` flag carries those pages
back in and says so on the same run. The knowledge pack blocks such pages in
its selection step and names them in its `blocked` list.

Pages written before this shipped carry no `content_class` key and are never
rewritten to add one; absence of the mark is the documented pre-stamp era,
and such a page exports exactly as it did before. A hand-edited class value
this build does not recognise reads as unmarked rather than hiding the page.

The full decision record for every export path, scanned and unscanned, is
`src/core/egress/registry.ts`, and the operator-facing summaries are the
"content class" and "network egress" sections of
[`docs/cli-reference.md`](docs/cli-reference.md).
