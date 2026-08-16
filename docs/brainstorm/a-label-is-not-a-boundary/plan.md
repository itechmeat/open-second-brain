# A label is not a boundary - implementation plan

Twelve units carrying ten tracker items. Each unit is one atomic commit or a
short sequence of them, test-first. Units marked **independent** may run in
parallel; the rest name what they depend on. Every acceptance line is a test
that fails before the change and passes after; a claim without a failing test
first is not accepted.

This plan was revised after a spec review that verified every number and path
against the source at `f02c1fd3`. Seven acceptance lines were unachievable as
first written and are corrected here; nine file paths were wrong and are
corrected here. Where a line says "fails today", the review confirmed it.

## Standing rules for every unit

From the operator and from this repository:

- No fallback that quietly does nothing. An error is shown explicitly, with the
  information that diagnoses it. A bare `catch { continue }` or
  `catch { return "failed" }` destroys the diagnosis and is forbidden.
- No stubs, no placeholders, no half-wired features.
- Maximally native: extend the registry, census or vocabulary that already owns
  the class. No parallel idiom, no second registry.
- A new closed vocabulary ships all four pieces in one module - frozen object,
  derived union type, members array, type guard whose parameter is `unknown` -
  and is registered in `CENSUS` in
  `tests/core/architecture/verdict-vocabulary-census.test.ts`. There is no
  exemption list.
- Any options type accepting a `Safeguard` also accepts `onProgress?:
  ProgressSink`; every `progressCounter(` site is registered in the emitter
  census with a drivable entry point.
- Anything extractable becomes a named constant. No natural-language word lists
  in any language.
- Defects noticed in passing are fixed in the same unit, not deferred.
- Format and lint are green before every commit. Commit with the pathspec form
  `git commit --only <paths>` so another agent's staged work is never swept in.
  Never `git commit --amend` - another agent may own the tip.

### Shared files, and how to not lose another agent's work

Several units edit the same three test files. Every unit works in ONE shared
working tree, so there is no merge conflict to resolve - there is only the
hazard of a stale overwrite. Rules:

- Never `Write` a file another unit also edits. Re-read it immediately before
  each change and use `Edit` against a unique anchor.
- `tests/core/architecture/verdict-vocabulary-census.test.ts` - U2, U5, U6, U9
  all append to `CENSUS` or edit the masker. Append at the end of the array,
  one entry per unit.
- `tests/mcp/agent-scope-matrix.test.ts` - U2 changes behaviour the fixture
  asserts, U3 rewrites the bucket shape. U3 depends on U2 for this reason.
- `src/core/brain/portability/okf.ts`, `src/core/redactor.ts` - U8 only.

## Tasks

### U1: Ownership is written, or it is not a boundary
- **Tracker**: t_b18551b1
- **Verdict**: ENFORCE
- **Files**: `src/core/brain/preference.ts`; `src/mcp/brain/feedback-tools.ts`;
  `src/cli/brain/verbs/feedback.ts`; `src/core/brain/derived-fact.ts`;
  `src/core/brain/merge.ts`; `src/core/brain/preference-txn.ts`;
  `src/core/graph/agent-scope.ts`
- **Acceptance**:
  - With `integrity.owner_scope_delivery` enabled, a preference written through
    each of the five production writers carries `owner:` equal to the
    server-resolved agent identity. A test drives all five and fails today on
    all five, because `writePreference` emits the field only when a caller
    supplies it (`preference.ts:446,553`) and no production caller does.
  - No new config key. Owner stamping is conditioned on the existing
    `integrity.owner_scope_delivery` gate, which is already templated and
    already commented (`config-template.ts:410`); a test pins that
    `brainConfigKnownKeys()` gained no entry.
  - With the gate off, a vault written by a fixture script under a pinned clock
    and pinned vault id has `digestVaultTree` equal to a second vault written by
    the same script with owner stamping forced off, and `changedPaths` between
    them is empty. Additionally, no file under `Brain/preferences/` contains an
    `owner:` line. (`vault-digest.ts` hashes trees in one process and cannot
    reach another branch, so the comparison is between two vaults here, not
    against `main`.)
  - `isOwnerVisible` returning false is ALREADY exercised at
    `tests/mcp/agent-scope-matrix.test.ts:228-234,367-374` using a hand-supplied
    `owner`. The new assertion is that the same withholding occurs on a vault
    written entirely through production surfaces, with no test-only owner
    argument anywhere in the fixture.
- **Depends on**: none (**independent**)

