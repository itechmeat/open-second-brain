# Independent review — tests and documentation

**Branch** `feat/nothing-runs-unwatched` · **base** `main` (`aa818084`) · reviewed at `751fbb17`
(re-checked against `ceb8b1e3`, whose only delta is test-timeout bookkeeping and touches nothing below).

**Scope.** Not whether the features are good — whether the branch's own proof stands up. Every
"CAUGHT" and "MISSED" row below was produced by mutating production code in a throwaway `git
worktree`, running the test, and reverting. Nothing was left in the working tree; the proof is at the
bottom of this document.

---

## 1. Falsification table

The mutation was applied to production code (never to a test) in a scratch worktree at branch HEAD,
the named test was run, and the worktree was restored.

### Breaks the suite caught

| # | Test | What I broke | Caught |
|---|---|---|---|
| 1 | `tests/core/brain/architect.test.ts:216` "the language tie-break does not depend on the host collation" | `compareStable` → `a[0].localeCompare(b[0])` in `generate.ts:55` | ✅ byte diff on the `Languages:` line |
| 2 | `tests/hooks/process-ceiling.test.ts:131` "the self-ceiling fires first, by the stated headroom" | `DEFAULT_HOOK_CEILING_MS = 55_000` | ✅ `Expected 8000, received 55000` |
| 3 | `tests/core/architecture/progress-census.test.ts:116` "every options interface that takes a safeguard takes a progress sink" | deleted `readonly onProgress?:` from `ScanProjectOptions` | ✅ names the interface |
| 4 | `tests/core/architecture/progress-census.test.ts:182` "every stage constant maps to identifier values" | `walk: "walk"` → `walk: "walking the project tree"` | ✅ |
| 5 | `tests/core/install/ownership.test.ts:225` "every writer is either attributed to an entry or excused in writing" | added `src/core/zz-new-writer.ts` doing `writeFileSync(join(homedir(), …))` | ✅ names the file |
| 6 | `tests/cli/doctor-exit.test.ts:71` "a proved failure outranks an unmeasured probe" | swapped the two branches of `doctorExitCode` (`src/cli/main.ts:318`) | ✅ `Expected 1, received 6` |
| 7 | `tests/cli/progress-rail.test.ts:50`, `:115` | `progressIsLegal` → `return true` | ✅ 2 failures |
| 8 | `tests/cli/progress-rail.test.ts:86` "an event kind this build does not know is a defect" | `throw new TypeError(…)` → `return` | ✅ |
| 9 | `tests/core/search/embeddings.concurrency-ceiling.test.ts:26` "Semaphore hands a released permit to the waiter" | restored the pool form (`permits++` on release, `permits--` after await) | ✅ `peak` 1 → 2 |
| 10 | `tests/core/search/embeddings.concurrency-ceiling.test.ts:160` "the ceiling spans the process" | `providerSemaphore` always constructs a fresh `Semaphore` | ✅ 4 failures, incl. `peak` 2 → 4 |
| 11 | `tests/core/bench/failure-modes.test.ts:143` "an always-inject strategy scores worse" | `false_fire_rate: 0` in `scoreProactiveRecall` | ✅ |
| 12 | `tests/core/bench/failure-modes.test.ts:270` "the assertion reads delivered contents" | `isolationViolations` → `[]` | ✅ |
| 13 | `tests/core/discipline/transcripts/scan-states.test.ts` (4 tests) | collapsed `unreadable` into `idle` in `classifyTranscriptScan` | ✅ 4 failures |
| 14 | `tests/mcp/progress-token.test.ts:124` "the response frame is identical with and without a token" | added a field to `result.structuredContent` when a token is present | ✅ |
| 15 | `tests/core/brain/ingest/concurrent-shared-writes.test.ts:100` "every source's content hash survives a four-process race" | removed the lock from `updateManifest` | ✅ 74 of 100 entries lost |
| 16 | `tests/core/vault-backing.test.ts:71` "an unrecognised magic number is undetermined, NOT durable" | unknown magic → `{state: durable}` | ✅ |
| 17 | `tests/core/brain/doctor-exit-census.test.ts:237` | added `EMBEDDING_MODEL_SUNSET_EXTRA_CODE` and pushed it, registering nothing | ✅ names the code |
| 18 | `tests/core/brain/doctor-exit-census.test.ts:298` | `code: ["embedding","model","sunset","computed"].join("-")` | ✅ names the expression |
| 19 | `tests/core/architecture/verdict-vocabulary-census.test.ts:906` | dropped `PROGRESS_KIND.started` from `PROGRESS_KINDS` | ✅ 2 problems reported |
| 20 | `tests/cli/brain-architect-progress.test.ts:45` "writes records to stderr and leaves stdout untouched" | rail writes to `process.stdout` | ✅ 2 failures |
| 21 | `tests/core/brain/maintenance/host-pressure.test.ts:49` "…unmeasurable, not idle" | `platformBlind` → `{state: measured, percent: 0}` | ✅ |
| 22 | `tests/core/brain/doctor/recovery-point-liveness.test.ts:150`, `:161` | `ctx.now.getTime()` → `Date.now()` | ✅ 5 failures, incl. the source scan |
| 23 | `tests/core/search/embeddings.sunset.test.ts:228` | `unsurveyed` → `noneAnnounced` for an off-table model | ✅ 4 failures |
| 24 | `tests/cli/cli.test.ts:226` "byte-identical opt-out" | `--readiness` writes an extra line into the base output | ✅ prefix check fails |
| 25 | `tests/core/brain/config-template-ratchet.test.ts:275` | `commented-example` emitted `live` | ✅ 3 failures |
| 26 | `tests/core/brain/sessions/dry-run-honesty.test.ts:77` | `write_mode` always `applied` | ✅ 2 failures |
| 27 | `tests/mcp/long-running-tools.test.ts:122` "brain_bridges discover aborts once its deadline has passed" | removed `safeguard:` from the MCP handler | ✅ |

