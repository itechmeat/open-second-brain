# Operability, Safety & First-Run - Design

## Problem

A freshly installed Open Second Brain is harder to stand up and operate than
it should be. A new vault prints one next step (search indexing); the doctor
diagnoses failures without telling the operator how to fix them; health is
pull-only, so an agent learns semantic search fell back to lexical only by
polling; lifecycle hooks have no self-imposed time ceiling and the inject path
fails fast instead of degrading; the embedding retry budget is a hardcoded 3
that silently drops chunks under strict rate limits; mutating sweeps can touch
far more files than expected and rewrite unchanged files; the HTTP transport
lacks a DNS-rebinding guard and a health endpoint; and skill proposals rank
with no signal about which skills agents actually use.

This release makes the system robust and pleasant to set up and operate, as one
coherent scope, without adding a dependency and without the kernel calling an
LLM.

## Scope

Eight in-scope board tasks:

- `t_9b0bb1be` - configurable 429/rate-limit retry budget for embeddings.
- `t_fb132614` - process self-watchdog (hard time ceiling) + fail-open context
  load for lifecycle hooks.
- `t_5161e7ab` - runtime-state notice channel on the injection surface.
- `t_b3dc1454` - config validator that prints copy-pasteable remediation per
  failing check, with a scriptable aggregate status.
- `t_67e491f6` - `--expect N` / `--strict` guards + honest matched/changed
  reporting on mutating ops.
- `t_bdd82ecf` - hardened optional loopback HTTP transport (Host/Origin
  rebinding guard, health endpoint, optional bearer).
- `t_56a12bde` - per-skill invocation telemetry feeding skill-proposal ranking.
- `t_84500f39` - guided first-run onboarding checklist (implemented last; ties
  the config/health/notice surfaces together).

## Out of scope

- Quota-error classification (`t_8880a68d`, an out-of-scope child of the retry
  task) - the retry task raises/exposes the retry budget only.
- A block-addressing query DSL or markdown AST for the mutation guards - port
  the guard/reporting concepts only.
