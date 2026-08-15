You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Ship one release of Open Second Brain covering nine units. Reconnaissance against the real code is already done and its findings are stated below as facts, not guesses. Your job is to decide the SHAPE of the release: how these nine units should relate to each other in the codebase.

The nine units share one theme. Every one is a place where the system states something it has not verified, or stays silent where silence is indistinguishable from an answer.

1. **Intake trust is decided from an unverified claim** (GitHub #160). `classifySourceTrust(vault, sourcePath)` decides trusted-versus-quarantined purely from the shape of a caller-supplied string and never checks whether the file exists. The caller is the same agent that extracted the entities, so untrusted content carrying a prompt injection can name a fake vault path and land its entities trusted and active. Reconnaissance established that the alternative fix (trust supplied by the MCP host) is not buildable: there is no unforgeable caller identity anywhere in the MCP surface, and the project already documented that conclusion in `src/core/write-binding/index.ts:12-22`. The remaining fix is an existence check plus a recorded content hash, which does not stop a caller naming a real file such as README.md but removes the free bypass and makes the claim auditable.

2. **A probe's answer is assumed to stay true** (GitHub #161). `allocateSlug` picks a free filename with a read-only `existsSync` probe; the caller then creates the file exclusively. On a race the loser gets a terminal error and its event is dropped. Three callers share the defect. There is no typed collision signal today: the atomic writer downgrades the native EEXIST to a plain Error whose errno survives only on `.cause`, so introducing the typed error is a prerequisite. Two more copies of probe-create-retry exist elsewhere, one of which swallows unrelated errors and one of which is unbounded.

3. **Index scope is stated by omission** (GitHub #155). Vault scope is exclude-only, so indexing only `Brain/` means enumerating every other top-level directory, and anything created later is indexed silently until noticed. The request is a positive `vault.include_paths` allowlist, absent meaning today's behaviour exactly. Reconnaissance found exclusion is fully shared through six call sites of one matcher, and that the composed include-narrowing predicate already exists as an unnamed inline lambda in the note walker.

4. **Readiness is reported from a surface that does not reflect reality** (GitHub #130, unanswered for five weeks). Hermes shows "Needs Setup" after a completed setup and a clean doctor. The plugin's entire readiness computation is whether a vault resolves. Its Python resolver claims in its own docstring to mirror the TypeScript resolver exactly and does not: it is missing project-pointer resolution, named-profile resolution and tilde expansion, and it takes the first duplicate key where TypeScript takes the last. An unreadable config file silently becomes "not configured". Nothing anywhere compares the two resolvers, so a clean doctor and a wrong badge coexist without contradiction.

5. **Health asserted from artifact presence** (kanban t_a3254fe8). A readiness probe reports pass from in-process construction alone, never reading disk, on a machine where nothing is installed. Adapter verify returns ok because two JSON keys exist and hash-match, while the `probeMcp` seam that would actually check liveness is declared and implemented by zero adapters. Staleness is purely content-relative with no wall-clock ceiling, and reports fresh when no input could be stat'ed, which is a measurement failure reported as up to date. Five independent copies of wall-clock-age-from-mtime math disagree about whether a stat failure means fresh or stale.

6. **Two silences that look identical** (kanban t_e5f447c1). Recall-delivery telemetry has no channel dimension, so "recall never fires" cannot distinguish a hook that was never installed from one that runs and stays quiet. The hook that actually injects recall emits no telemetry at all. The existing `host` field is an open caller-supplied string whose meaning is already overloaded between runtime identity and transport.

7. **A search result that cannot say why it is empty** (kanban t_3309a27a). Roughly a dozen degradation signals are computed and then discarded or flattened into free-form English in an untyped warnings array; several more are entirely silent, including a query that tokenises to an empty match and an owner-scope filter that removes every hit. Both answers already exist in typed form elsewhere in the tree and are each wired to exactly one surface: a recall-adequacy verdict never called from the search path, and a negative-recall vocabulary reachable only from the recall gate.

8. **A write that never says what is wrong with what it wrote** (kanban t_0e79f0b3). The vault lint is a separate 359 ms pass over every page, so an agent writing a page never sees quality problems at write time. Update, append and batch run no document validation at all and return a hardcoded success flag. There is no shared result envelope across the four write tools, so any per-write finding would have to be attached four times.

9. **An advertised schema that documents itself only partly** (kanban t_e24c6dbb). Fifty-nine advertised tool parameters carry no description across thirteen tools, with no CI guard. All 108 tools declare `additionalProperties: false` and the server enforces it on none: an unknown argument is silently ignored, and the caller gets a success envelope computed from defaults. No string-distance helper exists in the tree.

# Project context

Open Second Brain: an agent-owned second brain in an Obsidian-compatible Markdown vault. TypeScript on Bun, plus a Python Hermes plugin. Roughly 850 modules in `src/`, 1018 test files, version 1.45.1.

Recent commits:

```
29ea0099 fix: the flush that never landed (v1.45.1) (#158)
8d05a62a feat: silence is not an answer (v1.45.0) (#159)
34f96b84 fix: reuse and reap Hermes MCP bridges (v1.44.1) (#156)
3ee1963a feat: what the index already knew (v1.44.0) (#157)
0ae4b097 feat: provenance at the boundary (v1.43.0) (#154)
7e6a5672 refactor: module boundaries and the fallbacks behind them (v1.42.0) (#153)
5ac866eb feat: signals that survive (v1.41.0) (#152)
0963ef0a feat: no dead ends - every diagnosis names its exit (v1.40.0) (#151)
```

Note the last four release themes. This project has shipped "provenance at the boundary", "no dead ends - every diagnosis names its exit", and "silence is not an answer" already. The nine units above are the same argument applied to nine more places, which is either evidence that a shared mechanism is missing, or evidence that the argument is a review standard rather than a module. That tension is the thing to resolve.

Related files, by unit: `src/core/brain/intake/source-trust.ts`, `src/core/brain/paths.ts`, `src/core/fs-atomic.ts`, `src/core/vault-scope/index.ts`, `plugins/hermes/config.py`, `src/core/doctor-readiness.ts`, `src/core/brain/staleness.ts`, `src/core/brain/recall-telemetry.ts`, `src/core/search/pipeline/outcome.ts`, `src/core/brain/lint-consolidate.ts`, `src/mcp/registry-guard.ts`, `src/mcp/server.ts`.

Conventions:

- Closed vocabularies are always four pieces together: a frozen object with camelCase keys and snake_case values, a derived union type, a members array, and a type guard. Any such vocabulary whose values are persisted or copied into a tool schema must register in an architecture census test.
- There are already at least five such vocabularies in the tree answering neighbouring questions: negative recall states, negative recall unknown reasons, schema pack integrity, integrity degradation codes, and recall adequacy levels. A sixth, seventh and eighth are proposed by these nine units.
- A doctor check that could not run must report through a separate uncertain stream rather than emitting nothing, because no findings is what every surface renders as a clean bill of health.
- Every doctor code must be registered either with a structural next command or in an exclusion table with a written reason, enforced by a census test.
- Architecture census tests also govern direct filesystem writes, import cycles, vault-identity guards, CLI terminal states, and MCP schema description caps.
- No shared error module: roughly forty per-module exported Error subclasses.
- Module docblocks argue the design decision and name the rejected alternative and the measurement that refuted it.

Constraints:

- No stubs and no placeholders. Every branch either returns a definite verdict or a named unknown from a closed vocabulary.
- No fallback that silently does nothing or misleads. An error must surface explicitly.
- No hardcoded natural-language word lists in any language. Structural signals, explicit frontmatter fields, corpus frequency or agent extraction only.
- SOLID, KISS, DRY. Anything that can be a named constant or a shared helper should be.
- Absent configuration must keep today's behaviour byte-identical. This is a point release for existing vaults.
- One pull request, one CHANGELOG version, and the version bump rides inside the feature pull request.
- Implementation is test-driven and units land one at a time on one branch.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
