# Knowledge intake and consolidation - implementation plan

Sequence follows consultant Variant 2. Each task is one atomic TDD commit on feat/knowledge-intake-and-consolidation. Seams ride inside their anchor feature commits. Hard edges: I1 before I2 (capture contract), S1 before S2 (evidence-identity type), S2 and S1 before S3 only where the rollup consumes shared types (verify during TDD; otherwise S3 is independent). R1, G1, K1 are independent of both tracks.

## Tasks

### Task I1 (t_f8f5ef6a): inbound Telegram capture bot plus /catchup (carries seam 1)
- **Files**: new capture-contract module under src/core/brain (staging kind vocabulary, provenance fields, staging/archive path helpers, read/write functions anchored on forget-plan.ts inbox-vs-processed kinds), new inbound runner core module beside src/core/discipline/telegram.ts, new CLI runner verb, config for bot token reuse and chat-id allowlist, tests
- **Acceptance**: with the token configured and the runner started explicitly, a text message from an allowlisted chat becomes one capture note through the contract (kind, provenance, timestamp); non-allowlisted chats and malformed updates are rejected with one logged decision each; /catchup replies with captures since the last acknowledged one using existing MarkdownV2 escaping; token absent means the runner exits with a typed error; nothing runs implicitly; long-poll transport is fetch-based getUpdates with no new dependencies.
- **Depends on**: none

### Task I2 (t_b0bba8cb): inbox-drain classify-and-route pass
- **Files**: new inbox-drain module and CLI verb (dry-run default, --apply), per-run report type, tests
- **Acceptance**: the pass walks staged captures via the contract, classifies each structurally (source-reference by URL shape or explicit frontmatter, obligation by marker, otherwise atomic idea), routes on apply (ingestSource for source references, note create-or-merge for ideas, obligation open for tasks), archives processed captures via the contract, and emits a per-item report naming action and reason; unroutable items are reported and left in place; rerun after apply is a no-op (processed marker idempotency); dry-run writes nothing (regression test).
- **Depends on**: I1

### Task R1 (t_1dcbf352): web-research providers plus full-page extract (carries seam 2)
- **Files**: new keyed fetch helper (env-gated, Bearer auth, typed errors, shared cache), new brave and tavily provider modules and a page-extract step under the research area, pool wiring in src/core/brain/research/research.ts, tests (HTTP mocked at the fetch boundary)
- **Acceptance**: a provider joins the pool only when its key env (BRAVE_API_KEY, TAVILY_API_KEY) is set; keyless pool reports itself empty explicitly and byte-identically to today's behavior; responses cache by normalized request; the extract step feeds full page text into the existing citation-constrained pipeline; network and auth failures surface as typed errors in the report; no keys appear in logs or cache paths (redactor test).
- **Depends on**: none

### Task S1 (t_40fa4e8d): synthesis causal context, decomposed confidence, evidence-identity gate
- **Files**: src/core/brain/deep-synthesis.ts and its types (exported evidence-identity type plus predicate), tests
- **Acceptance**: every finding carries an additive causal-context field and decomposed confidence components (support, opposition, freshness, coverage; deterministic); findings lacking evidence identity are excluded and the excluded count with reasons is reported; steelman seed selection unchanged (regression test); existing consumers see additive fields only.
- **Depends on**: none

### Task S2 (t_28ba3fc4): subject diarization with stated-vs-evidenced gap
- **Files**: new diarization module and CLI verb plus MCP surface per codebase convention, tests
- **Acceptance**: given an entity, the document set assembles from the entity registry and source pages; output is a structured profile skeleton plus one needs-llm-step envelope for prose; the stated-vs-evidenced section is computed deterministically from claim machinery versus evidence frequency and recency, each line carrying the S1 evidence-identity type; unknown entity is a typed error.
- **Depends on**: S1

### Task S3 (t_c5263e27): count-triggered fact rollup ladder in dream synthesize
- **Files**: new rollup-ladder module wired into the dream synthesize phase, named-constant thresholds (config-overridable), tests
- **Acceptance**: when new facts at a tier since the last rollup reach the threshold, one needs-llm-step rollup envelope is emitted and the counter reset is recorded in the dream report; the ladder composes (facts to rollup, rollups to identity tier); below threshold the dream output is byte-identical (regression test); triggers are pure counters.
- **Depends on**: S1 only if the envelope reuses shared identity types (verify during TDD); otherwise none

### Task G1 (t_6832aac6): memory-graph repair lane with efficacy holdouts
- **Files**: new repair-lane module and CLI verb (dry-run default, --apply with exact confirmation), holdout harness module, tests
- **Acceptance**: candidates order by identity strength (explicit references, session continuity, same-topic evidence; inferred only behind an opt-in flag); confidence threshold and hard per-run write cap are named constants; dry-run writes nothing; reruns after apply converge to zero writes (idempotent forward-scan test); the holdout harness reports graph lift separately from direct recall and fails the gate when a graph target does not resolve to durable memory or hydrate into bounded evidence.
- **Depends on**: none

### Task K1 (t_6fc8663c): skill-proposal verifier gate, versioning, same-name merge
- **Files**: src/core/brain/skill-proposals.ts plus a verifier module, tests
- **Acceptance**: a draft reaches pending only after the deterministic verifier validates it against its own supporting records (evidence count, structural checks); rejections record a reason; accepted skills carry a version that increments on evolution; a same-name collision merges support instead of forking; human accept/reject flow unchanged (regression test).
- **Depends on**: none

### Task L: docs, changelog, version bump
- **Files**: README.md, CHANGELOG.md (1.36.0 entry plus link reference), docs/cli-reference.md, docs/mcp.md, package.json plus `bun run scripts/sync-version.ts`
- **Acceptance**: all eight features documented; version 1.36.0 propagated; `bun run scripts/sync-version.ts --check` passes.
- **Depends on**: all above

## Batching for delegated implementation

- Batch A (one agent, sequential): I1 then I2 (intake track, contract-first)
- Batch B (one agent, sequential): S1 then S2 then S3 (consolidation track, identity-type-first)
- Batch C (one agent, sequential): R1, G1, K1 (independent units)
- Batch D: L (docs and bump, orchestrator)

Batches run strictly one at a time (agents share one working tree). Every unit runs `bun run fmt`, `bun run lint` (baseline exactly 134 warnings, 0 errors), `bun run typecheck`, and full foreground `bun test` before its commit.