### U2: Identity is resolved, never echoed
- **Tracker**: t_b18551b1, t_3ebb6e0e
- **Verdict**: ENFORCE
- **Files**: `src/mcp/coerce.ts`; `src/core/brain/preferences-collect.ts`;
  `src/core/agent-identity.ts`; a new refusal vocabulary module;
  `tests/core/architecture/verdict-vocabulary-census.test.ts` registration;
  `tests/mcp/agent-scope-matrix.test.ts`
- **Acceptance**:
  - With `integrity.owner_scope_delivery` set to fail, a caller supplying an
    `agent_scope` naming an owner other than the server-resolved identity
    receives a typed refusal naming the conflict. The test proves the old
    behaviour first: today `coerceAgentScope` (`coerce.ts:120-121`) returns the
    argument unconditionally and `resolveOwnerScopeDelivery`
    (`preferences-collect.ts:182`) enforces the requested scope, so the caller
    receives that owner's private preferences.
  - A caller supplying no scope, and a caller supplying its own identity, are
    unaffected; both asserted.
  - With the gate off, behaviour is unchanged; a test pins that.
  - The refusal vocabulary passes the four-piece census with its guard typed
    `unknown`, registered in `CENSUS`.
  - The tools that stamp a caller-supplied `agent` verbatim are enumerated
    STRUCTURALLY from `buildToolTable`, never hand-written - a hand-written list
    is the exact defect this release is about. The test asserts the count and
    fails when a tool joins or leaves the set.
  - `agent-scope-matrix.test.ts:447-456` drives `brain_retrieval_plan` with a
    foreign `agent_scope` under a failing gate; that call now refuses, and the
    fixture is updated with the reason written in.
- **Depends on**: none (**independent**)

### U3: The scope matrix asserts correctness, not partition
- **Tracker**: t_b18551b1
- **Verdict**: ENFORCE
- **Files**: `tests/mcp/agent-scope-matrix.test.ts`;
  `src/core/search/store/links.ts`; `src/core/brain/backlinks.ts`;
  `src/core/brain/notes/scaffold-stub.ts`;
  `src/core/brain/link-graph/moc-audit.ts`;
  `src/core/brain/link-graph/unlinked-mentions.ts`;
  `src/mcp/brain/hygiene-tools.ts`
- **Acceptance**:
  - The unasserted bucket becomes `{name, args, reason}[]`: every entry carries
    the arguments that drive it and a written reason for its classification. The
    classification test at `:299-311`, which spreads the buckets as strings, is
    updated with it.
  - One two-owner fixture drives every entry and asserts no cross-owner marker
    appears in the response. The test fails today naming the ten tools listed in
    `recon/owner-scope-isolation.md` section C6. After the change all ten return
    no cross-owner marker; any ADDITIONAL leak the probe surfaces is either
    fixed or moved to `UNSCOPED_CONTENT` with a reason of the length and
    specificity the existing entries carry.
  - `listDanglingTargets` takes an optional owner scope and drops whole targets,
    not only sources; `buildBacklinkIndex` takes an optional second parameter
    and its nine call sites still compile untouched.
  - Adding a tool to the matrix without arguments fails the build; a test proves
    it, so the bucket cannot regrow as a bare name list.
  - `buildBacklinkIndex`'s `catch { continue; }` (`backlinks.ts:193-195`), which
    returns a confident `count: 0` on legacy frontmatter, reports the failure
    instead. A test drives a legacy-frontmatter preference and asserts the
    report.
  - The probe needs the `{ force: true }` index precondition
    (`notes/scaffold-stub.ts:172-180`) and pins `HOME` per file; nothing pins it
    globally.
- **Depends on**: U1 (needs a vault where ownership exists), U2 (same fixture
  file, and U2 changes what a gated call returns)

### U4: Four thresholds against a pinned number
- **Tracker**: t_eb94ac35
- **Verdict**: RE-MEASURE
- **Files**: `src/core/brain/recall-inject.ts`; `src/core/search/coverage.ts`;
  `src/core/brain/recall-adequacy.ts`; `src/core/brain/gaps/gap-loop.ts`;
  `src/core/bench/failure-modes.ts`; `src/core/search/ranker.ts`;
  `src/core/search/pipeline/assemble.ts`;
  `src/core/brain/page-meta/tier.ts`; `src/core/search/cross-vault.ts`
