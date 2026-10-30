You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Release wave "trust-and-responsiveness-hardening" (option 1): implement all four P4 kanban cards in one PR on one feature branch.

- t_c2ac4fc8 - Neutralize structure-bearing markdown markers (wikilinks, agent-facing inline markers, fenced marker blocks, semantic headings) in imported third-party text at capture/write time, behind an off/shadow/enforce gate, plus a read-only doctor audit of already-planted rows. Doctrine: neutralization keys off structure only, never vocabulary, is idempotent, and adds zero bytes when the gate is off.
- t_206562ae - Seeded .gitignore guardrails for derived brain state (.open-second-brain) at brain init (merge-safe for existing user files, idempotent), plus a doctor row that FAILs when derived runtime state is already tracked by git.
- t_00b617b6 - Doctor readiness row catching shadowed agent instruction files (AGENTS.md/CLAUDE.md/GEMINI.md): when the file a host reads is not the file carrying the write-back contract, the probe must fail naming both files, read-only.
- t_90409204 - Parallel MCP reads on the stdio transport with writes kept exclusive: classify every tool as read or write, dispatch reads concurrently under a bounded cap, serialize writes, and make EOF await the in-flight set. The tools-list wire output must stay byte-identical.

The four cards are independent; the task is to argue the SHAPE of the wave - how the four implementations are organized against each other on one branch.

# Project context

Open Second Brain - local-first agent memory for OpenClaw/Claude Code/Codex as an MCP server and CLI (`o2b`), TypeScript on Bun.

Recent commits:
88c118aa feat: verified delivery and honest write surfaces (v1.95.0) (#280)
b784126f chore(deps): bump the github-actions group with 2 updates (#276)
c435bee9 chore(deps-dev): bump the bun-minor-and-patch group with 2 updates (#275)
61a7ff1d feat: continuity promote - the host-memory readback path for mirrored host memory writes (v1.94.0) (#278)
3064defd feat: embedding-window chunk fit, sharded retirement links, decision-model provider chain and local thresholds, self-healing launchers (v1.93.0) (#274)
5572997d feat: write-time honesty and egress consent (v1.92.0) (#273)
89a921ba feat: one-off pledges with verified evidence and a counterparty brief (#270)
f203591e feat: measured autonomy - a rule-promoting dream pass, model-aware context budgets and honest benchmarks (#269)
9e579820 feat: note-change truth maintenance for links, index freshness and entity anchoring (#268)
f7c1c88c feat: entity merge repair, write destinations, cross-agent catch-up and OKF v0.2 (v1.88.0) (#267)
f6d9f95f feat: guarded host writes, walkable list results, a converse decision route and a snoozable trigger queue (v1.87.0) (#266)
b183b6c3 fix: one holder per hook-state scope through a stale-lock takeover (v1.86.2) (#261)
e0d11656 feat: session-mining economy - mining tombstones, a shadow trust-gate mode and a live-counts console (v1.86.0) (#258)
948a0403 feat: storage lifecycle for long-lived vaults (v1.85.0) (#257)

Related files:
- src/core/brain/untrusted-source.ts (read-time neutralizer), src/core/brain/capture/capture-note.ts (capture seam), src/core/brain/ingest/ingest.ts (ingest review gate), src/core/brain/wikilink.ts (wikilink detectors, code-region masking), src/core/brain/inline.ts (@osb marker grammar), src/core/brain/log.ts (log-row grammar)
- src/core/brain/init.ts (bootstrapBrain), src/core/brain/secrets/crypto.ts (existing .gitignore writer + invariant docblock), src/core/install/managed-block.ts (managed-block merger), src/core/brain/vault-dirty.ts (git-reading posture: ls-files vs status, check-ignore discipline)
- src/core/brain/doctor.ts (frozen DOCTOR_CHECKS registry), src/core/brain/doctor-exits.ts and src/core/brain/diagnostics.ts (exit-code classification, enforced by tests/core/brain/doctor-exit-census.test.ts), src/core/brain/doctor/privacy-marker-check.ts (counting-check pattern)
- src/core/brain/writeback-contract.ts (AGENT_INSTRUCTION_FILES, per-file audits), src/core/doctor-readiness.ts (probeWritebackContract readiness probe), src/core/brain/trust/instruction-file-ceiling.ts, src/core/brain/doctor/removed-tool-checks.ts (the other two instruction-file lists)
- src/mcp/stdio.ts (serveStdio production loop, serveStdioFromString test harness), src/mcp/server.ts (MCPServer.handleRequest, tools/list projection), src/mcp/tool-contract.ts (ToolDefinition), src/mcp/tools.ts and src/mcp/brain/*-tools.ts (registration slices), src/mcp/drain.ts (RequestDrain with N in-flight), src/mcp/http.ts (already-concurrent transport)

Conventions:
- SOLID/KISS/DRY; named constants over literals; errors surface explicitly by name; no stubs; everything English.
- Doctor findings follow no-dead-ends: every new code is classified in DIAGNOSTIC_SIGNALS (has a next command) or DOCTOR_EXIT_EXCLUSIONS (reason it has none), enforced by a census test; the doctor never mutates and never throws.
- Gate-mode precedent: SEARCH_TRUST_GATE_MODE (off/shadow/enforce, env twin wins over machine-config key, invalid values refused naming the key, default off).
- .gitignore writing precedent: the secrets sync-exclusion marker; its docblock claims an invariant ("nothing in src ever writes a .gitignore elsewhere") that a seeded guard must update.
- Version bump and CHANGELOG entry land inside the feature PR before the first push (CLAUDE.md overrides the release-time default).
- Each prior cycle documents design, plan, variants and the consultant prompt under docs/brainstorm/<slug>/.

Constraints:
- Do not change existing public APIs or any wire-visible schema; the MCP tools-list payload must remain byte-identical.
- No new external dependencies.
- Four implementation agents must be able to work simultaneously with disjoint file ownership; shared files need an explicit append-only protocol.
- The doctor stays read-only and fail-soft; nothing neutralizes or rewrites already-planted content in this wave (audit only).
- Neutralization must never key on natural-language vocabulary, never delete content, never introduce invisible characters, and must be idempotent.

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
