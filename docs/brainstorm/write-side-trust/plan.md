# Write-side trust: identity, permission, review - implementation plan

Feature branch: `feat/write-side-trust` (already checked out from `origin/main` at v1.78.0). TDD per task, one atomic conventional commit per task, `bun run fmt` + `bun run lint` green before every commit. Work is organized as five implementation lanes in separate worktrees plus one reconciliation task. Lane A commits its pure substrate modules first; the gate lanes start on tests against the pinned signatures below and land after the substrate commit reaches the branch.

Registration checklist for a new `o2b brain` verb (six places): handler `src/cli/brain/verbs/<verb>.ts`; barrel `src/cli/brain/verbs/index.ts`; dispatcher import + `case` in `src/cli/brain.ts` (switch terminated by `default:`); `src/cli/brain/help-text.ts` summary line in `BRAIN_HELP` AND a `VERB_HELP` key; `src/cli/command-manifest.ts` brain group; `docs/cli-reference.md`. Pinned by `tests/cli/manifest-completeness.test.ts` and `tests/cli/help-surface-parity.test.ts`.

Top-level command registration (`o2b bootstrap`, `o2b mcp token`): a `case` in `dispatchCommand` (`src/cli/main.ts:1272`) plus a `CLI_COMMAND_MANIFEST` entry (`src/cli/command-manifest.ts`); the manifest-completeness census reads the switch, so the case must be a literal. Lane B owns `main.ts` outright; no other lane touches it.

Registration checklist for a new closed vocabulary (statuses, verdicts, refusal-token sets): frozen object + companion member list + type guard, registered in `tests/core/architecture/verdict-vocabulary-census.test.ts`. New destructive move-then-unlink sites: `src/core/brain/destructive-sites.ts` declaration + census. New durable Brain directory: `src/core/state/surfaces.ts` row + `tests/core/architecture/state-surface-census.test.ts` count.

This wave adds NO new MCP tool. Every MCP change is an action on an existing tool enum, a field on an existing receipt, or a new CLI verb, so the tool-count pins (`tests/mcp/mcp.test.ts`, `brain-tools-parity.test.ts`, `agent-scope-matrix.test.ts`, `tests/core/install/tool-ceiling.test.ts`, `docs/mcp.md` prose) do not move.

## Cross-lane contract (pinned)

Module paths and the ONE owning lane per file during phases 0-1. Files may change owner across phase boundaries (the plan names each handoff); never within a phase.

| Owner | Files |
|---|---|
| Lane A | `src/core/brain/permissions/document.ts`, `src/core/brain/permissions/resolve.ts`, `src/core/brain/permissions/ledger.ts`; `tests/core/brain/permissions/**`; `tests/cli/brain-permissions.test.ts`; doctor finding module |
| Lane B | `src/core/brain/secrets/token-store.ts`; `src/mcp/http.ts`; `src/mcp/server.ts`; `src/cli/main.ts`; `src/cli/bootstrap/**`; `tests/core/brain/secrets/token-store.test.ts`; `tests/mcp/http-token-auth.test.ts`; `tests/cli/bootstrap.test.ts` |
| Lane C | `src/core/brain/write-gate.ts`; `src/core/brain/signal.ts`; `src/core/brain/pending.ts`; `src/core/brain/pending/pending-lanes.ts`; `src/core/vault-scope/index-admission.ts`; `src/core/brain/notes/create-note.ts`; `src/core/brain/write-batch.ts`; `src/core/brain/ingest/ingest.ts`; `src/core/brain/ingest/source-cleanup.ts`; `src/mcp/brain/notes-tools.ts`; `src/mcp/brain/write-batch-tools.ts`; `src/mcp/brain/feedback-tools.ts`; `src/mcp/brain/ingest-tools.ts`; `src/cli/brain/verbs/pending.ts`; their test files |
| Lane D | `src/core/brain/policy/blocks/integrity.ts` (+ `resolve.ts`/`types.ts` integrity fields); `src/core/brain/trust/owner-write-gate.ts`; `src/core/brain/preference.ts`; their test files |
| Lane E | `src/core/brain/decisions/open-store.ts`; `src/core/brain/decisions/brief.ts`; `src/mcp/brain/decisions-tools.ts`; `src/cli/brain/verbs/decision.ts`; `src/mcp/brain/brief-tools.ts`; `src/cli/brain/verbs/morning-brief.ts`; `src/core/brain/policy/blocks/guardrails.ts`; `src/core/brain/fact-extract.ts`; `src/core/brain/types.ts`; `src/core/brain/decisions/receipts.ts`; their test files |

