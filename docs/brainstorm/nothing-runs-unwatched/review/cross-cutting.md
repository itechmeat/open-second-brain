# Cross-cutting review — the seams, and the release's argument turned on itself

**Branch:** `feat/nothing-runs-unwatched` · **Base:** `main` · 61 commits, 173 files, +19585/−761
**Scope:** the seams between the four other reviewers — declared-surface reachability, damage from nine
concurrent agents, import cycles and layering, the commit record, operator-surface consistency.
**Not covered here** (other reviewers): the progress spine's own correctness, cancellation semantics,
the honesty of individual claims, locking and race analysis, test/doc completeness per unit.

**Anchors.** Every `path:LINE` below is against branch HEAD `751fbb17`, verified after the fact.
One caveat: while this review was in progress, `src/core/brain/progress.ts` acquired an **uncommitted
working-tree modification** made by something other than me — it adds a `PROGRESS_REASON.failed`
member, a `terminated` one-ending guard on the counter, a positive-integer check on `advance`, and
makes `withProgress`/`withProgressAsync` always emit a terminator. I left it alone rather than revert
another worker's edit. It shifts `src/core/brain/progress.ts` lines after `:117` by +13 and after
`:216` by a further +13; the findings below are unaffected by it, and the new `failed` member **is**
reachable (any throw inside `withProgress` at `bridge-discovery.ts:104`, `communities.ts:95`,
`indexer.ts:327`, `vector-backfill.ts:104`). Worth noting only because it is the same shared-tree
concurrency this review is about, still running.

The branch's thesis: *a system that does long work silently cannot be trusted, and a declared surface
with no producer is a defect.* It caught itself four times during construction. Applying the same
test to the release itself finds **six more declared surfaces with no producer**, five of them added
by this branch, plus one documented claim that is false.

The pattern behind almost all of them is the same, and it is the pattern nine concurrent agents
produce: a mechanism is built, a census or a doc is written asserting it is universal, and the census
checks the half the author could see. `progress-census.test.ts` checks that interfaces *declare* a
sink and never that a caller *passes* one. `docs/mcp.md` asserts four tools are bounded and the agent
who wrote it had edited three of them. `verdict-vocabulary-census.test.ts` checks that a vocabulary's
three parts agree and explicitly waives whether any member is reachable.

| # | finding | severity |
|---|---|---|
| F1 | `docs/mcp.md:116` claims `brain_dream` runs under a deadline; it has none | **high** |
| F2 | The whole `--progress` refusal path is unreachable in every shipped invocation | **high** |
| F3 | `refused` documented as a CLI stream kind that cannot be emitted there | medium |
| F4 | `dream stage\|validate\|apply --progress` parsed, threaded, and dropped in silence | **high** |
| F5 | `vector-backfill` grew the whole spine with no flag, no caller, no cancel | **high** |
| F6 | Three shapes for "the sink threw"; four of six emitters have none | medium |
| F7 | `maintenance run --json` omits `interrupted` where five siblings carry it | medium |
| F8 | `--progress` discoverable on 2 of 7 verbs; invisible on `brain dream` | medium |
| F9 | `completed` means "finished" in four emitters and "started" in the index run | medium |
| F10 | Two shapes for a new policy block; one docblock now documents the wrong symbol | low |
| F11 | A ninth lock-retry ladder beside a generic helper that already existed | low |
| F12 | Five new core→`progress.ts` edges the import-cycle ratchet cannot see | low (latent) |
| F13 | Half-applied seams; a hand-rolled copy of a shared test helper | low |
| F14 | Orphan exports; one vocabulary missing from the census that claims completeness | low |
| F15 | Two spellings for "could not determine" in one release | low |
| F16 | Five new doctor codes and one new config block documented nowhere | low |

---

## Findings

### F1 — `docs/mcp.md:116` says `brain_dream` runs under a deadline. It runs under none. CONFIRMED

