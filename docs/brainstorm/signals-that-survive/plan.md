# Signals that survive - implementation plan

Nine atomic units. Each lands as its own conventional commit on
`feat/signals-that-survive`, written test-first: the test is written and run and
must fail with the expected error before the implementation exists.

Unit numbers are the ones in `design.md`'s Scope list and are authoritative -
code comments referencing this wave use them. The nine units have no dependency
edges between them on the kanban board, so the sections below are laid out in
EXECUTION order rather than in unit order: units sharing a file must not run
concurrently, and the sequence here is what keeps them apart.

Execution order: 1, 2, 4, 7, 8, 9, then 3, then 5, then 6.

## Tasks

### Task 1: Shared git-aware discovery module

- **Kanban**: `t_4b2bd8f7`
- **Files**: new `src/core/fs/git-discovery.ts`; `src/core/hygiene/scan-repo.ts`
  (consume, behaviour unchanged); `src/core/brain/ingest/batch-plan.ts` (wire into
  `collectIngestible`); tests under `tests/`.
- **Acceptance**:
  - The hygiene scan's existing tests pass unmodified after the extraction - the
    refactor is provably inert.
  - An ingest plan over a directory containing a `.gitignore` excludes the declared
    paths; nested `.gitignore` files apply to their own subtree only.
  - `.git/info/exclude` is layered beneath the root `.gitignore`.
  - A submodule directory (gitlink file or nested `.git`) is not descended into.
  - Operator `--exclude` patterns still win over every repository-declared layer.
  - A directory with no ignore files produces the exact `planId` it produces today.
  - A malformed pattern in a repository's own `.gitignore` is returned as a
    structured warning on the plan, and does not fail the plan; a malformed operator
    `--exclude` still throws, as it does today.
- **Depends on**: none

### Task 2: Typed parse error carrying the path as a field

- **Kanban**: `t_ceee3b4d`
- **Files**: new `src/core/brain/parse-error.ts`; `src/core/brain/preference.ts`
  (throw the typed error from the preference and retired-preference parsers);
  `src/core/brain/doctor.ts` (`classifyParseError` reads the field);
  `src/cli/brain/verbs/doctor.ts` (renderer unchanged, verified by test); tests.
- **Acceptance**:
  - `o2b brain doctor` renders a parse-error finding with the path exactly once.
  - The finding's structured `path` field is unchanged.
  - All four parse-error kinds are covered, not only `preference-missing-field`.
  - The existing code classification still resolves from the bare message.
  - A caller that surfaces the error message directly still receives the path,
    through the shared location formatter rather than through string concatenation
    at the throw site.
- **Depends on**: none

### Task 3: Route discrimination on the extracted-fact router

- **Kanban**: `t_07ad3c42`
- **Files**: new `src/core/brain/routing/route-discriminator.ts`;
  `src/core/brain/fact-extract.ts` (`routeExtractedFacts` consumes it);
  `src/core/config.ts` (the gate key); tests.
- **Acceptance**:
  - `scoreRouteCandidates` is pure, returns a deterministically ordered frozen
    array, and every feature it reads is a count, an offset or a set membership -
    no natural-language token list, in any language.
  - `discriminate` fires only when the top two candidates are within the margin.
  - The terminal rule reproduces today's family-table order, so with no earlier rule
    separating the candidates the routed destination is identical to today's.
  - Each rule has a stable id, and the id that decided is recorded.
  - With the gate key absent, no telemetry record is written and behaviour is
    byte-identical.
  - With the gate key set, one `route_discrimination` record per discrimination
    carries the candidate set, scores, margin, winner and rule id, and carries no
    fact text.
- **Depends on**: none

### Task 4: Unroutable-capture routing hint

- **Kanban**: `t_75597bb9`
- **Files**: `src/core/brain/write-advisory.ts` (sibling of `adviseIncomingFeedback`);
  the CLI `feedback` verb and the `brain_feedback` tool (surface the structured field);
  `src/core/brain/next-step.ts` (one registered diagnostic code); tests.
- **Acceptance**:
  - A scope-less feedback write on a vault containing scoped preferences returns a
    hint naming `scope` as the missing signal plus the observed scope slugs, ranked
    by document frequency.
  - A vault with no scope corpus returns `null` - the hint is silent, not empty prose.
  - The write always lands; the hint never blocks or alters it.
  - The human surface prints the forward pointer through the advisory rail against a
    registered code; no sentence is assembled at the call site.
  - No new configuration key is introduced.
- **Depends on**: none

### Task 5: Fact and skill marker kinds

- **Kanban**: `t_9ba5c027`
- **Files**: `src/core/brain/inline.ts` (`MarkerKind`, `KNOWN_KINDS`,
  `REQUIRED_FIELDS`, two narrowing guards); the marker routing sites; tests.
- **Acceptance**:
  - A `fact` marker with all required fields routes to an unconfirmed preference; a
    missing required field is an explicit parse error naming the field.
  - A `skill` marker routes to the pending skill-proposal store, never to accepted.
  - Fence-awareness, the consumed sentinel and the dedup hash apply to both new kinds
    without new code - a re-run over the same file is idempotent.
  - Both the inline and the block shape parse for both kinds.
  - A file containing no markers of the new kinds behaves byte-identically.
