# Knowledge Provenance Suite - every fact knows where it came from

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation
**Target version:** 1.7.0

## Problem statement

Open Second Brain remembers conversations (session ingest) but cannot absorb the
documents a knowledge worker actually accumulates, cannot derive second-order
facts with traceable premises, cannot keep one agent's facts from polluting
another's, and gives the operator no declarative steering over what surfaces into
context. Across all of these the same gap recurs: a piece of knowledge in the
brain does not carry its origin - which source produced it, which premises it was
derived from, who owns it, and whether a human stated it or a machine inferred it.

## Scope

Six opt-in features, one unifying theme (knowledge carries its provenance),
shipped as one PR for v1.7.0:

1. **Source-ingest pipeline** - a text/Markdown/HTML/URL-text source becomes
   entity + concept pages plus a per-source summary page that links back to the
   raw artifact and lists its connections to existing notes.
2. **Parameterized research pipeline** - N sources become one dated, cited report
   page in the vault, each finding citing the source that flagged it.
3. **Derived-fact synthesis with premise provenance** - a `derive` step surfaces
   derivation-eligible premise sets deterministically; an agent supplies the
   derived fact; OSB commits it with premise links and a `stated|deduced|inferred`
   provenance label; recall trusts stated above inferred.
4. **Owner-scoped canonical facts** - a preference/fact may declare an `owner:`
   token; recall scoped to an owner sees that owner's facts plus shared
   (ownerless) facts. Reuses the v1.6 owner-visibility model.
5. **Model-based entity extraction on write (NER)** - entities discovered in free
   text by the calling agent's model are intaked into the entity registry. No ML
   dependency is bundled; opt-in; non-blocking.
6. **Operator-editable standing-query attention layer** - the existing
   `attention-flows` mechanism gains an operator-defined standing-query action so
   declared open loops / learnings always surface into the assembled context.

## Out of scope

- OCR, image/PDF-raster, audio, and any binary-media ingestion (the heavy-
  dependency surface of upstream `t_77f9d89b`). Text-bearing sources only.
- Observer-scoped / theory-of-mind beliefs (`t_741a64b0`) - declined for OSB and
  documented on the board.
- Any in-OSB LLM client. Generation stays on the agent side of the MCP/CLI
  boundary; OSB never calls a model.
- A daily-brief variant (`t_e4ddbe7c`) - not in this cycle's scope.

## Chosen approach

**Variant 2 - per-feature pipelines over three shared libraries** (consultant-
recommended; see `variants.md`). Each feature is its own module with its own MCP
tool or CLI verb and its own TDD unit, landing as one atomic commit. All features
import three shared primitives instead of duplicating logic:

- **(a) Extraction-intake** - the single validated path that turns
  agent-extracted entities/concepts into registry records (idempotent by content
  hash). Shared by the ingest pipeline and on-write NER.
- **(b) Provenance / citation** - a value object plus renderer that stamps source
  links, premise links, and a `stated|deduced|inferred` level onto a page, and
  renders the canonical `Sources` / citations section. Shared by ingest, research
  reports, and derived-facts.
- **(c) Owner-visibility** - the existing `src/core/graph/agent-scope.ts`
  (`pageOwner` / `normalizeAgentScope` / `isOwnerVisible`), reused unchanged at
  the fact/preference layer.

**Hardening over the bare variant:** each shared primitive is the ONLY exported
way to perform its operation - there is no public alternative write path for
extraction-intake or provenance-stamping, so a feature either imports the shared
export or fails to compile. This makes DRY a module-boundary guarantee rather than
a review-discipline hope.

**Provider-agnostic boundary:** for the four generation-bearing features (ingest,
research, derived-facts, NER) the model generation lives on the agent side. OSB
owns sequencing, validation, provenance-stamping, idempotent dedup, and the atomic
vault write - mirroring the `write-session` and `importSession` precedents. This
is the testable half and the half the operator agreed to cover.

## Design decisions

- **Opt-in behind `_brain.yaml` guardrail flags**, mirroring the v1.6
  `untrusted_source_delimiting` plumbing (defaults-merge-resolve + safe loader +
  known-keys validator). Every behavioural change defaults off; a vault that
  enables nothing is byte-identical in results, ordering, and shape. New tools/
  verbs are inherently opt-in (new surface), but any change to an EXISTING output
  (the dream pass for derived-facts; recall ordering by provenance; fact filtering
  by owner) is flag-gated.