`docs/mcp.md:109-118`, added by this branch in commit `e44ee1ae` ("feat(mcp): **the four long tools
are bounded** and observed"), states:

> The MCP surface that can genuinely run for minutes is `brain_dream`, `brain_bridges`,
> `brain_clusters` and `brain_maintenance`. … **Every one of those four also runs under a cooperative
> deadline** resolved from `safeguard_timeout_<operation>_seconds`, then `safeguard_timeout_seconds`,
> then the built-in default.

`grep -c 'safeguard\|Safeguard' src/mcp/brain/feedback-tools.ts` returns **0**. The tool's two `dream()`
call sites — `src/mcp/brain/feedback-tools.ts:469` (the count-guard preview) and
`src/mcp/brain/feedback-tools.ts:491` (the real pass) — pass `dryRun`, `now`, `agentName`, `gates` and
`onProgress`. No `safeguard`. No `signal`.

Commit `e44ee1ae` touched `src/mcp/brain/admin-tools.ts` and `src/mcp/brain/knowledge-tools.ts` and
added safeguards to `brain_bridges` (`knowledge-tools.ts:199`) and `brain_clusters`
(`knowledge-tools.ts:282`). `brain_maintenance` already had one (`admin-tools.ts:300`).
`src/mcp/brain/feedback-tools.ts` was never in that commit — it had been edited by a *different* agent
three commits earlier (`836bd626`, the progress token) to accept `onProgress`. One agent wired progress
into `brain_dream`; another agent bounded three tools and wrote a doc claiming four.

**Failure scenario.** An MCP client calls `brain_dream` with `action: "run"` on a large vault. The pass
walks the whole Brain tree synchronously. There is no deadline to trip and no signal to abort, and
because `dream()` is synchronous the server's event loop is blocked for its entire duration — so the
client cannot even time out and reissue. The operator's `safeguard_timeout_dream_seconds` setting,
which the doc tells them governs this call, does nothing.

`tests/mcp/long-running-tools.test.ts` — the file whose header says "a deadline and a progress tick sit
at the same … safeguard checkpoints" — asserts the deadline for exactly two tools:
`brain_bridges` (`:122`) and `brain_clusters` (`:141`). Nothing asserts it for `brain_dream` or
`brain_maintenance`. The claim is a comment, and the test that would have caught it was not written.

Same class, same file: `brain_brief view=operator` (`src/mcp/brain/brief-tools.ts:366-369`) runs a
full dry-run `dream()` with `onProgress` and **no** safeguard. It is a fifth progress-emitting MCP
tool, absent from the doc's list of four, unbounded and uncancellable.

And its CLI twin was not touched at all: `src/cli/brain/verbs/summary.ts:40` calls
`dream(vault, { dryRun: true })` — no sink, no safeguard, no `onInterrupt()`, no `--progress` flag.
One agent fixed the MCP copy of this call (and wrote a fresh comment there calling it "the slow half
of an operator summary on a large vault"); the CLI copy of the identical call is unchanged.
`src/core/brain/review-candidates.ts:102` is a third instance of the same dry-run `dream()` with none
of the three.

Two agents also invented two safeguard factories for the same job rather than sharing one:
`graphSafeguard` (`src/mcp/brain/knowledge-tools.ts:102-110`) and `laneSafeguard`
(`src/mcp/brain/admin-tools.ts:297-303`).

---

### F2 — The entire `--progress` refusal path is unreachable in every shipped invocation. CONFIRMED

`src/cli/progress-rail.ts:91-94`:

```ts
export function progressIsLegal(stream: ProgressStream): boolean {
  if (!stream.jsonRequested) return true;
  return ownsInternalJson(stream.command, stream.argv);
}
```

`ownsInternalJson` (`src/cli/json-helpers.ts:68-73`) returns `true` immediately when
`COMMANDS_WITH_INTERNAL_JSON.has(command)`. That set (`src/cli/json-helpers.ts:45-58`) contains
`"brain"` and `"search"`.

Every production call site of `attachProgress` passes one of those two:

| call site | `command` |
|---|---|
| `src/cli/brain/verbs/dream.ts:407` | `"brain"` |
| `src/cli/brain/verbs/bridges.ts:160` | `"brain"` |
| `src/cli/brain/verbs/clusters.ts:267` | `"brain"` |
| `src/cli/brain/verbs/architect.ts:44` | `"brain"` |
| `src/cli/brain/verbs/maintenance.ts:150` | `"brain"` |
| `src/cli/search/verbs/indexing.ts:99-103` (index and reindex) | `"search"` |

So `progressIsLegal` is `() => true` for every input the shipped CLI can construct. Consequently:

- `PROGRESS_OUTCOME.suppressedBufferedStream` (`src/cli/progress-rail.ts:62`) has no producer.
- `PROGRESS_REASON.streamBuffered` (`src/core/brain/progress.ts:117`) has no producer.
- `ProgressAttachment.reason` (`src/cli/progress-rail.ts:124`) is never set.
- `reportProgressRefusal` (`src/cli/progress-rail.ts:178-186`) is a no-op at all six call sites; the
  line `progress: not emitted (<reason>)` (`src/cli/progress-rail.ts:185`) can never be printed.
- The `argv` field of `ProgressStream` (`src/cli/progress-rail.ts:45`) is decorative — `ownsInternalJson`
  short-circuits on `command` before reading it.
- `docs/cli-reference.md:724` promises "when a stream cannot carry it the verb says
  `progress: not emitted (<reason>)`". No operator will ever see that string.

The only exercise of the branch is `tests/cli/progress-rail.test.ts:50-59`, which constructs a stream
with `command: "cron-recipe"` — **not a top-level command**; `cron-recipe` is a *module* name
(`src/cli/cron-recipe.ts`). `src/cli/main.ts` dispatches no such command. The test passes because the
input is fabricated, so it cannot fail for any reason an operator can produce.

This is the branch's own rule ("no declared surfaces with no producer") violated by the branch's own
edge module, with 40 lines of docblock (`src/cli/progress-rail.ts:14-28`, `:78-89`) and a dedicated
test arguing for a branch nothing enters. **Defect**, not an honest rare state: the rail was written
against a hazard (`withJsonFallback` buffering stderr) that structurally cannot reach it.

---

### F3 — `PROGRESS_KIND.refused` is documented as a CLI stream kind and is never emitted there. CONFIRMED

`docs/cli-reference.md:724` states the NDJSON `kind` "is one of the schema's fixed set (`started`,
`advanced`, `finished`, `stopped`, **`refused`**)".

`progressCounter` (`src/core/brain/progress.ts:210-265`) has exactly four emit paths — `start` →
`started`, `advance` → `advanced`, `finish` → `finished`, `stop` → `stopped`. There is no `refuse()`.
The only `refused` value in the tree is `ProgressRefusal.kind` (`src/mcp/progress.ts:161`), a
**different shape** on a **different channel** (`result._meta` on an MCP response), never a
`ProgressEvent` and never on stderr.

A caller who writes a parser against the documented set will branch on a `kind` the CLI cannot produce.
Combined with F2, two of the five documented kinds are unreachable on the surface the sentence
describes.

The vocabulary member itself is defensible — the census test's own rationale (`tests/core/architecture/
verdict-vocabulary-census.test.ts:404-410`) accepts members with no producer so a guard can read a
future release's value. The **documentation** is the defect.

---

### F4 — `o2b brain dream stage|validate|apply --progress` parses the flag and drops it silently. CONFIRMED

`src/core/brain/dream-stage.ts:107` declares `onProgress`, with a paragraph of rationale ("a caller who
asked to watch a staged pass watches the same five stages"), and threads it to `dream()` at
`:252`, `:368` and `:407`.

Nothing passes it.

- CLI: `src/cli/brain/verbs/dream.ts:109` parses `progress`; the attachment is built at `:406-409`,
  which is **inside the `run` path**. The staged actions run earlier (`:249-253` for `stage`,
  `:270-274` for `validate`/`apply`) and construct their options as `{ now, safeguard, agentName }`.
- MCP: `src/mcp/brain/feedback-tools.ts:414` builds `stageOpts = { now, ...agentName }` and calls
  `stageDream(ctx.vault, stageOpts)` at `:417`, discarding the `onProgress` the handler received at
  `:343`.

**Failure scenario.** An agent driving `brain_dream` with `action: "stage"` over stdio sends a
`progressToken`. The server reads it (`src/mcp/server.ts:367`), builds a live sink, does **not** issue a
refusal (because `onProgress !== undefined`, `src/mcp/server.ts:372`), runs a full dry-run consolidation
pass, and emits zero notifications. The client is told nothing and sees nothing — which the module
header of `src/mcp/progress.ts:1-33` names as precisely the failure this unit exists to remove
("accepted by the wire and then discarded without a word").

Same shape on the CLI: `o2b brain maintenance status --progress` parses the flag
(`src/cli/brain/verbs/maintenance.ts:68`) and returns at `:82-102` before any attachment is made.

---

### F5 — `o2b search vector-backfill` grew the full spine on this branch and has no flag to reach it. CONFIRMED

Commit `c82c4e53` added to `src/core/search/vector-backfill.ts`: `onProgress` (`:63`), a run-owning
counter (`:98-104`), a stage (`:106`) and `withProgressAsync`. `signal` (`:57`) was already declared.

`src/cli/search/verbs/vector-backfill.ts:96-99` calls `planVectorBackfill(cfg, { apply, forceCost })`.
No `onProgress`, no `signal`, no `safeguard`, no `onInterrupt()`. The verb file was not touched by this
branch. `src/cli/command-manifest.ts:579` declares the command with no `progress` flag.

It is the third embedding-loop builder in the CLI — the same loop `search index` and `search reindex`
now report and can be stopped — and it is the only one left both unwatchable and un-interruptible.
`VectorBackfillOptions.onProgress` is a declared surface with **no producer anywhere in `src/`**.

This is exactly the gap `tests/core/architecture/progress-census.test.ts` was built to close, and it
does not close it: the census (`:116-135`) asserts that an interface *declaring* `safeguard?:` also
*declares* `onProgress?:`. It never asserts that any caller passes either. An interface can satisfy the
census and emit nothing to nobody, which is what happened here.

**The census's blind spot is the release's own argument, inverted.** The design doc's rule is
"a mechanism which must be called by hand is a mechanism that will be missed, and the answer is
declaration plus a census." The census that shipped checks the declaration half only. Every one of
F4, F5 and the row below is invisible to it.

The same blind spot leaves seven of the nine index-build call sites unwired. Only
`src/cli/search/verbs/indexing.ts:185` and `:259` (and the maintenance lanes at
`src/cli/brain/verbs/maintenance.ts:186` / `src/mcp/brain/admin-tools.ts:324`, which pass a safeguard
and a sink but nothing to `onFile`) supply the seam. These pass none of `safeguard`, `signal` or
`onProgress`:

| call site | what it is |
|---|---|
| `src/core/maintenance/ensure-current.ts:211` | `await reindexVault(config)` — the **foreground** self-heal, a full rebuild |
| `src/core/search/pipeline/store-open.ts:50` | `await reindexVault(config)` — auto-rebuild on store open |
| `src/cli/search/verbs/query.ts:96` | `await indexVault(cfg)` — auto-index before a query |
| `src/core/search/link-ratchet.ts:283` | `await indexVault(config, { force: true })` |
| `src/cli/search/verbs/watch.ts:59` | `indexVault(cfg, {…})` — no `onProgress` |

The foreground self-heal is the sharpest of these: `ensureVaultCurrent` in non-background mode runs an
unbounded, unobservable, uninterruptible full rebuild on a path that F13's own sibling
(`startSelfHealReindex`) took care to instrument in the background case.

**A latent non-terminating stream, of exactly the shape commit `751fbb17` claims to have removed.**
`scanProject` (`src/core/brain/architect/scan.ts:347-360`) builds its own counter, calls
`progress.start(ARCHITECT_STAGE.walk)` at `:351`, and **returns without `finish()` or `stop()`**. It
does not use `withProgress`, the helper written in that very commit for that very rule. It is safe
today only because its sole in-tree caller, `generateArchDocs` (`generate.ts:313`), owns a second
counter that terminates — but `ScanProjectOptions` is exported and advertises `onProgress`
(`scan.ts:144`), and a successful standalone `scanProject(root, { onProgress })` emits `started`,
`advanced`… and then silence, which is the shape of a completed, a crashed and a hung run at once.
The abort path *is* covered (`walkTree`, `scan.ts:214-228`). Latent, not live — but the exemption is
undocumented, so the next caller inherits it silently.

---

### F6 — Three shapes for "the progress sink threw", and four of the six emitters have none. CONFIRMED

`src/core/brain/progress.ts:186-199` states the rule: "a broken edge stream — a closed pipe, a renderer
defect — must not abort a consolidation pass that is otherwise succeeding … With no reporter supplied
the throw propagates."

Three independent implementations of that one rule now exist:

1. **`progressCounter({ onSinkError })`** — `src/core/brain/progress.ts:199`. Used only by `dream`
   (`src/core/brain/dream.ts:162`), which turns the fault into a `DreamWarning` with code
   `progress-sink-failed` (`src/core/brain/dream.ts:125`, `:136-143`).
2. **`guardedSink()`** — `src/core/brain/architect/generate.ts:262-277`, a hand-rolled second copy of
   the same detach-and-report logic, whose own docblock (`:252-260`) explains it exists because a run
   spans two counters. It surfaces as `GenerateArchDocsResult.progressFault`
   (`src/core/brain/architect/generate.ts:357`), the `progress_fault` JSON key
   (`src/cli/brain/verbs/architect.ts:71`) and a third refusal wording,
   `progress: observer failed (…)` (`src/cli/brain/verbs/architect.ts:84`).
3. **Nothing at all** — `src/core/brain/link-graph/bridge-discovery.ts:102`,
   `src/core/brain/link-graph/communities.ts:88`, `src/core/search/indexer.ts:325`,
   `src/core/search/vector-backfill.ts:102`. These construct `progressCounter(op, sink)` with no
   options object, so per the spine's own docblock **the throw propagates and kills the operation**.

**Failure scenario (PLAUSIBLE, transport-dependent).** Over MCP stdio the sink is
`(event) => send(progressNotification(token, event))` (`src/mcp/progress.ts:154`), and `send` writes to
`process.stdout` (`src/mcp/stdio.ts:47`). If that write throws synchronously — a destroyed stream after
a client disconnect — `brain_dream` reports the fault on its summary and completes, while
`brain_bridges` and `brain_clusters` abort the tool call and return an error envelope. Same client,
same pipe, two different outcomes, decided by which agent wrote which module.

Two consequences worth naming separately:

- The wordings do not agree. `progress: not emitted (<reason>)` (unreachable, F2),
  `progress: observer failed (<message>)` (architect only), and a `DreamWarning` in a JSON payload
  (dream only) are three answers to one question on one CLI. Commit `e7b047e8` is titled
  "refactor(cli): **one wording** for a refused rail and a stopped run"; it unified two of them and left
  the third.
- `progress_fault` is a declared `--json` field with, in practice, no reachable producer: the only
  production sink (`src/cli/progress-rail.ts:146-155`) throws only on an unknown event `kind`, which
  cannot occur because the producer is in the same process. Listed as such in the table below.

---

### F7 — `o2b brain maintenance run --json` is the one interrupted verb whose payload omits `interrupted`. CONFIRMED

Five verbs route a stop through `reportInterrupted` (`src/cli/interrupt.ts:121-125`), which writes
`{ ok: false, interrupted: true, message }`:
`src/cli/search/verbs/indexing.ts:204` and `:288`, `src/cli/brain/verbs/bridges.ts:217`,
`src/cli/brain/verbs/clusters.ts:352`, `src/cli/brain/verbs/architect.ts:90`,
`src/cli/brain/verbs/dream.ts:425`.

The maintenance verb does not. It writes its normal payload at `src/cli/brain/verbs/maintenance.ts:262`
(`okJson({ verdict: result.verdict, tasks: result.tasks })`) and then returns the interrupt code at
`:274` with no field explaining it.

**Failure scenario.** A cron wrapper runs `o2b brain maintenance run --json`, an operator sends SIGTERM,
the wrapper receives exit 143 and a document that says `verdict: "run"` with four tasks marked
`ok: false`. It cannot distinguish "the operator stopped this lane" from "all four passes are broken" —
which the code comment at `:270-273` says is exactly the distinction it is preserving. The exit code
carries it; the document does not.

Related: `src/cli/brain/verbs/dream.ts:342-347` open-codes a sixth copy of `reportInterrupted`'s body
for the staged path instead of calling the helper introduced two commits earlier for that purpose.

---

### F8 — `--progress` is discoverable on 2 of 7 verbs. CONFIRMED

Commit `6d6ea805` is titled "fix(cli): the index builders **advertise the flag they now parse**" and
adds `flag("progress", "boolean")` to `src/cli/command-manifest.ts:538` (index) and `:548` (reindex).
The five brain verbs that also parse it got nothing:

| verb | parses | usage const | `command-manifest.ts` | per-verb doc line |
|---|---|---|---|---|
| `search index` | `indexing.ts:175` | n/a | yes `:538` | `cli-reference.md:848` |
| `search reindex` | `indexing.ts:233` | n/a | yes `:548` | prose only |
| `brain architect` | `architect.ts:32` | yes `:27` | **no** (`:292`, no flags) | `cli-reference.md:273` |
| `brain bridges` | `bridges.ts:56` | yes `:48` | **no** (`:278`) | `cli-reference.md:335` |
| `brain clusters` | `clusters.ts:131` | yes `:54` | **no** (`:279`) | `cli-reference.md:336` |
| `brain maintenance` | `maintenance.ts:68` | yes `:52` | **no** (`:189`) | `cli-reference.md:325` |
| `brain dream` | `dream.ts:109` | **no** (`:61-65`) | **no** (`:121-126`, which *does* carry a flags array with `step` and `gate`) | **none** |

`o2b brain dream` — the verb the design doc opens with ("`o2b brain dream` prints its first character
after it has finished") — is the one verb where `--progress` appears in no usage string, no manifest
entry and no per-verb documentation line. It exists only in the prose paragraph at
`docs/cli-reference.md:724`, which says "the same verbs" without naming them. Tab-completion and
`o2b help --json` do not offer it anywhere under `brain`.

The manifest is admittedly sparse for brain verbs generally, so this is drift *introduced by this
release*, not a pre-existing hole: one agent fixed the discoverability gap for its two verbs and named
the fix in a commit subject; five sibling verbs shipped the same flag without it.

---

### F9 — `completed` means "finished" in four emitters and "started" in the index run. CONFIRMED

`ProgressEvent.completed` is declared as "Units **finished** in this stage so far"
(`src/core/brain/progress.ts:149`).

- `src/core/brain/architect/generate.ts:243` advances **after** `atomicWriteFileSync`. Honest.
- `src/core/brain/dream.ts:209`, `:363`, `:406`, `:414` advance after each phase. Honest.
- `src/core/search/indexer.ts:359` advances at the **top** of the per-file loop, before the file is read
  or upserted.
- `src/core/search/indexer.ts:943` advances by `batch.length` **before** `provider.embed(texts)` at
  `:946` — the network call the whole phase is waiting on.

**Failure scenario.** `o2b search index --embeddings --progress` on 4 000 pending chunks with a
super-batch of 512. The stream reaches `{"stage":"embed","completed":4000,"total":4000}` while the last
512 vectors are still in flight at the provider. If that call then fails, the operator has been told
100 % of the embedding phase completed and then watched the command exit non-zero. An agent using the
counter to decide whether a retry is needed reads the wrong number.

Adjacent, same class:

- `src/core/brain/dream.ts:211` starts stage `plan` with `total = scan.preferences.length` and **never
  advances it** — there is no `progress.advance(DREAM_STAGE.plan)` anywhere. The planning phase emits
  one event, `0 of N`, then jumps to `apply`. A declared denominator with no producer of increments.
- `src/core/brain/link-graph/bridge-discovery.ts:103` and `:156` both call
  `progress.start(BRIDGE_STAGE)` for the **same stage name** — the second with a total. `start` resets
  `completed` and re-emits `started` (`src/core/brain/progress.ts:241-247`), so a bridges run emits the
  same stage's `started` twice and a client tracking stage transitions resets its bar mid-run. No other
  emitter does this.
- `src/core/brain/link-graph/communities.ts:94` passes `maxIterations` as `total`, but label
  propagation converges early, so the run habitually `finished`es at `completed < total`. `total` is a
  ceiling there and a denominator everywhere else, against the field's own declaration.

`tests/core/architecture/progress-census.test.ts` checks that stage *identifiers* are not prose. It
checks nothing about counter semantics, which is why all four of these coexist.

---

### F10 — Two shapes for a new policy block, and one docblock now documents the wrong symbol. CONFIRMED

Two `_brain.yaml` blocks were added by two agents in two commits (`0196dc28` maintenance, `1c89bf04`
embeddings). They are wired differently:

| | `maintenance` | `embeddings` |
|---|---|---|
| parser registered in `policy/validate.ts` | `:106` | `:113` |
| loader in `policy/load.ts` | `loadMaintenanceConfigSafe` `:272` | **none** |
| re-exported from the `policy.ts` barrel | `:59`, `:102-110` | **none** |
| consumer reaches it via | the barrel / `policy/load.ts` (`maintenance/lane.ts:37`) | a **direct** `policy/blocks/` import (`src/core/brain/doctor/embedding-sunset-check.ts:61`) |

`src/core/brain/doctor/embedding-sunset-check.ts:61` is the **only** module outside
`src/core/brain/policy/` in the entire tree that imports from `policy/blocks/`. Every other block
— active, lessons, guardrails, integrity, health, temporal, link-graph, notes, sessions, maintenance —
is reached through `src/core/brain/policy.ts`. Nothing enforces the barrel, so this is convention drift
rather than a break, but it is a second shape for one mechanism inside one release.

**Partial-merge artefact, same file.** `src/core/brain/policy/load.ts:248-260` is a docblock that names
`active.most_applied`, `BRAIN_MOST_APPLIED_DEFAULTS`, "the digest" and "the section is the operator's
own list of the rules they lean on". It is now attached to `loadMaintenanceConfigSafe` (`:272`), which
has its own docblock at `:261-271`. `loadActiveMostAppliedSafe` (`:277`) — the symbol the first
docblock was written for — is now undocumented. One agent inserted a declaration between an existing
comment and the symbol it described. Harmless at runtime; it is the signature the brief asked me to
look for.

---

### F11 — A ninth lock-retry ladder, added beside a generic helper that already existed. CONFIRMED (observational)

`acquireLockSyncWithRetry` (`src/core/brain/sync-lockfile.ts:159-175`) is new: a **wall-clock** budget
(5 s) with a **jittered** sleep, and a 40-line docblock arguing from first principles why an attempt
count is the wrong quantity. Adopted by `git/store.ts:193`, `ingest/checkpoint.ts:188`,
`ingest/content-manifest.ts:237`, `architect/generate.ts:340`.

The tree already contained eight, all still in place and none touched or exempted:

| module | shape | backend |
|---|---|---|
| **`src/core/reliability/lock.ts:22` `withFileLock`** | the **generic** helper, `retries ?? 3` | `proper-lockfile` |
| `src/core/search/store/writer-lock.ts:37` | 10 attempts × fixed 50 ms | `proper-lockfile` |
| `src/core/search/store/writer-lock.ts:88` | `retries: {3, factor 1}` + heartbeat | `proper-lockfile` |
| `src/core/brain/log.ts:238` | 10 × 50 ms | `proper-lockfile` |
| `src/core/brain/secrets/store.ts:90` | 20 attempts | `proper-lockfile` |
| `src/core/brain/portability/profiles.ts:160` | fixed attempts × fixed ms | `proper-lockfile` |
| `src/core/config.ts:449`, `:532` | two inline `for` loops in one file | `proper-lockfile` |
| `src/core/brain/inline-rewrite.ts:56` | `retries: {30, factor 1.2, 30–500 ms}` | `proper-lockfile` |

The new one is the only wall-clock/jittered member and the only one not built on `proper-lockfile`.
Its three new consumers — `git/store.ts`, `ingest/checkpoint.ts`, `ingest/content-manifest.ts` — are
read-modify-write on JSON/JSONL files, which is exactly `withFileLock`'s stated use case
(already used by `src/core/brain/schema-mutate.ts:197` and `src/core/brain/health-baseline.ts:58`).

This is not a bug — the mkdir-based `acquireLockSync` is the primitive the rest of `Brain/` uses, so
the new helper is consistent with its neighbours. It is the branch adding a ninth answer to a question
it also declares it has settled, without mentioning the generic answer already in the tree.

Worth flagging for the locking reviewer rather than deciding here: `Bun.sleepSync` blocks the thread,
so an ingest fold contending inside the long-lived MCP server can stall the event loop for up to five
seconds.

---

### F12 — Five new core→`progress.ts` edges are invisible to the import-cycle ratchet. CONFIRMED (latent)

`tests/core/architecture/import-cycles.test.ts:24-28` states the project's rule deliberately:
`import type … from "…"` **is** an edge, "the `type` keyword is one word, dropping it is invisible in
review". `:35` excludes `import("…")` in a type position, because it "pulls in no module".

Five of the six new progress-emitting modules reference the sink through the *inline* form rather than a
top-level `import type`:

| site | form | has a static import too? |
|---|---|---|
| `src/core/brain/dream-types.ts:219` | `import("./progress.ts").ProgressSink` | **no** — untracked edge |
| `src/core/search/indexer.ts:140` | inline | yes (`:67-72`) |
| `src/core/search/indexer.ts:855` (`EmbeddingPhaseOptions.progress`) | inline | yes |
| `src/core/search/vector-backfill.ts:63` | inline | yes (`:43`) |
| `src/core/brain/link-graph/communities.ts:76` | inline | yes (`:33`) |
| `src/core/brain/link-graph/bridge-discovery.ts:83` | inline | yes |
| `src/core/brain/architect/{scan,generate}.ts` | top-level `import type` | — |

No cycle exists today: `progress.ts` imports only `safeguard.ts`. But `dream-types.ts` now carries a
real type dependency on `progress.ts` that the ratchet does not count, and the branch has established
the inline form as the house style for this type in four modules. A future edge added the same way
closes a loop the ratchet stays green on. The two idioms in one release are also plain drift — two
agents, two habits.

**I ran the repository's own guards and both pass:** `tests/core/architecture/import-cycles.test.ts`
and `tests/core/layering.test.ts`, 6 tests, 0 fail. No new `process.exit` / `process.stdout.write` /
`console.log` in `src/core`; no `src/core` → `src/cli` or `src/mcp` import added.

---

### F13 — Half-applied seams and one hand-rolled copy of a shared test helper. CONFIRMED (low)

Three smaller artefacts of the same concurrency, each a mechanism applied to some of its sites:

**`dispatchByView` gained a fourth parameter; one of its two call sites passes it.**
`src/mcp/brain/shared.ts:194` now takes `onProgress?`, with a docblock (`:170-178`) stating that "a
dispatcher that silently swallowed it would make a view which DOES run long … look like a tool that
emits no progress rather than one whose progress was discarded in transit". `src/mcp/brain/brief-tools.ts:495`
forwards it. `src/mcp/brain/analytics-tools.ts:249` does not — its handler
(`:242-244`) never took the parameter. Defensible today (no `brain_analytics` view runs long), but it
is the exact behaviour the new docblock names as the thing to avoid, in the other file that uses the
function it was written for.

**Doctor codes are exported constants in one file and copied literals in another.**
`src/core/brain/doctor-exits.ts:207`, `:216` and `:225` hard-code
`"embedding-model-sunset-unsurveyed"`, `"embedding-model-sunset-undetermined"` and
`"recovery-point-unmeasured"` — strings that are exported one import away at
`src/core/brain/doctor/embedding-sunset-check.ts:81`, `:84` and
`src/core/brain/doctor/recovery-point-liveness.ts:68`. `src/core/brain/diagnostics.ts:466-470` argues
that the literal is deliberate there (importing the constant would let the census follow the import
back); the `doctor-exits.ts` exclusions carry no such justification and read as copies. A rename in
either new module leaves an orphaned exclusion whose only symptom is a code the exit census then
rejects.

**`tests/cli/brain-dream-progress.test.ts:60-74` hand-rolls `progressRecords`** byte-for-byte from
`tests/helpers/progress-records.ts:23` — minus the `try/catch` around `JSON.parse` that the helper
carries specifically so "another writer's brace-leading line" does not "blame this reader for someone
else's stderr". Five sibling progress tests import the helper; the dream one does not. The dream test
(`66610032`) predates the helper's extraction (`96dd769e`) and was never migrated, so the one verb
whose stderr is busiest is checked by the one copy without the guard. None of the six new progress
tests uses `CLI_SPAWN_BUDGET_MS` (`tests/helpers/cli-timeout.ts:41`) either, though six other CLI test
files adopted it on this branch.

---

### F14 — Orphan exports and one missing census registration. CONFIRMED

Exported by a new module and imported **nowhere** in `src/`, `tests/`, `hooks/` or `scripts/`:

| symbol | site | note |
|---|---|---|
| `EXIT_TERMINATED` | `src/cli/interrupt.ts:40` | The 143 exit is produced through `EXIT_FOR_SIGNAL` (`:47-50`); the named constant is read by nothing, and **no test asserts 143 anywhere** — `grep -rn '143\|SIGTERM' tests/` finds no coverage of the SIGTERM half of the contract documented at `docs/cli-reference.md:724`. Contrast `EXIT_INTERRUPTED`, asserted in two test files. |
| `progressNotification` | `src/mcp/progress.ts:125` | Used only by `progressSink` in the same file. Exported for no reader. |
| `SELF_HEAL_REINDEX_SURFACE` | `src/core/maintenance/self-heal-reindex.ts:47` | Referenced only inside its own file. |
| `readSelfHealReindexRows` | `src/core/maintenance/self-heal-reindex.ts:176` | Imported only by `tests/core/maintenance/self-heal-reindex.test.ts`. No shipped surface renders these rows. (Not a broken promise — `docs/metrics.md` tells external consumers to read the JSONL directly — but the reader is dead weight in `src/`.) |
| `ProgressStream`, `ProgressOutcome` | `src/cli/progress-rail.ts:41`, `:65` | Types with no external consumer. |
| `StatfsProbe`, `VaultBackingOptions` | `src/core/vault-backing.ts` | Injection seams used only by tests. |
| `HostPressureMeasured`, `HostPressureUnmeasurable` | `src/core/brain/maintenance/host-pressure.ts:130`, `:138` | Constituent types of an exported union; never named elsewhere. |
| `MaintenanceGateDecision` | `src/core/brain/maintenance/lane.ts:100` | The new return type of `evaluateGates` (`:166`), never named by any caller. |
| `HostPressureGate` | `src/core/brain/maintenance/lane.ts:70` | |
| `normalizePreCompactLabel` | `src/core/brain/pre-compact-extract.ts:121` | |
| `ProactiveRecallScore` | `src/core/bench/failure-modes.ts:158` | |
| `SessionAdapterRegistry` | `src/core/brain/sessions/registry.ts:34` | |
| `DATA_OWNERSHIP_KEY`, `installJson` | `src/cli/install/render.ts:50`, `:58` | File-private in practice. |

**A repeated shape, nine times over.** The branch mints the house closed-vocabulary quartet — `X`
object, `XS` list, `isX` guard, `XState` type alias — in nine independent modules. In **every one**
the object, list and guard are consumed and the exported **type alias is dead**: `ProgressKind`
(`progress.ts:74`), `ProgressOutcome` (`progress-rail.ts:65`), `HostPressureState`
(`host-pressure.ts:69`), `SelfHealReindexOutcome` (`self-heal-reindex.ts:92`),
`EmbeddingSunsetState` / `…UndeterminedReason` / `…Source` (`sunset.ts:116`, `:149`, `:190`),
`VaultBackingUndeterminedReason` (`vault-backing.ts:102`), `TranscriptScan`
(`transcripts/types.ts:29`), `ImportWriteMode` (`sessions/import.ts:148`). Nine agents applied one
template without any of them checking whether the type half is ever named. Harmless, but it is the
clearest single fingerprint of the build pattern in the tree.

(I checked one claim that rests on a dead type and it holds: `src/core/install/ownership.ts:254-257`
says `survivalLine`'s `switch` is "Exhaustive over `VaultBackingState` … a fifth state added to that
vocabulary fails this file to build". `VaultBackingState` appears in that file only inside a JSDoc
`{@link}`, but the switch discriminates on `backing.state` and the function's declared `string` return
makes TS2366 fire under `strict` the moment the union grows. The comment is true.)

**Missing census registration.** `tests/core/architecture/verdict-vocabulary-census.test.ts:18-21` says
"Every vocabulary the wave introduces registers below". `PROGRESS_OUTCOME` /
`PROGRESS_OUTCOMES` / `isProgressOutcome` (`src/cli/progress-rail.ts:55-76`) is a complete trio
introduced by this wave and is **not** in the census — the only new trio that is missing. (The census
already reaches outside `src/core`: it registers `src/mcp/registry-guard.ts` and
`src/mcp/brain/lifecycle-file-tools.ts`, so the layer is not the reason.) Its sibling
`PROGRESS_KIND`/`PROGRESS_REASON` are registered at `:721` and `:730`.

---

### F15 — Two spellings for "the reason we could not determine", in one release. CONFIRMED (low)

The tree already carried both conventions before this branch (`PROVIDER_PROBE` uses kebab,
`MATERIALIZE_UNKNOWN_REASON` uses snake), so this is not a break — but the branch adds five new reason
vocabularies to one release and splits them:

| vocabulary | spelling | example |
|---|---|---|
| `PROGRESS_REASON` (`progress.ts:100`) | kebab | `timed-out`, `transport-single-response`, `stream-buffered` |
| `PROGRESS_OUTCOME` (`progress-rail.ts:55`) | kebab | `suppressed-buffered-stream` |
| `VAULT_BACKING_UNDETERMINED_REASON` (`vault-backing.ts:92`) | snake | `probe_unsupported`, `fs_type_unknown` |
| `HOST_PRESSURE_UNMEASURABLE_REASON` (`host-pressure.ts:83`) | snake | `platform_blind`, `cpu_quota_in_force` |
| `EMBEDDING_SUNSET_UNDETERMINED_REASON` (`sunset.ts:137`) | snake | `model_unresolved`, `survey_stale` |

All five land in a `reason`-shaped field of a JSON payload an operator or agent parses. A caller
handling `"timed-out"` and `"survey_stale"` in the same switch is reading one release's output.
Doctor codes are consistently kebab (`recovery-point-stale`, `embedding-model-sunset-unsurveyed`) and
maintenance verdicts consistently colon-prefixed (`skipped:pressure`, matching the pre-existing
`skipped:window`), so those two are clean.

---

### F16 — Undocumented operator-visible surfaces added by this branch. CONFIRMED (low)

Five new doctor codes — `recovery-point-stale`, `recovery-point-unmeasured`,
`embedding-model-sunset-announced`, `embedding-model-sunset-unsurveyed`,
`embedding-model-sunset-undetermined` — appear nowhere under `docs/` outside the brainstorm folder,
while the doctor **exit-code** change they ride with is documented in detail
(`docs/cli-reference.md:61-83`). The new `embeddings:` config block is in the config template
(`src/core/brain/config-template.ts:370-388`) but in no doc, while its sibling `maintenance:` block is
documented at `docs/cli-reference.md:330`. `docs/mcp.md` also still documents the pre-rename
`exact`/`fallback` token-impact enum.

---

## Section 1 — the full enumeration: every declared surface, and whether an input reaches it

`✔` = a real input in a shipped configuration produces it. `✖` = no such input exists.
`~` = reachable only outside a supported configuration, or only after a future date.

### Progress spine (U1/U2)

| declared surface | site | reachable | by what input |
|---|---|---|---|
| `PROGRESS_SCHEMA "o2b.progress.v1"` | `progress.ts:56` | ✔ | every event |
| `PROGRESS_KIND.started` | `progress.ts:67` | ✔ | `--progress` on any of 6 verbs; MCP token |
| `PROGRESS_KIND.advanced` | `:68` | ✔ | any iteration checkpoint |
| **`PROGRESS_KIND.refused`** | `:69` | **✖** | no `ProgressEvent` producer — **F3** (defect in the doc, honest as a vocabulary member) |
| `PROGRESS_KIND.stopped` | `:70` | ✔ | Ctrl-C, or an elapsed safeguard deadline |
| `PROGRESS_KIND.finished` | `:71` | ✔ | normal completion |
| `PROGRESS_REASON.aborted` | `:102` | ✔ | SIGINT/SIGTERM → `SafeguardAbortError` |
| `PROGRESS_REASON.timedOut` | `:104` | ✔ | `safeguard_timeout_*_seconds` elapsing |
| `PROGRESS_REASON.transportSingleResponse` | `:111` | ✔ | `o2b mcp --transport http` + `_meta.progressToken` |
| **`PROGRESS_REASON.streamBuffered`** | `:117` | **✖** | **F2 — defect** |
| `ProgressEvent.total` | `:155` | ✔ | embed / plan / render / candidates / sweep stages |
| `ProgressCounterOptions.onSinkError` | `:199` | ✔ | passed only by `dream` — **F6** |
| `PROGRESS_OUTCOME.emitted` | `progress-rail.ts:57` | ✔ | `--progress` |
| **`PROGRESS_OUTCOME.suppressedBufferedStream`** | `:62` | **✖** | **F2 — defect** |
| **`ProgressAttachment.reason`** | `:124` | **✖** | **F2 — defect** |
| **`progress: not emitted (…)` line** | `:185` | **✖** | **F2 — defect** |
| **`progress_fault` (`--json`, architect)** | `architect.ts:71` | **✖ in practice** | only if the CLI sink throws; it can throw only on an unknown `kind`, impossible in-process — **F6** |
| `interrupted: true` (`--json`) | `interrupt.ts:122` | ✔ | Ctrl-C on 5 verbs; **absent on maintenance — F7** |
| exit `130` `EXIT_INTERRUPTED` | `interrupt.ts:37` | ✔ | SIGINT during a long verb |
| exit `143` `EXIT_TERMINATED` | `interrupt.ts:40` | ✔ (produced) | SIGTERM; **the exported constant has no reader and no test — F14** |
| `params._meta.progressToken` | `mcp/progress.ts:97` | ✔ | any MCP client; **declared in no `inputSchema`, advertised in no `initialize` capability** |
| `notifications/progress` | `:46` | ✔ | stdio + token |
| `result._meta["open-second-brain/progress"]` refusal | `:53`, `:173` | ✔ | HTTP transport + token |
| `--progress` on index/reindex | `indexing.ts:175`, `:233` | ✔ | flag |
| `--progress` on architect/bridges/clusters/maintenance `run` | see F8 | ✔ | flag (undiscoverable — **F8**) |
| `--progress` on `brain dream run` | `dream.ts:109` | ✔ | flag (undocumented anywhere — **F8**) |
| **`--progress` on `brain dream stage\|validate\|apply`** | `dream.ts:109` | **✖** | parsed, dropped, no refusal — **F4, defect** |
| **`--progress` on `brain maintenance status`** | `maintenance.ts:68` | **✖** | parsed, early return — **F4, defect** |
| **`VectorBackfillOptions.onProgress`** | `vector-backfill.ts:63` | **✖** | no producer in `src/` — **F5, defect** |
| **`DreamStageOptions.onProgress`** | `dream-stage.ts:107` | **✖** | no producer in `src/` — **F4, defect** |

### Vault backing (U8)

| surface | site | reachable | by what input |
|---|---|---|---|
| `VAULT_BACKING.durable` | `vault-backing.ts:57` | ✔ | Linux vault on ext4/btrfs/xfs/zfs/nfs/… |
| `VAULT_BACKING.volatile` | `:59` | ✔ | vault under a tmpfs `/tmp` or `/dev/shm` |
| `VAULT_BACKING.layered` | `:61` | ✔ | vault on a container overlayfs |
| `VAULT_BACKING.undetermined` | `:63` | ✔ | any non-Linux host |
| `…REASON.probeUnsupported` | `:94` | ✔ | **every macOS run** — the whole durability half of the ownership close is silent on a first-class platform. Honest, but the common case, not the rare one |
| `…REASON.pathUnreadable` | `:96` | ✔ | vault path removed between config write and probe |
| `…REASON.fsTypeUnknown` | `:98` | ✔ | 9p under WSL, exfat, squashfs, ecryptfs |
| `DataOwnership.outside_vault[]` (9 rows) | `ownership.ts:86-182` | ✔ | emitted **unconditionally** — an enumeration of what the tool *can* leave outside, not a detection of what *is* there. Row wording is conditional, so honest; a reader treating it as detection would be misled |
| `third_party_embedding_configured` | `ownership.ts:227` | ✔ | networked embedding provider configured |
| `schema_version: 1` on `install --apply --json` | `render.ts:56` | ✔ | constant, additive |

### Provider sunset (U9)

| surface | site | reachable | by what input |
|---|---|---|---|
| `EMBEDDING_SUNSET.announced` | `sunset.ts:106` | ✔ | any of 16 shipped first-gen OpenAI models, or an operator declaration |
| `EMBEDDING_SUNSET.noneAnnounced` | `:108` | ✔ | `text-embedding-3-small` |
| `EMBEDDING_SUNSET.unsurveyed` | `:110` | ✔ | any off-catalog model — the normal case, incl. the model onboarding suggests |
| `EMBEDDING_SUNSET.undetermined` | `:112` | ✔ | `model_unresolved`, or an unreadable search config |
| `…REASON.modelUnresolved` | `:139` | ✔ | semantic search on, `embedding_model` unset |
| **`…REASON.surveyStale`** | `:141` | **~** | clock-gated: first fires **2027-08-16** (`reviewedAt: "2026-08-15"` + 365 d). A hard-coded fuse: every operator on a surveyed-negative model starts getting `embedding-model-sunset-undetermined` on that date unless the table is refreshed. Honest state, but a scheduled future regression |
| **`…REASON.surveyEntryMalformed`** | `:143` | **✖** | every shipped survey row is a valid literal. Honest defensive guard against a future table edit |
| **`…REASON.declarationMalformed`** | `:145` | **✖** | `parseEmbeddingsBlock` (`blocks/embeddings.ts:100`) already rejects with `BrainConfigError` using **the same** `isValidIsoInstant` predicate. Provably dead on the config path — a second check of a fact already enforced |
| `EMBEDDING_SUNSET_SOURCE.{declaration,survey,none}` | `:182-186` | ✔ | all three |
| `embeddings.sunset_model` / `sunset_at` | `blocks/embeddings.ts:52-53` | ✔ | `_brain.yaml`; both-or-neither enforced |
| doctor `embedding-model-sunset-announced` | `embedding-sunset-check.ts:78` | ✔ | announced with ≤ 90 days remaining |
| doctor `embedding-model-sunset-unsurveyed` | `:81` | ✔ | off-survey model |
| doctor `embedding-model-sunset-undetermined` | `:84` | ✔ | 2 of its 4 reasons |

### Host pressure and the lane (U6)

| surface | site | reachable | by what input |
|---|---|---|---|
| `maintenance.host_pressure_percent` | `blocks/maintenance.ts:103` | ✔ | opt-in key; unset by default |
| `maintenance.failure_streak_limit` | `:111` | ✔ | default 3, active without opt-in |
| `HOST_PRESSURE.measured` | `host-pressure.ts:60` | ✔ | gate configured, no refusal fires |
| `HOST_PRESSURE.unmeasurable` | `:62` | ✔ | via the quota reasons |
| **`…REASON.platformBlind`** | `:85` | **~** | `win32` only, and `src/core/config.ts:128` throws `UnsupportedPlatformError` on win32. Reachable only by forcing `OPEN_SECOND_BRAIN_CONFIG` on a platform this build states it does not support |
| `…REASON.cpuQuotaInForce` | `:87` | ✔ | any container with `--cpus` |
| `…REASON.cpuQuotaUnknown` | `:89` | ✔ | malformed `cpu.max` / `cpu.cfs_quota_us` |
| **`…REASON.parallelismUnknown`** | `:91` | **✖** | `availableParallelism()` always returns an integer ≥ 1; the only injectable `HostPressureProbe` seam is set by tests |
| **`…REASON.loadAverageInvalid`** | `:93` | **✖** | `loadavg()` on linux/darwin always returns three finite non-negative numbers |
| `MAINTENANCE_VERDICT.skippedPressure` | `journal.ts:38` | ✔ | measured ≥ threshold |
| `MAINTENANCE_VERDICT.refusedStreak` | `:41` | ✔ | 3 journaled consecutive failures |
| `MAINTENANCE_VERDICT.pressureUnmeasurable` | `:43` | ✔ | any unmeasurable reading |

*Assessment of the four unreachable/near-unreachable arms above:* `parallelismUnknown` and
`loadAverageInvalid` are honest defensive guards against inputs the standard library cannot produce —
acceptable, and the module is right to check refusals before arithmetic. `platformBlind` is different:
the design doc cites Windows load-average behaviour as the *motivating* case, and the build refuses to
run on Windows. That is a member argued from a platform this release does not ship to.

### Self-heal reindex (U5)

| surface | site | reachable | by what input |
|---|---|---|---|
| `SELF_HEAL_SPAWN.spawned` | `self-heal-reindex.ts:59` | ✔ | schema bump + background `ensureVaultCurrent` |
| `SELF_HEAL_SPAWN.skippedWriterLock` | `:61` | ✔ | a second session losing the lock probe |
| `SELF_HEAL_REINDEX_OUTCOME.completed` | `:86` | ✔ | the detached child finishing |
| `SELF_HEAL_REINDEX_OUTCOME.failed` | `:88` | ✔ | the child throwing, or being stopped |
| `--self-heal` on `search reindex` | `indexing.ts:236` | ✔ | machine-only; set by `ensure-current.ts:37` |
| `EnsureCurrentResult.reindexSpawn` | `ensure-current.ts:43` | ✔ | background mode |
| `readSelfHealReindexRows` | `:176` | **✖ as a consumer** | no production caller — **F14** |

### Doctor, readiness, partner (U8/U9 + doctor unit)

| surface | site | reachable | by what input |
|---|---|---|---|
| exit `0` / `1` `DOCTOR_EXIT` | `main.ts:299-300` | ✔ | pre-existing values, tabled |
| exit `6` `DOCTOR_EXIT.probeIncomplete` | `main.ts:301` | ✔ | `--readiness` with ≥1 `unknown` probe. **Deliberate alias of `SEARCH_CHECK_EXIT.probeIncomplete = 6`** (`check.ts:111`); precedence one-way at `main.ts:318-319`, so `1` never hides behind `6`. Consistent |
| `readiness_summary` (`probes`/`failed`/`unknown`) | `main.ts:394-398` | ✔ | `doctor --readiness --json` |
| `READINESS_STATUS.unknown` from a timeout | `doctor-readiness.ts:580` | ✔ | probe exceeding its budget |
| `recovery-point-stale` | `recovery-point-liveness.ts:65` | ✔ | newest archive > 30 days |
| `recovery-point-unmeasured` | `:68` | ✔ | `listSnapshots` throwing (perm/EIO). Its second arm — an unparseable `created_at` — is unreachable, since the field is always `toISOString()` output |
| `partner_codegraph_disabled` + `OPEN_SECOND_BRAIN_PARTNER_CODEGRAPH_DISABLED` | `config.ts:1038-1039` | ✔ | config key or env var; default off |
| `code_graph` "silenced by" line | `partner/codegraph.ts:376-382` | ✔ | switch on |

### Bench, sessions, transcripts (U7/U10)

| surface | site | reachable | by what input |
|---|---|---|---|
| `RECALL_FAILURE.{know_to_ask,false_fire,faulted}` | `failure-modes.ts:87-91` | ✔ | operator-authored fixture questions |
| `o2b.bench.v2` schema + `failure_modes.*` fields | `bench/types.ts:23` | ✔ | `o2b brain bench` with a fixture. **No fixture ships in the npm tarball** (`package.json` `files` omits `tests/`), so reachable from a checkout or an operator-authored dataset only |
| `SESSION_ADAPTER_ID.{claude,codex,hermes,opencode,grok}` | `sessions/types.ts:34-38` | ✔ | `--format <id>` |
| `IMPORT_WRITE_MODE.{applied,dry_run}` + `write_mode`, `signals_withheld`, `facts_withheld` | `sessions/import.ts:143`, `import-session.ts:161-167` | ✔ | `brain import-session [--dry-run]` |
| `TRANSCRIPT_SCAN.{collected,idle,root_absent,unreadable}` | `transcripts/types.ts:22-28` | ✔ | all four; `unreadable` from a permission-denied transcript home |
| `TOKEN_COUNT_METHOD.{tokenizer,heuristic}` | `token-impact.ts:85-87` | ✔ | `brain_token_impact` `method`; legacy `exact`/`fallback` still accepted on read but no longer advertised — `docs/mcp.md` is stale |

---

## Section 4 — the commit record

**Verified intact.** Machine checks:

- `git diff main...HEAD --name-only` and the union of `git log main..HEAD --name-only` are **identical
  sets** (`diff` exit 0). No file was touched and then lost, and no file exists in the tree that no
  commit accounts for.
- No commit subject or body contains `revert`; no commit reverts an earlier one.
- No conflict markers (`<<<<<<<`/`=======`/`>>>>>>>`) anywhere in `src/`, `tests/`, or the brainstorm
  folder.
- No duplicated top-level `export function|const|class|interface|type` name inside any changed file —
  the usual signature of a botched merge.
- All 61 commits carry one author. Content is present and coherent.

**Sweeps confirmed, as reported.** Three commits carry files that belong to a different unit's subject:

| commit | subject | swept-in files |
|---|---|---|
| `5d6363e0` | `feat(benchmark): bound the query fan-out` | `src/cli/install/install.ts`, `src/cli/install/render.ts`, `tests/cli/install-json-shape.test.ts` |
| `c493f4e7` | `fix(architect): render the same bytes on a differently-collating host` | `src/core/brain/sessions/{import,registry,types}.ts`, `tests/core/brain/sessions/adapter-registry.test.ts` |
| `e7116b12` | `fix(cli): cancellation reaches both dream entry points, not one` | `src/cli/brain/verbs/import-session.ts` |

The *content* of the swept files is intact — each is a coherent, complete change and each has its own
tests. The cost is bisectability, not correctness: `git log --oneline -- src/core/brain/sessions/` now
attributes the session-adapter registry to an architect rendering fix.

**One file whose final state is a partial merge of two agents' intentions:**
`src/core/brain/policy/load.ts:248-280` — see **F10**. A declaration was inserted between an existing
docblock and the symbol it documented, so `loadMaintenanceConfigSafe` carries two docblocks (one about
`active.most_applied`) and `loadActiveMostAppliedSafe` carries none. This is the only instance I found.

---

## What I checked and found sound

- **Import cycles and layering.** `bun test tests/core/architecture/import-cycles.test.ts
  tests/core/layering.test.ts` — 6 pass, 0 fail. No new cycle. No `src/core` → `src/cli`/`src/mcp`
  import. No `process.exit`, `process.stdout.write` or `console.log` added under `src/core`. The one
  caveat is the ratchet-invisible inline type form (**F12**), which is latent, not live.
- **Exit-code consistency across surfaces.** `DOCTOR_EXIT.probeIncomplete = 6` deliberately reuses
  `SEARCH_CHECK_EXIT.probeIncomplete = 6` for the same meaning, with the same one-way precedence
  (proved failure outranks unmeasured) in both `doctorExitCode` (`main.ts:317-320`) and
  `exitCodeForCheck` (`check.ts:129-144`). `INSTALL_EXIT` (`install.ts:58-64`) does not collide with
  either — its `5` is `mcpUnreachable`, `search check`'s `5` is `providerUnreachable`, and the two verbs
  answer disjoint questions. `130`/`143` are the shell's own convention and collide with nothing.
- **Flag naming.** One spelling, one polarity, everywhere: `--progress` is boolean and opt-in on all
  seven verbs. No `--quiet` / `--no-progress` / `--progress=none` divergence. `--self-heal` appears only
  where its producer spawns it.
- **MCP transport decision.** The refusal is genuinely structural, not a flag: `src/mcp/http.ts:52`
  constructs `MCPServer` without `sendNotification`, and `src/mcp/stdio.ts:47` and `:131` supply one.
  A token over HTTP therefore cannot be silently honoured, and the refusal rides on `result._meta` on
  both the success and the error envelope (`src/mcp/server.ts:377`, `:384`). `serveStdioFromString`
  frames notifications through the same `frameLine` as responses, so the test harness cannot report the
  feature as absent.
- **Vocabulary trios really are closed.** I type-checked `MaintenanceVerdict`, `HostPressureState` and
  `VaultBackingState` against a non-member literal under `--strict`; all three reject it. The
  `Object.freeze({...})` form without `as const` used in `journal.ts:33` and `host-pressure.ts:58` still
  yields literal unions — my initial suspicion that those two had widened to `string` was wrong.
- **Vocabulary census coverage.** 15 of the 16 new trios are registered in
  `tests/core/architecture/verdict-vocabulary-census.test.ts`, and the census carries its own
  self-check suite (`:912-972`) so a broken audit cannot pass silently. Only `PROGRESS_OUTCOME` is
  missing (**F14**).
- **Lock adoption is complete where it was claimed.** `acquireLockSyncWithRetry` reached all four
  read-modify-write sites the recon named (`git/store.ts:193`, `ingest/checkpoint.ts:188`,
  `ingest/content-manifest.ts:237`, `architect/generate.ts:340`), and each holds the read and the write
  in one critical section rather than only the write.
- **`isWriterLockHeld` is honestly advisory.** `src/core/search/store/writer-lock.ts:70-73` throws
  rather than collapsing an unreadable lock to `false`, and its caller
  (`src/core/maintenance/ensure-current.ts:127-133`) records the probe failure by name and spawns
  anyway rather than silently declining to self-heal. `reindexTriggered` is set from the decision
  (`:207`) rather than optimistically, so a run that declined does not claim it started one.
- **The install-vault chain disagreement is genuinely fixed.** `resolveInstallVault`
  (`src/cli/install/install.ts:135-137`) now delegates to `resolveVault`, the same chain every other
  verb uses.