- **Depends on**: none

### Task 6: Response-shape validation on model-authored write paths

- **Kanban**: `t_80b01448`
- **Files**: new `src/core/brain/response-shape.ts` (promoted from
  `src/mcp/output-contract.ts`, named for shape rather than schema);
  `src/mcp/output-contract.ts` (re-export or consume, one definition only);
  the distill, derive-fact and dream payload entry points; tests.
- **Acceptance**:
  - Each of the three write paths validates its payload against a frozen descriptor
    before any normalization.
  - A payload violating the descriptor raises a named error carrying `{code, path,
    message}` as fields; it is never coerced, never partially written, and never
    silently dropped.
  - Validation is unconditional - there is no key that turns it off, because a
    validator that can be disabled is a validator the write path cannot rely on.
  - Descriptors stay shallow: required keys, primitive types, arrays of objects.
    A test asserts no descriptor uses a construct the subset validator cannot express.
  - The word `schema` is not used for this layer anywhere in the public surface, so
    it cannot be confused with the knowledge vocabulary in `schema-contracts.ts`.
- **Depends on**: none

### Task 7: Query-side temporal intent

- **Kanban**: `t_58fc4720`
- **Files**: new `src/core/search/temporal-intent.ts`;
  `src/core/search/query-plan.ts` (detect, contribute to `planHash`);
  `src/core/search/ranker.ts` (capped additive layer over `temporalProximity`);
  `src/core/search/search.ts` (thread the event-time map);
  `src/core/search/types.ts` (one additive `ScoreBreakdown` key); tests.
- **Acceptance**:
  - Detection reads only ISO tokens and the existing `<field>:<value>` grammar. A
    test asserts that a query written in a non-Latin script with an ISO date is
    detected identically to the same query in English.
  - A query with no temporal window produces byte-identical ranking, an absent
    breakdown key and an unchanged `planHash`.
  - A query naming a historical window ranks an in-window note above an equally
    relevant recent one.
  - The freshness prior and the temporal layer appear as separate entries in
    `reasons`, so a ranking change is attributable to one of them.
  - The new cap is a named constant, and a test asserts it is in proportion to the
    existing link, entity, activation and reuse caps.
- **Depends on**: none

### Task 8: Recall adequacy feeds the knowledge-gap loop

- **Kanban**: `t_3f96f87a`
- **Files**: `src/core/brain/query-demand.ts` (optional adequacy level on the record);
  the two verdict sites (`src/mcp/search-tools.ts`, `src/mcp/brain/pack-tools.ts`);
  `src/core/brain/gaps/gap-loop.ts` (aggregate over both sources);
  the session-start and session-end hooks (wire the dormant module behind the
  existing `gap_loop_enabled` / `gap_loop_threshold` keys); tests.
- **Acceptance**:
  - A weak or insufficient verdict stamps the demand record whose bucket key comes
    from `normalizeQueryTerms` - no new identity concept is introduced.
  - A bucket recurring at or above the threshold with weak verdicts promotes to one
    gap task; below the threshold nothing is minted.
  - Promotion is capped per run, and the cap is a named constant.
  - Structural gap rows and verdict rows stay distinguishable on the agenda - a test
    asserts `occurrences` is never a sum across the two sources.
  - An existing open gap task for the same key is not duplicated.
  - A gap task auto-closes when its topic later recalls with sufficient confidence.
  - With `gap_loop_enabled` absent, no gap task is written and the session hooks
    behave byte-identically.
- **Depends on**: none. Shares no file with tasks 1 through 7.

### Task 9: Durable work identity above the timing crutch

- **Kanban**: `t_e6be4f6b`
- **Files**: `src/core/brain/lineage/ledger.ts` (optional `wid` / `lane` on
  `LedgerLine`); `src/core/brain/lineage/crutch.ts` (a precedence rung above the
  window); the capture boundary that sources the identity; tests.
- **Acceptance**:
  - Identity is sourced in strict declared precedence and is never inferred.
  - Two ledger entries sharing a work id link on identity alone, with no freshness
    bound and no `cwd`, branch or commit predicate - so a resumed session re-attaches
    after a branch or worktree switch.
  - Two entries sharing a work id but carrying different lane ids never link, and the
    refusal is a named outcome, not a silent non-link.
  - Two same-lane survivors abstain through the v1.39.0 ambiguity path with a named
    reason; the abstention layer is consumed, not re-implemented.
  - With both fields absent, `resolveSessionLineageDetailed` returns exactly what it
    returns today, and the ledger's integrity chain is unaffected.
- **Depends on**: none

### Task 10: Release surface

- **Files**: `CHANGELOG.md` (one `## [1.41.0]` entry plus its compare link),
  `README.md`, `package.json`, then `bun run scripts/sync-version.ts`.
- **Acceptance**: `bun run scripts/sync-version.ts --check` is clean; the CHANGELOG
  heading and `package.json` agree.
- **Depends on**: tasks 1 through 9
