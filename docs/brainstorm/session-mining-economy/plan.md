# Session mining economy - implementation plan

Four implementation lanes (A to D) plus one integration task (I). The two substrate tasks land first (Task 1, lane A: the shared mining record; Task 2, lane B: the config flag surface) so every lane can start without waiting on another lane. File ownership is disjoint across lanes with one noted exception: docs/cli-reference.md is edited by several lanes, each in its own section, landing in task order on the shared branch. Every task is test-driven: the named tests are written first and must fail with the expected error before implementation.

## Tasks

### Task 1: Session mining ledger module
- **Lane**: A
- **Files**: src/core/brain/session-mining-ledger.ts (new), tests/core/brain/session-mining-ledger.test.ts (new)
- **Acceptance**: With the failing tests written first: the ledger stores schema-versioned entries {sessionId, minedContentHash, outcome {written, staged, deduped, durabilityRejected}, recordedAt} in the derived store beside session-import-ledger.json; reading a corrupt or unknown-schema ledger refuses with a named error and never resets; writing takes the file lock with the vault-identity assertion, writes atomically, is a byte-identical no-op when content is unchanged, and prunes entries whose sessions have no turns; the mined-turn hash helper is a stable SHA-256 over (turn id, text, timestamp) and changes when any turn changes.
- **Depends on**: none

### Task 2: Backlog nudge config flag
- **Lane**: B
- **Files**: src/core/config.ts, tests/core/config.test.ts
- **Acceptance**: With the failing test written first in tests/core/config.test.ts: a `resolveBacklogNudgeEnabled(configPath?)` resolver beside `resolveGapLoopEnabled` rides `resolveConfigFlag` with env override `OPEN_SECOND_BRAIN_BACKLOG_NUDGE_ENABLED` and config key `backlog_nudge_enabled`, defaulting false; the config-template ratchet test stays green (the key rides the flag path, not the resolver default tables).
- **Depends on**: none

### Task 3: Zero-yield tombstone gate at plan time
- **Lane**: A
- **Files**: src/core/brain/extract-signals-prefilter.ts, tests/core/brain/extract-signals-prefilter.test.ts, tests/core/brain/extract-signals.test.ts
- **Acceptance**: With the failing tests written first: inside `planExtractSignalsPrefiltered` and before the prefilter runs, a mining record whose hash matches the session's current turn material suppresses the plan with a typed outcome carrying the tombstone reason and the recorded breakdown as evidence; the reason union widens to typed literals without disturbing the prefilter's existing `skipped` reasons; unchanged content stays suppressed, content changed by re-import re-opens the session; the three existing plan refusals behave exactly as before.
- **Depends on**: Task 1

### Task 4: Record-at-commit with a named ledger failure field
- **Lane**: A
- **Files**: src/core/brain/extract-signals.ts, tests/core/brain/extract-signals.test.ts
- **Acceptance**: With the failing tests written first: a successful `commitExtractedSignals` with `written.length === 0 && staged === 0` records the ledger entry with the outcome breakdown; a commit with written or staged nonzero records nothing; an `ExtractSignalsWriteError` records nothing; the commit recomputes the mined-content hash from the turns present at commit time; when the commit succeeds but the ledger write fails, the result carries a named ledger-failure field and nothing throws.
- **Depends on**: Task 1

### Task 5: Tombstone wiring on both surfaces plus the re-mine escape hatch
- **Lane**: A
- **Files**: src/mcp/brain/extract-tools.ts, src/cli/brain/verbs/extract-signals.ts, tests/mcp/extract-signals-tool.test.ts, tests/cli/brain-extract-signals.test.ts, docs/cli-reference.md (extract-signals entry), docs/mcp.md (brain_extract_signals entry), docs/how-it-works.md (mining section)
- **Acceptance**: With the failing tests written first: a suppressed plan renders symmetrically on the MCP tool (response fields and tool description naming the tombstone reason and evidence) and on the CLI verb (output line and JSON fields); the ledger-failure field surfaces by name on both; the CLI force/re-mine flag and the documented MCP force argument bypass the gate for exactly one plan call and change no other behavior; docs state the invalidation semantics (content change re-opens; force for "I removed the downstream item and want it re-proposed").
- **Depends on**: Tasks 3, 4

### Task 6: Distilled and undistilled census
- **Lane**: B
- **Files**: src/core/brain/sessions/mining-census.ts (new), tests/core/brain/sessions/mining-census.test.ts (new), src/cli/brain/verbs/import-session.ts, tests/cli/session-discovery.test.ts
- **Acceptance**: With the failing tests written first: the census joins the mining record to the import ledger on `sessionRefIdentity` with no log re-hashing and classifies each imported session as distilled (yield on current content), known-nothing-new (tombstoned, content unchanged) or undistilled (never mined, or content changed since last mining); sessions the plan would refuse (boundary, zero imported turns, zero user turns) are excluded from the backlog; the import-session coverage output reports distilled and undistilled counts per runtime; a corrupt mining record refuses by name.
- **Depends on**: Tasks 1, 2

### Task 7: SessionStart backlog nudge hook
- **Lane**: B
- **Files**: hooks/backlog-nudge.ts (new), hooks/lib/backlog-nudge-state.ts (new), hooks/hooks.json, tests/hooks/backlog-nudge.test.ts (new), tests/hooks/hooks-json-shape.test.ts
- **Acceptance**: With the failing tests written first: the hook is a no-op exiting 0 with a byte-identical preamble when the flag is off; when on and the undistilled count differs from the last injected count, it injects one `additionalContext` line with the count; when the count is unchanged it stays silent; the throttle state is a vault-global, overwrite-only, size-one record beside the hygiene-digest state (path from path constants, never hard-coded); every path exits 0 and respects the process ceiling; the hooks.json SessionStart entry passes the shape test.
- **Depends on**: Tasks 2, 6