### Breaks the suite MISSED — a green run over broken code

| # | Test that should have caught it | What I broke | Result |
|---|---|---|---|
| A | `progress-census.test.ts:116` | `export interface ScanProjectOptions` → `export type ScanProjectOptions = {` **and** the sink deleted | ❌ 6 pass, 0 fail |
| B | `progress-census.test.ts:116` | `readonly safeguard?:` → `safeguard?:` **and** the sink deleted | ❌ 6 pass, 0 fail |
| C | `progress-census.test.ts:160` | `progress.advance(ARCHITECT_STAGE.walk)` → ``progress.advance(`walking the project tree`)`` | ❌ 6 pass, 0 fail |
| D | `progress-census.test.ts:204` | sink retyped as an async sink split across three lines (`) => Promise<void>;`) | ❌ 6 pass, 0 fail |
| E | `ownership.test.ts:225` | new module writing to `homedir()` through the repo's own `atomicWriteText` | ❌ 15 pass, 0 fail |
| F | `ownership.test.ts:225` | new module writing to `process.env["HOME"]` via `writeFileSync` | ❌ 15 pass, 0 fail |
| G | `verdict-vocabulary-census.test.ts` | new `src/core/zz-new-vocab.ts` with a duplicate value, a phantom member and a guard that accepts anything | ❌ 63 pass, 0 fail |
| H | `progress-token.test.ts:124` "the response frame is **identical**…" | `result.content` replaced wholesale when a progress token is present | ❌ 1 pass, 0 fail |
| I | **the entire `tests/mcp` + progress suite** | reverted this branch's own fix `354cbd19` — `dispatchByView` drops `onProgress` again | ❌ **882 pass, 0 fail** |
| J | `concurrent-shared-writes.test.ts:250` "the manifest stays parseable JSON" | lock removed from `updateManifest` | ❌ passes while 74 entries are silently lost |

---

## 2. Findings, most severe first

### F1 — A fix made *inside this branch* has no test; reverting it leaves 882 tests green — CONFIRMED

`src/mcp/brain/shared.ts:204` · commit `354cbd19` "fix(mcp): the view dispatcher forwards the sink instead of dropping it"

```ts
  return handler(ctx, args, onProgress);
```

Changing that one line back to `return handler(ctx, args);` — i.e. re-introducing exactly the defect
the branch found and fixed — leaves `bun test tests/mcp tests/cli/progress-rail.test.ts
tests/core/architecture/progress-census.test.ts` at **882 pass / 0 fail**. `grep -rn dispatchByView
tests/` returns nothing. `tests/mcp/long-running-tools.test.ts:244` exercises `brain_maintenance`'s
own fan-out, not the view dispatcher.

The consumer that made the fix necessary is `brain_brief` `view: "operator"`
(`src/mcp/brain/brief-tools.ts:495` → `:368`, which forwards the sink into a dry-run `dream`). No
test sends a `progressToken` to `brain_brief`. This is the single most important gap on the branch:
the release's whole argument is that a silent stream and a working stream must be distinguishable,
and the one regression that would collapse them again is undetectable by its own suite.

### F2 — The progress census has four syntactic bypasses — CONFIRMED

`tests/core/architecture/progress-census.test.ts:92`, `:116`, `:160`, `:204`

**Population it claims to cover:** "an interface that takes a safeguard takes a progress sink, or
carries a written reason why it cannot" (`:16-17`), plus "every `stage:` literal handed to the
counter is an IDENTIFIER" (`:21`) and "the sink type is synchronous" (`:26`).

**What it actually enumerates:** files under `src/` whose text contains the literal `safeguard?:`
(`:122`), then regions opened by `/(?:export\s+)?interface\s+(\w+)[^{]*\{/` (`:94`) whose body
matches `/\breadonly safeguard\?:/` (`:124`); for stages, only files containing the literal
`progressCounter(` (`:169`), scanned by `/\bstart\(\s*(?:[A-Z_]+\.\w+|"([^"]*)")|advance\(\s*"([^"]*)"/`
(`:165`); for sync-ness, single lines containing both `onProgress?:` and `Promise<` (`:213-214`).

