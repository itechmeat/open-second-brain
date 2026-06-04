You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Epic "Write-Time Integrity & Governance Suite" for Open Second Brain (~v0.44.0). Six kanban tasks ship as one release. Theme: every write into the Brain passes declared contracts.

## Task 1 (t_3f92d3f1, p4): Tiered frontmatter field protection (system vs business vs user-editable)

Upstream EverOS gives every markdown file a 4-tier frontmatter chassis (L1 read-only id/type/schema_version, L2 system, L3 business, L4 user) so direct hand-edits in Obsidian/Vim cannot clobber framework-owned join keys; writers merge frontmatter respecting tier protection on every append.

OSB writes frontmatter atomically and detects content-hash drift, but has no tier model declaring which frontmatter fields a human may safely edit vs which are framework-owned join keys. In a Syncthing-shared Obsidian vault that humans edit directly, a tier guard would prevent silent corruption of ids/scopes the index depends on.

Codegraph hints: writeFrontmatterAtomic in src/core/vault.ts:173 (atomic write, exclusive-create semantics); src/core/brain/content-hash.ts drift checks exist; no per-field tier-protection layer.

## Task 2 (t_0b134404, p4): Capability-gated secret custody store the agent uses but cannot read

Upstream Signet stores secrets encrypted-at-rest (per-value ciphertext, 0600) behind a privileged plugin. The agent never receives decrypted values: the daemon resolves a secret internally and either uses it directly in an API call or injects it into a subprocess env the agent cannot inspect. Every operation emits audited diagnostics (secret.resolved_for_exec, secret.exec_started) with values never logged; routes are capability-gated.

OSB redacts secrets out of memory (src/core/redactor.ts removes secrets, never resolves them) but has no positive custody path - nothing lets an OSB-driven agent USE a credential (an embedding key, a deploy token) without the value entering its context. A capability-gated, audited secret store under Brain/ would extend OSB's governance-first thesis from redaction to safe use, complementing Pay Memory's spend governance (src/core/pay-memory/ is spend approval, not credential custody).

## Task 3 (t_7a41f42d, p3): Controlled-vocabulary entity labels enforced at write time

Upstream Hindsight lets a memory bank define a fixed vocabulary of classification dimensions (e.g. priority with enum values low/medium/high/urgent) at config level. At retain time the extractor is forced to pick an allowed value, stored as a canonical entity like 'priority:urgent'. Labels become graph entities that cluster related memories and, when flagged, filterable tags.

OSB has free-form entity extraction and entity-match ranking but no operator-defined controlled vocabulary enforced at write time. A schema-pack-driven enum the extractor must choose from would give deterministic filterable tags (domain, sensitivity, lifecycle-stage) and natural clustering, fixing same-concept-three-spellings fragmentation.

Codegraph hints: src/core/search/ranker.ts:34-41 entityMatchByChunk (free-form entity layer only); schema-pack types exist but do not enforce enums at write time.

## Task 4 (t_15453235, p3): Schema-enforced source/target type constraints for link types

Extend the schema pack so each declared link_type carries allowed (source_type, target_type) pairs, and the extractor/validator refuses to materialize a typed relation whose endpoints violate those constraints. OSB currently declares link_types and an open relation vocabulary with fixed polarity, but never restricts which page/entity types a given relation may connect. Turns the schema pack from a flat token list into a real ontology, blocking nonsense edges (e.g. a depends_on from a preference to a payment receipt) at write time and making typed-relation recall trustworthy by construction.

Codegraph hints: src/core/brain/schema-pack.ts:14-22 (SchemaPack interface, no source/target field); src/core/brain/schema-mutate.ts (add_link_type/remove_link_type only); src/core/search/relation-polarity.ts:34,171-225 (open vocabulary, endpoints unconstrained).

## Task 5 (t_f5633190, p1): Per-type attribute fields with descriptions guiding fact extraction

Let an extractable schema type declare a small set of typed attribute fields (e.g. status, category, proficiency) with natural-language descriptions that steer the fact extractor toward populating those fields, instead of capturing only a flat span. OSB's regex fact-extraction captures whole spans into fact-family signals with no structured attributes; per-type attribute hints would let domain-specific terminology and structured values be captured and later filtered.

Codegraph hints: src/core/brain/fact-extract.ts:30-80 (FAMILY_PATTERNS, ExtractedFact has only family/text/line); src/core/brain/schema-pack.ts:20,43-45 (extractable is a token list, no field descriptors).

## Task 6 (t_166d1226, p3): Quiet-window, lease-guarded heavy maintenance lane

Upstream ClawMem runs a second consolidation worker only inside a configurable hour window and only when interactive query-rate is low, scoped exclusively via DB-backed worker leases (no double-run across processes), stale-first selection, journaling every attempt in maintenance_runs for operator visibility.