- **Acceptance**:
  - The recall floor is evaluated against IDF-weighted coverage
    (`src/core/search/coverage.ts:162-187`), which is absolute and
    pool-independent. A test drives a deliberately weak match through the
    shipped retriever and gets `below_floor`; a strong match does not. Both fail
    today.
  - No search score moves: the ranker's ordered `(path, score)` list over the
    committed fixture corpus is unchanged, pinned as a literal expectation and
    compared before and after within the same commit.
  - Through `brain_recall_gate` and `brain_context_pack` on a default
    keyword-only vault, a deliberately weak match yields `weak` and a no-match
    yields `insufficient`. Today both yield `sufficient`, because
    `DEFAULT_RECALL_ADEQUACY_THRESHOLDS.sufficient` (0.6) equals the shipped
    `keywordWeight` (0.6) and `normalizeBm25` pins the top row at 1. The
    end-to-end test is the failing one; the pure function is already covered at
    `tests/core/brain/recall-adequacy.test.ts` and must stay green.
  - The gap-loop auto-close floor rejects a low-quality hit; a test drives it.
  - The `0.65` at `src/core/bench/failure-modes.ts:40` is corrected to the real
    `keywordWeight` (`src/core/search/index.ts:154`), and a test ties the stated
    number to the constant so it cannot drift again.
  - The tier producer is wired, not retracted: `page-meta/tier.ts:38-45`
    documents `tier` as a multiplicative ranker weight and `:8-9` justifies the
    default by ranker bit-identity, so the label has a subject and the plumbing
    is the missing half. `collectCandidateSignals` gains a tier collector and
    `rankCandidates` (`pipeline/assemble.ts:390-441`) passes `tierByDoc`. Blast
    radius is measured as the score delta on a tier-tagged fixture; the untagged
    fixture corpus cannot move because `supporting` is 1.0.
  - `search_chain_stop_score` (`cross-vault.ts:200`) means opposite things under
    the two fusion modes - unreachable in one, always met in the other. It is
    resolved in this unit, and the commit message states which way and why.
  - If `idfWeightedCoverage` is surfaced on the search outcome, every MCP tool
    with a declared `outputSchema` is validated at request time
    (`server.ts:466`); the new field must satisfy those contracts.
    `recall_adequacy_sufficient` and siblings (`src/core/config.ts:850-868`) are
    operator-facing and change meaning, so `docs/cli-reference.md` is updated.
- **Depends on**: none (**independent**)

### U5: The write-only sink gets a reader
- **Tracker**: t_a160764a, t_77efc212
- **Verdict**: ENFORCE
- **Files**: `src/core/brain/portability/origins.ts`;
  `src/core/search/cross-vault.ts`; `src/core/brain/shared-namespace.ts`;
  `src/core/brain/agent-source/types.ts`, `query.ts`; `src/core/config.ts`;
  a new reachability vocabulary module; census registration
- **Acceptance**:
  - An unreachable origin is reported rather than dropped at
    `origins.ts:63`: a search across three origins with one unreachable returns
    a warning naming it. The `warnings` array at `cross-vault.ts:110` cannot be
    populated at all today because the information is destroyed one layer up.
  - The reachability verdict is a four-piece vocabulary distinguishing
    reachable, unreachable and unknown; a test proves unreachable and unknown
    are different values and neither reads as a zero contribution.
  - The shared namespace is enumerable as a read origin, and a test reads back a
    record written through the mirror carrying its `origin_vault` - the field's
    first reader anywhere in the repository.
  - `mirrorSignal` and `mirrorNote` (`shared-namespace.ts:52-54,80-83`) no
    longer discard the failure reason; a test drives a write failure and asserts
    the reason reaches the caller. `MirrorOutcome` stops conflating operator
    misconfiguration with I/O failure under one token, and becomes a four-piece
    vocabulary registered in `CENSUS` rather than a two-piece type alias outside
    the audited population.
  - `resolveAgentName`'s fallback to the literal `"agent"` (`config.ts:379`)
    merges every unconfigured install into one roster row that reads as a very
    busy agent. The fallback is made explicit: the roster reports an
    unconfigured identity as unconfigured rather than as a name.
  - The per-agent roster gains `last_activity`. The summary type declares
    exactly `contribution_count` and `last_activity`; a test asserts the
    returned key set equals that pair, so a third metric cannot be added without
    changing the assertion, and the docblock records that no open/closed unit of
    work exists in this product.
  - The tracker asked for a fleet surface. The surface already exists -
    `brain_agent_query` and `brain_agent_diff` - so no new tool is added; what
    was missing was the metrics and the honesty about the third. The unit
    records that reasoning in the test, and `AgentSourceSummary` gaining a field
    must satisfy `brain_agent_query`'s output contract.