Four things a future contributor could write that it would miss — each verified green above:

1. **A type alias instead of an interface** (row A). `type FooOptions = { readonly safeguard?: Safeguard }`
   with no sink is invisible: `interfaceBlocks` only matches the `interface` keyword. This is not
   exotic — it is the normal TS alternative and reviewers do not distinguish them.
2. **`safeguard?:` without `readonly`** (row B). The file filter at `:122` matches, the block filter
   at `:124` does not, so the interface is not even counted in `guarded`.
3. **A template-literal or single-quoted stage** (row C). ``advance(`walking the project tree`)``
   sails through; the very prose the census exists to ban is admitted by the quoting style.
   Additionally, only files that *call* `progressCounter(` are scanned at all, so a helper that
   receives a `ProgressCounter` as a parameter and emits from another module is out of the population
   entirely.
4. **A multi-line async sink** (row D). The check is line-based, so
   `readonly onProgress?: (\n  event: ProgressEvent,\n) => Promise<void>;` passes — and so would any
   sink typed through a named alias.

Two further weaknesses that need no experiment: `interfaceBlocks` walks braces without skipping
string or comment content, so a `"{"` in an interface body mis-terminates the block and silently
re-attributes members; and the `readonly onProgress?:` check is purely declarative — an interface can
declare the sink and never call it and the census is satisfied.

The exemption discipline is also thinner than it reads: `:154` only requires
`reason.length >= 80` and the absence of "TODO"/"for now"/"later". Eighty characters of plausible
prose is not a high bar for an exemption that disables the rule for one interface.

### F3 — The ownership completeness census misses the repository's own write idiom — CONFIRMED

`tests/core/install/ownership.test.ts:167`, `:190`, `:150`

**Population it claims to cover:** "every module that writes to a home-, XDG- or temp-rooted path"
(`:13-14`), so that "a new out-of-vault location cannot be added without the sentence learning about
it" (`:15-16`).

**What it actually enumerates:** files under `src/`, `hooks/`, `plugins/` (`:150`) whose
comment-stripped source matches an anchor regex (`:158`) **and** matches
`/(?:writeFileSync|appendFileSync|mkdirSync|symlinkSync|copyFileSync|mkdtempSync)\(/` (`:167`).

Two concrete misses, both verified green:

- **Row E — the house atomic-write helper.** `atomicWriteText(...)` / `atomicWriteFileSync(...)` from
  `src/core/fs-atomic.ts` do not appear in `WRITE_RE`. A module that writes into `homedir()` through
  the repository's *documented* durable-write path — the one every config writer uses — is not in the
  population at all. This is the likeliest way the next out-of-vault location gets added.
- **Row F — `process.env["HOME"]`.** The anchor regex (`:158`) knows `homedir()` and `env.home` but
  not `process.env["HOME"]` (which already appears at `src/core/doctor-readiness.ts:367`) or
  `USERPROFILE`.

Lower severity, same shape: `SWEPT_ROOTS` (`:150`) omits `scripts/`, which ships in `package.json`
`files`; deletions outside the vault (`rmSync`, `unlinkSync`, `renameSync`) are not in `WRITE_RE` at
all, so a module that *removes* out-of-vault state is never enrolled; and the comment stripper
(`:176`) also truncates any line after a `//` inside a string literal.

The `expect(sweep().length).toBeGreaterThan(8)` guard at `:222` protects against the regex dying
entirely, which is real value — but it cannot detect a regex that covers eight of the ten families.

### F4 — The verdict-vocabulary census is a consistency check, not a census — CONFIRMED

`tests/core/architecture/verdict-vocabulary-census.test.ts` (whole file; the branch adds 18 entries,
`:691-895`)

**Population it claims to cover:** by name and by placement beside the write-site and doctor-exit
censuses, the repository's closed verdict vocabularies.

**What it actually enumerates:** a hand-written `CENSUS` array of imports. `grep -n
'readdirSync\|readFileSync\|import.meta.dir'` over the file returns **nothing** — it reads no source
at any point. Every other census on this branch derives its population from the tree; this one does
not, and its docblock does not say so.

Row G: I added `src/core/zz-new-vocab.ts` carrying a frozen object with a duplicate value, a
membership list naming a member no value declares, and a guard that accepts every string — three of
the exact defects `auditVocabulary` exists to detect — and the file ran **63 pass / 0 fail**. Nothing
in the repository requires vocabulary #82 to be registered. The idiom's durability rests entirely on
authors remembering, which is the property the branch's own CHANGELOG argues is insufficient ("a
mechanism which must be called by hand is a mechanism that will be missed").