- A third-party plugin notice bus (mem9's model) - notices cover OSB's own
  subsystems only.
- Replacing the pull-based `brain_doctor` / `vault_health` - notices complement
  them.
- On-chain / Solana anchoring - never in scope for this project.

## Chosen approach

Variant 1 (see `variants.md`): thin composition on existing seams. New modules
are small and single-purpose; no new MCP tool is added (notices fold into
`vault_health` and the inject surface; skill usage folds into
`brain_skill_proposals`); the frozen 98-tool surface is preserved; no new
dependency; every new behaviour is additive and byte-identical when its
condition is absent or its gate is off.

## Design decisions

### Configurable embedding retry (`t_9b0bb1be`)
`ResolvedEmbeddingConfig` gains `maxRetries` (default 6, raised from the
hardcoded 3). It is read in `resolveSearchConfig` from `embedding_max_retries`
/ `OPEN_SECOND_BRAIN_EMBEDDING_MAX_RETRIES` via the existing `parseInteger`
`{min:1}` path, added to the frozen `semantic` object, and range-validated in
`validateResolvedConfig`. `OpenAICompatProvider.embed()` threads
`config.maxRetries` into `embedBatchWithRetry` -> `embedBatchOnKey`'s
`maxAttempts`; `ping()` keeps its explicit single attempt. `ZeroEntropyProvider`
gets the identical thread for parity. Backoff stays exponential with jitter; the
last backoff value repeats when attempts exceed the array length (already the
code's behaviour). The max-concurrency knob the upstream feature suggests
already exists as `embedding_concurrency`; it is documented, not re-added.

### Hook self-watchdog + fail-open inject (`t_fb132614`)
A reusable process-ceiling primitive arms a hard time ceiling (default ~55s,
overridable via `OPEN_SECOND_BRAIN_HOOK_CEILING_MS`) using an `unref`ed timer so
it never itself keeps a process alive; on expiry it appends a watchdog audit
line and exits 0 (never a partial write). The timer's `exit` and clock are
injectable so the primitive is unit-tested without spawning. It wraps the two
lifecycle-hook entry points (`active-inject`, `session-capture`).

A fail-open inject loader assembles the injected context inside a guard: on
success it records the assembled body as last-good under
`<vault>/.open-second-brain/`; on any error or overrun it degrades to the
last-good body, or to empty when no cache exists, and appends an audit line. It
never emits a partial or poisoned payload. Reuses `appendAuditRecord`
(`src/core/reliability/audit.ts`).

### Runtime-state notices (`t_5161e7ab`)
`collectRuntimeNotices(vault, {configPath})` returns a small ordered list of
`{code, severity, message}`, computed deterministically with no network and no
LLM: semantic search degraded (enabled but embedding key unresolved, or the
sqlite-vec extension unavailable), indexing lag / reindex in progress
(structural markers under `.open-second-brain/` and an index-older-than-newest-
note check), and read-only vault (a write probe). Notices render as a compact
`Runtime notices:` block prepended to the `active-inject` `additionalContext`
only when the list is non-empty (a healthy vault stays byte-identical), and are
folded into `vault_health` output for pull consumers. Default on; suppressible
via an opt-out env. It does not absorb the quota task.

### Doctor remediation (`t_b3dc1454`)
`CheckResult` gains an optional `fix` field (a copy-pasteable command). Each
failing branch in `src/core/doctor.ts` populates it where a deterministic fix
exists (checks with no deterministic fix omit it). It renders in all three
existing consumers: `o2b doctor` (which gains `--json` and an aggregate
`N checks, M failed` summary; the 0/1 exit stays the scriptable status),
`vault_health`, and the OpenClaw surface. This is the install/config doctor
(`src/core/doctor.ts`), distinct from the Brain-invariant doctor
(`src/core/brain/doctor.ts`).

### Mutation guards (`t_67e491f6`)
A pure `assertExpectedCount({matched, expect, strict, willMutate})` helper
throws a structured error carrying the match list when `expect` mismatches the
matched count, and refuses a guardless mutation when `strict` is set. The atomic
writer gains an opt-in `skipIfUnchanged` that reads the target and short-circuits
identical content, returning whether it actually wrote; this threads through
`writeFrontmatterAtomic` so signal/preference/page writers can report
`changed`. The guard + reporting wire into the three dry-run-capable mutating
ops (delete-by-source, hygiene apply, dream run) and their CLI verbs; each op
payload gains honest `matched` vs `changed` counts. `brain_review_candidates`
stays read-only (its `would_*` lists are the match source). No block-query DSL.

### Hardened HTTP transport (`t_bdd82ecf`)
The existing `src/mcp/http.ts` is hardened, not rewritten. A mandatory,
non-bypassable Host DNS-rebinding guard rejects any request whose `Host` header
is not the loopback host (or the explicitly bound host); a mandatory Origin
guard rejects a present-but-foreign `Origin`. A `GET /health` endpoint returns
`200` with a small JSON status (auth-exempt but still Host-guarded); other GETs
stay `405`. The bearer becomes optional on a loopback bind (loopback + guards
are the baseline defence) but stays required on a non-loopback bind - binding to
a public interface without a token is refused (no permissive fallback). stdio
stays the default transport.

### Skill invocation telemetry (`t_56a12bde`)
A new append-only continuity kind `skill_invoked` is emitted from the existing
session-import tool-call loop when a skill invocation is seen (disambiguated per
turn/call so each invocation hashes to a distinct record id). Counts are derived
read-side by mirroring the usage-signal decay math (append-only, replayable, no
mutable counter). The derived per-skill count feeds skill-proposal ranking and
is surfaced through `brain_skill_proposals` as a new `usage` view and the
matching CLI view. Deterministic, no LLM. No new tool (frozen surface intact).

### Guided onboarding (`t_84500f39`, last)
`buildOnboardingChecklist(vault, config)` computes an ordered set of steps from
real state (config persisted? index built? agent name set? embedding key
resolvable? any feedback signal yet? importable sessions present?), each with a
status, a copy-pasteable command, and a hint. `cmdInit` renders it after the
existing (retained) search block; a re-runnable `onboarding` verb prints it any
time. It reuses the doctor remediation and runtime-notice surfaces so the
checklist reflects the same signals the rest of the release exposes.

## File changes

New:
- `src/core/reliability/process-ceiling.ts` - hard time-ceiling primitive.
- `src/core/brain/runtime-notices.ts` - deterministic notice collector.
- `src/core/brain/count-guard.ts` - `assertExpectedCount` + `CountGuardError`.
- `src/core/brain/skill-usage.ts` - derive per-skill invocation counts.
- `src/cli/onboarding.ts` - onboarding checklist builder + renderer.
- Tests mirroring each under `tests/`.

Changed:
- `src/core/types.ts` - `CheckResult.fix?`.
- `src/core/doctor.ts` - populate `fix` per failing check.
- `src/core/search/types.ts`, `src/core/search/index.ts` - `maxRetries`.
- `src/core/search/embeddings/openai-compat.ts`, `.../zeroentropy.ts` - thread
  `maxRetries`.
- `src/core/fs-atomic.ts`, `src/core/vault.ts` - `skipIfUnchanged` +
  `changed` return.
- `src/mcp/http.ts` - Host/Origin guard, `/health`, optional bearer.
- `src/mcp/tools.ts` (`vault_health`) - `fix` + `notices`.
- `src/openclaw/index.ts` - render `fix`.
- `hooks/active-inject.ts`, `hooks/session-capture.ts` - ceiling + fail-open +
  notices.
- `src/core/brain/continuity/types.ts` - `skill_invoked` kind.
- `src/core/brain/sessions/import.ts` - emit `skill_invoked`.
- `src/mcp/skill-tools.ts` (optional supplementary emit).
- `src/core/brain/skill-proposals.ts`, `src/mcp/brain/procedure-tools.ts` -
  usage view + ranking feed.
- `src/cli/main.ts` (`cmdInit`, `cmdDoctor`, new `onboarding`),
  `src/cli/command-manifest.ts`.
- CLI verbs: `forget-source.ts`, `hygiene.ts`, `dream.ts`, `feedback.ts` -
  `--expect` / `--strict`.
- MCP ops: `ingest-tools.ts`, `hygiene-tools.ts`, `feedback-tools.ts` - guard +
  matched/changed.
- `CHANGELOG.md`, `package.json`, mirrored manifests (via `sync-version.ts`),
  `README.md` (HTTP transport + onboarding), `docs/`.

## Risks

- **HTTP hardening loosening the bearer.** Mitigation: loopback + Host/Origin
  guard are mandatory and non-bypassable; a non-loopback bind still requires a
  bearer; the guard is unit-tested against rebinding and cross-origin.
- **Process ceiling can't interrupt a truly synchronous hang.** Mitigation: the
  realistic hangs are async I/O (embedding fetch, fs stall on a network mount),
  which the `unref`ed timer + `AbortController` timeouts already cover; the host
  `timeout` in `hooks.json` remains a second line.
- **Notices changing injected context.** Mitigation: notices render only when a
  real degraded condition exists, so a healthy vault is byte-identical; an
  opt-out env exists.
- **Skill-invocation dedup collapsing distinct invocations.** Mitigation:
  each record carries a per-turn/call disambiguator so identical-second
  invocations hash to distinct ids.
- **Content-equality skip masking a needed mtime bump.** Mitigation:
  `skipIfUnchanged` is opt-in; default write behaviour is unchanged.
