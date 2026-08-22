# Salience, lifecycle, and enrichment wave - implementation plan

Order is dependency-driven: T1 first (T3, T8, T10 build on it), the rest are independent and land smallest-risk-first. Every task is one atomic conventional commit, TDD (failing test first), formatter and linter green before each commit.

## Tasks

### Task 1: Envelope spine and semantic-checker registry
- **Files**: new `src/core/brain/llm-step.ts`, new `src/core/brain/response-checks.ts`; modified `src/core/brain/diarization.ts`, `src/core/brain/rollup-ladder.ts` (re-declare their step shapes against the spine type, zero behavioral change); `src/core/brain/response-shape.ts` untouched except exports if needed.
- **Acceptance**: type-level test pins the spine field set; existing diarization and rollup suites pass unchanged; a semantic check registered for a test surface rejects a violating payload with a named refusal and passes a conforming one.
- **Depends on**: none.

### Task 2: Deterministic salience gate + retriage (t_de8a0b2d)
- **Files**: new `src/core/brain/salience-gate.ts`; modified `dream-types.ts`, `dream-apply.ts`, `dream.ts`, `types.ts` (`BrainDreamConfig` threshold), `dream-stage.ts` (retriage action), `src/cli/brain/verbs/dream.ts`, help-text, command-manifest, MCP dream tool schema.
- **Acceptance**: with threshold set, low-salience facts are excluded from rollup envelopes and listed by name in the dream summary; threshold unset reproduces current behavior byte-for-byte; `retriage` on a staged bundle reports the admitted/excluded delta after a threshold change; refusal paths carry `--json` shapes.
- **Depends on**: none.

### Task 3: extract-signals verb (t_1dace26d)
- **Files**: new `src/core/brain/extract-signals.ts`, new `src/cli/brain/verbs/extract-signals.ts`; modified `types.ts` (`BRAIN_SIGNAL_SOURCE_TYPE` + `auto_extract`, all consumers), `response-shape.ts` (descriptor + `MODEL_AUTHORED_SHAPES`), `response-checks.ts` (cap + confidence floor), `signal.ts` if needed, MCP tool module + `brain-tools.ts`, help-text, command-manifest.
- **Acceptance**: verb emits exactly one envelope over an imported session's turns; submitting a conforming payload writes inbox signals with `source_type: auto_extract` honoring the durability denylist and pending staging when write approval is on; an over-cap or under-floor payload is refused by name; `import-session` output is byte-identical to before.
- **Depends on**: Task 1.

### Task 4: delete-linked cascade (t_5e338af1 part A)
- **Files**: modified `src/core/brain/notes/lifecycle.ts` (flag, derived-set fold, ladder), `src/core/brain/destructive-sites.ts`, `src/mcp/brain/lifecycle-file-tools.ts`, `src/cli/brain/verbs/note-lifecycle.ts`, help-text, command-manifest.
- **Acceptance**: dry-run lists the deletion set (target + solely-derived files) and the report-only inbound references separately; confirm deletes exactly the listed set under one snapshot; a note referenced by any second source is reported, never deleted; destructive-site census test passes.
- **Depends on**: none.

### Task 5: capture guidance + CLI capture ingress (t_5e338af1 part B)
- **Files**: modified `src/core/brain/capture/capture-note.ts` (`guidance` in input, hash, frontmatter/body, parser), `src/core/brain/capture/telegram-capture.ts` (pass-through); new `src/cli/brain/verbs/capture.ts`; help-text, command-manifest, `state/surfaces.ts` if the surface row needs updating.
- **Acceptance**: two captures differing only in guidance produce distinct ids; round-trip parse returns the guidance verbatim; the CLI verb writes a capture note with source, sender, and guidance; existing telegram tests pass unchanged.
- **Depends on**: none.

### Task 6: expiration creation + mutation (t_5e338af1 part C)
- **Files**: modified `src/cli/brain/verbs/feedback.ts`, `src/mcp/brain/feedback-tools.ts` (creation `expires`), `signal.ts` / `preference.ts` (mutation helper through `normalizeExpirationDate`), the surface chosen for mutation (feedback verb action or lifecycle action per design note), help-text, command-manifest.
- **Acceptance**: a signal and a preference created with `expires` carry a normalized `expiration_date` and disappear from default queries after the date; mutation sets, changes, and explicitly clears the date; an unparseable date is refused by name at every surface; nothing bypasses `normalizeExpirationDate`.
- **Depends on**: none.

### Task 7: skill drafts from mature pages (t_abaec26b)
- **Files**: modified `src/core/brain/skill-proposals.ts` (new `mature_page` pattern kind, SKILL.md materializer branch), new `src/core/brain/skill-page-drafts.ts` (maturity gate + candidate mining + envelope emission); `response-shape.ts` descriptor; CLI/MCP surface for the drafting action; help-text, command-manifest.
- **Acceptance**: a page passing the maturity gate (tier/lifecycle/confidence + reuse evidence) yields a pending proposal containing one envelope-drafted SKILL body; a page covered by an installed skill is skipped with the skip named; accept materializes a well-formed SKILL.md under the skills root through the WAL; reject is sticky; nothing writes outside the vault before accept.
- **Depends on**: Task 1.

### Task 8: codegraph verdict region (t_3a418d07 descoped)
- **Files**: modified `src/core/brain/architect/generate.ts` (new `codegraph` overview region), reading `partner/codegraph-report.ts` output; region renderer.
- **Acceptance**: with a healthy partner index the overview carries `graph-present` with node/edge counts and health; with no partner it carries `graph-absent, lexical-only`; all five `CodegraphIndexState` values render distinctly; operator prose outside the region survives byte-for-byte; the declared byte-identity exception is documented in the generator docstring.
- **Depends on**: none.

### Task 9: Mermaid containment diagram + key-decisions note (t_041c571f)
- **Files**: modified `src/core/brain/architect/generate.ts` (new `module-map` region, new decisions note kind), reading `architect/scan.ts` facts and `Brain/decisions/candidates/` filtered by `repo_key`.
- **Acceptance**: the Mermaid block renders containment only (modules, file counts, dominant language), is deterministic under `compareStable`, and regenerates byte-identically for an unchanged project and vault; the decisions note lists ADR candidates for the repo's `repo_key` and updates when candidates change; a repo with no candidates gets an explicit empty-state line, not an absent region.
- **Depends on**: none.

### Task 10: design-note verb (t_c87644b4 trimmed)
- **Files**: new `src/core/brain/design-note.ts`, new `src/cli/brain/verbs/design-note.ts`; `response-shape.ts` descriptor; `response-checks.ts` exactly-one-Recommended check; MCP tool + `brain-tools.ts`; help-text, command-manifest.
- **Acceptance**: the verb grounds a topic in tension, decision, and truth records (empty stores produce a named empty grounding, not a failure), emits one envelope, and a payload with zero or two `recommended` alternatives is refused by the cardinality check while exactly one passes and commits a note under `Brain/decisions/`.
- **Depends on**: Task 1.

### Task 11: wave docs and version
- **Files**: `README.md`, `CHANGELOG.md` (`## [1.51.0]` + link reference), `package.json` + `bun run scripts/sync-version.ts` (mirrored manifests), brainstorm directory committed.
- **Acceptance**: `bun run scripts/sync-version.ts --check` passes; CHANGELOG entry covers all shipped units and the t_916f9953 refusal note.
- **Depends on**: Tasks 1-10.
