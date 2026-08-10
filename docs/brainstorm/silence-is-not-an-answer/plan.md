# Silence is not an answer - implementation plan

Ordering rule: the kernel lands first because two units persist what it produces.
After that, units are ordered so that every shared edit is made by the unit that
needs it first and merely consumed afterwards. Every task is one conventional
commit; formatter and linter are green before each commit, and the full check
suite is green before the next task starts.

Each task lists the defect fixes that belong to its blast radius. They are not
deferred to a cleanup commit: a defect found while reading a file is fixed while
that file is open.

## Tasks

### Task 0: Digest kernel and verdict census
- **Files**: new `src/core/integrity/digest.ts`; the ten modules carrying a
  byte-identical private SHA-256 helper; the two modules reimplementing canonical
  JSON serialization; new `tests/core/integrity/digest.test.ts`; new
  `tests/core/architecture/verdict-vocabulary-census.test.ts`.
- **Acceptance**: one exported hex-digest function and one canonical-JSON
  function with named truncation-length constants; every absorbed call site
  produces the identical digest it produced before, proved by a test that pins
  the hash of a fixed input; the census test passes over the vocabularies that
  exist today and fails when given a synthetic vocabulary missing its guard, its
  `Set`, or claiming a duplicate code.
- **Depends on**: none.

### Task 1: Schema-pack integrity tri-state (U1)
- **Files**: new `src/core/brain/schema-integrity.ts`; `schema-mutate.ts` (write
  the pack digest into the mutation audit, replace the audit-directory literal
  with a constant, add the digest to the apply result); `schema-admin.ts` (both
  read surfaces carry the status); `src/cli/brain/verbs/schema.ts` (report line);
  new `tests/core/brain/schema-integrity.test.ts`; extend
  `tests/core/brain/schema-mutate.test.ts` and `tests/mcp/schema-tools.test.ts`.
- **Acceptance**: apply then read gives `ok`; hand-editing the schema block gives
  `modified` with a populated mismatch on both sides; editing an unrelated comment
  in the same file still gives `ok`, because the digest is over the rendered block
  and not the raw file; a missing audit directory gives `unverified` with the
  no-apply-recorded reason and never `ok`; an unparseable audit shard gives
  `unverified` with the audit-unreadable reason; a deleted config file gives
  `unverified` with the config-absent reason.
- **Defects in scope**: the sync verb that reports success and does no work; the
  absent-config substitution that presents as a valid empty pack; the active-pack
  reader that reports a path it never checks.
- **Depends on**: Task 0.

### Task 2: Typed negative recall with a coverage receipt (U2)
- **Files**: new `src/core/brain/negative-recall.ts`; `src/mcp/search-tools.ts`
  (optional output block on the recall gate, computed only when the query yields
  no usable result); `src/core/brain/continuity/types.ts` (one new record kind);
  new `tests/core/brain/negative-recall.test.ts`; extend the recall-gate handler
  and telemetry tests.
- **Acceptance**: the receipt is deterministic over a fixed index snapshot and
  moves when the document count, chunk count or embedding signature moves;
  building a receipt over a non-existent index throws rather than returning a
  zero-count receipt; zero results over a healthy index give `not_found` with a
  receipt attached; no index gives `unknown` with the index-absent reason and no
  receipt; stale embeddings give `unknown` with the index-stale reason; a
  configured note root the index does not cover gives `unknown` with the
  coverage-divergent reason and names the root; asserting `did_not_happen` with
  no retraction evidence throws rather than being downgraded; a tombstoned or
  superseded claim gives `did_not_happen` with a receipt.
- **Depends on**: Task 0.

### Task 3: Reverse stale-dependency audit (U3)
- **Files**: new `src/core/brain/stale-dependency.ts` (collector) and new
  `src/core/brain/doctor/stale-dependency-check.ts` (pure join plus registry
  entry); `doctor.ts` registry; `diagnostics.ts` signal table; `wikilink.ts`
  gains the identifier-prefix helper and two call sites are repointed;
  `doctor/records.ts` gains the retired-record read; new
  `tests/core/brain/doctor/stale-dependency-check.test.ts`.