The drift tests at `:701-767` ("the census itself catches drift") are genuine and I confirmed one of
them by mutation (row 19). They prove `auditVocabulary` works; they do not prove the registry is
complete.

### F5 — The MCP byte-identity claim does not measure the field a client reads — CONFIRMED

`tests/mcp/progress-token.test.ts:73-79`, `:124`

```ts
function stripRunId(frame: JsonObject | undefined): string {
  const clone = JSON.parse(JSON.stringify(frame)) as Record<string, any>;
  delete clone["result"]["content"];              // ← the whole rendered payload
  delete clone["result"]["structuredContent"]["run_id"];
  return JSON.stringify(clone);
}
```

The file header claims (`:13`) "a call with no token is byte-identical to the call the previous
release made, which is what makes the feature additive". `result.content` is the rendered text an
MCP client actually displays. Deleting the entire array — rather than masking the `run_id` *inside*
it, which is all the justification at `:71-74` argues for — means any other divergence in `content`
is unmeasured. Row H: replacing `content` wholesale with
`[{type:"text",text:"WATCHED-RUN-DIFFERENT-BYTES"}]` whenever a progress token is present leaves the
test green. The fix is a one-line change: normalise the run id inside `content` instead of dropping
the member.

By contrast the same test *does* catch a `structuredContent` divergence (row 14), so the claim is
half-measured, not unmeasured.

### F6 — The hook-ceiling relation test pins the default and leaves the override unbounded — CONFIRMED

`hooks/lib/process-ceiling.ts:67-75` · `tests/hooks/process-ceiling.test.ts:131`

The module docblock (`:35-38`) states the test "asserts the RELATION between the two rather than
either number - so changing one without the other fails there instead of silently disarming the
watchdog again". The test asserts `DEFAULT_HOOK_CEILING_MS === hostMs - HEADROOM` and reads
`hooks/hooks.json`. Two gaps:

1. **`resolveHookCeilingMs` has a floor and no ceiling.** `OPEN_SECOND_BRAIN_HOOK_CEILING_MS=60000`
   returns 60 000 against a 10 s host timeout — precisely the "55 s behind a declared 10 s" state the
   docblock says was the bug — and no test covers it. The relation is enforced for the value nobody
   sets and unenforced for the value an operator can set.
2. **A second, unswept declaration of the same host timeout.** `src/core/install/grok-asset.ts:121`
   hard-codes `timeout: 10` into every hook entry the grok installer writes. The test only parses
   `hooks/hooks.json`, so lowering grok's timeout to 5 while leaving `hooks.json` at 10 keeps the
   suite green with an 8 s self-ceiling behind a 5 s host deadline.

`HOOK_HOST_TIMEOUT_SECONDS` also changes the shipped default from 55 s to 8 s, which is a real
behaviour change for anyone whose hooks legitimately take 10–55 s, and it is documented nowhere (see
F9).

### F7 — README's headline "we deliberately did not build this" claim is now false — CONFIRMED

`README.md:15` (untouched by this branch):

> There is no registry of embedding-provider shutdown dates, because the only way to build one is a
> hand-maintained table over an open set of endpoints that would rot in place and be believed.

`src/core/search/embeddings/sunset.ts:328` ships `EMBEDDING_SUNSET_SURVEY` — a hand-maintained table
of models with `sunsetAt` dates and per-row `source` strings, stamped `reviewedAt: "2026-08-15"`,
consumed by the new doctor check at `src/core/brain/doctor/embedding-sunset-check.ts:241`. The module
concedes the rot problem and works around it with a 365-day expiry
(`EMBEDDING_SUNSET_SURVEY_HORIZON_DAYS`, `sunset.ts:239`) — which is a good design, and is exactly
the thing the README says cannot be built. A previous release's stated refusal is now a shipped
feature and the README still advertises the refusal.

This is the strongest class of stale statement the branch produced: not an omitted flag, but a claim
about the project's judgement that its own code contradicts.

### F8 — `docs/observability.md` contradicts itself on the token-impact vocabulary — CONFIRMED

The branch renames `TOKEN_COUNT_METHOD` from `exact`/`fallback` to `tokenizer`/`heuristic`
(`src/core/brain/token-impact.ts:83-88`; the retired labels survive read-only at `:108-110`), updates
`docs/observability.md:103`, and leaves two sites behind:

- `docs/observability.md:42` — "the `method` label (`exact`/`fallback`)". The same file now says both.
- `docs/mcp.md:155` — "`method` exact/fallback" and "`summary` keeps **EXACT** prompt-token savings".

The advertised MCP input-schema enum is now `["tokenizer","heuristic"]`
(`src/mcp/brain/recall-tools.ts:1176`), so a client written from `docs/mcp.md:155` sends a value the
tool rejects.

