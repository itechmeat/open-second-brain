You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Open Second Brain release wave "answer-trust": four kanban cards plus a small repair lane, one coherent PR on the current main (v1.80.0). Product: a local-first memory/knowledge vault for AI agents (TypeScript, Bun, MCP server + CLI + hooks). The wave spine: the brain's answers are only as trustworthy as their ties to stored sources.

Card A (t_245378f9) - verify answer-time quotations against source notes; unsupported quotes are marked unverified; on by default where the underlying lane is enabled, per-phase switchable, graceful degradation on truncated context. Verified premises: the distill lane already verifies its own quotes (pure reusable helpers in src/core/brain/distill/quote-spans.ts: findQuoteSpans, normalizeForQuoteComparison, spanOccursIn, quoteHaystack); answers are produced by the HOST agent, so OSB owns (a) what enters context (injection hooks + injection-ledger.ts records injected notes per session) and (b) turn-end observation (Stop hook with transcript_path; precedent hooks/stop-log-guardrail.ts). A new Stop-hook step + a src/core/brain/answer-quotes/check.ts module is the natural shape; config via _brain.yaml quote_check: per-phase off|shadow|enforce, shadow default; never blocks, annotates via additionalContext.

Card B (t_2ffffd28) - statement-level attribution: join stated claims to the recall receipt they drew on. Verified premises: receipts (context-receipts.ts, items named, durable receiptId) and outcomes (context-pack-outcome.ts, three rows keyed by sample_id) already exist; the claim ledger (truth/store.ts ClaimEvent) has NO linkage to either. Chosen direction: read-time join - optional sample_id threaded through brain_truth state, frozen on the ClaimEvent (optional field, schema-compatible), new read-only join helper claim-provenance.ts; zero new answer-time writes. Alternative rejected for cause: per-statement provenance rows (duplicates claim ledger, unbounded continuity growth, OSB never sees answer text anyway).

Card C (t_9b835c8f) - durable raw-source capture at intake so provenance survives link rot. Verified premises: intake discards source bytes today (classifySourceOrigin is byte-discarding; readSourceOrigin keeps bytes but only distill calls it); distill stores a 64 KiB excerpt + excerpt_hash on the page; artifact store is ephemeral scratch. Proposed shape: new src/core/brain/provenance/source-archive.ts, content-addressed Brain/.archives/<sha256>.txt, trusted local-file lane only, <=1 MiB refuse-not-truncate, redact (redactRawOutput) before persist, stamp source_archive_hash on the ingest summary page, capture-scope hygiene detector + doctor verify presence/integrity; no TTL (evidence, not scratch); delete-by-source cleanup gains an archive-entry kind.

Card D (t_22d58fa7) - blank session identity. Verified premises: payload records written by lanes with no session in scope omit session_id; five reader sites coerce the absence to "" (session-recall.ts:577, session-summary.ts:243/339/375, idea-lineage.ts:120/198), lumping unrelated lanes into one shared "" group; scoped recall silently drops them. Decision: absence stays absence (precedent orphan-session-check.ts:37-40 "session:unknown is a statement there was no session, not a pointer to a missing one") - readers treat missing/non-string as no-session explicitly; grouping sites skip rather than lump; new count-only informational doctor check blank-session-identity (no fix verb - repair belongs to t_6cc80627's backup-gated posture); NO payload rewrites.

Repair lane (from the post-merge external review, verified): M1 - stale-index attribute narrowing silently excludes documents whose indexed snapshot no longer matches the file (property-pushdown.ts EXISTS...OR NOT EXISTS fragment has no freshness gate) despite advertised "judged live" semantics; fix = freshness gate so stale candidates fall through to the live filter. L12 - CHANGELOG whitespace damage at lines 264 and 2450. Everything else from that review is already fixed on main.

# Project context

Open Second Brain: TypeScript on Bun, local vault (Obsidian-style markdown + JSONL continuity logs + SQLite search store), MCP tools + CLI verbs + hooks. Recent waves: v1.77 correctable truth layer, v1.78 credential custody, v1.79 write-side trust, v1.80 recall quality (SQL pushdown, entity lexicon, hallways PMI graph). House rules: no silent fallbacks (errors surface by name), no stubs, no hardcoded natural-language phrases, constants over literals, TDD, per-feature config resolvers in src/core/config.ts, doctor checks registered in DOCTOR_CHECKS, census tests guard architecture invariants. A PR carries about 30-50 changed files with tests; implementation runs in parallel lanes with disjoint file ownership.

Constraints:
- No new external dependencies.
- Do not break existing pinned test semantics without reason.
- Read-time joins preferred over new write-path machinery when data already exists.
- The answer path is hot: Stop-hook work must be bounded (chars, wall clock) and fail-open.
- Redaction/visibility rules from v1.78-v1.79 apply to anything that persists bytes.

# Required output format

Produce exactly 3 distinct architectural variants for the WHOLE wave (how the four cards compose into one architecture). For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
