You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Wave scope (operator-picked option 3, "P4 silent-failure hardening"): nine tracker cards, already verified against the live source at commit f22df2c5 by a premise-verification pass. Every card premise survived; the verification corrected anchors and narrowed scope. The wave ships the surviving premises as one merged, released increment. Per card, the verified premise and the landed scope:

1. t_5c777198 (redaction wire formats): the URL-credential regex `BASIC_AUTH_URL_RE` (src/core/redactor.ts:249) has password class `[^\s/@]+`, so a password containing `/` (common in generated secrets) defeats the whole match and both user and password leak through the egress redaction boundary; a bare three-segment JWT passes verbatim under default options and is only partially redacted under `redactTokens` (the 20-character header slips the 24-character HIGH_ENTROPY gate). Land: widen the password class within the documented bounded/linear regex constraint, and add a default-on three-segment JWT detector next to the existing `BEARER_RE` pass.
2. t_c70f3d94 (sibling {name, value} secret pairs): the structured redaction walk keys secrecy off the value's own key only, so `{environment: [{name: "DB_PASSWORD", value: "hunter2"}]}` passes the value verbatim; the existing `isSecretKeyName` matcher already matches the sibling name, the walk never consults it. Land: inspect plain-object array elements for `{name, value}` shape and reuse `isSecretKeyName` on the sibling name; ECS `valueFrom` is an ARN reference, out of scope.
3. t_796c1a9b (save-time absolute-path warning): note bodies are never scanned for absolute paths at write time, while a reusable grammar exists at src/core/hygiene/hardcoded-paths.ts (currently CI-only). Land: non-blocking advisory on the write receipt, following the page-lint precedent (`pageLintField` on `noteWriteResult`), advised not blocking (a WriteBatchError would abort the all-or-nothing batch).
4. t_9b30f48b (unclassifiable ingested files): two vault walks and the source-ingest discovery walk `collectIngestible` silently drop files whose extension is not ingestible; no count or notice exists. Land: aggregate counters for skipped extensions plumbed to a surface, reusing the closed `DEGRADATION_CODE` vocabulary.
5. t_09d52938 (typed skip taxonomy): `SkippedPage.reason` is free text; the session lane already has a dry run with counters, so the genuinely new ground is typing the source-ingest skip reasons and adding aggregate per-reason counters on the BatchPlan lane. No new preview. Land: type `SkippedPage.reason` following the `PageLintSkipReason` pattern (membership list plus narrowing parser, wire-compatible), aggregate per-reason counters surfaced through `serializeBatchPlan` and the CLI verb.
6. t_a77e35a2 (mtime-stable re-renders): `skipIfUnchanged` exists in fs-atomic but no production caller passes it; every identical rewrite lands a fresh inode and bumps mtime. Land: opt-in at exactly the two unguarded chokepoints, `commitNoteRewrite` (src/core/brain/write-batch.ts:594) and the `writeFrontmatterAtomic` overwrite branch (src/core/vault.ts:477); on short-circuit skip the before-image store and the note-write record, and make the audit result `updated` reflect whether bytes were written. No default flip in fs-atomic.
7. t_541083b3 (WAL on remote backing): `applyPragmas` sets `PRAGMA journal_mode = WAL` unconditionally on every index open; on NFS/CIFS/FUSE backing WAL is unreliable. The backing probe (src/core/vault-backing.ts) classifies nfs/cifs/fuse as `durable` and has no remoteness axis. Land: add a remoteness axis to the probe; on a remote backing, skip WAL (stay on the default journal mode) and warn, no hard refuse; non-Linux probe-unsupported stays silent, WSL/9p false-positive risk respected.
8. t_f99250aa (embeddings-health doctor check): signals for embeddings health exist and are scattered (pending-vector census, stale-embedding counts, provider probe in `o2b search check`) but nothing is consolidated into the brain doctor. Land: a new read-only failSoft doctor check modeled on `embeddingSunsetCheck`, registered in `DOCTOR_CHECKS`, message-embedded next command, uncertain stream for unrecorded census.
9. t_6cc80627 (orphan observation signals): observation signals carry `session_ref` and nothing resolves it against the sessions/continuity store; a signal whose parent session is gone is silently accepted. Land: a doctor check (failSoft, read-only) for unresolved `session_ref` signals, plus a repair verb following the repair-lane discipline (dry-run default, exact confirm phrase, hard write cap, never reachable from `runDoctor`).

