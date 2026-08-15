# Nothing runs unwatched - implementation plan

Eleven units carrying nine tracker tasks. Each unit is one atomic commit or a
short sequence of them, test-first. Units marked **independent** may run in
parallel; the rest name what they depend on.

## Tasks

### U1: The progress spine
- **Tracker**: t_62bb944a
- **Files**: `src/core/brain/progress.ts` (new); `src/core/search/indexer.ts`;
  `src/core/brain/dream.ts`, `dream-types.ts`, `dream-stage.ts`;
  `src/core/brain/link-graph/bridge-discovery.ts`, `communities.ts`;
  `src/core/brain/maintenance/lane.ts`; `src/core/search/vector-backfill.ts`;
  `src/cli/progress-rail.ts` (new); `src/cli/brain/verbs/dream.ts`,
  `bridges.ts`, `clusters.ts`, `maintenance.ts`;
  `src/cli/search/verbs/indexing.ts`;
  `tests/core/architecture/progress-census.test.ts` (new)
- **Acceptance**:
  - `PROGRESS_KIND` passes the four-piece vocabulary census (frozen object,
    camelCase keys, snake_case values, derived union, members array, guard whose
    parameter is `unknown`).
  - A dream pass driven with a recording sink emits `started`, at least one
    `advanced` per phase in `DREAM_PHASE_ORDER`, and one `finished`.
  - An index run emits events with no `total`; an embedding phase emits events
    with a `total` equal to the pending-chunk count.
  - The progress census fails when a new options interface accepts
    `safeguard?: Safeguard` without `onProgress?: ProgressSink` and without a
    registered written reason.
  - A test asserts `search` and `brain` are in `COMMANDS_WITH_INTERNAL_JSON`,
    with the reason written in the test: progress from a wrapped command is
    buffered and released at the end, which looks like it worked.
  - Progress renders on stderr; a `--json` run's stdout stays byte-identical to
    the same run without a progress sink.
- **Depends on**: none

### U2: MCP progress - stdio carries, HTTP refuses
- **Tracker**: t_62bb944a
- **Files**: `src/mcp/server.ts`; `src/mcp/stdio.ts`; `src/mcp/http.ts`;
  `src/mcp/tool-contract.ts`; `src/mcp/brain/admin-tools.ts`,
  `feedback-tools.ts`, `knowledge-tools.ts`; `docs/mcp.md`
- **Acceptance**:
  - `params._meta.progressToken` is read at `handleToolsCall` and reaches the
    handler as an optional third parameter; a handler declaring two parameters
    still typechecks and still runs.
  - Over stdio, a `brain_dream` call carrying a token receives at least one
    `notifications/progress` frame before the response frame, and the response
    frame is unchanged from a call with no token.
  - Over HTTP, a call carrying a token receives a typed refusal naming the
    transport, and emits no progress frames.
  - A call with no token produces no frames and no refusal.
  - `brain_bridges` and `brain_clusters` pass a safeguard, which they do not
    today.
- **Depends on**: U1

### U3: Cancellation, wired
- **Tracker**: t_fe4b6be0
- **Files**: `src/core/brain/safeguard.ts`; `src/cli/brain/verbs/dream.ts`,
  `bridges.ts`, `clusters.ts`, `maintenance.ts`;
  `src/cli/search/verbs/indexing.ts`; `src/cli/exit-codes` surface
- **Acceptance**:
  - A long CLI verb interrupted once stops at the next checkpoint, emits a
    `stopped` progress event, and exits with a code distinct from both success
    and crash.
  - `SafeguardAbortError` is reachable from a production path; a test proves it
    by driving the verb's handler with a pre-aborted signal.
  - A second interrupt is not intercepted, matching the watch-runner precedent.
  - A timeout still produces `SafeguardTimeoutError` and its existing code.
- **Depends on**: U1

### U4: A ceiling that spans the process
- **Tracker**: t_fe4b6be0
- **Files**: `src/core/search/embeddings/provider-semaphore.ts` (new);
  `openai-compat.ts`; `zeroentropy.ts`; `src/core/search/benchmark.ts`