Related and unresolved: the `summary` **response** keys moved from `by_method.exact` /
`by_method.fallback` to `by_method.tokenizer` / `by_method.heuristic`
(`src/core/brain/token-impact.ts:445-451` vs `main`). `docs/stability.md:12-16` and `:78-84` classify
renaming a documented response field as breaking, and `docs/updating.md` carries no migration note.
Either the rename needs a note or the policy needs an exception — the current state satisfies
neither. **CONFIRMED** as an inconsistency; whether it is a policy violation is a maintainer call.

### F9 — Six user-visible surfaces this branch adds are documented nowhere — CONFIRMED

Verified by grep across `docs/` and `README.md`:

| Surface | Code |
|---|---|
| Doctor check `recovery-point-liveness` and codes `recovery-point-stale` / `recovery-point-unmeasured` | `src/core/brain/doctor/recovery-point-liveness.ts:65,68`; registered `src/core/brain/doctor.ts:168` |
| Doctor check `embedding-sunset-check` and codes `embedding-model-sunset-announced` / `-unsurveyed` / `-undetermined` | `src/core/brain/doctor/embedding-sunset-check.ts:78-84` |
| Config block `embeddings:` with `sunset_model` / `sunset_at` (both-or-neither), written as a commented example into every new `_brain.yaml` | `src/core/brain/policy/blocks/embeddings.ts`; `src/core/brain/config-template.ts` |
| `embedding_concurrency` is now a **process-wide** ceiling shared per provider endpoint, and two live configs that disagree now **throw** | `src/core/search/embeddings/provider-semaphore.ts:88-104` |
| Install "ownership" close-out block, `install --json` `data_ownership` + a new `schema_version: 1` on the apply payload, `onboarding --json` `data_ownership` | `src/core/install/ownership.ts:296-328`; `src/cli/install/render.ts:39,50,60` |
| Hook self-ceiling default 55 s → 8 s, and the `OPEN_SECOND_BRAIN_HOOK_CEILING_MS` override | `hooks/lib/process-ceiling.ts:46-57,70` |

The precedent the branch itself sets makes the doctor omissions conspicuous: `recall-channel-silent`
/ `recall-channel-unmeasured` got a twenty-line section at `docs/cli-reference.md:678-698` for exactly
this shape of check. `sunset` appears nowhere in `docs/` or `README.md` outside `docs/brainstorm/`.

The `embedding_concurrency` change deserves separate weight: it is a **semantic** change to an
existing operator-facing key (per-call → per-process) plus a new runtime `SearchError` an operator can
now hit, and the key appears in no `docs/*.md` file at all.

### F10 — `docs/cli-reference.md` flag listings drifted inside this branch's own edits — CONFIRMED

- `:836-847` — the `search reindex` block lists `--force-cost`, `--embeddings`, `--concurrency`,
  `--db`, `--verbose`, `--cron-template`, `--interval`, `--self-heal` and **not** `--progress`, while
  `src/cli/search/verbs/indexing.ts:233` parses it and `src/cli/command-manifest.ts:548` declares it.
  The sibling `index` line at `:848` *was* updated in the same commit.
- `:703`, `:116` — the `brain dream` forms carry no `--progress`, while `architect` (`:273`),
  `maintenance run` (`:325`), `bridges discover` (`:335`) and `clusters run` (`:336`) all received it.
  Only the prose at `:724` covers dream, by inference.
- `:261` — "`o2b brain bench memory` … quality, latency, and context cost reported separately" is now
  wrong on three counts: four families not three, `o2b.bench.v2` not v1
  (`src/core/bench/types.ts:23`), and `context_cost.est_tokens` renamed to `avg_injected_tokens`.
  `docs/observability.md:107` was updated for all of it; `cli-reference.md:261` was not.