Shared-append files (every lane appends only its own entries; the reconciliation task owns the result): `src/cli/brain.ts`, `src/cli/brain/verbs/index.ts`, `src/cli/brain/help-text.ts`, `src/cli/command-manifest.ts`, `docs/cli-reference.md`, `docs/mcp.md`, `docs/observability.md`, and the census pins listed above. No lane edits `src/core/brain/paths.ts` - new path helpers live in their owning modules (the `secrets/store.ts` precedent).

### Exported signatures each lane provides or consumes

Lane A provides (`src/core/brain/permissions/`, leaf modules - import nothing from `core/brain` except `types.ts`-level constants; must satisfy `tests/core/architecture/import-cycles.test.ts`):

```ts
// document.ts
export const PERMISSIONS_DOCUMENT_REL = "Brain/_permissions.yaml";
export const PERMISSIONS_SCHEMA_VERSION = 1;
export type PermissionVerdict = "allow" | "ask" | "deny";
export type PermissionAction = "write" | "ingest" | "owner_write";
export interface PermissionEntry { id: string; agent?: string; role?: string; action: PermissionAction; target?: string; verdict: PermissionVerdict }
export interface PermissionsDocument {
  version: 1;
  default_action: PermissionVerdict;          // required - no silent default
  roles: Record<string, Partial<Record<PermissionAction, PermissionVerdict>>>;
  agents: Record<string, { role?: string; write?: PermissionVerdict; ingest?: PermissionVerdict; owner_write?: PermissionVerdict }>;
  entries: PermissionEntry[];
  ledger?: { record_allows?: boolean };
}
export class PermissionsDocumentError extends Error {}   // message names file + field
export function loadPermissionsDocument(vault: string): { document: PermissionsDocument | null; path: string };
// absent file -> { document: null }; present-but-unreadable -> throws PermissionsDocumentError (fail closed)

// resolve.ts
export interface PermissionSubject { agent: string; via: "token" | "config" | "operator" }
export interface PermissionDecision { verdict: PermissionVerdict; source: string; reason: string }
// source: "entry:<id>" | "agent:<name>" | "role:<name>" | "default"
export function resolvePermission(doc: PermissionsDocument, subject: PermissionSubject, action: PermissionAction, target?: string): PermissionDecision;
// precedence: target entry > agent override > agent role > default_action; deny > ask > allow at equal specificity

// ledger.ts
export interface DecisionLedgerRow { ts: string; actor: string; via: string; action: PermissionAction | "resolution"; target: string; verdict: string; source: string; reason: string; tool?: string; correlation_id?: string }
export function appendDecisionLedger(vault: string, row: DecisionLedgerRow): { logged: boolean; audit_reason?: string };
// append-only month/device JSONL under Brain/logs/decisions/, per-shard proper-lockfile; a failed append never throws - it returns audit_reason
export function queryDecisionLedger(vault: string, filter: { actor?: string; action?: string; verdict?: string; target?: string; since?: string; until?: string; limit?: number }): DecisionLedgerRow[];
```

Lane B provides (`src/core/brain/secrets/token-store.ts`, `src/mcp/http.ts`, `src/mcp/server.ts`):

```ts
// token-store.ts
export interface McpTokenRecord { name: string; agent: string; status: "active" | "revoked"; token_hash: string; token_prefix: string; created_at: string; rotated_at?: string }
export function mintAgentToken(vault: string, name: string, agent: string): { tokenMaterial: string; record: McpTokenRecord };  // tokenMaterial shown once, never stored
export function rotateAgentToken(vault: string, name: string): { tokenMaterial: string; record: McpTokenRecord };
export function revokeAgentToken(vault: string, name: string): boolean;
export function listAgentTokens(vault: string): McpTokenRecord[];          // sorted by name; never contains material
export function resolveAgentForToken(vault: string, presented: string): { agent: string; name: string } | null;
// sha256(presented) compared against stored hashes (timingSafeEqual); store read behind an mtime cache

// http.ts
export interface RequestIdentity { agent: string; via: "token" | "shared-key" }
export function authenticateRequest(req: IncomingMessage, opts: { apiKey: string | null; resolveToken: (presented: string) => { agent: string } | null; tokensRequired: boolean }): RequestIdentity | null;
// token map first, then shared key (identity = process config name), else null; invalid/missing credential with tokensRequired && map non-empty -> 401 (same generic body)

// server.ts
async handleRequest(request: JsonRpcRequest, identity?: RequestIdentity): Promise<JsonRpcResponse | null>;
// identity threads as a PARAMETER through handleToolsCall -> invokeToolHandler -> contextFor(identity);
// contextFor().agentName === identity?.agent ?? resolveAgentName(configPath). No instance field (concurrent requests).
```

