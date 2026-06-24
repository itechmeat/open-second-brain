# Consultation: Open Second Brain — Session Lifecycle Capture Durability

You are a senior backend architect. Produce exactly **3 distinct architectural
variants** for shipping the release below, then exactly one
**"Recommended: Variant N"** line with rationale. Output ONLY the three variant
sections and the recommendation. No code. No prose outside those sections.

## Project

- **Name:** Open Second Brain (repo `open-second-brain`, local slug `o2b`)
- **Language/runtime:** TypeScript (strict), runs on **Bun**. ESM (`"type": "module"`).
- **Tests:** `bash scripts/test`. The provider shim is plain Python (no Hermes needed in CI).
- **Nature:** An Obsidian-native memory layer for the Hermes Agent. Memory is plain Markdown under `Brain/` in the vault. The core is **deterministic / LLM-free** by design.
- **Conventions:** SOLID / KISS / DRY. No misleading fallbacks. No hardcoding. All strings and docs in English; the design must be abstract and multi-language-capable, never locale-coupled. New behaviour must be **off by default or byte-identical** when unused. Hooks must be **fail-soft** (a capture path can never break an agent turn). Every change is **additive** where possible.

## Release scope (three tasks shipping together on one branch)

### t_c181f92b — Capture interrupted sessions: on_session_end(interrupted=True) + persisted transcript (#50004/#50003/#50312)

Hermes PRs #50004 (CLI), #50003 (TUI), #50312 (gateway drain-timeout) — all merged — now flush the in-flight transcript on SIGHUP/SIGTERM/force-quit/restart-drain and fire `on_session_end` with `interrupted=True`. Previously these sessions were silently dropped from memory capture. Ensure the OSB session-lifecycle / session-summary path handles the `interrupted` flag and consumes the now-available pre-restart transcript, so interrupted conversations are captured (not lost) and **not double-counted on resume**. Refs: `src/core/brain/session-lifecycle.ts`, `session-summary.ts`; `plugins/hermes/provider.py`.

### t_3b8fe3a1 — Verify memory on_session_end fires on /exit now native (#49315); drop any workaround

Hermes #49315 (merged) restored the memory-provider `on_session_end` hook on CLI `/exit` (the god-file Phase 4 refactor had bound the atexit `_active_agent_ref` to the mixin module, not `cli.py`, so `on_session_end` never ran). Confirm OSB's provider end-of-session capture now fires on `/exit` and **remove any local workaround/poll** that compensated for the missing hook. Refs: `plugins/hermes/provider.py`, `_base.py`.

### t_12c8b256 — [upstream:hermes-memlock] Post-compaction pinned-anchor survival audit and selective re-assertion

Detect a Hermes context-compaction event, audit which pinned anchors / standing instructions actually survived in the ACTIVE (non-summary) region of the conversation, and re-assert only the drifted ones as a reminder block. MemLock's `pre_llm_call` hook scans `conversation_history` for the compressor's `SUMMARY_PREFIX` literal, hashes the summary body to detect a NEW compaction, then runs keyword probes (optionally windowed-embedding) for each anchor scoped to the non-summary region — an anchor whose probes hit only inside the summary block counts as drifted. Drifted anchors get rehydrated; survivors cost zero tokens. Deterministic, no LLM in the loop; fail-open; bounded drift log. Refs: `src/core/brain/pinned.ts` (`readPinnedContext`/`writePinnedContext`/`appendPinnedContext`, `MAX_PINNED_CONTEXT_LEN = 20_000`), `src/core/brain/pre-compact-extract.ts` (`extractPreCompactRecords` — the SYMMETRIC pre-compaction capture pass that already exists), `src/core/brain/context-presets.ts`, `src/core/brain/active-budget.ts`. There is currently NO post-compaction survival check anywhere in `src/core/brain`.

## Current architecture (grounding — do NOT re-derive)

### Python provider — `plugins/hermes/provider.py` (386 lines)

`OpenSecondBrainMemoryProvider` is a thin orchestrator over a `BrainBridge` to the TS core.

- Hook contract (verified): `on_session_end(self, messages: list, **_kwargs: Any)` and `on_pre_compress(self, messages, **_kwargs)`. `interrupted=True` now arrives via `_kwargs` — currently swallowed into `_kwargs` and ignored.
- `sync_turn(user, assistant, *, session_id, messages)` buffers the turn off the hot path on a **daemon thread**: `_append_turn` appends `(user, assistant)` to `self._buffer` (under `self._lock`) AND calls `_persist_turn` which appends a durable `session-transcript.jsonl` line under `hermes_home/open-second-brain/`.
- `on_session_end` and `on_pre_compress` both call `_drain_captures()` (join outstanding daemon threads, timeout=5s) then `_flush_buffer()` which joins buffered turns into one text blob and calls the `brain_pre_compact_extract` bridge tool with `{session_id, turn_start, turn_end, text}`.
- `shutdown()` does the same drain+flush then `self._bridge.stop()`.
- All bridge calls go through `_safe_call` (try/except → `None`); hooks must never raise into Hermes.
- `_base.py` ships a fallback `MemoryProvider` no-op ABC so the module imports and unit-tests without a Hermes install.

### TS lifecycle capture — `src/core/brain/session-lifecycle.ts` (512 lines)

`captureSessionLifecycleEvent(vault, payload, opts)` is the single entry point, invoked by the CLI verb `o2b brain session-hook` (`src/cli/brain/verbs/session-hook.ts`) which reads the host hook payload from stdin.

