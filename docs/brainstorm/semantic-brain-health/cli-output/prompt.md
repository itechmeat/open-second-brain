You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Build a "Semantic Brain Health & Self-Maintenance" bundle for Open Second Brain. Today `brain_doctor` validates only structural vault invariants (frontmatter validity, duplicate IDs, ISO parsing, dangling wikilinks, duplicate-preference near-dupes, content-hash drift). It does NO semantic-level auditing, and it cannot fix anything it finds. The bundle adds a semantic quality gate plus deterministic self-maintenance:

1. Cross-preference contradiction detection: surface pairs of CONFIRMED preferences that are about the same subject but carry an opposite "sign of record" (positive vs negative). Must be language-agnostic — no negation word lists.
2. Concept-gap detection: terms that recur across the signal+preference corpus (frequency >= N) yet have no dedicated preference/page.
3. Stale-claim flagging: confirmed preferences whose newest supporting evidence is older than a configurable window.
4. Per-preference edit-history audit trail: append-only sidecar capturing one entry per content mutation {timestamp, agent, revision, field, before, after}, rendered as a timeline on demand.
5. Dependency-ordered remediation plan with dry-run: doctor computes an ordered repair plan from its own findings, classifies each step auto-safe (deterministic) vs needs-review, applies only auto-safe fixes outside dry-run, and refuses past a bounded step cap. NO paid LLM jobs, NO background worker — purely local deterministic repairs.
6. Semantic-health aggregate surface ("truth reconciliation"): run the semantic detectors as distinct domains (preferences / evidence / retirement) and return one structured verdict in a single deterministic pass (NOT spawning sub-agents).

# Project context

Open Second Brain — TypeScript + Bun, Obsidian-vault-backed agent memory. Vault is plain markdown synced across peers via Syncthing; determinism is load-bearing (same vault must hash/rank/flag identically on every peer). Just shipped v0.13.0 (hybrid search & recall suite) with the same in-place-extension-of-pure-modules style.

Recent commits:
2147640 v0.13.0 - Hybrid Search and Recall Quality
84886d1 v0.12.0 - Brain Integrity Suite: typed collision detection, content-hash drift, durable dream workruns
c002268 v0.11.0 - Brain-centric vault layout
a8d4803 v0.10.18 - temporal axis: timeline, belief evolution, stale watch, daily brief, weekly synthesis
3b7dfe9 v0.10.16 - trust and operator surfaces - verification, verdict, dashboard

Related files (existing primitives to reuse, DRY):
- src/core/brain/doctor.ts (1088 lines): runDoctor() -> RunDoctorResult { issues: DoctorIssue[]{severity:"warning"|"error", kind, message}, trustVerdict, ... }. Lint functions are private `check*` helpers appended to an issues array. Already has checkDuplicatePreferences (jaccard 0.7), checkContentHashDrift, checkLowEvidenceConfirmed, checkPinnedWithoutRecentEvidence, readAllPreferenceRecords, readAllLogRecords. Never mutates state today.
- src/core/brain/similarity.ts (84 lines): tokenise(text) (language-agnostic, no stopwords), jaccard(a,b), findSimilarPairs(entries, {threshold}) bucket-and-pair walk. Already shared by doctor + merge-candidates.
- src/core/brain/dream.ts (1904 lines): the learning pass. Has the "sign of record" derivation — a preference's sign (positive/negative) is the dominant sign of the signals in its evidenced_by; falls back to topic signals. contradictionTopics is tracked when both polarities appear for a topic with no active pref. BRAIN_SIGNAL_SIGN = {positive, negative}.
- src/core/brain/preference-txn.ts (285 lines): writePreferenceTxn() — THE single chokepoint for every preference write (direct + dream). Runs an expectations chain under a sync lock, then computes smart defaults (_content_hash on confirm, monotonic _revision bumped only when wouldRewritePreference says bytes change), then delegates to writePreference. willChange is already computed here.
- src/core/brain/preference.ts (1135 lines): parsePreference, writePreference, wouldRewritePreference. BrainPreference carries principle, scope, topic, status, revision, content_hash, last_evidence_at, _applied_count, _violated_count.
- src/core/brain/temporal/stale-watch.ts (208 lines): file-mtime-based staleness (different axis than evidence-age staleness).
- src/core/brain/trust/assess-rule-quality.ts (129 lines): language-agnostic structural quality gate returning {score, severity: ok|warn|reject, reasons}. Pattern to mirror.
- src/mcp/brain-tools.ts (1880 lines): MCP tool handlers (brain_doctor, brain_query, brain_review_candidates, ...).
- src/cli/brain/verbs/doctor.ts, dream.ts: CLI verb wrappers.

Conventions:
- Language-agnostic by construction: no stopword lists, no negation dictionaries, no per-language vocab. Codepoint-shape and structural signals only (\p{L}, \p{N}, polarity sign, token overlap, counts, ages).
- Determinism: identical vault -> identical output on every peer. No wall-clock except injected `now`. No network in core.
- Pure core modules + a thin store/IO boundary; MCP and CLI are thin shells over core.
- Graceful per-layer degrade; each detector independently skippable/config-gated.
- New artifacts excluded from the search index by default when they are bookkeeping sidecars.

Constraints:
- Do NOT add external dependencies.
- Do NOT introduce a background-job/worker system or any paid LLM call in remediation — repairs must be local and deterministic.
- Do NOT spawn sub-agents for the "reconciliation" feature — single deterministic pass with domain partitioning.
- brain_doctor must remain non-mutating by default; remediation is an explicit opt-in path.
- Reuse similarity.ts and the preference-txn chokepoint rather than re-implementing token/diff/write logic.

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
