You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Make src/core/brain/fact-extract.ts language-agnostic. Today it extracts 7 families of facts from user turns in real time using regex patterns anchored on ENGLISH trigger phrases: "my name is", "I'm called", "I prefer / always use / never use", "I live/based in", "my site/blog/repo is", "my email is", a confirmation frame ("yes|correct|right|exactly" + "my|our|the" + "is|are"), generic possession ("my X is Y"), and a quantity family (English action verbs "spent|paid|earned|saved|billed|ran|completed|logged|worked|shipped" + number + optional unit). It also hardcodes English stop-words ("on","for","the",...) and an English possession-key blocklist ("name","email","blog",...).

The hardcoded English phrases must be removed. The system must not hardcode phrases for any specific human language (we cannot enumerate all world languages). Where non-English input must be handled, it must be handled ABSTRACTLY (structurally), not by adding another language's word list. The replacement must not introduce meaningless/misleading fallbacks.

This extractor is the real-time, LLM-free complement to a heavier pre-compaction extraction path. It feeds the truth subsystem (truth/ingest.ts, sessions/import.ts, session-lifecycle.ts) by writing `source_type: extracted` signals. Precision is valued over recall: a missed fact costs little, a hallucinated fact pollutes memory.

# Project context

Open Second Brain - an agent-owned Obsidian-compatible Markdown vault plugin. TypeScript run on Bun. Offline-first: search defaults to keyword-only; semantic/LLM features are opt-in via providers (openai-compat | local lexical baseline | disabled). The just-merged PR #84 already made SEARCH and CLASSIFICATION language-agnostic by removing hardcoded EN/RU word lists in favor of structural signals, corpus document-frequency (IDF), and explicit frontmatter. fact-extract.ts was the one deferred slice.

Recent commits:
9886d9a refactor: make search and classification language-agnostic (#84)
618870e refactor!: remove the pay.sh integration and the Pay Memory layer (#83)
72bac52 fix(hermes): advertise static tool schemas so the provider registers with its full tool set (#81)
ff43abd fix(ci): treat an existing release as success in the release workflow (#80)
957a403 feat!: Stability & Trust - 1.0.0 API freeze, deprecation sweep, safeguard, staged dream, timezone, report deltas (#79)
786b0f5 fix(openclaw): rebuild stale plugin bundle so the release verify gate passes (#78)
6d09d3c feat: Link & Recall Intelligence Suite - alias resolution, bridge discovery, communities, recall benchmark, self-tuning (#77)
789e3e3 feat: Write-Time Integrity & Governance Suite - schema ontology, tier guard, secret custody, maintenance lane (#76)
c03d569 fix(hermes): root cli.py shim completes the upstream CLI discovery contract (#75)
a0054dd feat: Entity Truth & Self-Improving Dream Suite - claim ledger, outcome-aware dream, foresight (#74)
b16c37d feat: Time-Aware Recall & Activation Suite - usage-aware ranking, event-time recall, two-pass recovery (#73)
c3a2fcc feat: Agent Write Contract Suite - write sessions, decision panel, backend boundary, shared namespace (#72)
7733f20 feat: Project History Suite - git history memory, ADR mining, architecture notes, query telemetry (#71)
8e8c0bc feat: Memory Observability Suite - versioned continuity contract, lazy telemetry, ATOF/ATIF export, recall benchmark (#70)
eb56c9f feat: Workspace Insight Suite - project pointers, cross-vault recall, trigger queue, proactive synthesis (#69)
707197a feat: Agent Surface Suite - skills over MCP, two-pass tool catalog, surface profiles, session lifecycle (#68)
eda202d feat: Embedding Provider Suite - local embedder, provider registry, cost gate, RRF fusion (#67)
dee5ab7 feat: Memory Integrity Suite - canonical entities, conflict-free log shards, capture boundaries, fact extraction (#66)
5066e71 feat: Token Diet - budgeted injection, reminder cadence, consolidated MCP surface (#65)
c494fd8 feat(search): Recall Trust Suite - relation polarity, learned weights, time-aware and verified recall (#64)

Related files:
- src/core/brain/fact-extract.ts (the target)
- src/core/brain/truth/ingest.ts, src/core/brain/sessions/import.ts, src/core/brain/session-lifecycle.ts (consumers)
- src/core/brain/entities/canonical.ts (normalizeEntityName, used for entity anchoring)

Conventions:
- Offline-first; deterministic where possible; providers are opt-in (openai-compat | local | disabled).
- Precision over recall for real-time capture.
- SOLID / KISS / DRY; no hardcoded natural-language word lists; no meaningless fallbacks.
- The sibling search/classification refactor (PR #84) preferred: structural signals, Unicode-aware tokenization, explicit frontmatter fields, corpus IDF, and agent/LLM extraction where structure is insufficient.

Constraints:
- Do NOT hardcode phrases/words for any specific human language.
- Do NOT add a fallback that silently does nothing or misleads (e.g. "no provider -> pretend extraction happened").
- Keep the public exports stable where reasonable (extractFacts, parseQuantityFact, routeExtractedFacts, factDedupHash) - consumers depend on them.
- Real-time path must stay cheap; a per-turn synchronous LLM call on every user message is likely too heavy for the default offline mode.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences.
- **Trade-offs**: bullet list of pros and cons (include the recall regression risk explicitly).
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences considering the offline-first, precision-over-recall, no-fake-fallback context.

Output nothing outside of these sections.
