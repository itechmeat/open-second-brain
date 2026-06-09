# Variants - language-agnostic fact extraction

The external CLI consultant step was waived by the operator (decisive
"remove without mercy" directive). Variants below were authored by the
orchestrator to record the alternatives considered and why one was chosen.

### Variant 1: Structural-only extraction

- **Approach**: Drop every family that needs a human-language frame
  (identity, preference, location, possession, confirmation) plus the
  English `STRUCTURERS`/`POSSESSION_RE` in `truth/ingest.ts`. Keep only
  language-neutral structural families: URL, e-mail, and quantity bound to
  a currency/percent symbol. Stop deriving the English `action` verb.
- **Trade-offs**:
  - Pro: zero language coupling; same philosophy as PR #84; deterministic
    and offline; no fake fallback; smallest, clearest surface.
  - Pro: works identically for every language - a Japanese or Arabic turn
    with a URL / `@`-address / currency amount extracts the same facts.
  - Con: real recall regression - English prose facts (name, preference,
    location) are no longer auto-captured by this path.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Explicit author-label markers

- **Approach**: Replace prose detection with explicit structured labels the
  agent/user writes (mirroring `pre-compact-extract.ts`'s `decision:` /
  `rule:`): e.g. `name:`, `prefers:`, `location:`. Detect `label: value`
  structurally.
- **Trade-offs**:
  - Pro: language-neutral (the label is a fixed token, not prose); higher
    precision than prose regex.
  - Con: labels are still English tokens (just a smaller, schema-like set) -
    only partially honors the directive; shifts behavior (capture now
    depends on authors using labels); larger doc/skill change to teach the
    convention.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Provider-assisted extraction

- **Approach**: Route prose-fact extraction through the configured provider
  (openai-compat) when present; structural-only when `local`/`disabled`.
- **Trade-offs**:
  - Pro: highest recall, genuinely language-agnostic for prose.
  - Con: a synchronous per-turn LLM call is too heavy for the default
    offline hot path; the `disabled`/`local` branch is exactly the
    "meaningless fallback" the operator forbids unless framed as additive;
    largest blast radius and new failure modes.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 1

**Rationale**: It is the only option that fully and immediately satisfies
"no hardcoded language phrases anywhere" without inventing a new English
label vocabulary (Variant 2) or coupling the offline hot path to a provider
(Variant 3). The recall loss is precision-safe and explicitly accepted; if it
proves material, Variant 2 or 3 can be layered later as an additive,
opt-in source rather than a hot-path dependency.