- **Acceptance**: a consumer written before a retirement is reported and one
  written after is not, on a strict comparison; a receipt naming the pre-retirement
  identifier joins the retired record through its alias; the bare, wikilink and
  path spellings of one subject fold to one row; a retired artifact citing another
  retired artifact is not reported; the retirement's own log entry and back-pointer
  do not self-flag; a vault with retired states and no receipts at all reports
  not-recorded with an empty row set, distinguishably from a clean result; an
  unreadable continuity directory leaves the other checks intact and surfaces an
  uncertainty entry naming the consequence; the per-state consumer cap reports the
  true total rather than a silent prefix.
- **Defects in scope**: the decision-receipt directory read that conflates
  unreadable with absent, and the duplicate-append it causes.
- **Depends on**: Task 0.

### Task 4: Code-index health exit and the shared cron recipe (U4)
- **Files**: new `src/cli/cron-recipe.ts` (kernel extracted from the search
  template); `src/cli/search-cron-template.ts` (re-exports every existing name and
  delegates); new `src/cli/partner-codegraph-cron.ts`; `src/cli/partner.ts` (new
  verb, new health-exit flag, both usage strings); `src/cli/command-manifest.ts`;
  `src/core/partner/codegraph.ts` (partner CLI vocabulary hoisted to one frozen
  constant); extend `tests/cli/search-cron-template.test.ts` with a pinned
  fixture; new `tests/cli/cron-recipe.test.ts` and
  `tests/cli/partner-codegraph-resync.test.ts`.
- **Acceptance**: the existing template's output is byte-identical to a pinned
  fixture after the extraction; the resync recipe emits the interval as cron, the
  recipe name, the scheduler recipe and the external indexer command; running the
  verb writes nothing anywhere, proved by comparing directory listings before and
  after; omitting the template flag exits with a usage error and does not run an
  indexer; the health flag exits non-zero when health is bad and the verb's
  default behaviour is unchanged without it; in the emitted script the
  wrong-root guard precedes the indexer invocation and the missing-parser branch
  exits non-zero.
- **Defects in scope**: the report verb that always exits zero; the five inline
  copies of the partner CLI vocabulary, two of which are the same sentence written
  twice.
- **Depends on**: Task 0.

### Task 5: Trigger suppress and unsuppress (U5)
- **Files**: `src/core/brain/triggers/types.ts` (new status, the two status
  partitions move here, four new record fields); `triggers/store.ts` (parse and
  render the new fields, block reason, recurrence writer, two new transitions);
  `src/cli/brain/verbs/trigger.ts` (verbs, JSON projection, suppressed count, the
  nested-ternary verb map replaced by a constant map);
  `src/mcp/brain/workspace-tools.ts` (operations, error text, the status enum
  sourced from the shared list, JSON projection); help text, CLI reference and
  how-it-works; extend the trigger store and MCP tool tests; new
  `tests/cli/brain-trigger.test.ts`.
- **Acceptance**: suppressing blocks recreation a year later with the suppressed
  reason; three scans against a suppressed twin leave a recurrence count of four
  and the last-seen instant of the last scan; a materially different finding keys
  differently and is created normally while the twin is suppressed; dismiss then
  suppress then unsuppress restores the dismissed status with its original
  resolution instant and its original cooldown arithmetic; unsuppressing something
  that is not suppressed throws naming its actual status; suppressing twice is
  idempotent; a suppressed trigger never reaches the morning brief; the tool's
  status enum equals the shared status list.
- **Defects in scope**: three hand-maintained copies of the status partition; the
  fourth copy of the status list as a schema literal; the malformed
  grounding-artifact list that degrades to empty; the verb map that routes an
  unknown verb to the act transition.
- **Depends on**: Task 0.

### Task 6: Derived-store coverage in the snapshot archive (U6)
- **Files**: `src/core/brain/path-constants.ts` and `paths.ts` (the derived-store
  literal becomes a constant and gains a snapshot path helper);
  `src/core/brain/manifest.ts` (optional derived-store field with a named
  exclusion vocabulary, validated on read); `src/core/brain/snapshot.ts` (options
  bag, archive step, new typed error, list and prune and restore); policy
  lifecycle block, defaults, config template; `src/cli/brain/verbs/rollback.ts`;
  help text and how-it-works; extend the snapshot, manifest, snapshot-gate and CLI
  tests.
