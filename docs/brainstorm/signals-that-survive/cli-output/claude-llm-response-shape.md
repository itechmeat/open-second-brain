### Variant 1: Ingress shape gate — one shared validator, static shape table

- **Approach**: Promote the existing JSON-Schema-subset validator in `src/mcp/output-contract.ts` (`OutputSchema` / `validateOutputContract`) into a core module — named for *response shape*, not "schema", to stay clear of `schema-contracts.ts` / `schema-pack.ts` / `schema-admin.ts` — and declare one frozen shape descriptor per model-authored write path (distill claims, derived facts, dream/synthesis payloads). Each consumer site validates the agent-supplied payload against its descriptor before any normalization, replacing scattered ad-hoc coercion with a single fail-closed check that emits structured `{code, path, message}` findings. The descriptors stay deliberately shallow — required keys, primitive types, array-of-object items — so extraction recall is not squeezed by over-constraint.
- **Trade-offs**:
  - Reuses a validator that already exists and is already tested; no new dependency, no zod.
  - Removes loose parsing from three write paths in one pass, with findings carried as structured fields rather than prose.
  - Enforcement is at the boundary only — the model still generates free-form and a mismatch costs a full round trip that Open Second Brain cannot itself initiate.
  - Tightening validation can reject payloads today's callers get away with, so it needs a config key defaulting to the current tolerance to keep behaviour byte-identical when absent — which means the strict path ships dormant until an operator opts in.
  - The subset validator is intentionally small; a shape needing conditionals or unions has nowhere to go without growing it.
- **Complexity**: small
- **Risk**: low

### Variant 2: Generalize the write-session contract loop to every model-authored payload

- **Approach**: `src/core/brain/write-session/` already implements the full pattern the upstream PR is reaching for — a session holding a declared target and `schemaType`, fail-closed validation, machine-readable errors, and a correction prompt derived from the error list so the agent resubmits the whole artifact. Extract that open → submit → validate → correct → commit engine into a payload-shape-agnostic primitive and route distillation, fact derivation, and dream synthesis through it, each registering its own shape descriptor and reserved-target policy. A bad response then becomes a *retryable session state* with an operator-visible attempt record, not a silent parse degradation.
- **Trade-offs**:
  - Highest fidelity to the goal: a malformed response is caught, named, and given an explicit exit, which matches the no-dead-ends and no-silent-fallback conventions directly.
  - Reuses an engine already proven on the riskiest write path rather than inventing a parallel mechanism — strong DRY win, and one correction-prompt derivation instead of three.
  - Turns three currently stateless single-shot calls into stateful multi-step ones: session records, TTLs, abandonment, idempotency, and the audit trail all multiply.
  - Changes the shape of existing CLI and MCP surfaces for `brain_distill_source` / `brain_derive_fact` / `brain_dream`; keeping them compatible means running both the direct and session forms, which is duplicated surface, not less.
  - Largest test surface: the session engine's failure matrix has to be re-verified per new consumer.
- **Complexity**: large
- **Risk**: medium

### Variant 3: Two-sided contract — publish shape descriptors outward, verify on return

- **Approach**: Keep the kernel model-free and instead make each write path's expected response shape a *first-class published artifact*: exposed in MCP tool metadata and capabilities, printable from the command line, and stable enough for the calling harness (Claude, Hermes routing) to feed straight into its own native structured-output mechanism. Open Second Brain then runs a thin ingress verification of the same descriptor on the returned payload, so constrained generation happens where the model actually lives and validation happens where the vault write happens.
- **Trade-offs**:
  - The only variant that gets genuine *constrained generation* rather than post-hoc rejection, without the kernel ever issuing a model call.
  - Descriptors become versioned public contract, which is exactly what makes the auto-memory extraction follow-on (`t_1dace26d`) cheap to add — it registers a descriptor instead of a parser.
  - Effectiveness is contingent on caller cooperation; a harness that ignores the published descriptor gets no benefit beyond Variant 1's rejection, so the win is unevenly distributed across clients.
  - Publishing descriptors on MCP tool metadata expands a surface that is already covered by `registry-guard.ts` and the preview-budget rules — schema growth there has token cost on every session.
  - Two enforcement points can drift; the descriptor must have exactly one definition with both the published form and the validator derived from it.
- **Complexity**: medium
- **Risk**: medium

### Recommended: Variant 1

**Rationale**: The kernel issues no model calls, so the real defect here is loose parsing at the ingress of agent-supplied payloads, and Variant 1 fixes exactly that with a validator the repository already owns — no new dependency, no zod, no surface change, and a config key that keeps behaviour byte-identical when absent. Variant 2's session loop is the correct end state but pays large structural cost up front for three call sites that are single-shot today, and Variant 3's outward publication is only worth the versioned-contract burden once the descriptors have proven stable in practice. Variant 1 is also the strict prerequisite that makes the other two cheap later: it establishes the single shape-descriptor definition and the distinct naming (response *shape*, never *schema*) that both would build on.
