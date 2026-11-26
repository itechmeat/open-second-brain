# Feature catalog

What Open Second Brain does, by feature, in a form an agent can compare with another product. Read [`INDEX.md`](INDEX.md) first: one line per feature, grouped by area, at most 20000 bytes in all. Open an area file (`<area>.json`) only when a feature needs detail.

## Fields

Each area file holds `area`, `name`, `summary` and `features`. A feature has, in this order:

1. `slug`: flat lowercase kebab-case, unique across all area files.
2. `name` and `summary`: what a user would call it, and one factual line of at most 120 characters.
3. `status`: `stable`, `optional` (off by default, or needs a model, a service or a credential), `experimental` or `deprecated`.
4. `aliases` (optional): former names and slugs.
5. `capabilities`: 3 to 8 lines, one behavior each.
6. `limits`: up to 4 lines on the scope of the feature.
7. `surfaces`: the `cli` verbs, `mcp` tools, `hooks`, `skills` and `config` settings that belong to it; an empty list is left out.
8. `docs`: repository-relative doc paths, with an optional `#anchor`.
9. `code`: 1 to 3 repository-relative entry points.
10. `keywords`: 4 to 8 words, the most useful first; `INDEX.md` shows the first five.

The check requires these counts. The contract is [`feature-catalog.schema.json`](feature-catalog.schema.json).

## Slugs

1. A slug never changes and is never reused. Renaming a feature keeps its slug and records the old name in `aliases`.
2. A removed or merged feature moves to [`_removed.json`](_removed.json) with `replaced_by`, the slugs that took over.
3. A slug does not encode its area (`dream-drafts`, not `dream.drafts`).

## Feature or capability line

A feature is enabled separately, has surfaces of its own, or would carry its own stream of work. A flag, a heuristic or a format is a capability line inside a feature.

## Writing rules

1. A capability line states one behavior (verb, object, condition) and names the mechanism where one exists, with no adjectives of praise.
2. `keywords` are the words outsiders use for the same thing, not the product's internal names.
3. `limits` are neutral facts of scope that are already true of the product: never a wish, a plan or a comparison.
4. The catalog names no other product. An agent host or a service appears only where a feature integrates with it.
5. No tracker ids.

## What the check covers

`bun run catalog:check` fails when:

1. an area file does not follow the schema (counts included), a slug repeats, or a slug of `_removed.json` comes back;
2. a CLI verb, MCP tool, hook script or skill that the code has belongs to no feature or to two, or a listed one does not exist or was removed;
3. a declared setting belongs to no feature, or a listed setting is not declared;
4. a `docs` path, its anchor or a `code` path does not exist;
5. an MCP tool is not named in backticks in `docs/mcp.md`;
6. `INDEX.md` differs from what the build writes, or is over 20000 bytes;
7. a file in this folder carries a tracker id.

## Changing the catalog

Edit the area file, run `bun run catalog:build`, run `bun run catalog:check`. A pull request that adds, renames or removes a CLI verb, an MCP tool, a hook or a skill updates the catalog in the same pull request.
