You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation. You are running inside the project repository and MAY read files to ground your variants; cite file paths you relied on.

# Task

This is an EPIC of seven related kanban tasks that ship as ONE feature branch, ONE pull request and ONE release of Open Second Brain. Produce variants for the architecture of the whole suite (how the seven pieces share primitives, in what order they land, where the seams are), not seven separate mini-designs. The wave's working title: write-side trust - identity, permission, review.

Constraints every variant must honor:

- Default-off or default-preserving: with zero configuration, every existing single-key install, every existing write path and every current test stays green byte-for-byte. No silent fallbacks; refusals surface by name with a next command.
- Reuse what exists: the staged-review pending queue (`src/core/brain/pending.ts`, toggle `write_approval.enabled`), the credential custody subsystem from v1.78.0 (`src/core/brain/secrets/`), the trigger store lifecycle precedent (`src/core/brain/triggers/store.ts`), the owner-scope refusal gate (`src/mcp/owner-scope-refusal.ts`), the integrity gate-mode pattern (`off|warn|fail`).
- The permissions document and its choke point are the substrate every other card consumes.
- The plan must be executable by 4-5 parallel implementation lanes with disjoint file ownership.

## Card t_6ff73d61 (priority 4): staged review for writer tools and bulk ingest

The write-approval gate stages extracted signals into `Brain/pending/` instead of `Brain/inbox/` when `write_approval.enabled` is on (`src/core/brain/pending.ts:37-52`); it is consumed by exactly two extraction callers (`src/core/brain/extract-signals.ts:602`, `src/core/brain/fact-extract.ts:350-362`). Every MCP writer tool and every bulk-ingest lane publishes straight to its final lane: `brain_feedback` writes its signal with no targetDir (`src/mcp/brain/feedback-tools.ts:199`), all note tools route through `createNote`/`applyWriteBatch` with no staging concept, and session import, inline scan and capture/checkpoint write to the inbox ungated. Correction verified in source: staged documents are NOT out of recall today - the search walker admits every in-scope `.md` and `admitToIndex` excludes only `Brain/state` and `Brain/.payloads` (`src/core/vault-scope/index-admission.ts:39-52`), so `brain_search` and recall-inject can surface an unapproved staged note. Extending the gate without closing that hole would stage notes recall still sees.

## Card t_29798f41 (priority 3): unified permissions document, approval door, decision ledger

Trust checks are scattered point checks across at least six layers with no shared policy or queryable record. Corrections verified: the role matrix is nearly dead (one enforced call site, `src/core/brain/apply-evidence.ts:197`; `force_confirmed` at `src/mcp/brain/feedback-tools.ts:268-306` writes a confirmed preference past both the matrix and the dream trial window), and five partial trails exist (Brain log, pref-audit, idempotency ledger, trigger ledger, ephemeral retrieval receipts) but no queryable allow/ask/deny ledger. Decide: document format and home (vault file vs `Brain/_brain.yaml` block vs flat device config), the principal vocabulary (identity is currently process-global, `src/mcp/server.ts:249-251`), precedence when document and config disagree, and how ask surfaces to a human.

## Card t_8913c934 (priority 3): durable pending-decision record with enumerated options

`recordDecision` requires `chosen` (`src/core/brain/decisions/record.ts:400-401`); no open-decision artifact exists anywhere. The trigger store supplies the lifecycle pattern to copy: one Markdown record per item, open/terminal status sets, read-time TTL, terminal records stay in place, named-unreadable partitioned reads, directory locks (`src/core/brain/triggers/store.ts`). Resolution should mint a real decision page via `recordDecision` and land in the existing decision-change receipt trail.

## Card t_85059d6d (priority 3): named per-agent MCP auth tokens

`authorized()` compares ONE shared key (`src/mcp/http.ts:367-371`); caller identity is the process config name (`resolveAgentName`, `src/mcp/server.ts:249-251`) plus a caller-supplied `agent_scope` argument read only by `coerceAgentScope` (`src/mcp/coerce.ts:128-146`). Even under `integrity.owner_scope_delivery: fail` the identity is process-global - one identity per endpoint (`src/mcp/http.ts:355-361` says so). The v1.78.0 custody store (`src/core/brain/secrets/store.ts`) can host credentials but a locked passphrase envelope must not become an authentication outage. Decide: storage shape, token format, per-request identity threading into `MCPServer` (one instance serves concurrent requests), revocation and rotation semantics, shared-key coexistence.

## Card t_89e1f601 (priority 3): idempotent machine bootstrap

No machine-facing bootstrap exists; install is human-driven per harness (`src/core/install/`, adapters for ten targets). Corrections verified: the token primitive does not exist (t_85059d6d must land first), and Claude Code and ZCode are deliberately not adapter targets (`src/core/runtime/host-facts.ts:170-173`), so bootstrap spans three install models: adapter-driven, plugin-driven (verify only), print-and-paste (generic). Idempotency contract: same input, byte-identical output (`src/core/install/payload.ts:6-8`); receipt-driven teardown via `install.lock.json`. No plaintext secrets in harness configs - the reference form is `$secret:NAME` and names allow no dashes.

## Card t_107cac80 (priority 2): operator opt-in gate for cross-owner and global scope writes

Correction verified: the global/wildcard half is refuted as a live surface - no wildcard token exists in the scope model (`src/core/graph/agent-scope.ts:130-147`), and the one genuinely global write (the `shared_namespace` mirror) is already operator opt-in (`src/core/config.ts:462-470`). The real surface is cross-owner writes: an explicit caller `owner` wins unconditionally in `resolvedOwnerFor` (`src/core/brain/preference.ts:545-546`, pinned by test), and on the note lane `owner:` is not in the reserved frontmatter keys (`src/core/brain/write-batch.ts:699-704`), so a caller can stamp or strip another agent's ownership. Decide: gate placement (the two chokepoints exist), mode shape (the repo's `off|warn|fail` `GATE_MODE`), and what explicit-owner stays legal for.

## Card t_af5e252f (priority 3): opt-in ambient writeback with TTL and consent

Corrections verified: the managed-instruction-block convention exists and is audited but has no installer by design (`src/core/brain/writeback-contract.ts:29-33`); session capture already runs on Stop (`hooks/hooks.json:112-121`) and the extraction lane ALREADY writes whenever a session classifies as capture, with no opt-in flag - so a default-off flag on the existing lane would be default-changing, not default-preserving. TTL machinery exists end to end (`expiration_date`, read-time filtering, `brain_feedback expires` chokepoint). Decide: what opt-in means on a lane that already writes, consent storage (the `guardrails.*` boolean block is the precedent for a memory-mutating lane), and whether a Stop-hook backstop has a nameable delta over session-capture-on-Stop.

# Output format

Three variants, each with: Approach (where the seams are, what shares primitives, landing order), Trade-offs (pros and cons grounded in the repo), Complexity, Risk. Then a recommendation with rationale. Be specific about module paths, and design for parallel lanes with disjoint file ownership.