Lane C provides (`src/core/brain/write-gate.ts`, `src/core/brain/pending/pending-lanes.ts`, `src/core/brain/signal.ts`):

```ts
// write-gate.ts (leaf module: imports only config/fs - signal.ts imports it, pending-lanes.ts imports it)
export const WRITE_APPROVAL_NOTES_CONFIG_KEY = "write_approval.notes";
export const WRITE_APPROVAL_INGEST_CONFIG_KEY = "write_approval.ingest";
export const WRITE_APPROVAL_NOTES_ENV_KEY = "OPEN_SECOND_BRAIN_WRITE_APPROVAL_NOTES_ENABLED";
export const WRITE_APPROVAL_INGEST_ENV_KEY = "OPEN_SECOND_BRAIN_WRITE_APPROVAL_INGEST_ENABLED";
export type ReviewLane = "signals" | "notes" | "ingest";
export function resolveWriteApprovalLane(lane: ReviewLane, configPath?: string): boolean;  // lane key ?? master write_approval.enabled ?? false; env wins per key

// pending-lanes.ts
export interface WriteDisposition { verdict: "publish" | "stage" | "refuse"; source: string; reason?: string; pendingId?: string }
export function resolveWriteDisposition(vault: string, lane: ReviewLane, subject?: PermissionSubject): WriteDisposition;
// no document -> write_approval lane keys (on = stage, off = publish); document present -> resolvePermission (deny = refuse, ask = stage, allow = publish)
export function stageForReview(vault: string, lane: ReviewLane, publishTarget: string, render: () => string): { pendingId: string; path: string };
// writes the rendered bytes verbatim into Brain/pending/<lane-dir>/<id>.md under the vault-identity write guard
export function encodePendingTargetPath(relPath: string): string;   // reversible percent-encoding, Windows-legal, 255-bound refusal by name
export function decodePendingTargetPath(encoded: string): string;
export function listPendingLane(vault: string, lane: ReviewLane | "all"): PendingLaneEntry[];      // sorted; unreadable entries partitioned and named
export function applyPendingLane(vault: string, id: string, opts?: { dryRun?: boolean }): PendingApplyResult;   // exclusive-create at the decoded target, then unlink; occupied -> PendingApplyConflictError
export function rejectPendingLane(vault: string, id: string, reason: string, opts?: { dryRun?: boolean }): PendingRejectResult;
// ids: ^(sig|note|ing)-\d{4}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9._%-]*$ - the sig- shape stays byte-compatible
// with the existing queue; the note- suffix is the encoded publish target without its final .md
// (note-2026-10-10-notes%2Ffoo%2Fbar), the ing- suffix is the deterministic publish basename without .md

// signal.ts (extension)
// WriteSignalOptions unchanged; writeSignal resolves resolveWriteApprovalLane("signals") when targetDir is absent,
// stages into Brain/pending/, and adds `staged: boolean` to its result. stagePendingSignal passes targetDir explicitly and bypasses the gate.
```

Lane D provides (`src/core/brain/trust/owner-write-gate.ts`, consumed by Lane C in Task 13):

```ts
export const OWNER_SCOPE_WRITES_KEY = "integrity.owner_scope_writes";   // in INTEGRITY_GATE_KEYS; strict fallback = fail
export interface CrossOwnerWriteInput { explicitOwner?: string; frontmatterOwner?: string; resolvedIdentity: string; gateMode: "off" | "warn" | "fail"; document?: PermissionsDocument | null; subject?: PermissionSubject }
export type CrossOwnerWriteVerdict = { refused: false } | { refused: true; token: OwnerWriteRefusal; reason: string };
export function refuseCrossOwnerWrite(input: CrossOwnerWriteInput): CrossOwnerWriteVerdict;
// composition: document verdict (most restrictive) with gate mode; warn -> { refused: false } + caller logs one ledger row; off with no document -> { refused: false } byte-identically
```

