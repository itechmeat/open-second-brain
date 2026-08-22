You are brainstorming architectural variants for a multi-task release wave. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

One release wave of Open Second Brain (TypeScript, Bun, vault + CLI + MCP server; the kernel deliberately never calls an LLM — model work is delegated to the host agent through "needs-llm-step" envelopes). Eight tracker units, already reconnoitered against the real source. The question for you is NOT per-unit implementation detail; it is the wave-level architecture: which shared abstractions to build once, in what order, and where each unit plugs in.

The eight units, with reconnaissance corrections already applied:

1. Salience gate for dream synthesis (t_de8a0b2d). CORRECTION: the dream pass has no per-item model lane; its only model delegation is the rollup ladder, one envelope per count-triggered rung (rollup-ladder.ts, defaults 20 facts -> rollup). A gate can only govern which items enter the rollup fold set. Open choice: deterministic scorer (decayed salience mass in lessons.ts:228, Wilson-bound confidence in confidence.ts:38, reuse rates in observed-use.ts:168 — no cache, no second round trip, kernel stays model-free) versus an LLM triage scorer as a second needs-llm-step envelope with a verdict ledger keyed by judging model + prompt version (idempotency-ledger.ts discipline: same key + different hash = explicit payload_mismatch; provider failures never cached, mirroring CodegraphUnanswered vs error). Plus a `retriage` action on the existing dream stage/validate/apply bundle verbs.

2. Auto-capture of memory signals from session streams (t_1dace26d). Must be a separate batch verb (the live hook path runs under a self-terminating process ceiling and cannot host an LLM round trip). Emits one needs-llm-step envelope over imported session turns; returned payload validated by a new ShapeDescriptor in response-shape.ts (MODEL_AUTHORED_SHAPES); extracted signals become speculative inbox entries (new closed-vocabulary source_type member `auto_extract`), staged through the existing write-approval surface (pending.ts), never straight to confirmed preferences. House rule to preserve: precision beats recall — a hallucinated fact pollutes memory.

3. Write-time lifecycle (t_5e338af1), three sub-gaps: (a) --delete-linked cascade on note delete — the inbound-reference probe already computes the candidate set (notes/lifecycle.ts inboundFiles); the blast-radius rule to adopt is deleteBySource's "only single-purpose derived files tracing SOLELY to this source are deleted, everything else is reported"; full destructive ladder mandatory (dry-run default, count guard, snapshot gate, destructive-sites registry entry). Note: the module header of notes/lifecycle.ts explicitly argues a delete must report, not repair, inbound links — the design must argue past it. (b) Per-capture free-form guidance on WriteCaptureInput — but no CLI/MCP capture ingress exists (only telegram-capture calls it), so the field needs an ingress decision. (c) Expiration: expiration_date is enforced on read but NO surface can set it at creation and none can mutate it after — a double gap; both halves must route through normalizeExpirationDate as the single chokepoint.

4. Agent Skill drafts from mature vault pages (t_abaec26b). A full mine -> verify -> stage -> human-accept pipeline already exists (skill-proposals.ts, 51KB: pending proposals, evidence floor >=3 distinct + 0.55 confidence, WAL-protected accept materialising Brain/procedures/). What is missing: it never reads vault page content (input is continuity telemetry) and never writes SKILL.md. Open choices: extend skill-proposals with a new pattern kind versus a new subsystem; maturity = page-meta trio (tier/lifecycle/confidence frontmatter) gated by observedReuseRates as evidence; where a generated SKILL.md lands (skills_dir may be OUTSIDE the vault; staging inside Brain/skill-proposals/pending/ and materialising on accept splits the problem); draft body: honest template versus needs-llm-step envelope.

5. Local in-process transformer embedding provider (t_916f9953). CONFLICT: docs/brainstorm/retrieval-ranking-quality/design.md declares "NO new npm dependencies and NO ML runtime... the feature is redesigned in the OSB idiom, not the dependency added" — phrased release-scoped, justified in absolute terms. The lexical LocalProvider already gives key-less installs working recall. If pursued: distinct EmbeddingIdentity so switching invalidates rather than mixes vector spaces (ensureEmbeddingModel clears on model/dim change); provider registration walks an exhaustive switch (presets.ts) so the type system forces every touch point; house pattern for optional native deps is synchronous require in try/catch with memoized tri-state (cjk-tokenizer.ts), never silent download. Options include: operator-supplied model artifact + operator-installed runtime with loud config-time failure; defer the unit entirely; or ship only the seam.

