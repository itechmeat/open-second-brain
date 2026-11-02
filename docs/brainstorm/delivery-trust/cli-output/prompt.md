You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Release wave "delivery-trust" (option 1): implement all four kanban cards in one PR on one feature branch.

- t_1af24938 - Quote unverified and agent-origin stored text on remote read deliveries (tier-keyed): a quote fence around stored note text whose provenance is below operator-authorship (agent-written, tool data, imported, untrusted origin), on the MCP read surfaces that return stored text, no-op at local reach; absence of any provenance stamp reads as unverified (fail closed); local reads and stored bytes unchanged.
- t_4300e5fd - Re-hash verification of session context receipts against current memory content: a verify verb over the existing context receipts (which already carry per-item sha256 hashes and session ids) reporting MATCH, CHANGED or NOT AVAILABLE per entry, with no new capture machinery.
- t_eaf760a6 - Tool gating and prompt-time injection on the opencode lane (parity with the Claude Code lane): a tool-execute.before gate and per-prompt injection carriers on the opencode plugin, which today only captures sessions, injects at system-prompt build time and nudges after writes.
- t_3bdb82b0 - Ed25519-signed checkpoints binding the per-shard log heads to store state: an operator-managed signing key, a signed point-in-time binding of every log shard's chain head to a digest of store state, and on-demand verification, so out-of-band edits to the log or the store after the signed point are provable.

The four cards are independent; the task is to argue the SHAPE of the wave - how the four implementations compose into one coherent design: a shared delivery-shaping seam, the verify verb, the checkpoint signing kernel, and the opencode parity lane.

# Project context

Open Second Brain - local-first agent memory for OpenClaw/Claude Code/Codex as an MCP server and CLI (`o2b`), TypeScript on Bun.

Recent commits:
285cb9a8 feat: trust and responsiveness hardening - neutralized imports, gitignore guardrails, shadowed-contract detection, parallel MCP reads (v1.96.0) (#281)
88c118aa feat: verified delivery and honest write surfaces (v1.95.0) (#280)
61a7ff1d feat: continuity promote - the host-memory readback path for mirrored host memory writes (v1.94.0) (#278)
3064defd feat: embedding-window chunk fit, sharded retirement links, decision-model provider chain and local thresholds, self-healing launchers (v1.93.0) (#274)
5572997d feat: write-time honesty and egress consent (v1.92.0) (#273)

Related files:
- src/core/graph/transport-reach.ts (TRANSPORT_REACH local/remote, resolvedTransportReach fail-closed to remote), src/mcp/tool-contract.ts (contextReach, ServerContext.reach minted only by the transport), src/mcp/reach-refusal.ts (caller-supplied reach refused by name), src/mcp/error-redaction.ts (redactErrorForCaller - the one existing reach-keyed egress shaping, a no-op at local reach), src/mcp/server.ts (buildMcpToolResult, redactedErrorMessage)
- src/core/brain/untrusted-source.ts (the fence family: neutralizeUntrustedText, wrapUntrustedSource, fenceUntrustedContent - read-time only, never rewrites the page), src/core/brain/trust/untrusted-provenance.ts (untrusted_source frontmatter marker), src/core/origin-channel.ts (origin_channel mcp-tool/cli/import, unset literal, no backfill by design), src/core/brain/provenance/content-class.ts (content_class prompt-derived), src/core/brain/provenance/provenance.ts (ProvenanceLevel trust band, a different axis)
- src/core/brain/context-receipts.ts (emitContextReceipt with per-item text_hash and final_text_hash via sha256Hex, ContextReceiptFilter.receiptId, getContextReceipt; session_inject receipts carry no text by construction), src/core/integrity/digest.ts (sha256Hex, canonicalJson, sealWithDigest/digestVerifies), src/core/brain/content-hash.ts (computeContentHash/verifyContentHash - the stored-hash-vs-recomputed pattern), src/core/brain/context-pack-evidence.ts (closed-verdict vocabulary precedent, "no second hashing path" doctrine)
- plugins/opencode/open-second-brain.ts (self-contained single-file plugin, V1/V2 dual API: event capture, system-prompt inject via a spawned o2b-hook shim with synthetic SessionStart payloads, tool.execute.after nudge; no tool.execute.before, no prompt hook), hooks/hooks.json (UserPromptSubmit rows session-capture/recall-inject/nav-inject/counterparty-brief/reground-deliver; PreToolUse rows pretool-orient, pretool-host-backup), hooks/lib/context-events.ts (CONTEXT_EVENT_NAMES default-closed), hooks/lib/injection-ledger.ts (per-session dedupe keyed on session id in vault hook-state), src/core/install/adapters/grok-hook-parity precedent tests/core/install/adapters/grok-hook-parity.test.ts (DECLARED_GROK_DIVERGENCES census shape)
- src/core/brain/log.ts (per-day locked appendLogEvent, per-shard chain: prev + h = sha256 over canonical {prev, ts, kind, payload}, private lastChainHash head scanner), src/core/brain/log-chain.ts (verifyLogChain, report-only doctrine), src/core/brain/lineage/ (a second, independent chain), src/core/state/surfaces.ts (STATE_SURFACES registry), src/core/brain/secrets/ (loadOrCreateKey 0600 keyfile, restrictToOwner ACL, envelope passphrase wrap, sync-exclusion marker), src/core/brain/checkpoint-store.ts (the resume substrate that already owns the noun "checkpoint"), src/core/brain/snapshot.ts (Brain/.snapshots recovery points, why derived-store byte hashing is unaffordable)

Conventions:
- SOLID/KISS/DRY; named constants over literals; errors surface explicitly by name; no stubs; everything English.
- Delivery rules are encoded as per-family views with two frozen conventions: FAIL CLOSED and IDENTICAL TO ABSENT (a withheld row is dropped, never counted), pinned by tests. Per-tool output schemas are validated by a contract module.
- Gate-mode precedent: SEARCH_TRUST_GATE_MODE (off/shadow/enforce, env twin wins over machine-config key, invalid values refused naming the key, default off).
- Persisted formats are additive-only; a persisted record carries schema_version and refuses unknown versions by name. The audit log chain is report-only and never a read gate.
- Census registries enumerate surfaces and writers (visibility-surface, state-surface, lock-site, write-site, verdict-vocabulary, origin-channel) and fail loudly on unregistered newcomers.
- Version bump and CHANGELOG entry land inside the feature PR before the first push; each prior cycle documents design, plan, variants and the consultant prompt under docs/brainstorm/<slug>/.

Constraints:
- Four implementation agents must be able to work simultaneously with strictly disjoint file ownership; files more than one lane touches need an explicit append-only protocol.
- The shaper must be a no-op at local reach (dozens of pinned byte-identity and withheld-as-absent tests must stay green untouched) and must not add counts or markers for withheld rows.
- No new external dependencies (node:crypto Ed25519 is available).
- The opencode plugin file must stay self-contained (node builtins plus Bun globals only) and must not import repo modules; opencode is not installed on dev or CI, so all plugin tests are stub-driven.
- The verify verb is read-only; signatures and keys are operator-managed; verification stays report-only and never gates reads.

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
