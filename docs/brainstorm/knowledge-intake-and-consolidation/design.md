# Knowledge intake and consolidation - one wave, eight tasks, two shared seams

**Status:** approved
**Author:** wave orchestrator (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain captures well from CLI and MCP but poorly from the operator's pocket, and what accumulates in the vault is consolidated by hand. There is no inbound phone capture path, no pass that drains the inbox staging area into structured artifacts, and no bundled web-research source. On the consolidation side, facts pile up without rolling into higher-tier summaries, no entity-anchored profile exists, synthesis findings lack causal context and an evidence-identity gate, the link graph is write-once with no repair or efficacy proof, and skill proposals reach the pending queue with arbitrarily thin evidence.

## Scope

Eight kanban tasks in two themes, one PR, one release (v1.36.0):

- A. Intake: t_f8f5ef6a (inbound Telegram capture bot plus /catchup), t_b0bba8cb (report-then-apply inbox-drain pass classifying and routing each capture), t_1dcbf352 (keyed env-gated Brave and Tavily research providers plus a full-page extract step).
- B. Consolidation: t_c5263e27 (count-triggered fact rollup ladder in the dream synthesize phase), t_28ba3fc4 (subject diarization with a stated-vs-evidenced gap section), t_40fa4e8d (causal context, decomposed confidence, and an evidence-identity gate on synthesis findings), t_6832aac6 (deterministic memory-graph repair lane with graph-efficacy holdouts), t_6fc8663c (pre-promotion verifier gate, versioning, and same-name merge for skill proposals).

## Out of scope

- Webhook server transport for Telegram (long-polling only, no new dependencies); outbound discipline reports stay untouched.
- OCR or binary artifact ingest (separate subsystem, t_77f9d89b).
- A dream-phase plugin registry (the rollup ladder is ordinary synthesize-phase code; the repair lane is deliberately CLI-first and not a dream phase).
- Any LLM call inside the deterministic kernel: rollup and diarization TEXT synthesis emit needs-llm-step envelopes; triggers, classification, gating, and repair are counters and structural signals only.

## Chosen approach

Consultant Variant 2, two-seam pragmatic.

Seam 1, capture-note contract: one module owning the staging vocabulary - frontmatter kind, provenance (source, sender identity, capture timestamp), staging and archive paths - anchored on the existing inbox-versus-processed distinction in forget-plan.ts. The Telegram bot writes captures only through this contract; the inbox-drain pass reads only through it. Rides in the t_f8f5ef6a anchor commit.

Seam 2, keyed external-fetch helper: a small module for env-gated HTTP calls - Bearer auth, typed errors, shared response cache - used by the Brave provider, the Tavily provider, and the full-page extract step. Telegram keeps its existing token and MarkdownV2 plumbing. Rides in the t_1dcbf352 anchor commit.

Non-extractions: evidence identity is a shared exported type plus predicate in deep-synthesis types (t_40fa4e8d defines it, t_28ba3fc4 consumes it); the rollup ladder is plain code in the synthesize phase.

Track ordering: intake track t_f8f5ef6a then t_b0bba8cb; consolidation track t_40fa4e8d then t_28ba3fc4 then t_c5263e27; t_1dcbf352, t_6832aac6, t_6fc8663c independent.

## Design decisions

- Telegram bot (t_f8f5ef6a): an explicit runner verb (long-poll getUpdates via fetch) gated by the existing bot token config; every accepted update becomes one capture note through the contract; sender allowlist by chat id (config, structural); /catchup renders what changed since the last acknowledged capture using existing brief machinery; every rejected or failed update is an explicit logged decision, never a silent drop.
- Inbox drain (t_b0bba8cb): classification is structural only (frontmatter kind, URL-shaped body, obligation markers, contract provenance); dry-run report is the default, apply is explicit; each item's routing decision (source page, note create-or-merge, obligation) lands in a per-run report with a reason; archive moves the capture to the processed area via the contract; unroutable items are named in the report and left in place.
- Research providers (t_1dcbf352): a provider joins the pool only when its key env is set; keyless runs report the empty pool explicitly; responses cache in the shared fetch helper keyed by normalized request; the full-page extract step fetches page text for a finding and hands it to the existing citation-constrained pipeline; network failures are typed errors carried in the report, never invented content.
- Rollup ladder (t_c5263e27): named-constant thresholds (config-overridable) count new facts per tier since the last rollup; reaching the threshold emits one needs-llm-step rollup envelope and records the counter reset in the dream report; identity-tier facts get the highest existing tier weight; no counter movement means byte-identical dream output.
- Diarization (t_28ba3fc4): a CLI verb and MCP param take an entity, collect its document set from the entity registry and source pages, and emit a structured profile note skeleton plus a needs-llm-step envelope; the stated-vs-evidenced section is computed deterministically from claim machinery (stated claims) against evidence frequency and recency (behavioral signals), each line carrying evidence identity.
- Synthesis findings (t_40fa4e8d): additive causal-context field, decomposed confidence components (support, opposition, freshness, coverage - each deterministic), and an emission gate that drops identity-less findings while reporting the excluded count; the steelman seed selection stays unchanged.
- Repair lane (t_6832aac6): dry-run default with exact confirmation to write; candidate edges ordered by identity strength (explicit references, session continuity, same-topic evidence, opt-in inferred), confidence threshold and hard per-run write cap as named constants; forward-scan past existing edges makes reruns converge to zero writes; the holdout harness measures graph lift separately from direct recall and fails the gate on any dangling edge.
- Skill proposals (t_6fc8663c): the verifier gate runs before a draft reaches pending, checking evidence count and structural validity against the proposal's own supporting records, recording the rejection reason; accepted skills carry a version field that increments on evolution; a same-name collision merges support instead of forking; the human accept/reject flow is unchanged.

## File changes

- New: capture-contract module under src/core/brain (staging vocabulary and read/write helpers), Telegram inbound runner (CLI verb plus core module beside src/core/discipline/telegram.ts), inbox-drain pass module and CLI verb, src/core/research providers (brave, tavily, extract) plus the keyed fetch helper, rollup-ladder module in the dream synthesize path, diarization module and CLI verb, graph repair-lane module and CLI verb plus holdout harness, skill-proposal verifier and version fields.
- Modified: src/core/brain/dream.ts and dream-phases.ts (synthesize hook point), src/core/brain/deep-synthesis.ts (fields, gate, exported evidence-identity type), src/core/brain/skill-proposals.ts, src/core/brain/research/research.ts (pool wiring), relevant MCP tool registrations and registry baselines, tests beside every change.
- Exact paths follow the codebase layout discovered during TDD; implementers adapt names to neighboring conventions and record deviations in commit bodies.

## Risks and open questions

- Telegram long-polling is a long-running process: the runner must handle token absence, network failure, and shutdown explicitly; it never runs implicitly from hooks.
- Inbox-drain routing must never double-ingest on rerun: the contract's processed marker is the idempotency key.
- Provider caches must not leak keys into cache paths or logs (redactor applies).
- The evidence-identity gate could exclude legitimate findings in sparse vaults; the excluded count plus reasons keep the loss visible, and the gate threshold is a named constant.
- Repair-lane inferred edges are opt-in; the default lane uses only explicit-reference and continuity candidates.