Lane E provides (`src/core/brain/decisions/open-store.ts`, consumed by nobody this wave; and the ambient keys consumed only by its own fact-extract wiring):

```ts
export const OPEN_DECISION_STATUS = Object.freeze({ open: "open", resolved: "resolved", discarded: "discarded" } as const);
export const OPEN_DECISION_STATUSES: ReadonlyArray<OpenDecisionStatus>;   // frozen trio: object + list + guard, census-registered
export function openDecision(vault: string, input: { title: string; question: string; options: string[]; context?: string; agent?: string }): OpenDecisionRecord;
// Brain/decisions/open-<slug>.md; dedup on sha16(normalized question) -> typed duplicate refusal naming the existing id; directory lock; vault-identity guard
export function listOpenDecisions(vault: string, opts?: { status?: OpenDecisionStatus; readable?: (relPath: string) => boolean }): { records: OpenDecisionRecord[]; unreadable: { path: string; reason: string }[] };
export function resolveOpenDecision(vault: string, id: string, input: { choice: string; actor?: string; rationale?: string }): { decision: string };  // mints recordDecision page, stamps resolved + [[decision-<slug>]], appends "open_resolved" receipt
export function discardOpenDecision(vault: string, id: string, input: { reason: string; actor?: string }): void;
```

### Config keys inventory (pin - one vocabulary per key, no second reader)

