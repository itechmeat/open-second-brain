# P4 silent-failure hardening - implementation plan

Nine TDD tasks in five file-disjoint lanes. Tasks inside one lane share files and run as an explicit
sequence in the order given; lanes are independent of each other and can be implemented in any order
between lanes. Every task starts with the named failing test, implements until it passes, refactors,
runs the formatter and linter, and lands exactly one atomic conventional commit.

Shared-file sequences:
- Redactor lane: Task 1 then Task 2 (both edit `src/core/redactor.ts`).
- Write lane: Task 3 then Task 6 (both edit `src/core/brain/write-batch.ts`).
- Ingest lane: Task 4 then Task 5 (both edit `src/core/brain/ingest/batch-plan.ts`,
  `src/mcp/brain/ingest-tools.ts`, `src/cli/brain/verbs/batch-plan.ts`).
- Doctor lane: Task 8 then Task 9 (both edit `src/core/brain/doctor.ts`; Task 9 also adds the
  `fix` field Task 8's issue shape documents).
- Standalone lane: Task 7 (no shared files with any other task).

## Tasks

### Task 1: Redaction wire formats - slash-password URLs and bare JWTs
- **Files**: src/core/redactor.ts, tests/core/redactor.test.ts
- **Failing test first**: in tests/core/redactor.test.ts - (a) a URL whose password contains `/`
  (`postgres://admin:s3cr3t/Tr4p@db.internal:5432/prod`) has both user and password redacted under
  default options and under `redactUrlCredentials: true`, keeping the scheme and host; (b) a bare
  three-segment JWT (`eyJ...hdr.eyJ...pld.sig`) is redacted under default options; (c) a
  Bearer-prefixed token stays redacted exactly as today (regression guard); (d) the slash-free control
  URL redacts as before.
- **Module**: src/core/redactor.ts - widen the `BASIC_AUTH_URL_RE` password class to `[^\s@]+` keeping
  the scheme and `@` anchors and bounded repetition; add a default-on three-segment base64url JWT
  detector pass in `scanRawOutput` next to the `BEARER_RE` pass. Preserve the existing pass order
  (bare-token pass before the URL-credential pass).
- **Acceptance**: the new tests pass; the existing redactor suites (redactor-base64-secret,
  redactor-scan-window, redactor-yaml-structure) stay green; continuity and egress-guard caller tests
  that pinned verbatim leakage are updated in the same commit.
- **Depends on**: none
- **Commit**: `fix(redaction): close the slash-password and bare JWT gaps in egress redaction`

### Task 2: Structured redaction - sibling {name, value} secret pairs
- **Files**: src/core/redactor.ts, tests/core/redactor-scan-window.test.ts
- **Failing test first**: in tests/core/redactor-scan-window.test.ts -
  `redactStructured({environment: [{name: "DB_PASSWORD", value: "hunter2s3cret"}]})` returns the value
  redacted with `redacted: true`, also under `redactTokens: true`; a `{name, value}` element whose name
  is not a secret key passes through; an ECS `valueFrom` ARN reference passes through untouched;
  non-object array elements are unaffected.
- **Module**: src/core/redactor.ts - in the walk() array branch (:1033-1037), inspect plain-object
  elements for a `{name, value}` shape and reuse `isSecretKeyName` (:162) on the sibling `name` when
  walking the value. No new secret-name vocabulary.
- **Acceptance**: the new tests pass; export-identifier-integrity tests stay green.
- **Depends on**: Task 1 (shared file src/core/redactor.ts, strict sequence)
- **Commit**: `fix(redaction): redact sibling name-value secret pairs in the structured walk`

### Task 3: Write receipt - non-blocking absolute-path advisory
- **Files**: src/core/brain/write-path-advisory.ts (new), src/core/brain/write-batch.ts,
  src/mcp/brain/notes-tools.ts, src/mcp/brain/write-batch-tools.ts,
  tests/core/brain/write-path-advisory.test.ts (new), tests/mcp/brain-write-batch.test.ts
- **Failing test first**: (a) new tests/core/brain/write-path-advisory.test.ts - the advisory scans
  authored note content and returns vault-relative page, line number and detector for a body containing
  `/home/alice/notes/x.md`, honors the `hygiene:allow-path` marker, and reports nothing for a clean
  body; (b) tests/mcp/brain-write-batch.test.ts - an update writing a body with an absolute home path
  yields a receipt carrying the advisory field, the batch still applies (non-blocking), and a clean
  write carries no advisory key at all (byte-identical-when-absent).
- **Module**: the advisory wraps `scanText` from src/core/hygiene/hardcoded-paths.ts; the write-batch
  projection computes it over authored note content only (create, update, append; log-line ops skip)
  and carries it as an optional field on the write result; the two MCP tools pass the field through on
  their receipts. Never a `WriteBatchError`; findings echo identifiers and integers, never absolute
  paths.
- **Acceptance**: the new tests pass; existing write-batch and notes-tools tests stay green.
- **Depends on**: none (first task of the write lane)
- **Commit**: `feat(write): advise absolute paths on the note write receipt`

### Task 4: Ingest lane - typed skip taxonomy and per-reason counts
- **Files**: src/core/brain/ingest/extractable-gate.ts, src/core/brain/ingest/batch-plan.ts,
  src/mcp/brain/ingest-tools.ts, src/cli/brain/verbs/batch-plan.ts,
  tests/core/brain/ingest/extractable-gate.test.ts, tests/core/brain/ingest/batch-plan.test.ts
- **Failing test first**: (a) extractable-gate.test.ts - a skipped page carries a typed reason token
  from a closed membership list plus a `detail` holding the schema_type value;
  `isSkippedPageReason` accepts the token and the legacy sentence and rejects an unknown string;
  (b) batch-plan.test.ts - the plan exposes per-reason counts and `serializeBatchPlan` emits them only
  when non-empty (byte-identical-when-absent for a plan with no skips).
- **Module**: extractable-gate.ts types `SkippedPage.reason` following the `PAGE_LINT_SKIP_REASON`
  pattern (token const, membership list, narrowing parser, checkable detail); batch-plan.ts aggregates
  skips per reason; ingest-tools.ts serializes; the CLI verb renders the counts. The discovered set,
  filter chain and `planId` are untouched.
- **Acceptance**: the new tests pass; the wire tests in tests/mcp/ingest-tool-ignore-warnings.test.ts
  are updated for the typed reason in the same commit.
- **Depends on**: none (first task of the ingest lane)
- **Commit**: `feat(ingest): type the skip reasons and count them per reason`

### Task 5: Ingest lane - unclassifiable-file counts
- **Files**: src/core/brain/ingest/batch-plan.ts, src/mcp/brain/ingest-tools.ts,
  src/cli/brain/verbs/batch-plan.ts, tests/core/brain/ingest/batch-plan.test.ts
- **Failing test first**: a vault containing a `.png` and a `.csv` beside ingestible pages yields a
  plan whose unclassifiable aggregate reports the total 2 and per-extension counts
  `{".png": 1, ".csv": 1}`; a vault with none carries no such key on the wire; `planId` is unchanged by
  the counting; the CLI render shows the counts.
- **Module**: `collectIngestible` (:502-522) counts files dropped for a non-ingestible extension
  (hidden-dot entries and ignore-rule matches are not counted; `DEFAULT_SKIP_DIRS`/`DEFAULT_SKIP_FILES`
  noise stays out); `WalkContext` carries the counters; `BatchPlan` exposes the aggregate and
  `serializeBatchPlan` emits it once for both surfaces. No new preview, no new `DEGRADATION_CODE` in
  this task, no change to the generic vault walks in src/core/vault.ts.
- **Acceptance**: the new tests pass; the scoping and git-discovery batch-plan suites stay green.
- **Depends on**: Task 4 (shared ingest-lane files, strict sequence)
- **Commit**: `feat(ingest): count unclassifiable files dropped by extension`

### Task 6: mtime stability - skipIfUnchanged at the two chokepoints
- **Files**: src/core/brain/write-batch.ts, src/core/vault.ts, tests/mcp/brain-write-batch.test.ts,
  tests/core/vault.test.ts
- **Failing test first**: (a) tests/mcp/brain-write-batch.test.ts - re-applying a byte-identical update
  leaves the note's mtime unchanged, reports `updated: false`, and records no new before-image and no
  new note-write record; a real change still bumps mtime and reports `updated: true`; an append with a
  fresh body reports `appended: true`; (b) tests/core/vault.test.ts - calling
  `writeFrontmatterAtomic` with overwrite on identical content leaves mtime unchanged, and a changed
  content still rewrites.
- **Module**: `commitNoteRewrite` (:584-602) passes `skipIfUnchanged: true` to `atomicWriteFileSync`,
  branches on the returned boolean to skip `storeBeforeImage` (:593) and `recordNoteWrite` (:595); the
  update commit (:535) reports `updated: <wrote>` and the append commit (:569) `appended: <wrote>`.
  The `writeFrontmatterAtomic` overwrite branch (:475-479) opts in and returns the boolean additively;
  exclusive-create branches are untouched; no fs-atomic default flip.
- **Acceptance**: the new tests pass; the fs-atomic primitive suite (tests/core/fs-atomic.test.ts) is
  untouched and green; audit-chain and active-note tests stay green.
- **Depends on**: Task 3 (shared file src/core/brain/write-batch.ts, strict sequence)
- **Commit**: `fix(write): stop phantom mtime bumps on byte-identical rewrites`

### Task 7: Journal mode - remoteness axis, skip WAL and warn on remote backing
- **Files**: src/core/vault-backing.ts, src/core/search/store/lifecycle.ts,
  tests/core/vault-backing.test.ts, tests/core/search/store-remoteness.test.ts (new),
  tests/core/architecture/verdict-vocabulary-census.test.ts
- **Failing test first**: (a) vault-backing.test.ts - the probe classifies nfs (`0x6969`) and cifs
  (`0xff534d42`) backing as remote on the new axis; fuse, ext4, tmpfs classify non-remote;
  probe-unsupported and fs-type-unknown stay silent and non-remote; (b) new
  tests/core/search/store-remoteness.test.ts - with an injected remote-classifying probe,
  `openWriteDatabase` opens with journal mode DELETE (read back via `PRAGMA journal_mode`), emits one
  stderr warning naming the filesystem, and the vault data is untouched; with the default local
  classification the journal mode stays WAL; (c) the census test fails until the new classification
  vocabulary is registered.
- **Module**: vault-backing.ts gains the remoteness axis beside durability (named network magics
  remote; fuse non-remote with the rationale documented; unknown/probe-unsupported silent);
  `applyPragmas` (:51-60) takes the journal-mode decision from the probe result - a pure decision
  function plus an optional injectable statfs probe parameter on the write-open path are the test seam.
  No refusal, no env gate, no change to the maintenance lease database.
- **Acceptance**: the new tests pass; the existing vault-backing and store-integrity suites stay green.
- **Depends on**: none (standalone lane)
- **Commit**: `fix(search): keep WAL off remote-backed index files and say so`

### Task 8: Brain doctor - embeddings-health check
- **Files**: src/core/brain/doctor/embeddings-health-check.ts (new), src/core/brain/doctor.ts,
  src/core/brain/diagnostics.ts, tests/core/brain/doctor/embeddings-health-check.test.ts (new),
  tests/core/brain/doctor-exit-census.test.ts
- **Failing test first**: in the new embeddings-health-check.test.ts - a healthy embedded index emits
  no issue; a census with pending or stale embeddings emits a warning whose message embeds
  `o2b search vector-backfill` and `o2b search check`; an unrecorded census emits to the uncertain
  stream and never reports a failed read as healthy; a throwing probe degrades to uncertain without
  failing the doctor run (failSoft); the exit-census test fails until the code is registered.
- **Module**: the check reads `readPendingVectorCensus` (indexer.ts:1706) and the index-count surface
  (:1280/:1406), uses `ctx.now`, and is shaped on `embeddingSunsetCheck` (:261); register in
  `DOCTOR_CHECKS` (doctor.ts:139) and add the code to the diagnostics registry. Strictly read-only.
- **Acceptance**: the new tests pass; doctor-drift and doctor-exit-census stay green.
- **Depends on**: none (first task of the doctor lane)
- **Commit**: `feat(doctor): consolidate embeddings health into the brain doctor`

### Task 9: Orphan observations - session_ref check and repair verb
- **Files**: src/core/brain/doctor/orphan-session-check.ts (new), src/core/brain/link-graph/orphan-repair.ts (new),
  src/cli/brain/verbs/orphan-repair.ts (new), src/core/brain/doctor.ts, src/core/brain/types.ts,
  tests/core/brain/doctor/orphan-session-check.test.ts (new), tests/core/brain/link-graph/orphan-repair.test.ts (new),
  tests/cli/brain-orphan-repair.test.ts (new), tests/core/brain/doctor-exit-census.test.ts
- **Failing test first**: (a) orphan-session-check.test.ts - an observation signal whose `session_ref`
  resolves to no session or continuity record emits a warning issue carrying the new optional `fix`
  field with the exact repair command; a resolvable `session_ref` emits nothing; an unreadable signals
  subtree goes to the uncertain stream; (b) orphan-repair.test.ts - dry-run default writes nothing and
  lists the detach actions; apply requires the exact confirm phrase; a run stops at the hard write cap;
  a rescan after apply is idempotent; (c) the CLI test proves `runDoctor` never repairs and the verb
  never runs from the doctor.
- **Module**: the check parses signals with `parseSignal` (signal.ts:683) and resolves `session_ref`
  (signal.ts:134/:479) against the sessions/continuity store, shaped on `danglingWorkrunCheck`
  (store-integrity.ts:62); `DoctorIssue` gains an optional additive `fix` field (mirroring the general
  doctor's `CheckResult.fix` at src/core/types.ts:27), byte-identical-when-absent; the repair module
  reuses the repair-lane discipline (REPAIR_CONFIRM_PHRASE-style exact phrase, hard per-run write cap,
  idempotent rescan, vault-identity assert, atomic frontmatter writes) and the repair action detaches
  the dangling reference from the signal frontmatter, keeping the observation content.
- **Acceptance**: the new tests pass; doctor-exit-census, doctor-drift and the repair-lane suites stay
  green with the new codes registered.
- **Depends on**: Task 8 (shared file src/core/brain/doctor.ts and the `fix` field Task 8 documents,
  strict sequence)
- **Commit**: `feat(brain): detect and repair orphaned session references on observations`
