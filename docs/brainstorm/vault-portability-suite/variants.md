# Vault portability + session economy - brainstorm audit trail

Consultant: Claude Code (`claude -p`), primary. Exit 0, three parseable
variants; the Codex fallback was therefore not run. Raw output at
`cli-output/claude.md`; filled prompt at `cli-output/prompt.md`.

## Variants (verbatim summary)

### Variant 1: Five independent additive slices
- **Approach**: Each feature a standalone pure module + its own verb, sharing only existing helpers. The codec ships ONLY as a module + CLI utility (never touches session import or signal `raw`). Vault-map tokens resolve user content folders only; profiles activate via pointer-in-config. Each slice independently mergeable.
- **Trade-offs**: Pro - lowest blast radius, default byte-identical by construction, sidesteps both risky seams, easy per-feature TDD. Con - codec delivers no automatic value to stored signals (utility, not integration); duplicated folder-resolution plumbing across slices; vault-map underdelivers.
- **Complexity**: small. **Risk**: low.

### Variant 2: Shared portability subsystem (foundation-first)
- **Approach**: One `src/core/brain/portability/` subsystem of deterministic primitives (codec with protected-span scanner, graph serializer over `collectExportRows` + `extractWikilinks` + typed relations, `resolveRoleToken`, profile registry); features 2-5 compose them. Codec ships as module + CLI AND an off-by-default `signals.raw_codec` flag (compress imported `raw`, expand on read, round-trip-guarded, gated by a stored marker). Vault-map addresses user content folders only; FIXED Brain `*_REL` untouched. Profiles via pointer-in-config. Foundation-first sequencing front-loads pure code.
- **Trade-offs**: Pro - delivers real integration value with the risky codec-in-signals seam strictly opt-in and round-trip-tested once; shared resolver prevents folder-resolution drift; token resolver scoped to user content avoids fighting `paths.ts`; pure deterministic code front-loaded for TDD. Con - more up-front shared-module design; the opt-in expand-on-read branch in the signal reader must be tested even though off by default.
- **Complexity**: medium. **Risk**: low-medium.

### Variant 3: Deep integration with unified role-token indirection
- **Approach**: One portability layer where the codec compresses signal `raw` as part of import (expanded on read everywhere), vault-map becomes a general role-token indirection that can relocate Brain internal dirs by routing the `*_REL` constants, profiles activate via filesystem symlink, graph export/import is the canonical migration format.
- **Trade-offs**: Pro - maximally capable, least duplication, complete migration story. Con - attacks both highest-risk seams (rerouting widely-consumed `*_REL` threatens the one-Brain-root design + every `ensureInsideVault` guard; codec-on-import mutates the proven import path and changes on-disk bytes); symlinks sync inconsistently under Syncthing (breaks the determinism contract); large tightly-coupled change, hard to split/revert.
- **Complexity**: large. **Risk**: high.

### Consultant recommendation: Variant 2
Captures the real integration value (codec that can compress stored signal
bodies, a genuine shared role-token resolver) while keeping every risky
behaviour off-by-default so the Syncthing byte-identical contract and the
one-agent-owned-Brain-root design are never threatened; eliminates the
folder-resolution drift Variant 1 risks without rerouting `paths.ts` or adopting
symlink activation as Variant 3 does; foundation-first sequencing front-loads
cheap-to-test pure code.

## Orchestrator decision: Variant 2 (agree with consultant)

Adopted without override. Variant 2 is the only option that delivers the
integration value the operator's chosen scope implies (a codec that actually
compresses stored session bodies, a resolver shared across graph import/export
and scan) while keeping the determinism + sync contract and the one-Brain-root
architecture intact. Variant 1's codec-as-utility underdelivers and duplicates
folder resolution; Variant 3 directly attacks the two seams the project's design
forbids (rerouting the FIXED `*_REL` constants; symlink activation fragile under
Syncthing). The single cost of Variant 2 - an expand-on-read branch in
`parseSignal` - is isolated to opt-in-written signals via a stored `_raw_codec`
marker, so the default read path stays byte-identical and is covered by
exhaustive round-trip tests.