- `docs/mcp.md:109` — "The MCP surface that can genuinely run for minutes is `brain_dream`,
  `brain_bridges`, `brain_clusters` and `brain_maintenance`." `brain_brief` `view: "operator"` also
  emits (`src/mcp/brain/brief-tools.ts:368`), and its own code comment calls it "the slow half of an
  operator summary on a large vault". A client sending a token to `brain_brief` gets frames the doc
  says it will not. (This is F1's blind spot, seen from the documentation side.)
- `docs/cli-reference.md:328` — "A maintenance gate skip exits 0 so cron never alarms on a quiet
  hour", immediately above the new paragraph introducing `failure_streak_limit`. A task refused by the
  streak limit lands with `ok: false` (`src/core/brain/maintenance/lane.ts:341`) and the verb returns
  1 (`src/cli/brain/verbs/maintenance.ts:275`). The new paragraph never says the run exits 1, nor
  that task results gained `refused` / `failure_streak` fields. An operator reading the two paragraphs
  in order will be surprised by a cron alarm. — CONFIRMED (the older sentence is still true for gate
  skips; the omission is in the new text).

### F11 — Ctrl-C is a headline documented behaviour with no end-to-end test — CONFIRMED

`docs/cli-reference.md:724` promises: "Ctrl-C (or SIGTERM) now reaches these operations: the run
stops at the next checkpoint and exits **130** (SIGINT) or **143** (SIGTERM) … and a second interrupt
is not intercepted".

What is actually tested:

- `tests/cli/progress-report.test.ts:85,103` calls `onInterrupt()` and then calls
  `reportInterrupted(handle, new SafeguardAbortError(...), …)`. No signal is ever delivered, so
  `handle.received()` is `null` and `exitCode()` returns `EXIT_INTERRUPTED` **by its own fallback**
  (`src/cli/interrupt.ts:97`) — the SIGINT branch of `EXIT_FOR_SIGNAL` is never taken.
- `tests/cli/brain-dream-progress.test.ts:119` asserts `EXIT_INTERRUPTED === 130`, a constant against
  a literal.

`grep -rn SIGINT tests/` shows the only real signal delivery on the branch is
`tests/cli/brain-explorer.test.ts:190`, an unrelated verb. `EXIT_TERMINATED` (143) is referenced by
**no** file in `src/` or `tests/` other than its own declaration. Nothing proves that a real SIGINT
to `o2b brain dream --progress` aborts the pass, that the process exits 130, that SIGTERM exits 143,
or that a second interrupt is not intercepted. The file's own docblock argues a real race would be a
lottery, which is fair — but a `Bun.spawn` + `proc.kill("SIGINT")` after the first progress record
appears on stderr is deterministic and is the pattern `brain-explorer.test.ts` already uses.

### F12 — No CHANGELOG entry and no version bump — CONFIRMED

`git diff main...HEAD -- CHANGELOG.md package.json` is empty. `package.json` is still `1.47.0` and the
newest CHANGELOG heading is `## [1.47.0] - 2026-08-15`, describing the *previous* branch. `CLAUDE.md`
requires the entry, the bump and `bun run scripts/sync-version.ts` **inside the feature PR, before the
first push**, and states plainly why: a forgotten bump means `package.json` and the CHANGELOG heading
disagree on `main` and a second PR is needed. As it stands roughly twenty user-visible surfaces would
ship with no release note.

### F13 — Two tests whose names promise more than their bodies check — CONFIRMED

- `tests/core/brain/ingest/concurrent-shared-writes.test.ts:250` "the manifest stays parseable JSON
  after concurrent writers". Its only body assertion is
  `expect(() => JSON.parse(readFileSync(manifestPath(vault)))).not.toThrow()`. Row J: with the lock
  removed from `updateManifest` and 74 of 100 entries lost, this test passes. It sits directly beside
  a test that *does* catch the same break (row 15), so nothing is lost — but as written it is a
  tautology over any well-formed JSON, including `{}`.
- `tests/cli/brain-architect-progress.test.ts:83` "without the flag nobody is watching, and **the run
  is unchanged**" only asserts `returncode === 0` and zero progress records on stderr. "The run is
  unchanged" is checked in a different test (`:63`, `watched.stdout === warm.stdout`); this one's name
  claims a property it does not measure. The same name and body appear in four sibling files.

### F14 — Weak or self-fulfilling assertions found by a second pass — CONFIRMED unless noted

There are **no** `.skip`, `.only`, `.todo`, `.failing`, `skipIf`, or environment-gated tests anywhere
in the 64 changed test files, and no missing `await` on a `.rejects` (commit `761c1877` fixed the one
that existed). The remaining weak spots:

- `tests/cli/brain-dream-progress.test.ts:99` — the "integers and identifiers only" loop has **no**
  `records.length > 0` guard, unlike all five sibling files (`brain-architect-progress.test.ts:74`,
  `brain-bridges-progress.test.ts:68`, `brain-clusters-progress.test.ts:72`,
  `brain-maintenance-progress.test.ts:94`, `search-index-progress.test.ts:75`). Removing `--progress`
  wiring from `o2b brain dream` entirely leaves it green.
- `tests/cli/install-vault-resolution.test.ts:75,81,100` — `canonical()` is
  `resolveVault(configPath) ?? ""` and `resolveInstallVault(null, configPath)` is
  `resolveVault(configPath) ?? ""` (`src/cli/install/install.ts:137-139`). Three assertions compare an
  expression to itself. The file's docblock claims precedence is "pinned by COMPARISON… so a future
  edit to either chain fails this file"; that is false for those three lines (`:74` and `:80` are
  real).
- `tests/cli/progress-rail.test.ts:125` — `expect(progressIsLegal(s)).toBe(!advisoryIsLegal(s))` under
  `jsonRequested: true` is `X === !(!X)` over one shared helper (`progress-rail.ts:93` vs
  `advisory-rail.ts:87`). It did catch row 7 because the mutation broke the shared expression, but as
  a statement about the two rails agreeing it is a tautology. The `jsonRequested: false` loop at
  `:128` is meaningful.