# Project context

Project: Open Second Brain, TypeScript (ESM, NodeNext) on Bun 1.4.0; an Obsidian-compatible Markdown vault with a SQLite WAL search index, a deterministic CLI (`o2b`) and an MCP server.
Recent commits:
f22df2c5 chore(apb): zg search, code-ranker and OpenCodeReview before push, scope-scan hardening (#218)
83979b9d fix: MCP startup off the upgrade path, fair ingest locks, inline plugin MCP manifest, inbox archive (v1.61.0)
3e59f319 feat: decision-model uses, adapters and setup skill (v1.60.0)
eacad953 feat: optional decision-model core and decision-model rerank kind (v1.59.0)
5c550263 fix: session capture off the hook path, registry scanner hygiene (v1.58.1)
6f33c424 feat: payload registry and knowledge packs, boundary hardening, CJK chunking (v1.58.0)
54bb28d9 feat: what this install knows (v1.56.0)
5f415267 feat: who wrote what, and how to take it back (v1.55.0)
dc552590 feat: private is not a suggestion (v1.54.0)
323e2f09 feat: nothing writes silently, nothing degrades silently (v1.52.0)
Related files:
- src/core/redactor.ts, src/core/egress/guard.ts, src/core/brain/continuity/redaction.ts
- src/core/hygiene/hardcoded-paths.ts, src/core/hygiene/scan-repo.ts
- src/core/brain/write-batch.ts, src/core/brain/page-lint.ts, src/mcp/brain/write-batch-tools.ts, src/mcp/brain/notes-tools.ts
- src/core/vault.ts, src/core/fs-atomic.ts
- src/core/brain/ingest/batch-plan.ts, src/core/brain/ingest/extractable-gate.ts, src/core/integrity/degradation.ts
- src/mcp/brain/ingest-tools.ts, src/cli/brain/verbs/batch-plan.ts, src/core/brain/metrics.ts
- src/core/vault-backing.ts, src/core/search/store/lifecycle.ts, src/core/search/store.ts, src/core/search/paths.ts, src/core/install/ownership.ts
- src/core/brain/doctor.ts, src/core/brain/doctor/embedding-sunset-check.ts, src/core/brain/doctor/log-checks.ts, src/core/brain/types.ts
- src/core/search/indexer.ts (pending-vector census), src/core/brain/signal.ts, src/core/brain/link-graph/repair-lane.ts, src/cli/brain/verbs/repair-lane.ts
Conventions:
- Closed vocabularies with census tests: new verdict/reason codes must be registered in tests/core/architecture/verdict-vocabulary-census.test.ts or the census fails.
- Wire serializers follow a byte-identical-when-absent idiom: new fields are emitted only when non-empty; one serializer per wire contract shared by CLI JSON and MCP.
- Warnings are non-blocking by default; refusal paths are named errors with next-step advice (v1.52.0 rule: nothing writes silently, nothing degrades silently).
- Doctor checks are read-only and failSoft; one broken scan must not mask later checks; repairs live in dedicated verbs with dry-run default, exact confirm phrase and a hard write cap.
- Regexes in the redactor must stay bounded and linear (documented no-ReDoS constraint).
- Tests colocated under tests/ mirroring src/; TDD; formatter (oxfmt) and linter (oxlint) must pass before every commit.
Constraints:
- No new external dependencies.
- No changes to existing public API shapes except additive, byte-identical-when-absent fields.
- Do not flip global defaults (no fs-atomic default change, no config default changes); opt-in at named chokepoints.
- English only, no hardcoded natural-language phrases outside existing copy conventions; no AI-authorship markers in committed artifacts.

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