- **Depends on**: none (**independent**)

### U6: The writer surface states its own name
- **Tracker**: t_f2ede668
- **Verdict**: ENFORCE
- **Files**: `src/mcp/instructions.ts`; `src/mcp/tool-contract.ts`;
  `src/mcp/tools.ts`; `src/cli/main.ts`; `src/core/identity-reminder.ts`;
  `src/mcp/http.ts`; `scripts/measure-token-surface.ts`; `tests/mcp/mcp.test.ts`
- **Acceptance**:
  - The writer and catalog instruction branches carry the identity line; a test
    asserts the resolved agent name appears on all three scopes and fails today
    on two, because `instructions.ts:110-111` returns before `agent` is read.
  - The declared-but-never-read `vault` option (`:26-27`) and the dead
    string-argument branch (`:105-107`) are removed; `tests/mcp/mcp.test.ts:792-793`
    and `scripts/measure-token-surface.ts:62-63` are updated with them, and the
    always-loaded token surface the script measures is re-measured and recorded.
  - `ToolScope`'s members, hand-copied into four places with nothing asserting
    agreement (`tool-contract.ts:19`, `tools.ts:378`, `cli/main.ts:629`,
    `cli/main.ts:762`), are promoted to the four-piece idiom and registered in
    `CENSUS`; the four sites derive from it.
  - `isRuntimeTarget` (`identity-reminder.ts:45`) takes `unknown`, as the idiom
    requires, not `string | undefined`.
  - `src/mcp/http.ts:166` stops advertising an `mcp-session-id` nothing reads:
    either it is read or it is not minted, and a test pins the choice.
- **Depends on**: none (**independent**)

### U7: The delegation boundary the host already delivers
- **Tracker**: t_0c6f31ee
- **Verdict**: ENFORCE
- **Files**: `hooks/hooks.json`; `hooks/README.md`;
  `hooks/lib/context-events.ts`; `src/core/brain/session-lifecycle.ts`;
  `src/core/brain/sessions/claude.ts`, `import.ts`, `registry.ts`;
  the session turn type; `docs/observability.md`
- **Acceptance**:
  - `SubagentStop` is registered - it is in the host's official event list and
    `hooks/hooks.json` registers seven events without it - and its payload is
    normalised. A test drives the hook with the captured payload shape.
  - `SessionTurn` carries the agent id and the sidechain flag. A committed
    fixture under `tests/fixtures/sessions/` holds a parent transcript plus a
    sidechain file with `isSidechain: true` and a distinct `agentId` under the
    same `sessionId`; the test asserts the parent turn count excludes the
    sidechain turns and that the flag is set. The count is whatever the
    committed fixture holds, pinned in the test.
  - `tool_response`, declared in the hook payload and dropped by
    `normalizePayload` (`session-lifecycle.ts:563-568`), is either carried or
    removed from the declaration; a test pins the choice, and if it is carried,
    the payload-safety rules in `docs/observability.md` are updated with it.
  - `--agent` on `o2b brain import-session` is honoured rather than validated
    and discarded (`import.ts:601-604`); the intentional-precedence docblock at
    `:597-600` changes with the behaviour, and `agentLabelForTurn`'s unused
    `turn` parameter becomes the seam that carries the sub-agent label.
  - Three of five session adapters stamp `claude`, `codex` and `hermes`, which
    `normalizeAgentArgument` rejects as non-identities everywhere else. The
    contradiction is resolved in this unit and a test asserts the two surfaces
    agree.
- **Depends on**: none (**independent**)

### U8: The eighth egress site
- **Tracker**: t_09a3752a, t_08f6ffca
- **Verdict**: ENFORCE
- **Files**: `src/cli/brain/verbs/explorer.ts`; `src/core/brain/explorer.ts`;
  `src/core/egress/registry.ts`; `src/core/egress/guard.ts`;
  `tests/core/architecture/egress-census.test.ts`; `src/core/redactor.ts`;
  `src/core/brain/export.ts`; `src/core/brain/portability/okf.ts`;
  `src/core/search/embeddings/openai-compat.ts`