### Task 8: Ask-once batching layer
- **Lane**: B
- **Files**: src/core/brain/distill/backlog-proposals.ts (new), tests/core/brain/distill/backlog-proposals.test.ts (new), src/cli/brain/verbs/import-session.ts, tests/cli/session-discovery.test.ts
- **Acceptance**: With the failing tests written first: the pure function takes the pending undistilled set plus a `loadDedupIndex` result and returns one proposal per distinct `computeDedupHash` across sessions, each naming its contributing sessions, plus a report naming every candidate dropped because its dedup hash already exists in the vault; sessions raising only already-known material appear in the report and in no proposal; the import-session verb exposes the batched envelope as output for the calling agent to present, with no interactive loop in the kernel; the function handles an empty backlog as an explicit empty result.
- **Depends on**: Task 6

### Task 9: Measure-only shadow mode on the retrieval trust gate
- **Lane**: C
- **Files**: src/core/search/types.ts, src/core/search/index.ts, src/core/brain/trust/retrieval-gate.ts, src/core/brain/trust/retrieval-receipts.ts, src/core/search/pipeline/post-rank.ts, src/core/search/pipeline/cache-slot.ts, src/core/search/explain-envelope.ts, tests/core/search/config.test.ts, tests/core/brain/trust/retrieval-gate.test.ts, tests/core/brain/trust/retrieval-receipts.test.ts, tests/core/search/retrieval-trust-gate.test.ts
- **Acceptance**: With the failing tests written first: the resolved config carries `search_trust_gate_mode` (off | shadow | enforce), resolved as explicit mode, else legacy boolean true mapped to shadow, else off; an invalid value is refused naming the key after the `parseFusionMode` pattern; under off, ranking and outcome shape are byte-identical to today; under shadow, `trustGateAdjuster`'s classification runs, nothing is excluded, and every would-be refusal is recorded with its structural reasons into receipts whose `excluded` counts stay untouched; the query-cache key includes the resolved mode; the explain envelope names it; enforce reproduces today's excluding behavior exactly.
- **Depends on**: none

### Task 10: Edge-level eligibility adjuster in the relational arm
- **Lane**: C
- **Files**: src/core/search/pipeline/relational-arm.ts, tests/core/search/relational-arm.test.ts
- **Acceptance**: With the failing tests written first: each walked node and edge is classified from the same controlled-vocabulary frontmatter signals as the page gate plus `parseValidityWindow` at query time and the relation-polarity vocabulary; under enforce an ineligible edge is removed from the arm's contribution set, under shadow it is counted only; refusals carry named structural reason tokens and are reported per lane into the receipts, distinct from both `excluded` and the arm's identical-to-absent provenance convention (a refusal is counted, a provenance omission is not reported); traversal internals of relational-fanout.ts are unchanged.
- **Depends on**: Task 9

### Task 11: Console collector and explorer routes
- **Lane**: D
- **Files**: src/core/brain/explorer-console.ts (new), src/core/brain/explorer.ts, src/cli/brain/verbs/explorer.ts, tests/core/brain/explorer-console.test.ts (new), tests/core/brain/explorer.test.ts, tests/cli/brain-explorer.test.ts
- **Acceptance**: With the failing tests written first: the collector returns a frozen, deterministic payload (given `opts.now`) holding the telemetry summary, the most-recalled top-N under a named cap, the written-per-day histogram over a named 30-day window bucketed from continuity createdAt, and the latest report-snapshot date per surface reported as "disabled" when snapshots are off; `buildLiveServer` serves `/counts.json` from the collector and `/status.json` from `buildOperatorSnapshot`, both loopback-only, re-read per GET, with errors surfaced by name and no write endpoints; `configPath` reaches the server through an additive options object and the existing boot refusals are unchanged.
- **Depends on**: none

### Task 12: Console sections in the explorer template
- **Lane**: D
- **Files**: templates/brain-explorer.html, tests/cli/brain-explorer.test.ts
- **Acceptance**: With the failing tests written first: the template gains counts and ops sections that fetch `/counts.json` and `/status.json` client-side and render them in the template's existing vanilla-JS structure with no new dependencies; the `__GRAPH_JSON__` marker still appears exactly once and the single-marker validation still passes; the live spawn test fetches all four routes on loopback and asserts the shutdown behavior is unchanged.
- **Depends on**: Task 11

### Task 13: Wave integration verification
- **Lane**: I
- **Files**: none expected; cross-document consistency fixes in docs/cli-reference.md, docs/mcp.md, docs/how-it-works.md if review finds drift
- **Acceptance**: The full test suite passes; the cross-lane chain holds end to end: a barren commit records the entry (Task 4), the plan gate suppresses the next scan (Task 3), the census classifies the session known-nothing-new (Task 6) and the hook count excludes it (Task 7); a tombstoned session spends no decision-model requests on either surface; the recall lane with every new knob unset is byte-identical to the merge base; the console renders from the shipped stores with every knob off; the three docs files read as one coherent story across the four lanes; fmt and lint are green on the whole tree.
- **Depends on**: Tasks 5, 7, 8, 10, 12
