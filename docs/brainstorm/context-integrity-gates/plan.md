# Context integrity gates - implementation plan

Fourteen atomic units on one branch, `feat/context-integrity-gates`, each a separate conventional commit. Test-driven: every unit writes its failing tests first and runs them to confirm they fail for the expected reason before any implementation.

Gates before every commit, all in the foreground: `bun run fmt`, `bun run lint` (baseline is exactly 134 warnings and 0 errors), `bun run typecheck`, the full `bun test`, and `bun run scripts/sync-version.ts --check`.

Every unit carries a byte-identical assertion: with its new field, flag, or config key absent, the affected output must equal the previous release's output exactly.

## Tasks

### Task 1: Degradation notice seam
- **Files**: `src/core/integrity/degradation.ts` (new), `tests/core/integrity/degradation.test.ts` (new)
- **What**: the notice record (`code`, `site`, `path?`, `detail`), a closed `DegradationCode` union, and the emit helper. Codes are added deliberately per consuming unit; an unhandled code must be a type error at the consumer, not a runtime string.
- **Acceptance**: the union is exhaustive-switchable; a notice renders to a single-line English string with the path when known; no natural-language classification anywhere in the module.
- **Depends on**: none

### Task 2: Frontmatter diagnostic channel
- **Files**: `src/core/vault.ts`, `tests/core/vault.test.ts`
- **What**: a sibling of `parseFrontmatterText` returning `[map, body, notices]`, where every line the `key: value` scanner drops and every unreadable read produces a notice. `parseFrontmatterText` and `parseFrontmatter` keep their exact current signatures and delegate, discarding notices.
- **Acceptance**: the existing tests at `tests/core/vault.test.ts:34-70` pass unchanged; a new test asserts that `-foo` (the case currently pinned as "silently ignored") produces exactly one notice naming the line; the block-list regression from commit 426d06f8 still parses and produces no notice.
- **Depends on**: Task 1

### Task 3: Frontmatter diagnostics surfaced
- **Files**: `src/core/search/indexer.ts`, `src/core/search/types.ts`, `src/core/brain/doctor.ts`, `src/cli/search.ts`, and the swallowing call sites: `src/core/brain/query.ts`, `context-pack.ts`, `heal-run.ts`, `source-cleanup.ts`, `claim-graph.ts`, `procedural-graph.ts`, `idea-discovery.ts`, `attention-flows.ts`, `src/core/vault.ts` (the `walk` catch), plus tests
- **What**: the index run reports per-file frontmatter notices through `IndexStats`; the doctor reports them through its `uncertain` extension point; each bare `catch { continue }` on a frontmatter read is replaced by a named notice plus the same control flow. Behaviour is unchanged - only the trace is new.
- **Acceptance**: a vault containing a note with an unsupported frontmatter grammar produces a named diagnostic in the index-run output and in `o2b brain doctor`, and the note still indexes; the doctor still never throws; a vault with no malformed frontmatter produces output byte-identical to before.
- **Depends on**: Task 2

### Task 4: Stamp-and-compare seam and the `integrity` config block
- **Files**: `src/core/integrity/stamp.ts` (new), `src/core/brain/types.ts`, `src/core/brain/policy.ts`, `src/core/brain/index.ts`, `tests/core/integrity/stamp.test.ts` (new), `tests/core/brain/policy-integrity.test.ts` (new)
- **What**: stamp comparison over a token map, a typed mismatch carrying field, expected, and actual, and the `off | warn | fail` gate resolution. The `integrity` block adds `owner_scope_delivery` (default `off`), `embedding_abi` (default `warn`), and `pack_validity_seconds` (positive integer). Follow the defaults-plus-resolver strategy, not parse-time merging, and register the keys in `warnUnknownKeys`.
- **Acceptance**: an invalid mode string and a non-positive `pack_validity_seconds` each raise `BrainConfigError` naming the dotted field; an absent block resolves to the documented defaults; a fully-known config emits no warnings (this is what `tests/core/brain.policy.test.ts:416` pins).
- **Depends on**: none

### Task 5: Shared preference collector, behaviour-preserving
- **Files**: `src/core/brain/preferences-collect.ts` (new), `src/core/brain/active.ts`, `context-pack.ts`, `pre-compress-pack.ts`, `morning-brief.ts`, `digest.ts`, plus tests
- **What**: one collector replacing the independent `readdirSync(dirs.preferences)` loops on the delivery path. No predicate yet - this task is a pure refactor whose only job is to prove the collector is a faithful replacement.
- **Acceptance**: every existing test over these five surfaces passes unchanged; the collector is the only `readdirSync` of the preferences directory on the delivery path.
- **Depends on**: none