| Key | Home | Default | Owner |
|---|---|---|---|
| `write_approval.enabled` / `OPEN_SECOND_BRAIN_WRITE_APPROVAL_ENABLED` | device flat (existing) | off | Lane C (unchanged semantics; master fallback) |
| `write_approval.notes` / `OPEN_SECOND_BRAIN_WRITE_APPROVAL_NOTES_ENABLED` | device flat | falls back to master | Lane C |
| `write_approval.ingest` / `OPEN_SECOND_BRAIN_WRITE_APPROVAL_INGEST_ENABLED` | device flat | falls back to master | Lane C |
| `Brain/_permissions.yaml` | vault document | absent = no document | Lane A |
| `integrity.owner_scope_writes` | `Brain/_brain.yaml` integrity block | `off` (unreadable config: `fail`) | Lane D |
| `guardrails.ambient_writeback` | `Brain/_brain.yaml` guardrails block | absent (= today's behavior); explicit `false` suppresses | Lane E |
| `guardrails.ambient_ttl_days` | `Brain/_brain.yaml` guardrails block | absent (no stamp) | Lane E |
| `mcp_tokens_required` / `OPEN_SECOND_BRAIN_MCP_TOKENS_REQUIRED` | device flat | false | Lane B |
| `.open-second-brain/secrets/mcp-tokens.json` | device custody dir | absent until first mint | Lane B |
| `<vault>/.open-second-brain/bootstrap.lock.json` | device receipt | absent until first bootstrap | Lane B |
| `Brain/logs/decisions/` | vault ledger dir | empty until first gate fires | Lane A |

### Dependency-wait rule

A task whose **Depends on** names an unlanded commit proceeds as follows: write the failing tests against the pinned signatures above first; then poll every 30 seconds with `git fetch origin feat/write-side-trust && git log origin/feat/write-side-trust --oneline -- <owner paths>` until the upstream commit subject appears; rebase onto it and run the suite. After 30 minutes of waiting, stop and report to the orchestrator instead of stubbing the dependency. Never copy a substrate module into your lane to unblock yourself.

### Security-review and portability rules for every lane

- No identifier containing `secret` before a quoted value anywhere in src or tests; name credential variables `tokenMaterial`, `presentedCredential`, `PRIVATE_PATH`. The plugin scanner flags `const secret = "..."` forms.
- Every credential-shaped literal in tests comes from `tests/helpers/fake-credentials.ts` (`fakeCredential(...parts)`), the established pattern in `tests/core/brain/secrets/store.test.ts:158`. A raw `osbt_...` or bearer-shaped literal in a test is a review failure.
- Tests that assert permission denial via file modes use `test.skipIf(CHMOD_CANNOT_DENY)` (`tests/helpers/platform.ts:31`); no POSIX-only assumption in new tests; all new path handling round-trips Windows-invalid characters.
- Tests never depend on directory iteration order: every listing sorts deterministically (the `listPending` precedent).
- Tests that spawn subprocesses (bootstrap adapter probes, hook invocations) set an explicit per-test timeout of 20000 ms and never rely on wall-clock sleeps.
- Ledger and store writers serialize under `proper-lockfile` directory locks with deterministic merge order `(timestamp, shardId)`.

## Tasks

### Task 1: Permissions document loader and resolver (Lane A, substrate)
- **Lane**: A. **Files**: new `src/core/brain/permissions/document.ts`, `src/core/brain/permissions/resolve.ts`; `tests/core/brain/permissions/document.test.ts`, `tests/core/brain/permissions/resolve.test.ts`.
- **Acceptance**: absent `Brain/_permissions.yaml` yields `{ document: null }`; a valid minimal document loads with `default_action` required (missing key is a field-named `PermissionsDocumentError`); unknown keys warn, `version` other than 1 hard-refuses naming the file; an unreadable file (bad YAML, wrong types) throws with the field named, never returns a document; resolution order (target entry > agent override > role > default; deny > ask > allow at equal specificity) is pinned table-style; the modules import nothing from `core/brain` beyond type-level constants and `tests/core/architecture/import-cycles.test.ts` passes. This task commits FIRST and its commit sha is the substrate anchor for Tasks 8, 12, 13.
- **Depends on**: none

### Task 2: Decision ledger store (Lane A, substrate)
- **Lane**: A. **Files**: new `src/core/brain/permissions/ledger.ts`; `tests/core/brain/permissions/ledger.test.ts`; `src/core/state/surfaces.ts` + `tests/core/architecture/state-surface-census.test.ts` (decisions-ledger row, count +1).
- **Acceptance**: rows append to `Brain/logs/decisions/<YYYY-MM>[.<deviceId>].jsonl` under the shard grammar with per-shard lock; concurrent appends from two simulated devices never lose a row; a failed append returns `{ logged: false, audit_reason }` and never throws; `queryDecisionLedger` filters by actor/action/verdict/target/time with deterministic merge order; an empty vault yields zero rows and no directory.
- **Depends on**: none

### Task 3: Named per-agent token store (Lane B, substrate)
- **Lane**: B. **Files**: new `src/core/brain/secrets/token-store.ts`; `tests/core/brain/secrets/token-store.test.ts`.
- **Acceptance**: `mintAgentToken` returns material exactly once and persists only the sha256 hash plus a non-secret prefix; the store file is `.open-second-brain/secrets/mcp-tokens.json` created 0600 (Windows: `custodyTargets` owner ACL; denial-assertions `test.skipIf(CHMOD_CANNOT_DENY)`); writes serialize under `withSecretsLock`; every mint/rotate/revoke appends a no-values custody audit record (`mcp_token_minted|rotated|revoked`); `resolveAgentForToken` matches the presented material by hash in constant time, returns null for unknown or revoked, and reflects a rotation on the next call without any restart; names validate `mcp_token_<slug>` (underscores, `$secret:`-compatible); every credential literal in tests comes from `fakeCredential`.
- **Depends on**: none

### Task 4: Permissions CLI verb and doctor finding (Lane A)
- **Lane**: A. **Files**: new `src/cli/brain/verbs/permissions.ts` (`show` prints the effective document plus a dry-run decision table over configured agents and roles; `ledger` lists rows with `--actor --action --verdict --since --until --json`); doctor finding `permissions-unreadable` (`nextCommand` names the fix); shared-append registration (six places); `tests/cli/brain-permissions.test.ts`; doctor-exit census.
- **Acceptance**: with no document, `show` says so and prints no table; with a document, `show` renders the resolved decision for each declared agent; `ledger` returns rows in deterministic order; a deliberately corrupt document makes `show` fail with the field-named error and the doctor emit exactly one `permissions-unreadable` finding.
- **Depends on**: Tasks 1, 2

### Task 5: Recall exclusion for the review lane (Lane C)
- **Lane**: C. **Files**: `src/core/vault-scope/index-admission.ts` (`BRAIN_PENDING_REL` covered-lane exclusion, reason `review-pending`); `tests/core/search/index-admission.test.ts` extension; a walker-level case proving `Brain/pending/**` is not indexed while `Brain/pendingfoo/x.md` still is (the `pathCovers` boundary rule).
- **Acceptance**: a document staged under `Brain/pending/` never enters the search index (so `brain_search` and recall-inject cannot surface it) while gate-off vaults are unaffected (no pending directory, no behavior change); the exact-state-lane and payload-store verdicts are unchanged.
- **Depends on**: none

### Task 6: Signal-lane chokepoint gate (Lane C)
- **Lane**: C. **Files**: new `src/core/brain/write-gate.ts` (lane resolver leaf module); `src/core/brain/signal.ts` (resolve the signals lane when `targetDir` is absent; `staged: boolean` on the result); `tests/core/brain/write-gate.test.ts` (new) plus staged-path cases in the `writeSignal` suites (`tests/core/brain/vault-identity.test.ts` extension and the MCP feedback suite covering the staged receipt).
- **Acceptance**: with every toggle absent, `writeSignal` is byte-identical (the existing suites pass unmodified); with `write_approval.enabled: true`, every ungated `writeSignal` caller (MCP feedback, CLI feedback, inline scan, session import, session lifecycle, session checkpoint) stages into `Brain/pending/` with `staged: true` on the result and the identical dedup/idempotency consumption; `stagePendingSignal` (explicit `targetDir`) never re-enters the gate; the two extract callers are behavior-identical with their injected resolution; lane keys fall back to the master key per the resolver table.
- **Depends on**: none

### Task 7: Transport authentication and request-scoped identity (Lane B)
- **Lane**: B. **Files**: `src/mcp/http.ts` (`authenticateRequest`, token map wiring, non-loopback rule accepts key OR non-empty map, `mcp_tokens_required` enforcement with the unchanged generic 401 body); `src/mcp/server.ts` (`handleRequest(request, identity?)` parameter threading through `handleToolsCall`/`invokeToolHandler`/`contextFor`); `tests/mcp/http-token-auth.test.ts`; extensions of `tests/mcp/http-transport.test.ts` and `tests/mcp/owner-scope-refusal.test.ts` (identity-positive cases only - the one-reader census must pass unmodified).
- **Acceptance**: no tokens configured - every existing HTTP test passes unmodified (byte-identical auth); a valid token yields per-caller identity so `brain_context` reports the token's agent and `refuseOwnerScopeRequest` under `fail` refuses a foreign scope per caller; the shared key still authenticates with the process identity; a revoked token gets the same generic 401 as an unknown one; `mcp_tokens_required: true` with a non-empty map refuses credential-less requests, and with an empty map only warns at startup; non-loopback bind accepts key-or-map; concurrent requests with different tokens never observe each other's identity (parameter threading, no instance field); stdio is untouched.
- **Depends on**: Task 3

### Task 8: Owner-write gate and the preference lane (Lane D)
- **Lane**: D. **Files**: `src/core/brain/policy/blocks/integrity.ts` (+ resolver/types: `owner_scope_writes` in `INTEGRITY_GATE_KEYS`, default `off`, strict fallback `fail`); new `src/core/brain/trust/owner-write-gate.ts` (the pinned `refuseCrossOwnerWrite` predicate); `src/core/brain/preference.ts` (the explicit-owner arm consults the predicate; `warn` appends one ledger row via the Task 2 recorder); `tests/core/brain/trust/owner-write-gate.test.ts`; extensions of `tests/core/brain/owner-stamp.test.ts` (gate-off cases unchanged) and a new gate-matrix suite.
- **Acceptance**: gate off or document absent - `owner-stamp.test.ts` passes unmodified (explicit caller owner still wins, pinned behavior preserved); under `fail`, an explicit owner differing from the resolved identity refuses with `owner-write-refused` naming both tokens; under `warn` it is allowed with one decision-ledger row carrying the gate key as source; an unreadable `_brain.yaml` fails closed (named error); a document `owner_write: deny` refuses even when the gate mode is `off`, and a document `allow` cannot override gate `fail` (most-restrictive-wins pinned both ways); the restore/import paths (explicit = undefined) are unaffected.
- **Depends on**: Tasks 1, 2

### Task 9: Multi-lane pending queue and the notes/ingest staging seams (Lane C)
- **Lane**: C. **Files**: new `src/core/brain/pending/pending-lanes.ts` (lane registry, `resolveWriteDisposition` over the write-approval keys only at this task, `stageForReview`, encode/decode, generalized list/apply/reject with named-unreadable partitioning); `src/core/brain/pending.ts` (delegate listing/resolution to the lanes module; the existing exports and id grammar stay); `src/core/brain/notes/create-note.ts` (stage creates under the notes lane disposition; update/append untouched); `src/core/brain/write-batch.ts` (create ops stage per-op, receipt status `staged` with the pending id); `src/core/brain/ingest/ingest.ts` + `source-cleanup.ts` (summary page stages under the ingest lane; cleanup removes a matching staged page); `src/core/brain/destructive-sites.ts` (generalized move-then-unlink entries); `src/cli/brain/verbs/pending.ts` (lane column, `--lane`, widened id grammar, `--dry-run` honest previews); `src/mcp/brain/notes-tools.ts`, `write-batch-tools.ts`, `feedback-tools.ts`, `ingest-tools.ts` (staged receipt fields with `pending_id` and next command); `tests/core/brain/pending-lanes.test.ts`, extensions of the pending/dry-run/CLI suites and the batch suites.
- **Acceptance**: toggles absent - every existing pending, note, batch, ingest and feedback suite passes unmodified (byte-identical published paths); `write_approval.notes: true` stages `brain_create_note` and batch create ops as byte-for-byte documents whose apply reproduces the published bytes exactly (round-trip encode tests over CJK, spaces, dots, nested paths; over-long targets refuse by name); apply moves into an occupied target refusing with `PendingApplyConflictError`; update/append against published notes stay direct under the gate; `write_approval.ingest: true` stages the summary page while registration completes and cleanup removes the staged page; `o2b brain pending list` shows all lanes sorted with `--lane` filtering and named-unreadable entries; dry runs run every check and write nothing.
- **Depends on**: Task 6 (the `write-gate.ts` leaf and its config keys)

### Task 10: Open-decision vault (Lane E)
- **Lane**: E. **Files**: new `src/core/brain/decisions/open-store.ts` (frozen key table, JSON-quoted values, `## Question`/`## Options`/`## Context` body sections, named-unreadable reads, directory lock, dedup, transitions); new `src/core/brain/decisions/brief.ts` (render-only `## Open decisions` section, cap 5); `src/core/brain/decisions/receipts.ts` (`open_resolved` reason); `src/core/brain/types.ts` (log kinds `decision-open`, `decision-resolved`, `decision-discarded`); `src/mcp/brain/decisions-tools.ts` (actions `open | list_open | show_open | resolve | discard` on the existing tool, reach `readable` predicate as today); `src/cli/brain/verbs/decision.ts` (action mirror); `src/mcp/brain/brief-tools.ts` + `src/cli/brain/verbs/morning-brief.ts` (section wiring); shared-append registration; `tests/core/brain/decisions/open-store.test.ts`, extensions of `tests/mcp/decision-tool.test.ts` and `tests/cli/brain-decision.test.ts`, brief suite, verdict-vocabulary census registration.
- **Acceptance**: an open record with two enumerated options round-trips through hand-edit-tolerant parsing; a duplicate question (same normalized hash) refuses naming the existing id; resolve mints a real `decision-<slug>` page via `recordDecision` with the chosen option, stamps the open record `resolved` with the `[[decision-<slug>]]` pointer, and lands exactly one `open_resolved` receipt; discard records the reason; terminal records stay in place and `list` partitions by status with unreadable entries named; resolving or discarding a missing id is a typed error; the morning brief renders at most five open records plus the unreadable block and never mutates them; every writer carries the vault-identity guard and rewrites under the directory lock.
- **Depends on**: none

### Task 11: Ambient consent and TTL (Lane E)
- **Lane**: E. **Files**: `src/core/brain/policy/blocks/guardrails.ts` (`ambient_writeback` boolean, `ambient_ttl_days` non-negative integer in `KNOWN_KEYS` with resolver + defaults); `src/core/brain/fact-extract.ts` (explicit `false` suppresses ambient extraction with a counted, logged `ambient-withheld` event; `ambient_ttl_days` stamps `expiration_date` at creation through the validated chokepoint); `tests/core/brain/fact-extract.ambient.test.ts`; extensions of `tests/core/brain/fact-extract.durability.test.ts` and the expiration suites.
- **Acceptance**: keys absent - the extraction lane and its tests are byte-identical; explicit `false` suppresses with one counted event per capture and no signal written; `ambient_ttl_days: N` stamps `expiration_date = created + N` on ambient-extracted signals which `filterExpired` then drops at read; a non-boolean or negative value is a hard field-named config error; staging composes (a TTL-stamped signal still stages when the signals gate is on, expiration preserved verbatim through apply).
- **Depends on**: none

### Task 12: Document-backed dispositions and the force-confirmed rule (Lane C)
- **Lane**: C. **Files**: `src/core/brain/pending/pending-lanes.ts` (`resolveWriteDisposition` consults `loadPermissionsDocument` + `resolvePermission` when a document exists; deny -> typed `WriteRefusedError` naming principal, action, rule and next command; ask -> stage; ledger rows via the Task 2 recorder for stage and refuse); `src/mcp/brain/feedback-tools.ts` (under a document, `force_confirmed` requires the caller's `write` verdict to be `allow`, else the named refusal); `tests/core/brain/pending-lanes.test.ts` document cases; an MCP-level refusal-shape test.
- **Acceptance**: no document - dispositions come from the write-approval keys exactly as in Task 9 (all Task 9 assertions still hold); with a document, one write produces exactly one deciding rule and (for stage/refuse) exactly one ledger row with `source` naming the entry, role, or default; `deny` on `ingest` refuses `brain_ingest_source` before any write; a document cannot be bypassed by the lane keys (document present = document only); `force_confirmed` under a non-allow verdict refuses with `force-confirmed-requires-allow` and document-absent behavior is unchanged; the refusal token vocabulary is census-registered.
- **Depends on**: Tasks 1, 2, 9

### Task 13: Note-lane owner-frontmatter guard (Lane D, after the Lane C handoff)
- **Lane**: D (receives file ownership of the guard regions of `src/core/brain/write-batch.ts` and `src/core/brain/notes/create-note.ts` from Lane C at this boundary; the staging code landed in Task 9 is untouched). **Files**: `write-batch.ts` (`owner` joins the refused update-frontmatter keys under the gate via `refuseCrossOwnerWrite`), `create-note.ts` (create-time frontmatter owner guard), `tests/core/brain/owner-write-notes.test.ts` (two-state probe: a `CROSS_OWNER_MARKER` page is not writable by the wrong identity under `fail`, is writable with a ledger row under `warn`, untouched under `off`).
- **Acceptance**: gate off - the note suites from Task 9 pass unmodified; under `fail`, an update naming a foreign `owner:` refuses with `owner-write-refused` and a create carrying one refuses before any byte; matching-identity owners always pass; warn logs exactly one decision-ledger row per allowed write; the refusal answers as a named error, never as an existence leak.
- **Depends on**: Tasks 8, 9

### Task 14: Bootstrap command and rotation (Lane B)
- **Lane**: B. **Files**: new `src/cli/bootstrap/` (command module, receipt writer); `src/cli/main.ts` (`bootstrap` arm, `mcp token` sub-dispatcher with `mint|rotate|revoke|list`); `src/cli/command-manifest.ts` (Lane B entries); `tests/cli/bootstrap.test.ts`; `tests/cli/mcp-token.test.ts`.
- **Acceptance**: `o2b bootstrap --target codex --agent codex --token` runs the adapter's existing idempotent apply, mints `mcp_token_codex`, prints the material exactly once with a shown-once notice (never on argv, never in any harness config - the payload env block stays credential-free), and writes `.open-second-brain/bootstrap.lock.json` (schema 1, owned entries, token name and non-secret prefix, `applied_at`); a second identical run is a byte-identical no-op (exit 0, no receipt churn); `--rotate` re-mints under the same name with a `replaced: true` audit row and reprints once, and the new material authenticates on the next request with no server restart; `--check` verifies drift from `InstallEnv` alone; `--target generic` prints the payload and the manual steps; unsupported targets are refused with the available list; exit codes follow the `INSTALL_EXIT` table style; adapter-probing tests use explicit 20000 ms timeouts; Windows uses the existing launcher machinery untouched.
- **Depends on**: Tasks 3, 7

### Task 15: Reconciliation, docs, version (orchestrator)
- **Files**: every shared-append registration file (dispatcher, barrels, help text, manifest, `docs/cli-reference.md`, `docs/mcp.md`, `docs/observability.md` - decision ledger section, README control section); census pins reconciled by measurement (verdict vocabulary, state surfaces, destructive sites, doctor exits); `CHANGELOG.md` `[1.79.0]` with link reference; `package.json` 1.79.0 + `bun run scripts/sync-version.ts`.
- **Acceptance**: `bun run typecheck`, `bun run lint`, `bun run fmt:check`, `bun run test`, `bun run sync-version:check`, `python -m unittest discover -s tests/python` all green on the merged branch; every gate documented as default-off with its key, and every refusal token documented with its next command.
- **Depends on**: Tasks 1-14