- `tests/core/brain/token-impact.test.ts:291` "records already on disk under the **old** labels are
  still classified" — the comment says "Exactly what the pre-rename code path wrote" but the two
  appended payloads at `:299` and `:305` use `method: "tokenizer"` / `"heuristic"`, the *new* labels.
  The legacy translation at `src/core/brain/token-impact.ts:420` is never exercised through the
  integration path the test names. A change that filtered legacy rows out of `total_samples` — the
  exact regression named — stays green.
- `tests/core/brain/maintenance/host-pressure.test.ts:107` — every assertion is a `typeof` check or
  `expect([measured, unmeasurable]).toContain(reading.state)` over a two-member closed vocabulary.
  Returning `{platform:"", loadAverage1m:NaN, cpuCount:0}` from the real probe leaves it green.
- `tests/helpers/progress-records.ts:28-33` swallows `JSON.parse` failures with `catch { continue; }`.
  Positive uses are safe; the eleven **negative** assertions built on it
  (`brain-architect-progress.test.ts:68,84`, `brain-bridges-progress.test.ts:62,78`,
  `brain-clusters-progress.test.ts:66,85`, `brain-maintenance-progress.test.ts:82,104`,
  `search-index-progress.test.ts:69,96,115`) would all still read `toHaveLength(0)` if a verb
  regressed to emitting *malformed* progress JSON without the flag.
- `tests/cli/install-json-shape.test.ts:162` runs `toContain("manifest")` against a comma-**joined
  string**, so it is substring matching and `manifest_path` would satisfy it. The other three payloads
  in the file are pinned with exact key sets.
- `tests/core/vault-backing.test.ts:171` "the verdict is a function of the filesystem alone" calls a
  pure function twice with the same stub and compares — tautological for a pure function.
- `tests/core/brain/sessions/adapter-registry.test.ts:81` — bare `.toThrow()` with no matcher, in a
  file that elsewhere matches `/claude/`.
- `tests/core/brain/policy/embeddings-block.test.ts:93-99` throws a sentinel inside the `try` whose own
  `catch` asserts on it; it passes today only because the sentinel text does not contain `sunset_at`.
  PLAUSIBLE, low.

### F15 — Timeout budgets that could mask a hang — PLAUSIBLE, by design

`tests/helpers/cli-timeout.ts:41` sets `CLI_SPAWN_BUDGET_MS = 60_000` and six files call
`setDefaultTimeout` with it (`cli.test.ts:19`, `cli-json-contract.test.ts:11`,
`config-read-failure-surfaces.test.ts:38`, `doctor-exit.test.ts:29`, `install-verb.test.ts:29`,
`run-cli-helper.test.ts:19`), replacing previously targeted 30 s markers. The rationale — measured
cold-spawn cost, no working project-wide knob on bun 1.3.14 — is documented and sound, but the cost is
that a CLI path regressing to a 40 s hang now passes silently across six files.

Three assertions are scheduling-races in the *test*, not in the code:
`tests/core/maintenance/self-heal-reindex.test.ts:126` asserts a detached child has **not** finished
at the instant the parent returned; `tests/core/search/benchmark-concurrency.test.ts:61` asserts exact
saturation equality (`toBe(BENCHMARK_QUERY_CONCURRENCY)`) rather than `toBeLessThanOrEqual` plus a
floor; and the exact `probe.peak` equalities in `embeddings.concurrency-ceiling.test.ts` rest on a
25 ms stub latency. All three are the kind that go red on an unusually fast or unusually loaded
runner.

Two tests `chmod 0o000` a directory (`tests/core/discipline/transcripts/scan-states.test.ts:53`,
`tests/core/brain/doctor/recovery-point-liveness.test.ts:139`). Under a root UID — common in container
CI — the read succeeds and these fail loudly rather than passing silently, so the risk is a red build,
not a false green.

---

## 3. What I checked and found sound

**The re-measured byte-identity claim is legitimate — verified.**
`tests/core/brain/snapshot-gate-coverage.test.ts:227` re-pins the dream-output digest from
`6ef6ceb…` to `1944a334…`, with `_brain.yaml` newly excluded from the row set (`:137-145`). The
comment claims "the replacement literal was taken from `main` with the same exclusion applied, and
this branch reproduces it — so it is still a number from a tree without the units it guards". I tested
that claim directly: I created a worktree at `main` (`aa818084`), copied **this branch's** test file
into it unchanged, and ran it — **16 pass / 0 fail**. The digest is a measurement against a tree that
does not contain the units it guards, not a recomputed expectation. The exclusion argument is also
correct: `_brain.yaml` is bootstrap output that `dream` reads and never writes back.

**Byte-identity claims that hold up.** The architect collation fix is proved the hard way — two child
processes, one with a reversed `String.prototype.localeCompare` installed *before* the generator is
imported, comparing rendered bytes (rows 1 and the test's own note that `LC_ALL` alone cannot prove
it, since `Intl.Collator` resolves to `en-US` regardless). `--progress` leaves `--json` stdout
untouched (row 20). `--readiness` leaves the base doctor output untouched (row 24, prefix check). The
config template's live surface and resolved-behaviour identity are both real (row 25).