### Task 6: Owner scope on preference-backed delivery surfaces
- **Files**: `src/core/brain/preferences-collect.ts`, `context-pack.ts` (owner on `ContextPackOptions`), `pre-compress-pack.ts`, `morning-brief.ts`, `digest.ts`, `active.ts`, `src/core/brain/anticipatory-cache.ts` (owner in the cache key), plus tests
- **What**: the owner predicate attaches to the collector, gated by `integrity.owner_scope_delivery`. The anticipatory cache path includes the scope, so a cache built under one scope can never be served under another.
- **Acceptance**: with the gate `off`, output is byte-identical to Task 5; with it `fail`, an owner-tagged preference is absent from every one of these surfaces for a different scope and present for its own; an ownerless preference is always visible; the cache file for scope A is a distinct path from scope B.
- **Depends on**: Task 4, Task 5

### Task 7: Owner scope on search-backed surfaces and the drill-down
- **Files**: `src/core/brain/file-recall.ts`, `src/core/brain/deep-synthesis.ts`, `src/cli/brain/verbs/sgrep.ts`, `src/cli/search.ts`, `src/core/search/cards.ts`, plus tests
- **What**: thread `agentScope` into the existing `SearchOptions` for each search-backed caller, add the `--agent-scope` flag beside `--visibility`, and give `expandHit` an owner check on the resolved path that returns the existing not-found error rather than a distinguishable refusal.
- **Acceptance**: a scoped call to each surface excludes another owner's page; an unscoped call is byte-identical; `expandHit` on another owner's chunk id is indistinguishable from a missing chunk.
- **Depends on**: Task 4

### Task 8: MCP scope arguments and the isolation regression matrix
- **Files**: `src/mcp/tool-contract.ts`, `src/mcp/brain/pack-tools.ts`, `brief-tools.ts`, `context-tools.ts`, `src/mcp/search-tools.ts`, `tests/mcp/agent-scope-matrix.test.ts` (new)
- **What**: an `agent_scope` argument on every content-returning tool that lacks one, an agent identity on `ServerContext` resolved through `resolveAgentName` for the no-argument `brain_context` surface, and a table-driven test asserting the rule once per surface.
- **Acceptance**: the matrix test enumerates every content-returning tool and fails if a new one is added without an entry; the MCP tool count stays 108; every tool that declares an `outputSchema` with `additionalProperties: false` is left untouched or has its schema extended deliberately.
- **Depends on**: Task 6, Task 7

### Task 9: Pack provenance stamp and validity window
- **Files**: `src/core/brain/context-pack.ts`, `src/core/brain/anticipatory-cache.ts`, `src/mcp/brain/pack-tools.ts`, plus tests
- **What**: a stamp pairing `corpusGeneration()` with a Brain-tree digest over path, mtime, and size for the directories the pack walks, plus an expiry from `integrity.pack_validity_seconds`. The anticipatory cache stores both and rejects a mismatch or an expiry as a miss; its schema version bumps so pre-existing files read as misses.
- **Acceptance**: editing a Brain note invalidates a warm cache entry; an expired entry is refused rather than served; a rebuilt entry is served; the refusal names the reason; with the cache absent, `brain_context_pack` output is byte-identical.
- **Depends on**: Task 4

### Task 10: Embedding ABI stamp and read-path comparison
- **Files**: `src/core/search/store.ts`, `src/core/search/indexer.ts`, `src/core/search/types.ts`, `src/cli/search.ts`, plus tests
- **What**: capture the already-executed `vec_version()` result and stamp it into `index_state` beside `embedding_model` and `embedding_dimension`, with the same delete-on-change semantics. Compare all three on the read-mode open, gated by `integrity.embedding_abi`. Add the field to `IndexCheckReport`, its JSON projection, its human renderer, and a recommendation branch. Do not route into `openReadOrSelfHeal` - that path rebuilds keyword-only and would not touch the vectors.
- **Acceptance**: a store whose recorded dimension differs from the configured one produces a named error on a read-mode open under `fail` and a named warning under `warn`; a legacy store with no recorded `vec_version` warns once rather than erroring; `o2b search check` reports the mismatch with a copy-pasteable fix; a matching store produces byte-identical output.
- **Depends on**: Task 4

### Task 11: Fail-closed session continuation
- **Files**: `src/core/brain/lineage/crutch.ts`, `resolve.ts`, `types.ts`, `ledger.ts`, `src/core/brain/session-lifecycle.ts`, `src/core/brain/git/reader.ts`, `src/core/redactor.ts`, plus tests
- **What**: the crutch resolver returns a discriminated outcome (`linked` or an abstention naming `no-candidate`, `self-known`, `no-workspace`, `ambiguous`, `stale`, or `evidence-missing`) instead of a bare `null`. Two surviving candidates abstain. Repo, branch, and commit are captured onto the lineage observation through the existing hardened `runGit` argv pattern, with a bounded timeout, and become required-match predicates. A pure canonicalizer normalizes a git remote to `scheme://host/org/repo` with userinfo, port, `.git`, and trailing slash removed - a comparable identity, distinct from the redactor's placeholder rewrite.
- **Acceptance**: two concurrent sessions in one directory inside the window both abstain with `ambiguous` where today one is stitched; a session in a different branch or commit does not link; the abstention reason reaches the caller; a remote carrying credentials canonicalizes to the same identity as the same remote cloned without them, and the credential never appears in any recorded field; the git probe cannot exceed its timeout budget; all lineage capture stays fail-soft and never throws into the hook.
- **Depends on**: Task 1

