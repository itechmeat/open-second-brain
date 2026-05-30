### Variant 1: `_brain.yaml` schema block + shared vocabulary boundary

- **Approach**: Add one optional `schema:` block to `_brain.yaml` that declares user extensions to the otherwise-closed vocabularies (custom preference categories/scopes, extra signal source types, custom log/event kinds, custom page/note types). Resolve it through a single new `schema-vocab.ts` boundary modeled on `relation-vocab.ts`: built-in `as const` defaults are frozen, declared extensions are merged in, and `isKnown*` predicates replace compile-time exhaustiveness at the SQL/frontmatter narrowing points. Ship read-only introspection only — a `o2b brain schema --json` verb and a `doctor` lint that reports declared-vs-used types — and defer all mutation.
- **Trade-offs**:
  - Pro: Reuses the established data-driven single-boundary pattern (`relation-vocab.ts`) and the forward-compat resolver pattern already in `policy.ts`; no new parser, no second store.
  - Pro: Default install stays byte-identical (absent `schema:` block → resolver returns frozen built-in defaults, predicates behave exactly as the current closed unions).
  - Pro: The child's 11 mutation primitives become "edit one `schema:` block" — a clean, bounded extension point that needs no architectural change later.
  - Con: The tiny indent-aware YAML parser must grow to carry richer declarations (lists of maps for typed entries), or declarations must be flattened into the existing two-level shape.
  - Con: One config block as the home for several distinct vocabularies risks an awkward schema if the kinds diverge.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Dedicated schema-pack registry under `Brain/_schema/`

- **Approach**: Introduce a first-class schema-pack concept living in its own vault location (a `Brain/_schema/` directory of pack markdown files, or a single `Brain/_schema.yaml`), with an active-pack selector and a pack loader/registry that the core vocabularies consult at runtime. This mirrors gbrain's schema-pack model most faithfully and gives the future Schema Cathedral a natural home (pack-lock, mutate-audit, multi-pack switching). The foundation slice ships the loader, the registry, active-pack resolution, and read-only introspection/lint; mutation stays out.
- **Trade-offs**:
  - Pro: Most faithful to the upstream design; the full child surface (pack-lock, per-pack stats, switching) drops in without re-architecting.
  - Pro: Cleanly separates schema declarations from runtime tuning knobs in `_brain.yaml`.
  - Con: Directly tensions the "do not add a second graph or a parallel hidden schema store" constraint — a dedicated registry is a new store with its own format and lifecycle.
  - Con: Largest surface for a bounded PR; introduces pack selection/precedence semantics the foundation doesn't strictly need.
  - Con: Higher chance of accidentally widening legacy fixtures, since a new store changes how every vocabulary resolves.
- **Complexity**: large
- **Risk**: medium

### Variant 3: In-code union widening with built-in extension points only

- **Approach**: Widen the closed `as const` unions to typed-string with a centralized known-set (extending the tolerance pattern already used by `PrefAuditOp` and the log-kind reader), narrowing at SQL-row/frontmatter boundaries via `isKnown*` predicates — but expose no user-facing declaration surface this PR. The vocabulary is seeded purely from built-in defaults; introspection reports those built-ins. This delivers exactly gbrain's "widen casts, validate at runtime" type-system change and leaves the declaration mechanism entirely to the child.
- **Trade-offs**:
  - Pro: Smallest, lowest-risk change; touches only the type boundary, no config or YAML changes at all.
  - Pro: Makes the eventual declaration mechanism trivial — predicates and narrowing points already exist.
  - Pro: Easiest to prove default/legacy behavior is unchanged, since there is no new input surface.
  - Con: Delivers no user-observable value (no custom types yet) — it is a pure refactor that opens a door without a way to walk through it.
  - Con: Risks designing the predicate seam without a concrete declaration consumer, so the child PR may still need to reshape it.
- **Complexity**: small
- **Risk**: low

### Recommended: Variant 1

**Rationale**: It satisfies every hard constraint — no second store, no heavy YAML, defaults byte-identical, one shared validation boundary, read-only-first — while reusing two patterns the codebase already trusts (`relation-vocab.ts` and the `policy.ts` optional-block resolver). Unlike Variant 3 it ships real custom-type capability, and unlike Variant 2 it keeps the foundation small and avoids a parallel schema store, while still giving the child's mutation primitives a clean target (the `schema:` block) to evolve.