- **Acceptance**:
  - Two overlapping `embed()` calls against one resolved provider identity never
    exceed the configured concurrency in flight; a test counts concurrent
    in-flight requests against a stub transport.
  - Two different provider identities do not share a ceiling.
  - The benchmark fan-out is bounded by a named constant; a test asserts the
    in-flight ceiling under a dataset larger than it.
- **Depends on**: none (**independent**)

### U5: The herd
- **Tracker**: t_992f0c33
- **Files**: `src/core/maintenance/ensure-current.ts`; `src/cli/main.ts`;
  `hooks/active-inject.ts`
- **Acceptance**:
  - When the writer lock is already held, no child is spawned and the skip is
    recorded with a typed reason.
  - When a child is spawned, its terminal outcome is written where an operator
    can read it; a test drives a failing child and asserts the record exists and
    names the failure.
  - `stderr: "ignore"` no longer discards the only report of a failure.
- **Depends on**: none (**independent**)

### U6: A fourth gate, a streak, and a watchdog that can fire
- **Tracker**: t_992f0c33
- **Files**: `src/core/brain/maintenance/pressure.ts` (new);
  `streak.ts` (new); `lane.ts`; `src/core/brain/policy/blocks/*`;
  `templates/` brain config template; `hooks/hooks.json`;
  `hooks/lib/process-ceiling.ts`
- **Acceptance**:
  - On a POSIX host the gate reads a normalised pressure ratio and skips with a
    typed verdict above the configured threshold.
  - On a platform where the metric is degenerate the gate emits a distinct
    verdict meaning "unmeasurable here" and does not skip; the journal shows the
    two cases are different lines.
  - A task with N consecutive journaled failures is refused without `--force`,
    and the refusal names the streak.
  - The new config keys satisfy all four config-template ratchet assertions and
    appear commented, not live.
  - The hook ceiling and the declared host timeout no longer contradict each
    other, and a test asserts the relation rather than the two numbers.
- **Depends on**: none (**independent**)

### U7: The ingest lock that was never taken
- **Tracker**: t_da034197
- **Files**: `src/core/brain/ingest/content-manifest.ts`; `checkpoint.ts`;
  `src/core/brain/git/store.ts`;
  `src/core/brain/ingest/adapter-registry.ts` (new);
  `src/core/brain/sessions/registry.ts`;
  `src/core/discipline/transcripts/claude-code.ts` and siblings;
  `tests/core/architecture/verdict-vocabulary-census.test.ts`
- **Acceptance**:
  - Two concurrent manifest updates do not lose one another's record; a test
    drives the race and asserts both survive.
  - The adapter registry rejects an unknown id loudly with the id in the
    message, and adding an adapter touches only the new module and the registry
    entry.
  - `isSessionAdapterId` takes `unknown` and the vocabulary is registered in the
    census.
  - A transcript resolver distinguishes "directory absent", "unreadable" and
    "no transcripts" from one another; none of the three is a bare zero.
  - A dry-run import is distinguishable in its result from a real run that wrote
    nothing.
- **Depends on**: none (**independent**)

### U8: The install says only what it checked
- **Tracker**: t_b5fa7344, t_1037d94e
- **Files**: `src/core/brain/portability/vault-residence.ts` (new);
  `src/cli/install/install.ts`, `render.ts`, `init-interactive.ts`;
  `src/cli/install-cli.ts`; `src/cli/onboarding.ts`;
  `src/core/brain/diagnostics.ts`; `src/core/brain/doctor/*`
- **Acceptance**:
  - Install resolves the vault through the same chain as the rest of the CLI; a
    test pins the precedence and fails on divergence.
  - The success path carries an ownership statement built from the resolved
    path plus the enumerated out-of-vault state; a test asserts every known
    out-of-vault location appears in the enumeration, so a new one cannot be
    added without updating the statement.
  - Every install `--json` shape carries a schema version and is asserted by a
    test, which none is today.
  - The residence verdict has an `undetermined` member and a separate reason;
    a test proves a negative container signal does not produce a positive
    "local" verdict.
  - The durability check reports liveness only and states in its own message
    what it could not check, because no job registration exists to check the
    presence of.
