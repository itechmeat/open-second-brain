# Operability, Safety & First-Run - Per-Task Plan

Implementation order follows the sequence hint: resilience -> visibility ->
guards/transport -> telemetry -> onboarding last. Each task is test-driven: a
failing acceptance test first, then minimal code, then zero-warning
`bun run validate`.

---

## t_9b0bb1be - Configurable 429 retry budget

**Files.**
- `src/core/search/types.ts` - add `readonly maxRetries: number` to
  `ResolvedEmbeddingConfig`.
- `src/core/search/index.ts` - `DEFAULTS.maxRetries = 6`; read
  `embedding_max_retries` / `OPEN_SECOND_BRAIN_EMBEDDING_MAX_RETRIES`
  (`parseInteger`, `{min:1}`); add to frozen `semantic`; range-validate in
  `validateResolvedConfig`.
- `src/core/search/embeddings/openai-compat.ts` - thread `config.maxRetries`
  into `embed()`'s retry (`embedBatchOnKey` `maxAttempts`); keep `ping()` at 1.
- `src/core/search/embeddings/zeroentropy.ts` - same thread.
- `tests/core/search/embeddings.test.ts` (+ zeroentropy test) - retry cases.

**Acceptance test.** With `embedding_max_retries=5` a provider hitting `429`
four times then `200` succeeds and makes exactly 5 attempts; with the default,
6 attempts; a non-retriable `400` still fails fast on attempt 1; `ping()` still
makes a single attempt. Config out of range fails validation.

**Depends on.** None. (Out-of-scope child `t_8880a68d` not pulled in.)

---

## t_fb132614 - Hook self-watchdog + fail-open inject

**Files.**
- `src/core/reliability/process-ceiling.ts` (new) - `armProcessCeiling({
  ceilingMs, onExpire?, exit?, setTimer? })` returning a disarm fn; `unref`ed
  timer; default ceiling from `OPEN_SECOND_BRAIN_HOOK_CEILING_MS` (~55000).
- `src/core/brain/inject-failopen.ts` (new) - last-good cache read/write under
  `<vault>/.open-second-brain/` + degrade-to-cached/empty wrapper with an audit
  line.
- `hooks/active-inject.ts`, `hooks/session-capture.ts` - arm the ceiling; route
  inject assembly through the fail-open loader.
- `tests/core/reliability/process-ceiling.test.ts`,
  `tests/core/brain/inject-failopen.test.ts` (new).

**Acceptance test.** A ceiling armed with an injected fake timer + injected
`exit` fires `onExpire` and calls `exit(0)` at the ceiling when work has not
completed, and does nothing when disarmed first. The fail-open loader, given an
assembler that throws, returns the previously-cached body (and, with no cache,
empty), never a partial value, and appends exactly one degrade audit record.

**Depends on.** None (foundational).

---

## t_5161e7ab - Runtime-state notice channel

**Files.**
- `src/core/brain/runtime-notices.ts` (new) - `collectRuntimeNotices(vault,
  {configPath})` -> `RuntimeNotice[]` (`{code, severity, message}`), covering
  degraded semantic search, indexing lag / reindex-in-progress, read-only vault.
- `hooks/active-inject.ts` - prepend a `Runtime notices:` block when non-empty.
- `src/mcp/tools.ts` (`vault_health`) - add a `notices` array.
- `tests/core/brain/runtime-notices.test.ts`, an inject-surface test, a
  `vault_health` test.

**Acceptance test.** A vault with semantic enabled but no embedding key yields a
`semantic_degraded` notice; a read-only vault yields a `vault_read_only` notice;
a healthy vault yields none and the injected `additionalContext` is
byte-identical to today. `vault_health` surfaces the same notices. No network is
touched (verified with a no-network harness).

**Depends on.** None; consumed by onboarding (`t_84500f39`).

---

## t_b3dc1454 - Config validator remediation

**Files.**
- `src/core/types.ts` - `CheckResult.fix?: string`.
- `src/core/doctor.ts` - populate `fix` in each failing branch with a concrete
  command.
- `src/cli/main.ts` (`cmdDoctor`) - render `fix`; add `--json`; print an
  aggregate `N checks, M failed` summary; keep 0/1 exit.
- `src/mcp/tools.ts` (`vault_health`), `src/openclaw/index.ts` - render `fix`.
- `tests/core/doctor.test.ts`, a `cmdDoctor` CLI test, a `vault_health` test.

**Acceptance test.** A missing/unwriteable vault check carries a
copy-pasteable `fix` command; a passing check omits `fix`; `o2b doctor --json`
emits `{ok, checks:[{name, ok, message, fix?}], summary:{total, failed}}` and
exits `1` when any check fails, `0` when all pass; `vault_health` includes
`fix`.

