# ADR: Runtime schema packs live in `_brain.yaml` first

## Status

Accepted for the Runtime Schema Packs Foundation PR.

## Context

The upstream schema-pack tasks describe a broad system: runtime-declared page/take kinds, atomic mutation primitives, MCP/admin operations, CLI authoring verbs, locks, audit logs, and an agent-facing schema-author workflow. Open Second Brain currently keeps Brain state in plain Markdown plus a small `_brain.yaml` policy file. Several core vocabularies are closed `as const` objects because deterministic algorithms depend on exhaustive state handling.

Recent work added `relation-vocab.ts`, a successful single validation boundary where adding a relation token is data-driven and migration-free. The schema-pack foundation should use that lesson without turning every operational enum into an arbitrary string.

## Decision

For the first schema-pack release, store user-declared schema vocabulary in an optional `schema:` block inside `Brain/_brain.yaml` and resolve it through one shared Brain schema vocabulary module. The release is read-only/introspection-first: it can validate declarations, parse inert schema metadata on Brain artifacts, and report declared-vs-used tokens, but it does not mutate schema packs or change `dream` lifecycle behavior.

Operational lifecycle enums remain closed in this PR. Custom schema tokens are taxonomy metadata, not alternate states for `dream`, retire, apply-evidence, or audit state machines.

## Consequences

- Default vaults remain byte-compatible: no `schema:` block means built-in vocabulary only.
- Future mutation primitives have a clear target: editing `_brain.yaml`'s `schema:` block with atomic config writes and validation.
- The implementation avoids a second schema store and avoids a heavy YAML dependency.
- The foundation does not yet satisfy the full Schema Cathedral surface. That is intentional; mutation, locks, admin MCP tools, and schema-author workflow need a later PR.

## Rejected alternatives

- **Dedicated `Brain/_schema/` registry.** More faithful to the upstream system, but it adds a second store and active-pack lifecycle before Open Second Brain has proven the user-facing need.
- **Pure in-code widening.** Lowest implementation risk, but it would ship almost no operator-visible capability.
- **Opening lifecycle enums immediately.** Too risky: `preference.status`, retire reasons, apply results, and log event kinds drive deterministic control flow. Arbitrary user tokens there need separate designs for every consuming algorithm.
