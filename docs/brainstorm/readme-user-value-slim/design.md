# README user-value slim - cut the agent-function wall-of-text

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook; consultant waived by operator)
**Audience:** implementation

## Problem statement

`README.md` (213 lines) reads as an exhaustive agent-function changelog rather
than a user-facing pitch. The worst offenders are the "Top features" section -
two multi-thousand-character paragraphs enumerating every release surface from
v0.12.0 to v1.0.0 - and the "CLI" section dumping ~35 commands. A reader cannot
tell in ten seconds what the plugin is for them.

## Scope

- Keep the value-first half verbatim: hero/poster, tagline, intro, "Why", the
  "One vault, many runtimes" diagram, "Quick start", "Other runtimes".
- Replace "Top features" (the version-by-version walls) with one compact
  "What you get" section of user-facing value bullets.
- Drop the "How rules accrete" sequence diagram and the full "CLI" command dump
  from the README; both are covered by the linked docs.
- Trim "Safety" to the points a user cares about.
- Keep "Documentation", "Updating", "Uninstalling", "License" - the docs table
  is where the full surface and every CLI verb already live.

## Out of scope

- Editing any `docs/*` target (they already hold the detail).
- Changing the poster image or install instructions.

## Chosen approach

The README answers "what is this for me, and how do I start". Depth moves behind
the existing Documentation table. No capability is lost - it is relocated, not
deleted - and the version-history prose stops living in the README (the
CHANGELOG and release notes own that).

## File changes

- `README.md` - rewrite the middle (sections "How rules accrete" through "CLI")
  into a single "What you get" section; trim "Safety"; leave the rest intact.

## Risks and open questions

- A reader wanting the exhaustive surface must follow a doc link. Acceptable: the
  Documentation table is immediately below and names every relevant doc.
- Mermaid "One vault, many runtimes" diagram is retained; confirm it still
  renders after the edit.