**Depends on.** None; consumed by onboarding.

---

## t_67e491f6 - Expect/strict guards + matched/changed

**Files.**
- `src/core/brain/count-guard.ts` (new) - `assertExpectedCount` +
  `CountGuardError` (carries the match list).
- `src/core/fs-atomic.ts` - optional `skipIfUnchanged` returning `changed:boolean`.
- `src/core/vault.ts` (`writeFrontmatterAtomic`) - thread `changed` through.
- `src/mcp/brain/ingest-tools.ts`, `hygiene-tools.ts`, `feedback-tools.ts` -
  wire `expect`/`strict`; add `matched`/`changed` to payloads.
- CLI verbs `forget-source.ts`, `hygiene.ts`, `dream.ts`, `feedback.ts` -
  `--expect` (string->int), `--strict` (bool).
- `tests/core/brain/count-guard.test.ts`, `tests/core/fs-atomic.test.ts`, and
  op-level tests.

**Acceptance test.** A delete/hygiene/dream op run with `--expect 3` when it
would touch 5 aborts without writing and returns the 5-item match list; the same
op with `--strict` and no `--expect` aborts as guardless; a write of identical
content with `skipIfUnchanged` returns `changed:false` and leaves the file mtime
untouched; each op payload reports `matched` and `changed` distinctly.

**Depends on.** None.

---

## t_bdd82ecf - Hardened optional HTTP transport

**Files.**
- `src/mcp/http.ts` - mandatory Host DNS-rebinding guard, mandatory Origin
  guard, `GET /health`, optional bearer on loopback / required on non-loopback.
- `src/cli/main.ts` (`cmdMcp`) - allow `--transport http` without `--api-key` on
  a loopback host; keep requiring it on a non-loopback host.
- `tests/mcp/http-transport.test.ts` - update + extend.
- `README.md` - document the opt-in transport and its security model.

**Acceptance test.** A request with a non-loopback `Host` header is rejected
`403` (DNS-rebinding guard); a request with a foreign `Origin` is rejected
`403`; `GET /health` returns `200` JSON with no bearer; a loopback server with
no configured bearer serves an authenticated-free `initialize`; a configured
bearer is still enforced (`401` on wrong/missing); starting an HTTP transport on
a non-loopback host with no bearer is refused.

**Depends on.** None. Extra CodeRabbit attention here (security-sensitive).

---

## t_56a12bde - Per-skill invocation telemetry

**Files.**
- `src/core/brain/continuity/types.ts` - add `"skill_invoked"` kind.
- `src/core/brain/sessions/import.ts` - emit a `skill_invoked` record per skill
  invocation in the tool-call loop (per-turn/call disambiguator).
- `src/core/brain/skill-usage.ts` (new) - derive per-skill counts (mirror
  usage-signal decay).
- `src/core/brain/skill-proposals.ts` - feed counts into ranking.
- `src/mcp/brain/procedure-tools.ts` (`brain_skill_proposals`) - `usage` view.
- `src/cli/brain/verbs/skill-proposals.ts` - `usage` view.
- `tests/core/brain/skill-usage.test.ts`, a session-import test, an MCP test.

**Acceptance test.** Importing a session that invokes skill `release` three
times and `triage` once yields four `skill_invoked` records with distinct ids;
`deriveSkillUsage` reports `release:3, triage:1`; `brain_skill_proposals`
`operation:"usage"` returns the same counts; a vault with no invocations is
byte-identical (no records, empty usage). No LLM is called.

**Depends on.** None. Distinct from `t_6fc8663c` (verifier gate) and
`t_703f7b18` (outcome ranking).

---

## t_84500f39 - Guided first-run onboarding (last)

**Files.**
- `src/cli/onboarding.ts` (new) - `buildOnboardingChecklist(vault, config)` ->
  ordered steps (status, command, hint), computed from real state; renderer.
- `src/cli/main.ts` - extend `cmdInit` to render the checklist after the
  retained search block; add a re-runnable `onboarding` verb.
- `src/cli/command-manifest.ts` - register the verb.
- `tests/cli/onboarding.test.ts`, a `cmdInit` test.

**Acceptance test.** `buildOnboardingChecklist` on a bare vault marks
"persist config" done and "build search index", "set agent name", "record first
feedback" as todo, each with a copy-pasteable command; after indexing, the index
step flips to done; `o2b onboarding` re-runs the checklist any time; `o2b init`
still prints the existing search block plus the checklist. It reflects the same
doctor/notice signals the rest of the release exposes.

**Depends on.** `t_b3dc1454` (doctor remediation) and `t_5161e7ab` (notices) for
the surfaces it reuses; implemented last.
