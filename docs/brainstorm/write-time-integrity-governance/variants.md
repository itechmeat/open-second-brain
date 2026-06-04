# Write-Time Integrity & Governance Suite - brainstorm audit trail

Consultant: Claude Code (`claude -p`), primary path, exit 0, 3 parseable variants. Fallback (Codex) not needed. Prompt: `cli-output/prompt.md`, raw output: `cli-output/claude.md`.

## Variants (consultant verbatim)

### Variant 1: Unified Write-Contract Gateway
- **Approach**: Funnel every Brain write through a single `validateWrite()` contract gateway that composes pluggable validators (tier guard, enum vocabulary, link-endpoint constraints, attribute hints) and enforces fail-closed semantics with one shared audit trail. Secret custody is a sibling "resolve-but-never-return" capability resolver invoked outside the write path; the maintenance lane is a separate scheduler. All six features hang off two cross-cutting spines.
- **Trade-offs**:
  - Pro: one enforcement point with consistent fail-closed behaviour and a single, uniform diagnostic/audit stream.
  - Pro: new contracts (future epics) register once and apply everywhere.
  - Con: directly courts the explicitly-forbidden "governance framework" over-abstraction.
  - Con: retrofitting every existing write call site is invasive and threatens the bit-identical neutral-default guarantee across a wide blast radius.
  - Con: couples the capture hot path to a generalized validator chain, risking the "capture stays fast" constraint.
- **Complexity**: large
- **Risk**: high

### Variant 2: Schema-Pack-Centric Ontology + Two Satellites
- **Approach**: Promote the schema pack to the single declarative ontology via additive version bump - adding a tier map (T1), controlled-vocab enums (T3), per-link source/target pairs (T4), and per-type attribute descriptors (T5) - while enforcement stays at each feature's existing seam (frontmatter merge, ranker/extractor, relation-polarity, fact-extract), all reading the same pack. Secret custody (T2) and the quiet-window maintenance lane (T6) ship as standalone modules reusing only existing conventions (node:crypto, JSONL ledger discipline, `discipline/window.ts` math). Three of six tasks collapse onto one config surface without a new runtime layer.
- **Trade-offs**:
  - Pro: leverages existing `schema-pack`/`schema-mutate`/`schema-vocab` machinery - the shared surface genuinely "pays for itself" and turns a flat token list into a real ontology.
  - Pro: hot path untouched; expensive validation stays in explicit verbs/dream; neutral defaults trivially preserved (empty pack fields = old behaviour).
  - Pro: per-task landability and additive versioning fit the v0.43.0 format-stability constraint.
  - Con: schema pack grows broad; four enforcement seams remain physically separate even though they share one source of truth.
  - Con: one coordinated schema version bump must serve four features, needing care to stay additive.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Six Fully Independent Modules
- **Approach**: Each task is a self-contained core module + CLI verb + MCP tool + tests touching only its named seam, with zero coordination layer. Tier guard, enums, link constraints, and attribute hints each extend their respective files independently (the three schema features each add their own additive field in isolation); secret store and maintenance lane stand alone.
- **Trade-offs**:
  - Pro: minimal risk, maximal composability, easiest per-task land/revert, smallest blast radius.
  - Pro: neutral-default guarantee is almost free per feature.
  - Con: duplicated write-time validation plumbing across T3/T4/T5.
  - Con: three tasks mutate the schema pack with no shared discipline - invites drift and fragmented enum/constraint/attribute handling.
  - Con: no consistent fail-closed or audit story; misses the natural synergy of the three schema-driven features.
- **Complexity**: medium
- **Risk**: medium

### Consultant recommendation: Variant 2
**Rationale (verbatim)**: It captures the real synergy - tasks 3, 4, 5, and 1 are all declarations that belong in the schema pack, which already exists and so avoids the forbidden framework layer while still giving a single source of truth. Enforcement at the proven existing seams keeps the capture hot path fast and makes the bit-identical neutral-default guarantee easy to pin with tests, and leaving secret custody and the maintenance lane as independent satellites honours their genuine orthogonality rather than forcing all six into the over-abstraction that sinks Variant 1 or the duplication/drift that weakens Variant 3.

## Orchestrator decision

Variant 2 accepted without override. Project-context confirmation beyond the consultant's reasoning:

1. The schema pack already has exactly the needed lifecycle (parse -> freeze -> render -> mutate -> lint) proven across three prior releases; adding four additive fields rides battle-tested machinery instead of inventing parallel config surfaces (Variant 3's drift risk is real - the v0.43.0 cycle showed how much discipline one shared format needs).
2. Variant 1 contradicts a hard brief constraint ("no governance framework layer unless it genuinely pays for itself") and would touch every writer call site, blowing both the bit-identical guarantee and the 50-70 file target.
3. The two satellites match precedents: secrets follow the Pay Memory governance + activation-store storage discipline; the maintenance lane reuses `discipline/window.ts` and the #71 recall-telemetry counters - no new abstractions anywhere.

Containment refinements documented in `design.md`: tier guard never write-denies humans (detect + staged repair instead), secrets keyfile threat model stated honestly, `--force` on maintenance bypasses soft gates but never the lease.