- **Acceptance**:
  - `o2b brain explorer --export` calls `redactForEgress`. A test exports a
    vault containing a credential and asserts the redaction marker; today the
    credential appears verbatim while every other export path redacts it.
  - The egress census's file-destination derivation is widened so the flag that
    hid the eighth site cannot hide a ninth: `export` joins `DESTINATION_FLAGS`
    (`egress-census.test.ts:96-118`), and a synthetic destination flag proves
    the census fails until the site is declared.
  - The census gains a SECOND population rule for network destinations - a
    module POSTing vault-derived bytes to an operator-configured URL - because
    the existing derivation (`:164-171`) requires a file-destination parameter
    and a raw file write, so a network site cannot be declared under it without
    failing `:196-201`. `src/core/search/embeddings/openai-compat.ts` is
    declared under the new rule with a reason stating that chunk bodies leave
    unscanned. A synthetic network-destination module proves the rule fires.
  - Every new `EGRESS_SITES` entry satisfies `:204` (declared-as-redacting
    implies a `redactForEgress` call), `:217` (guard calls at least equal
    destination count) and `:241` (no entry understates its module).
  - `private: true` frontmatter is retracted as a privacy claim: the
    `<private>` region marker in `continuity/redaction.ts` is the product's only
    content-derived privacy primitive, nothing under `portability/` reads the
    frontmatter key, and the export composers are content composers rather than
    visibility filters. The registry reason strings state that the region marker
    is the only primitive, and a test asserts a `private: true` page exports in
    full, so the label cannot be re-read as a boundary.
  - The redactor no longer eats signal ids: a round trip exports and imports a
    preference whose `_evidenced_by` link survives, which fails today because
    `HIGH_ENTROPY_TOKEN_RE` (`src/core/redactor.ts:337-338`) consumes
    `sig-<date>-<slug>`. The carve-out follows the existing `CONTENT_ADDRESS_RE`
    precedent and its effect on `redactSecrets` in the CLI `--json` path
    (`json-helpers.ts:75-86`) is asserted by
    `tests/cli/cli-json-contract.test.ts`.
  - `export.ts:106-107,118-119` and `explorer.ts:105-108` no longer silently
    continue past a parse failure; a test drives a malformed preference and
    asserts a non-zero exit and a message naming the file. The new exit code
    lands in the terminal-state census, and `CliError` exits 1 under
    `o2b brain` (`src/cli/brain.ts:462-467`), not 2.
  - `okf.ts:334`'s date pattern matches only the legacy un-sharded log name
    while `log.ts:113-114` writes `<date>.<deviceId>.md`, so `log.md` is empty
    on every default install. A test exports a vault with one log day and
    asserts it is present.
- **Depends on**: none (**independent**)

### U9: One lexer, and the hole in the live one
- **Tracker**: t_1d4f932f
- **Verdict**: RE-MEASURE
- **Files**: `tests/helpers/source-lexer.ts` (new);
  `tests/helpers/source-lexer.test.ts` (new);
  `tests/core/architecture/destructive-site-census.test.ts`;
  `tests/core/architecture/progress-census.test.ts`;
  `tests/core/architecture/verdict-vocabulary-census.test.ts`;
  `tests/cli/progress-emitter-census.test.ts`;
  `tests/core/architecture/write-site-census.test.ts`;
  `tests/core/layering.test.ts`;
  `tests/core/brain/continuity/reader-census.test.ts`
- **Acceptance**:
  - One helper exports the two views, taken verbatim from the more general of
    the two byte-identical copies. Its own tests cover the regex literal
    containing a quote, the regex literal containing a backtick, the brace in a
    string, the brace in a comment, division mistaken for a regex opener, an
    escaped backslash before a quote, and a nested template interpolation. No
    helper in `tests/helpers/` has its own test today, so this establishes the
    convention.
  - The backtick newline-guard hole at
    `verdict-vocabulary-census.test.ts:1085` is closed. The positive control - a
    synthetic module carrying a complete four-piece vocabulary inside a region
    the live masker blanks - is found after the change and not before.
  - Populations are run before and after and compared: 10 safeguard-bearing
    options types, 57 `CENSUS` entries, 461 modules with 31 destructive sites,
    129 write-site rows with 64 direct, **8** emitter sites. No census loses a
    rule. (The task body says nine emitters; the census asserts set equality
    against eight, and the ninth is the declaration site itself.)
  - A test pins that the comment-stripped view preserves import specifiers.
    Routing that read through the other view drops the write-site census from 64
    rows to zero with an empty failure list, which is the false-clean signature
    these censuses exist to prevent.
  - Count floors become equalities where a floor hides a drifted reality:
    `verdict`'s `toBeGreaterThan(50)` against 57, and
    `MIN_DIRECT_STORE_READERS = 20` against 21.
  - `tests/core/layering.test.ts:39-42` decides "is a comment" from a line
    prefix, which both over- and under-matches; it routes through the helper,
    and its population is compared before and after like the others.
