---
name: schema-author
description: Use when adding, renaming, reviewing, or explaining Brain schema tokens, aliases, prefixes, link types, extractability, or expert routing in Open Second Brain vaults.
---

# Schema Author

Use this skill when a task changes the active Brain schema pack in `Brain/_brain.yaml` or reviews content against that schema.

## Workflow

1. Inspect the active schema pack with `schema_inspect` (`view="active_pack"`) or `o2b brain schema --json`.
2. Check current usage and findings with `schema_inspect` views `stats`, `lint`, and `orphans`.
3. Explain candidate tokens with `schema_inspect` (`view="explain_type"`) before renaming or deleting them.
4. Apply schema changes only through `schema_apply_mutations` or `o2b brain schema apply --mutation ...` so writes are locked, atomic, and audited.
5. Re-run lint/stats after mutation and report changed tokens plus any remaining findings.

## Mutation Notes

Supported operations are `add_type`, `remove_type`, `update_type`, `add_alias`, `remove_alias`, `add_prefix`, `remove_prefix`, `add_link_type`, `remove_link_type`, `set_extractable`, and `set_expert_routing`.

Schema tokens must be lowercase normalized tokens accepted by Open Second Brain schema validation. Prefer small, durable tokens over project-specific phrasing unless the schema pack is explicitly project-scoped.