6. Codegraph-assisted enrichment of brain architect output (t_3a418d07). CORRECTION: the partner report carries counts and health only — no symbols, no call edges — and partner/codegraph.ts declares its four CLI tokens "the entire surface OSB knows about codegraph... absolute". Honest descope available: a new sentinel region in generated overview stamping the graph verdict ("graph-present, N nodes / M edges, health X" versus "graph-absent, lexical-only") from the existing report, with the five-state CodegraphIndexState vocabulary. Full symbol citation requires inventing a partner query surface — a separate decision with its own risks.

7. Deterministic Mermaid module diagram + key-decisions note in brain architect (t_041c571f). CORRECTION: the architect scan carries no module relations (import-graph analysis explicitly out of scope in scan.ts); a deterministic diagram can only show containment (project -> modules, file counts, dominant language). Key-decisions note: repo-scoped ADR candidates already exist (git/decisions.ts mines conventional-commit signals into Brain/decisions/candidates/ with repo_key frontmatter; deriveRepoKey is the join key shared with architect). Regeneration byte-identity guarantee (generate.ts) must be preserved or the exception declared.

8. One-shot design-note generator (t_c87644b4, trimmed). CORRECTION: a stateful multi-turn deliberation surface already exists (o2b brain panel on the write-session kernel, committing to Brain/decisions/panels/). The trimmed unit is: given a topic, ground in tension/decision/truth records (all three have query APIs; truth is an append-only claim ledger with projections), emit exactly one needs-llm-step envelope whose payload is validated to carry named alternatives and exactly one Recommended. Structural template: diarization.ts (read-only report + one envelope + PROSE_MARKER). Open choice: standalone diarization-shaped verb versus a new persona-free panel session kind. The "exactly one Recommended" cardinality cannot be expressed in the deliberately-shallow ShapeDescriptor language — either a dedicated checker beside it (as research.ts does for citation set-membership) or extending the descriptor language against its stated design.

# Project context

Open Second Brain, TypeScript on Bun, single-user vault product. v1.50.3.
Recent commits:
86544b9b fix(hermes): the bridge child inherits a PATH that can find Bun (v1.50.3)
ba1a9678 fix(hermes): preserve context-pack recall (v1.50.2)
4ba335d4 ci: adopt Bun 1.4.0 - pin the toolchain and rebuild the bundle it gates
1e8792cb fix: a provider the host cannot read is not an unconfigured one (v1.50.1)
962228ae fix(mcp): the pairing one tool declared and the other only enforced (v1.50.0)
aa73af4b feat: what the machine already has (v1.50.0)
b49af81e feat: a label is not a boundary (v1.49.0)
280469d2 feat: nothing runs unwatched (v1.48.0)

Related files: src/core/brain/{dream-apply,dream-gates,rollup-ladder,response-shape,write-session/,skill-proposals,notes/lifecycle,expiration,capture/capture-note,diarization,decisions/,tensions,truth/,architect/,partner/,sessions/import,signal,pending,idempotency-ledger}.ts, src/core/search/embeddings/, src/mcp/brain-tools.ts, src/mcp/registry-guard.ts.

Conventions:
- Kernel never calls an LLM; model work is delegated via needs-llm-step envelopes. THREE envelope shapes exist today (write-session durable sessions; diarization plain-data step; rollup envelope) sharing field names but no shared type — a named DRY paydown opportunity.
- Fail loudly, never a misleading fallback: validation that cannot be switched off (response-shape), refusals name the specific reason, partner-absent is a value not an error, partial writes report how far they got.
- Every model-authored write path validates through response-shape.ts ShapeDescriptors (closed key set, deliberately shallow).
- New MCP tools: previewBudget mandatory, closed schemas, description on every property, parity test pins the tool-name set. New CLI verbs: dispatch case + help-text + command-manifest, gated by completeness tests.
- New durable vault state needs a STATE_SURFACES row; destructive operations need a destructive-sites registry entry and the snapshot/count-guard/confirm ladder.
- bun:test, throwaway vault per test, numbered docblocks stating the claims a suite pins.

Constraints:
- No new runtime npm dependencies without an explicit policy decision; nothing downloads silently.
- Public APIs are additive; the MCP tool-name set is frozen per major (additions allowed, renames not).
- All user-facing strings in English; no language-specific hardcoding.
- SOLID, KISS, DRY; no stub implementations; errors surface explicitly.
- One PR, one CHANGELOG version, eight atomic TDD units.

# Required output format

Produce exactly 3 distinct architectural variants FOR THE WAVE AS A WHOLE (how the shared abstractions are shaped and which unit-level options they imply). For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
