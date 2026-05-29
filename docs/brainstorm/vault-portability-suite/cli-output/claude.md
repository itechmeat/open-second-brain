### Variant 1: Five independent additive slices
- **Approach**: Ship each feature as a standalone pure core module under `src/core/brain/` with its own CLI verb (and MCP tool where stated), sharing nothing but existing helpers (`vault.ts`, `extractWikilinks`, `resolveVault`). The session codec ships *only* as a reusable codec module + `o2b codec` CLI utility — it never touches the session-import path or signal `raw` body, so stored output is unchanged. Vault-map tokens resolve *only* user content folders (scan-inline `read_paths`, graph-import write target, search scope) and never the FIXED `*_REL` Brain constants; profiles activate via a pointer-in-config key (no symlinks). Sequence: dashboard → codec → graph export/import → vault-map → profiles, each independently mergeable.
- **Trade-offs**:
  - Pro: lowest blast radius — default install stays trivially byte-identical because no shared seam is touched and the codec/profile/token paths are all opt-in or read-only.
  - Pro: each slice is independently testable and revertible; clean RED→GREEN per feature; easy CHANGELOG story.
  - Pro: sidesteps both risky seams entirely (codec stays out of signals; tokens stay out of `paths.ts`).
  - Con: codec delivers no automatic value to stored signals — operator must invoke it manually, so it's a utility not an integration.
  - Con: some duplicated plumbing (frontmatter round-trip, path resolution) across slices; vault-map and graph-import each resolve folders independently.
  - Con: vault-map utility is narrow (content folders only), which may underdeliver on the "tools resolve role tokens" framing.
- **Complexity**: small
- **Risk**: low

### Variant 2: Shared portability subsystem (foundation-first)
- **Approach**: Introduce one new subsystem `src/core/brain/portability/` holding deterministic primitives — a codec (tokenizer/compress/expand with a protected-span scanner for code/URLs/paths/identifiers/versions), a graph serializer over `collectExportRows` + `extractWikilinks` + typed relations, a `resolveRoleToken(map, token)` resolver, and a profile registry — then features 2–5 compose those primitives rather than reimplementing. The codec ships as module + `o2b codec` CLI *and* exposes an off-by-default `signals.raw_codec` flag that compresses the imported signal `raw` body and expands on read (round-trip-guarded; default install writes identical bytes because the flag is off). Vault-map tokens address user content folders only and the same resolver is reused by graph import/export and scan-inline; the FIXED Brain `*_REL` constants are untouched, preserving "one agent-owned Brain root." Profiles use pointer-in-config activation. Sequence: codec + graph primitives (pure, heavily unit-tested) → read-only dashboard → token resolver → profiles → graph export/import layered on the serializer.
- **Trade-offs**:
  - Pro: the riskiest seam (codec-in-signals) exists but is strictly opt-in and reuses the *same* round-trip-tested codec, so correctness is proven once and the default stays byte-identical.
  - Pro: shared resolver means vault-map, graph-import target, and search scope agree by construction — no drift between three folder-resolution copies.
  - Pro: token resolver deliberately scoped to user content folders avoids fighting `paths.ts`/the one-Brain-root design while still being a real abstraction.
  - Pro: foundation-first sequencing front-loads the pure, deterministic, easily-tested code and defers anything stateful.
  - Con: more up-front design of the shared module before any user-visible verb lands; a larger first PR-section if not carefully split.
  - Con: the opt-in signal-codec path adds an expand-on-read branch in the signal reader that must be exercised in tests even though it's off by default.
- **Complexity**: medium
- **Risk**: low–medium

### Variant 3: Deep integration with unified role-token indirection
- **Approach**: Treat all five as one portability layer where the codec compresses session-imported signal `raw` bodies as part of the import pipeline (expanded on read everywhere the body is consumed), and the vault-map becomes a *general* role-token indirection that can resolve both user content folders *and*, behind a flag, relocate the Brain internal dirs by routing the `*_REL` constants through the resolver. Profiles activate via filesystem symlink so the resolved vault path is a stable target, and graph export/import is the canonical serialization for moving a vault between profiles. Sequence: build the resolver + profile/symlink machinery first (it underpins everything), then re-route `paths.ts` and the import codec through it.
- **Trade-offs**:
  - Pro: maximally capable — tokens are a single uniform abstraction, codec saves tokens on every stored signal automatically, profiles+graph export form a complete vault-migration story.
  - Pro: least duplication; one indirection point for all path/role resolution.
  - Con: directly attacks the two highest-risk seams — rerouting widely-consumed `*_REL` constants risks the "one agent-owned Brain root" design and every `ensureInsideVault` guard, and codec-on-import mutates the proven session-import path and changes on-disk signal bytes (breaks byte-identical default unless heavily gated, which contradicts the always-on framing).
  - Con: symlink activation is fragile under Syncthing (symlinks sync inconsistently across devices/OSes), threatening the determinism/sync contract.
  - Con: large, tightly-coupled change set; hard to split into one-version PR, hard to revert, wide test surface.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 2
**Rationale**: It captures the real integration value the task asks for — a codec that can actually compress stored signal bodies and a genuine role-token resolver shared across graph import/export — while keeping every risky behavior off-by-default so the Syncthing byte-identical contract and the "one agent-owned Brain root" design are never threatened. The shared `portability/` primitives eliminate the folder-resolution drift that Variant 1 risks, without rerouting the FIXED `paths.ts` constants or adopting symlink activation as Variant 3 does. Its foundation-first sequencing front-loads pure deterministic code (codec round-trip, graph serializer) that is cheapest to test under TDD and defers anything that touches existing on-disk output to a gated, reversible seam.