### Task 12: Lineage ledger integrity
- **Files**: `src/core/brain/lineage/ledger.ts`, `src/core/brain/lineage/verify.ts` (new), `src/core/brain/doctor.ts`, plus tests
- **What**: sequence numbers and a hash chain over the canonical line, a synchronous writer lock around the read-modify-write following the continuity-store precedent, lossless compaction that retains recent lines verbatim instead of folding one summary line per session, and a verification function whose findings reach the doctor. The read path stays fail-soft and the verification never refuses to start. A dropped observation caused by lock contention is recorded as a named gap rather than vanishing.
- **Acceptance**: compaction preserves `firstSeenMs`, per-session event history, and any field the writer emits; a tampered line is reported by verification with its sequence number and does not prevent resolution; two concurrent writers crossing the cap both land their observations or the loser is recorded as a named gap; `readLineageLedger` still returns an empty map rather than throwing on a corrupt file.
- **Depends on**: Task 1, Task 11

### Task 13: Broken-link ratchet
- **Files**: `src/core/search/link-ratchet.ts` (new), `src/core/search/store.ts`, `scripts/link-ratchet.ts` (new), `link-ratchet.json` (new), `package.json`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `src/mcp/brain/hygiene-tools.ts`, plus tests
- **What**: a deterministic vault-wide broken-link count, taken only after a full resolution pass. ~~Using the SQL definition (`target_document_id IS NULL AND target_path IS NOT NULL`).~~ Corrected after measurement: the count is the link rows the read-time resolution ladder leaves unresolved, sharing that ladder's SQL with `resolvedDocLinkPairs` rather than reimplementing it. A committed ceiling file at the repository root carrying `schema_version`, the count, and the definition token. The script mirrors `scripts/sync-version.ts` exactly: one code path, `--check` disabling writes, exit 1 on a rise, a named fix command on failure, and `link-ratchet` / `link-ratchet:check` npm scripts wired into both workflows. `brain_hygiene` gains an additive top-level key.
- **Acceptance**: two runs over an unchanged vault produce the same count; a new broken link fails `--check` with exit 1 and names the fix; fixing links and rerunning the write form lowers the ceiling; the detection code path is provably identical between the write and check forms; `brain_hygiene`'s existing keys are unchanged and its detector enum is untouched.
- **Depends on**: none

### Task 14: Injection meter, session receipt fold, and vault identity guard
- **Files**: `hooks/active-inject.ts`, `src/core/brain/context-receipts.ts`, `src/core/brain/observed-use.ts`, `src/mcp/brain/pack-tools.ts`, `src/core/brain/vault-identity.ts` (new), `src/core/brain/paths.ts`, `src/core/brain/init.ts`, `src/core/brain/doctor.ts`, `src/core/brain/portability/profiles.ts`, `src/mcp/brain/entity-tools.ts`, plus tests
- **What**: three small units sharing no code but each too small to carry a commit alone if split further - keep them as three separate commits.
  - **H**: measure bytes and tokens per source (notices, active body, lessons body) where the sub-bodies are still separate strings, take the measurement after the fail-open loader returns so it reflects what is emitted, record the loader source and the hook event name, and emit through the receipt surface with a widened trigger. The whole meter sits inside its own try/catch and cannot extend the hook's process ceiling.
  - **I**: a session-scoped fold over existing `context_receipt` records - receipt count, total items, distinct items, per-item injection frequency and token cost - plus a session filter on the observed-reuse fold, exposed as a `summary` operation on `brain_context_receipts`. Bound the scan the way the token-impact summary already does. A vault with no receipts reports "no receipts recorded", never zeros presented as a finding.
  - **J**: a vault identity marker written by the bootstrap path, an assertion on the write path hanging off the function every Brain writer funnels through, an `isDirectory` check in profile switching, and removal of the doctor early return that reports a `Brain`-less root as clean.
- **Acceptance**: **H** - the meter records one record per injection with per-source attribution, a hook failure in the meter never changes the hook's exit code or its emitted context, and PostCompact records are distinguishable from SessionStart ones. **I** - the fold matches a hand-computed expectation over a seeded set of receipts, redacted payloads are not resurrected, and the MCP tool count stays 108. **J** - a marker mismatch refuses the write with a named error, an absent marker warns rather than refusing, `o2b brain init` still bootstraps a fresh vault without tripping the guard, switching to a profile pointing at a non-existent directory fails at switch time rather than in a later process, and the doctor reports a `Brain`-less root as a named condition instead of `clean`.
- **Depends on**: Task 1, Task 4