- **Depends on**: none (**independent**)

### U9: The provider death date
- **Tracker**: t_e7a226ce
- **Files**: `src/core/search/embeddings/sunset.ts` (new); `presets.ts`;
  `signature.ts`; `src/core/brain/diagnostics.ts`;
  `src/core/brain/doctor/*`; `tests/core/brain/doctor-exit-census.test.ts`
- **Acceptance**:
  - A configured model with a declared sunset date in the future within the
    warning window produces a warning naming the model and the date.
  - A configured model that is not in the catalog produces a verdict meaning
    "unknown to the catalog", which is a different value from "no sunset
    announced"; a test asserts the two are distinguishable.
  - The check reads its clock from the injected doctor clock and calls no global
    time function.
  - The new code is present in `DOCTOR_REGISTERED_CODES` and the `nextCommand`
    passes the structural command assertion.
  - The message never claims to name a vendor, because the provider field
    resolves to a transport kind.
- **Depends on**: none (**independent**)

### U10: Four failure modes, measured
- **Tracker**: t_72d6eb23
- **Files**: `src/core/bench/failure-modes/` (new);
  `src/core/bench/phases.ts`, `types.ts`; `src/cli/brain/verbs/bench.ts`;
  `src/core/brain/token-impact.ts`; the shared token estimator;
  `src/core/brain/pre-compact-extract.ts`; `tests/helpers/run-cli.ts`;
  `.github/workflows/ci.yml`
- **Acceptance**:
  - Proactive recall is scored by driving the pure decision function with an
    injectable retriever over a fixture; a strategy that always injects scores
    worse than one that abstains correctly, because the false-fire term is
    weighted against it.
  - Write-back fidelity grades provenance fields on the shipped path with no
    model call.
  - Cross-source isolation asserts on delivered pack contents under the strict
    gate and gates at zero.
  - Injected tokens are counted by exactly one estimator; a test asserts no
    second estimator remains reachable from the bench.
  - `brain_token_impact` no longer reports `method: "exact"` over integers a
    caller supplied.
  - The prose recognizer on the write path carries no natural-language word
    list; a fixture in a non-Latin script scores on structure.
  - The two environment variables that changed the bench between a developer and
    CI are scrubbed by the CLI test helper.
  - A committed baseline exists and CI runs the suite.
- **Depends on**: none (**independent**)

### U11: The scanner's walk
- **Tracker**: t_4b479851
- **Files**: `src/core/brain/architect/scan.ts`, `generate.ts`;
  `src/cli/brain/verbs/architect.ts`
- **Acceptance**:
  - The traversal visits each directory once; a test counts directory reads on a
    fixture with a nested layout.
  - Dot-directories and `.gitignore` entries are not visited; a test asserts a
    file under an ignored directory does not appear in the facts.
  - The language tie-break is locale-independent; a test runs it under two
    locales and asserts identical output.
  - The scan emits progress through the U1 sink.
  - Rendered notes are byte-identical to the previous release on a fixture with
    no ignored directories, measured with the vault-digest helper.
- **Depends on**: U1

## Release-phase tasks

- Docs pass: `docs/mcp.md` (progress notifications and the HTTP refusal),
  `docs/cli-reference.md` (new flags, exit code for a deliberate stop, new
  doctor code), `docs/how-it-works.md` (the maintenance gate set),
  `docs/architecture.md` (out-of-vault state enumeration),
  `docs/metrics.md` if a new surface appears, `docs/observability.md`.
- `CHANGELOG.md` entry under a new version heading plus its compare link.
- `package.json` version bump followed by `bun run scripts/sync-version.ts`.
- OpenClaw bundle rebuild if any bundled source changed.