- **Derived-facts split deterministic vs generated.** The `derive` phase in
  `dream.ts` only does the deterministic part: identify premise sets eligible for
  derivation (e.g. confirmed, high-confidence preferences sharing a scope) and
  record them as candidates. The actual reasoning is supplied by an agent through
  a `brain_derive_fact` MCP tool; OSB validates the premises exist, stamps
  `provenance: inferred` + premise wikilinks, and commits. Tests cover candidate
  identification, provenance round-trip, and recall ordering - never the model's
  prose.
- **Provenance label is a first-class preference field.** `BrainPreference` gains
  `provenance?: "stated" | "inferred"` (and the finer `deduced` where a premise
  chain is purely logical). Absent label reads as `stated` for every pre-existing
  preference, so existing prefs are unchanged. Recall ordering treats stated >
  deduced > inferred only when the trust-ordering flag is on.
- **Owner field reuses the v1.6 model verbatim.** `pageOwner` already reads an
  `owner:` token from any frontmatter map, so a preference's owner is read with
  the same function as a page's. No second implementation. Fact filtering applies
  `isOwnerVisible(owner, requestedScope)` and is byte-identical when no scope is
  requested.
- **NER is non-blocking and opt-in.** Note save never synchronously calls a model.
  Entity extraction is a separate agent-driven tool call (or a batched pass during
  dream), so it cannot add latency or token cost to a plain write. The extraction
  contract is structural and language-agnostic: the agent returns typed
  entity/concept records; OSB validates shape, never matches natural-language word
  lists.
- **Standing queries extend `attention-flows`, not a parallel system.** A new
  `standing_query` action type is added to the existing flow recipe; an
  operator-authored flow doc under `Brain/attention/flows/` declares the queries.
  Nothing fires unless the operator adds the action, so the default is unchanged.
- **No `as` cast crutches.** Payload shapes are built with conditional spreads and
  narrowing validators that return the correct literal types (the repo's
  established pattern), per `pref-no-typescript-cast-crutches`.

## File changes

New (illustrative; final paths settle during TDD):
- `src/core/brain/provenance/` - provenance value object + citation renderer
  (primitive b) and its tests.
- `src/core/brain/intake/` - extraction-intake validate+commit (primitive a) and
  its tests.
- `src/core/brain/ingest/` - source-ingest pipeline (feature 1) + MCP tool + CLI
  verb.
- `src/core/brain/research/` - research-report pipeline (feature 2) + MCP tool +
  CLI verb.
- `src/core/brain/dream-derived.ts` - the `derive` phase (feature 3).
- `src/mcp/brain/derive-tools.ts` - `brain_derive_fact` tool (feature 3).
- `src/core/brain/entities/ner-intake.ts` - on-write NER intake (feature 5) + MCP
  tool.
- standing-query extension inside `src/core/brain/attention-flows.ts` (feature 6).

Modified:
- `src/core/brain/types.ts` - `provenance` + premise links on `BrainPreference`;
  `owner` on the preference record; new guardrail flag fields; `derived` fields on
  `DreamRunSummary`.
- `src/core/brain/preference.ts`, `preference-txn.ts` - write/parse the new
  provenance + owner fields; frontmatter emission.
- `src/core/brain/policy.ts` - new guardrail flags through
  `BRAIN_GUARDRAIL_DEFAULTS`, `resolveGuardrails`, the YAML validator known-keys.
- `src/core/brain/dream.ts`, `dream-phases.ts`, `dream-workrun.ts` - wire the
  `derive` phase between synthesize and heal, flag-gated.
- recall/search ordering site - provenance trust ordering + fact owner filtering,
  flag-gated.
- `src/mcp/...` + `src/cli/...` + `command-manifest.ts` - register new tools/verbs.
- `CHANGELOG.md`, `README.md`, `package.json` (1.7.0) + `bun run
  scripts/sync-version.ts`.

## Risks and open questions

- **Scope breadth.** Six features touch sensitive subsystems (dream pass,
  preference store, context-pack, entity registry). Mitigation: strict one-feature-
  per-commit TDD; byte-identical-when-off as a test for each behavioural unit;
  shared primitives built and tested first so features compose rather than
  reinvent.
- **Lowest-ROI unit is the research pipeline** (`t_bdb46ec9`). It is the first to
  trim if the diff grows beyond a clean single PR; it sits on primitive (b) so it
  adds little once ingest exists.
- **Derive-phase byte-identical guarantee.** The dream pass must emit identical
  output when the derived-fact flag is off (the phase must be a true no-op).
  Verified by a dream-summary equality test with the flag off.
- **Standing-query cost.** Operator-declared queries run at context assembly; they
  must respect the existing character/token budget and not bypass it. The
  extension reuses the attention-flow injection path, which is already budgeted.
