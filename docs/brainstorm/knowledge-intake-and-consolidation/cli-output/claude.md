### Variant 1: Convention-first, zero extraction

- **Approach**: Extract no shared modules. Each of the eight tasks lands self-contained in kanban order (1→8); the capture note shape, env-gating pattern, and evidence-identity fields are documented conventions (in code comments plus a short docs page), with each consumer implementing its own copy. Task 2 pattern-matches whatever frontmatter task 1 happened to write; tasks 5 and 6 each define their own evidence-identity fields; task 3 builds its own gated fetch-plus-cache inline.
- **Trade-offs**:
  - Pro: lowest upfront cost; all eight tasks are parallelizable with no blocking dependency chain.
  - Pro: no speculative abstraction; every line shipped has exactly one consumer today.
  - Con: the capture contract is defined implicitly by task 1's output and re-derived by task 2's parser - a drift bug factory, and the drain pass's structural classification (frontmatter, markers) depends on that shape being exact.
  - Con: evidence-identity duplicated between the finding gate (6) and diarization gap section (5) means two vocabularies that will diverge, and "excluded for missing proof identity" will mean different things in two reports.
  - Con: keyed env gating plus typed network errors plus cache implemented at least twice (Brave/Tavily, page extract), likely three times (Telegram polling).
- **Complexity**: small
- **Risk**: medium (drift between paired tasks 1/2 and 5/6 is near-certain rework inside the same PR)

### Variant 2: Two hard seams, two conventions

- **Approach**: Extract exactly the two seams that have concrete dual consumers with real coupling: (a) a capture-note contract module (frontmatter `kind`, provenance, timestamps, staging/archive paths) that the Telegram bot writes through and the inbox drain reads through, anchored on the existing inbox-vs-processed distinction in forget-plan.ts; (b) a small keyed-env-gated HTTP fetch helper (Bearer auth, typed errors, shared cache) used by Brave, Tavily, and full-page extract - Telegram may adopt it but keeps its existing token plumbing. Evidence-identity (seam 3) stays a shared exported type plus predicate in the deep-synthesis types, not a module; dream extension (seam 4) stays "the rollup ladder is ordinary code in the synthesize phase" - no plugin registry. Each seam lands inside the commit of its first consumer (contract with task 1, fetch helper with task 3), preserving one-atomic-commit-per-task. Ordering: 1→2 (intake track), 6→5 then 4 (consolidation track), 3 anywhere before or parallel, 7 and 8 fully independent.
- **Trade-offs**:
  - Pro: the two extractions are exactly where silent drift would break a same-PR sibling task; the two non-extractions avoid frameworks with one consumer.
  - Pro: type-level evidence-identity gives 5 and 6 one vocabulary at zero runtime cost, and the compiler enforces it - fits the deterministic-kernel and no-new-deps constraints.
  - Pro: ordering gives each track a contract-defining task first (1 defines captures, 6 defines evidence identity), so downstream tasks consume rather than guess; the two tracks plus 3/7/8 can proceed in parallel.
  - Con: seam-inside-first-consumer-commit means task 2's author must wait for task 1's commit (and 5 waits on 6); mild serialization within tracks.
  - Con: if a fourth network consumer appears later (e.g. more providers), the minimal fetch helper may need a second pass; accepted as cheap.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Platform-first, four subsystems

- **Approach**: Treat all four candidate seams as first-class subsystems landed before any feature task: an intake staging bus (contract, writer API, reader iterator, archive semantics), a `net/` gateway (provider registry, env gating, cache, budgets) that all network callers must route through including Telegram, a synthesis evidence-identity module with decomposed-confidence types, and a formal dream-phase extension registry into which the rollup ladder plugs and which the repair lane explicitly declines. Feature tasks then become thin consumers, in any order.
- **Trade-offs**:
  - Pro: cleanest long-term layering; future intake sources and providers slot in without touching consumers.
  - Pro: eliminates all cross-task drift by construction; every seam has a single owner file.
  - Con: the dream-phase registry is a framework whose only new client is the rollup ladder - and the wave's own spec says the repair lane is NOT a dream phase, so half the registry's motivation is explicitly out of scope. Speculative generality against this repo's "no stubs, no do-nothing surfaces" ethos.
  - Con: forcing Telegram long-polling through a generic gateway fights its existing, working token/config plumbing in telegram.ts, contradicting the task's "reuse existing plumbing" instruction.
  - Con: subsystem-first commits are not attributable to any one kanban task, straining the one-atomic-commit-per-task convention, and the whole wave serializes behind platform work.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 2

**Rationale**: The rework risk in this wave is concentrated in exactly two places - the task-1/task-2 capture contract and the task-5/task-6 evidence vocabulary - and Variant 2 hardens the first as a module and the second as a shared type, which is proportionate to two consumers each. Variant 1 guarantees same-PR drift on those pairs, while Variant 3 builds a dream-extension framework the spec itself undercuts and violates the repo's aversion to speculative surfaces and its commit-per-task convention. Variant 2 also yields the best ordering story: each track opens with its contract-defining task, keeping the eight commits atomic and the two tracks parallel.