OSB's dream/maintenance fires from cron with no contention awareness or lease, so a heavy pass can overlap an interactive recall on the same vault. A query-rate-gated, lease-guarded quiet-window lane would schedule expensive synthesis/reindex without competing with live agent turns, with an auditable run journal.

Codegraph hints: src/core/brain/dream.ts (cron-triggered, no lease/quiet-window/query-rate gate); src/core/discipline/window.ts:53 has timezone window math but not applied to workers; no worker-lease/maintenance-runs equivalent.

# Project context

Open Second Brain: TypeScript on Bun, second brain for AI agents over Obsidian-compatible Markdown vaults plus SQLite (FTS5 + sqlite-vec) index. CLI (`o2b brain <verb>`), MCP server (69 tools), python Hermes plugin. Markdown files are authority; SQLite/state.json files are recomputable caches.

Recent commits:
3a2d2c7 chore(release): v0.43.1
db22f43 fix(hermes): root cli.py shim completes the upstream CLI discovery contract
a0054dd feat: Entity Truth & Self-Improving Dream Suite - claim ledger, outcome-aware dream, foresight (#74)
b16c37d feat: Time-Aware Recall & Activation Suite - usage-aware ranking, event-time recall, two-pass recovery (#73)
c3a2fcc feat: Agent Write Contract Suite - write sessions, decision panel, backend boundary, shared namespace (#72)
7733f20 feat: Project History Suite - git history memory, ADR mining, architecture notes, query telemetry (#71)
8e8c0bc feat: Memory Observability Suite - versioned continuity contract, lazy telemetry, ATOF/ATIF export, recall benchmark (#70)
eb56c9f feat: Workspace Insight Suite - project pointers, cross-vault recall, trigger queue, proactive synthesis (#69)
707197a feat: Agent Surface Suite - skills over MCP, two-pass tool catalog, surface profiles, session lifecycle (#68)
eda202d feat: Embedding Provider Suite - local embedder, provider registry, cost gate, RRF fusion (#67)
dee5ab7 feat: Memory Integrity Suite - canonical entities, conflict-free log shards, capture boundaries, fact extraction (#66)

Related files:
- src/core/vault.ts (writeFrontmatter, writeFrontmatterAtomic, parseFrontmatterText)
- src/core/brain/content-hash.ts (drift detection)
- src/core/brain/schema-pack.ts, src/core/brain/schema-vocab.ts, src/core/brain/schema-mutate.ts (schema pack: declarations, aliases, prefixes, link_types, extractable, expert_routing; mutation verbs)
- src/core/search/relation-polarity.ts (typed-relation vocabulary, fixed polarity)
- src/core/brain/fact-extract.ts (FAMILY_PATTERNS regex families incl. quantity; ExtractedFact {family, text, line})
- src/core/brain/entities/registry.ts (canonical entity registry upsert/relate)
- src/core/redactor.ts (SECRET_KEYS, redactRawOutput - removal only)
- src/core/pay-memory/ (approval workflow, receipts, policy check - the governance precedent)
- src/core/brain/dream.ts (2226 lines, cron-fired learning pass; DreamRunSummary)
- src/core/brain/triggers/ (trigger queue with cooldown dedup, push-mode findings)
- src/core/discipline/window.ts (tz-aware window math, currently only for daily digest)
- src/core/brain/truth/ (v0.43.0 claim ledger: append-only JSONL shards folding to state.json - the storage discipline precedent)
- src/cli/brain/verbs/ + src/mcp/brain-tools.ts (CLI verb / MCP tool registration patterns)

Conventions:
- Deterministic, bounded, fail-closed core; no model calls in core paths; provider-dependent work is optional and degrades cleanly.
- Markdown-first: durable state is human-readable .md with frontmatter; derived caches recomputable; append-only JSONL ledgers with explicit sweep where event history matters.
- Neutral defaults: a vault without the new config/data must behave bit-identically to the previous release (pinned by tests).
- Nothing auto-resolves silently: conflicts and destructive decisions stage as ask_user findings or require explicit flags (--force / bypass options).
- Every new capability ships as: core module + CLI verb + MCP tool + tests (bun test) + docs.
- TDD with atomic conventional commits; oxlint/oxfmt baseline; TypeScript strict, no `as` cast crutches.

Constraints:
- Do not change existing public APIs or break the v0.43.0 truth-ledger / schema-pack file formats (additive schema versioning only).
- No new heavyweight external dependencies; encryption must come from the platform (node:crypto). No daemon processes - OSB is CLI/MCP invoked; "the agent cannot read the secret" must be designed within that constraint honestly (threat model: protect against accidental context leakage and casual reads, document what root/same-user access can still do).
- The capture hot path must stay fast; expensive validation belongs in explicit verbs or the dream/maintenance lane.
- Single PR ~50-70 files; six features must compose without a shared over-abstraction (no "governance framework" layer unless it genuinely pays for itself).

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