Flow: normalize payload → build capture boundary → session-decision (`capture`/`stateless`/`ignored`) → resolve session lineage → capture markers → route extracted facts → tool feedback replay → session-scoped focus cleanup on `SessionEnd` → handoff note on `SessionEnd` (gated by `session_handoff` config, reads transcript via session adapters) → anticipatory cache refresh → append lifecycle log → append audit record → return counters.

`NormalizedPayload` carries: `event` (`SessionStart`/`UserPromptSubmit`/`PostToolUse`/`SessionEnd`), `sessionId`, `parentSessionId`, `rootSessionId`, `compressionDepth`, `cwd`, `transcriptPath`, `promptText`, `toolName`, `sessionStartSource` (`startup|resume|clear|compact`). The event discriminator at `NormalizedPayload` comment: "SessionStart discriminator (`startup|resume|clear|compact`)."

### TS continuity records

- `pre-compact-extract.ts` — `extractPreCompactRecords`: pulls decisions/rules out BEFORE compaction, stores a `pre_compact_extract` continuity record (kind `pre_compact_extract`), dedupes by content hash. This is the PRE-compaction capture pass that t_12c8b256's audit is the symmetric complement to.
- `session-summary.ts` — `appendSessionSummary`/`getSessionSummary`: dedupes by `[KIND, sessionId, contentHash]` dedupe key; `listSessionSummaries`.
- `pinned.ts` — `readPinnedContext`/`writePinnedContext`/`appendPinnedContext`/`clearPinnedContext`, `applyPinnedOperations` (atomic batch), budget enforcement via `assertWithinPinnedBudget` (`MAX_PINNED_CONTEXT_LEN = 20_000`).
- A shared continuity store: `listContinuityRecords(vault, { kind, since })`, `ContinuityRecord`/`ContinuitySourceRef`.

### Key codegraph facts

- A `pre_llm_call` / pre-compression hook seam already exists conceptually (`on_pre_compress` + the `pre-compress-pack.ts` read-only bundle). The compressor's `SUMMARY_PREFIX` literal and a post-compaction survival audit do NOT exist anywhere.
- Resume-aware lineage: `resolveSessionLineage` + `recordLineageObservation` + `isCompressionEvidenceEvent` already exist — a resume after an interrupt is already detectable as a lineage child.
- The capture boundary already dedupes sessions and suppresses repeated message text; double-counting protection has an existing substrate.

## Constraints & invariants (must hold for every variant)

1. The TS core stays deterministic / no-LLM. t_12c8b256's keyword-probe audit must not sneak in an LLM call (embedding probe is optional and off by default if proposed).
2. Hooks are fail-soft: an interrupted-session flush or a drift audit failure must never break an agent turn or block session close.
3. New behaviour is off-by-default or byte-identical when the flags/fields are absent (so unchanged installs see no diff).
4. No misleading fallback: an interrupted flag that cannot be honoured must be surfaced honestly (e.g. in the audit record), not silently coerced to a clean SessionEnd.
5. No double-counting: an interrupted session resumed later must not re-capture turns already captured by the pre-interrupt flush, and must not create duplicate session-summary / pre-compact-extract continuity records (reuse the existing `[KIND, sessionId, contentHash]` dedupe key).
6. The interrupted path must consume the now-available pre-restart transcript (the `messages` list Hermes hands to `on_session_end`, plus the persisted `session-transcript.jsonl`).
7. English-only strings; locale-agnostic.

## Git log (last 20, newest first)

```
c5e30b8 fix: cross-vault chain-stop reads the max normalized score (v1.18.1) (#111)
33b4fba feat: recall precision, coverage, and provenance hardening (v1.18.0) (#110)
254b580 feat: codegraph link-graph depth and MCP exposure (v1.17.0) (#108)
da2e3cc feat: memory subsystem alignment - honest pinned budgets, atomic batch writes, on_memory_write host bridge (v1.16.0) (#107)
4db7862 fix(hermes): pass --repo so bridge skill discovery resolves repoRoot (#103) (#106)
0a4b6da feat: calendar obligations, agenda synthesis, OKF portability, Obsidian Bases and steelman synthesis (v1.15.0) (#105)
f8b4abf feat(brain): add feedback default scope and vault write containment (#104)
20ea7ef feat: per-handoff LLM generation tracing and prompt-prefix stability metric (#102)
9c1d48f feat: CodeGraph and MCP operational readability (v1.12.0) (#101)
c2c3ff4 feat: Session Knowledge Synthesis Suite (v1.11.0) (#100)
56dd3dd fix(hermes): bridge EOF - byte streams, stderr drain, retry loop (#92)
35b824e feat: Recall & Working-Memory Quality Suite (v1.10.0) (#99)
929d54c feat: Brain Portability & Interop Suite (v1.9.0) (#98)
7cdbfc0 feat: Indexer Durability & Resilience Suite (v1.7.0) (#97)
8b679fe feat: Knowledge Provenance Suite (v1.7.0) (#96)
6e59a42 feat: Vault Integrity & Trust Suite (v1.6.0) (#95)
70d95c6 chore(release): bump version to 1.5.0 (#94)
e4df212 feat: Search & Recall Quality Suite (v1.10.0) (#93)
2e74afe feat: native Grok Build CLI integration - bundled plugin, hooks, session import (v1.4.0) (#91)
3e7e233 fix(hermes): serialize handle_tool_call result to a string (v1.3.1) (#90)
```

## Output format (STRICT)

### Variant 1: <short name>
- **Approach:** 2-3 sentences.
- **Trade-offs:** bullet list (Pro/Con).
- **Complexity:** small | medium | large
- **Risk:** low | medium | high

### Variant 2: <short name>
(same shape)

### Variant 3: <short name>
(same shape)

### Recommended: Variant N
2-3 sentence rationale.

Nothing else. No code. No preamble. No closing summary.