- **Acceptance**: with the default configuration no store archive is written and
  the manifest records not-requested together with the live store size; enabled
  over a valid store, the archive is written and its digest matches the manifest;
  enabled with the store absent, integrity-faulted, or over the size ceiling, the
  snapshot throws with the corresponding reason and leaves no partial archive
  behind, and the destructive-snapshot gate consequently does not run the
  operation; pruning removes the store archive alongside the tar and the sidecar;
  a sidecar written before this feature parses and renders as unknown rather than
  excluded; restoring a snapshot that included the store swaps it under the writer
  lock and says so, and restoring one that did not says that too.
- **Defects in scope**: the gzip fallback that silently overwrites an existing
  archive while the collision-resolution logic depends on refusal; the artifact
  directory archived and hashed despite being documented as never backed up; the
  version literal repeated in four places; the empty conditional, the unused
  parameter behind a lint suppression, and the statement keeping a dead import
  alive.
- **Depends on**: Task 0.

### Task 7: Typed lifecycle history and the log surface (U7)
- **Files**: `src/core/brain/types.ts` (snapshot-reason vocabulary and one new log
  event kind); `manifest.ts` (optional reason field);
  `src/core/brain/snapshot.ts` (stamp the reason, emit the log event);
  `snapshot-gate.ts` (extract a reusable take-snapshot entry point, require a
  reason, repoint five call sites and replace three inline label literals);
  `src/cli/brain/verbs/snapshot.ts` (new subcommand); `rollback.ts` (reason
  column); command manifest, help text, how-it-works; extend the types, snapshot,
  manifest, snapshot-gate and CLI tests.
- **Acceptance**: creating a snapshot stamps its reason into the sidecar and emits
  exactly one log event carrying the run id and the reason; a log-append failure
  does not fail the snapshot; a sidecar with no reason reads as null rather than
  being guessed from the run-id prefix; an invalid reason fails the manifest
  closed, consistent with the existing rule; the new subcommand lists newest
  first, filters by reason, rejects an unknown reason with a usage exit, honours
  a limit, and exits zero on an empty snapshot directory; the extracted entry
  point and the gate produce byte-identical archives for the same input.
- **Defects in scope**: the snapshot diff classifier that predates per-device log
  sharding and mislabels both the sharded markdown and the machine-primary log.
- **Depends on**: Task 6 (both add an optional manifest field and both touch the
  same list and restore surfaces; sequencing them avoids a merge of two partial
  shapes).

### Task 8: Operator standing rules and loud truncation (U8)
- **Files**: `src/core/brain/path-constants.ts` and `paths.ts`; new
  `src/core/brain/standing-rules.ts`; `src/core/brain/text/text-budget.ts` (the
  notice becomes a function of the truncation report as well as a string);
  `src/core/brain/active-budget.ts` (the constant notice becomes a function that
  names the dropped sections); `hooks/active-inject.ts` (compose the block outside
  the fail-open boundary, first, metered as an exempt source, and amend the
  docblock that currently claims a different head of payload);
  `src/mcp/brain/context-tools.ts` (prepend on every return path including the
  error branch, plus an optional response key); policy active block, defaults,
  config template; how-it-works; new standing-rules, uneditability and
  context-surface tests; extend the text-budget, active-budget and injection-hook
  tests.
- **Acceptance**: the injected preamble begins with the standing block and the
  memory body follows; with no active memory file the block is still emitted;
  when memory assembly throws and no cache exists the block is still emitted and
  the hook exits zero; with the budget at its minimum and an oversized rules file,
  the block is emitted whole and only the memory body carries a truncation notice;
  an over-cap rules file is cut on a line boundary and its notice names the kept
  and total line and character counts and the path; an unreadable rules file
  throws naming the path and does not return null; a body of non-Latin text
  round-trips byte-identically and produces the same counts as a Latin body of
  equal length; each caller-named write tool refuses the rules path and leaves the
  bytes unchanged; no tool name, description or schema property mentions the path;
  an over-budget memory body's notice names the sections that were dropped.
- **Defects in scope**: the truncation report computed and discarded one line
  before the return; the vault-instruction reader whose configuration errors are
  swallowed into null.
- **Depends on**: Task 0.

### Task 9: Documentation, changelog and version
- **Files**: `README.md` if a described capability changed; `CHANGELOG.md` under
  one new version heading with its comparison link; `package.json`; every mirrored
  manifest via the version sync script.
- **Acceptance**: the sync check passes; the changelog entry names what shipped,
  what was refused and why, in the shape the two preceding releases use; the
  changelog heading and the package version agree.
- **Depends on**: Tasks 0 through 8.