- **Depends on**: none (**independent**)

### U10: Retractions, stated with their evidence
- **Tracker**: t_09a3752a, t_08f6ffca, t_3ebb6e0e, t_77efc212, t_f2ede668
- **Verdict**: RETRACT
- **Files**: `docs/architecture.md`, `docs/observability.md`, `docs/mcp.md`,
  `CHANGELOG.md`, and the dead declarations U4, U6 and U8 identify
- **Acceptance**: each of the following is recorded with the measurement that
  justified it, and no retraction leaves a dangling reference (the link ratchet
  has zero headroom at 22/22 on `templates/brain-starter`):
  - The git-visibility ladder: no git transport exists and
    `src/core/egress/registry.ts:6-8` states there deliberately never will be;
    every `git` call under `src/` is read-only.
  - The staging copy and history purge: no history to purge, and the export
    bundle already is the staging copy.
  - The `off` identity mode: the bottom of the chain is already the literal
    `"agent"`, which is itself a placeholder, so `off` has no distinct subject.
  - The `passthrough` and `managed` mode vocabulary: passthrough is the shipped,
    ungated default across the tools that accept a caller-supplied `agent`, and
    U2 is what makes it gateable. The mode names are not adopted, and the reason
    is recorded rather than left implicit.
  - The per-agent instruction block: not reachable over either transport, and
    the config reader has no block-scalar form to declare one in.
  - The `shared` observation-scope member: a positive scope that no reader
    requests narrows visibility rather than widening it. U5 builds the first
    reader of a foreign origin, and the disposition records that a shared scope
    is reconsidered only once a reader requests one by name.
  - Whatever U8 resolves for `private:` frontmatter, and whatever U4 resolves
    for `search_chain_stop_score`.
- **Depends on**: U4, U6, U8

### U11: The contract honoured at three sites of forty-one
- **Tracker**: none - found during reconnaissance for t_b18551b1
- **Verdict**: ENFORCE
- **Files**: `src/mcp/tools.ts`; the ten `src/mcp/brain/*-tools.ts` modules that
  emit `vault_path`; a new census assertion
- **Acceptance**:
  - `src/mcp/tools.ts:94-119` states the contract for what a `vault_path` may
    contain; 41 sites emit the raw absolute host path and 3 honour it. A test
    enumerates the emitting sites structurally from source and asserts each
    honours the contract; it fails today naming 38.
  - The substitution is mechanical and changes no tool's schema.
  - This is the same shape as U3 - a rule with no enumeration behind it - on the
    same tool surface, which is why it ships here rather than as a follow-up.
- **Depends on**: none (**independent**)

### U12: The small ones, each with its own failing test
- **Tracker**: none - found during reconnaissance
- **Verdict**: ENFORCE
- **Files**: `src/mcp/brain/admin-tools.ts`; the `schema_inspect` handler;
  `src/core/brain/secrets/store.ts`; `src/core/time.ts`
- **Acceptance**:
  - `schema_inspect view=lint` and `view=orphans` currently die on the malformed
    artifact they exist to report, and the message carries an absolute host
    path. They report the artifact instead; a test drives a malformed artifact.
  - `brain_labels {operation:"show", id}` errors with "path must be a
    vault-relative string" for an argument named `id`; the mismatch is resolved
    and a test drives the documented call.
  - `secrets/store.ts:309-311` duplicates `time.ts`'s `isoSecond`; the duplicate
    is removed.
- **Depends on**: none (**independent**)

## Release-phase tasks

- Docs pass: `docs/observability.md` (session turn fields, and the three sites
  that still say twenty readers against a 21-entry reality),
  `docs/architecture.md` (owner scope, the egress registry and its second
  population rule), `docs/mcp.md` (the refusal and the instruction surface),
  `docs/cli-reference.md` (recall adequacy thresholds changing meaning, any new
  flag or exit code), `docs/how-it-works.md`, `README.md`.
- `CHANGELOG.md` entry under a new version heading plus its compare link.
- `package.json` version bump to 1.49.0 followed by
  `bun run scripts/sync-version.ts`, verified with `--check`.
- OpenClaw bundle rebuild if any bundled source changed; CI byte-diffs it.