**Censuses that are genuinely adversarial.** `tests/core/brain/doctor-exit-census.test.ts` enumerates
its population recursively from `src/core/brain/doctor/`, reads two code shapes, and carries a
separate test for the third shape that neither scan can read — I tried both a new unregistered `*_CODE`
constant (row 17) and a computed `code:` expression (row 18) and it named each one. This is the model
the other three censuses should follow.

**Race tests that are real races.** `tests/core/brain/ingest/concurrent-shared-writes.test.ts` spawns
four genuine `bun` children behind a 1.5 s start barrier; removing the lock from `updateManifest` loses
74 of 100 entries and the test names every one (row 15). The semaphore hand-off test constructs the
exact microtask interleaving the pool form loses (row 9), and the process-wide ceiling tests
distinguish four separate identity axes (row 10).

**Negative controls that are non-vacuous.** `failure-modes.test.ts:250` "the strict gate is what
isolates: without it the same fixture leaks" runs the *shipped default* and asserts the leak, so the
gate assertion elsewhere cannot pass for a reason unrelated to isolation; `:278` asserts the converse
(isolation that withholds the caller's own memory is also a failure). `:197` charges a `faulted`
retriever to neither rate. `progress-census.test.ts:133` and `ownership.test.ts:219` both guard against
a sweep that found nothing.

**Documentation that is accurate.** The architect paragraph at `docs/how-it-works.md:1221-1231` — the
single walk, the dot-directory rule, the exact skip list (`node_modules`, `dist`, `build`, `out`,
`coverage`, `vendor`, `target`, `venv`, `__pycache__`), the two stage names and the per-directory
deadline — matches `src/core/brain/architect/scan.ts:34-44,71,130` and `generate.ts:330` exactly.
`docs/metrics.md:69,75-82` and `docs/updating.md:92-100` describe the `self_heal_reindex` two-process
surface correctly. The MCP progress-token section (`docs/mcp.md:51-118`) is accurate apart from the
"which tools report" list (F10). `docs/observability.md:107` is accurate and thorough about what the
bench numbers do *not* say.

**`docs/architecture.md` correctly left untouched.** It is a layer/adapter/responsibility document
(`:5-27`, `:31-60`); nothing this branch changed contradicts it, and `:45` ("expose readiness
diagnostics") remains true under the fail→unknown reclassification.

**`README.md` NOT correctly left untouched** — see F7. Beyond that, `README.md:11` still opens "Open
Second Brain **1.46.0** is about…" while `package.json` says 1.47.0 (pre-existing on `main`, but this
is the natural branch to fix it), and the branch's headline surfaces — a progress rail on every long
pass, Ctrl-C that actually stops a run, MCP progress notifications — are exactly the shape of change
`README.md:105-120` documents for other releases and are absent. `README.md:108` ("An index that
survives interruption") now reads as the narrow case of a general capability.

---

## 4. Recommended order of work

1. Write a test for `dispatchByView` sink forwarding (F1) — send a `progressToken` to `brain_brief`
   `view: "operator"` and assert notification frames arrive.
2. Fix the four progress-census bypasses (F2): match `type X = {` as well as `interface X {`, drop the
   `readonly` requirement from the field pattern, scan for `advance(`/`start(` in every file that
   imports `ProgressCounter` rather than only those calling `progressCounter(`, and normalise
   whitespace before the `Promise<` check.
3. Add `atomicWrite*` and `process.env["HOME"]` to the ownership sweep (F3); add `scripts/` to
   `SWEPT_ROOTS`.
4. Fix `stripRunId` to mask the run id inside `content` instead of deleting the member (F5).
5. Cap `resolveHookCeilingMs` at `HOOK_HOST_TIMEOUT_SECONDS * 1000`, and sweep
   `src/core/install/grok-asset.ts:121` into the relation test (F6).
6. Correct `README.md:15` (F7), `docs/observability.md:42` and `docs/mcp.md:155` (F8).
7. Document the six undocumented surfaces (F9) and fix the five drifted doc statements (F10).
8. Add one real-signal interrupt test (F11).
9. CHANGELOG entry + version bump + `sync-version.ts` (F12).
10. Enumerate the verdict-vocabulary population from source, or state in the file that it is a
    registry rather than a census (F4).

---

## 5. Proof the tree was left clean

Every mutation above was applied inside disposable `git worktree` copies under the session scratchpad,
never in `/srv/projects/open-second-brain`, and each was reverted with `git checkout --` immediately
after its test run. Both scratch worktrees were removed with `git worktree remove --force` and
`git worktree prune`.

```
$ git status --short
?? docs/brainstorm/nothing-runs-unwatched/review/
```

The single untracked entry is the `review/` directory holding this file. No tracked file in the
repository was modified and nothing was committed.
