# Recon — incremental progress/status reporting (t_62bb944a)

Read-only reconnaissance against `feat/nothing-runs-unwatched`, based on
v1.47.0 (`aa818084`). Every claim below carries a `path:LINE` anchor that
was read directly. Where a claim could not be established from source it
says so.

---

## 1. Inventory of genuinely long-running operations

The repository already has a canonical list of what it considers long: the
safeguard operation vocabulary at
`src/core/brain/safeguard.ts:26` —
`export type SafeguardOperation = "dream" | "reindex" | "bridges" | "clusters" | "maintenance"`.
That module was itself created from an upstream-mirage task (`t_06784b8d`,
docblock `src/core/brain/safeguard.ts:1-21`) and describes exactly the same
population this task is about. Any progress design should treat that union
as the existing definition of "long-running" rather than inventing a second
one.

### Countable-unit table

`known?` = is the total number of units available BEFORE the loop starts.

| Operation | Entry point | Unit iterated | Total known before loop? |
|---|---|---|---|
| Incremental index | `indexVault` — `src/core/search/indexer.ts:296` (body `indexInto`, `:303`) | markdown files, then chunks per file | **NO** |
| Full rebuild | `reindexVault` — `src/core/search/indexer.ts:920` | delegates to one `indexVault` call at `src/core/search/indexer.ts:969` | **NO** (inherits) |
| Embeddings build | `runEmbeddingPhase` — `src/core/search/indexer.ts:816` | super-batches of chunks | **YES** |
| Embeddings backfill | `planVectorBackfill` — `src/core/search/vector-backfill.ts:85` | chunks lacking a vector | **YES** |
| Event-anchor backfill | `planEventAnchorBackfill` — `src/core/search/event-anchor-backfill.ts:84` | documents | **YES** |
| Dream pass | `dream` — `src/core/brain/dream.ts:101` | phases (each with its own inner item loop) | **YES** |
| Maintenance lane | `runMaintenance` — `src/core/brain/maintenance/lane.ts:121` | named tasks | **YES** |
| Bridge discovery | `discoverBridges` — `src/core/brain/link-graph/bridge-discovery.ts:88` | candidate documents | **YES** |
| Community detection | `detectCommunities` — `src/core/brain/link-graph/communities.ts:76` | propagation sweeps × nodes | **CEILING ONLY** |
| Heal/enrichment pass | `runHealEnrichment` — `src/core/brain/heal-run.ts:43` | vault pages, twice (two passes) | **YES** |
| Hygiene scan | `runHygieneScan` — `src/core/brain/hygiene/scan.ts:38` | detectors | **YES** |
| Brain doctor | `runDoctor` — `src/core/brain/doctor.ts:202` | checks (static 30-entry registry) | **YES** |
| Memory bench | `runMemoryBench` — `src/core/bench/phases.ts:65` | 5 named phases, then questions | **YES** |
| Recall benchmark | `runRecallBenchmark` — `src/core/search/benchmark.ts:189` | queries, **concurrent** | **YES, but unordered** |
| Link-ratchet measure | `measureVault` — `src/core/search/link-ratchet.ts:269` | vault copy → forced index → recount | **NO** |
| Backlink index | `buildBacklinkIndex` — `src/core/brain/backlinks.ts:98` | five directory collectors | **NO** |
| Stale scan | `findStaleEntries` — `src/core/brain/temporal/stale-watch.ts:63` | three directory sub-scans | **NO** |

### Why index/reindex cannot report a fraction

The index driver is a generator consumed as it goes:
`src/core/search/indexer.ts:324` — `for (const file of walkVault(config)) {`,
where `walkVault` is `export function* walkVault(...): Generator<WalkedFile>`
at `src/core/search/walker.ts:51`. Nothing materializes the file list first.
The one pre-known set is the *previously indexed* documents,
`src/core/search/indexer.ts:313` (`store.listDocuments()`), which is used for
the deletion sweep — it is not a denominator for this run (a first index has
zero of them, and new files are not in it).

A count is obtainable only by walking twice; the repo does exactly that where
it needs one: `src/core/search/link-ratchet.ts:256` —
`return [...walkVault(config)].length;`, with the docblock at
`src/core/search/link-ratchet.ts:248-253` explaining the materialization
trade. So for index/reindex a progress report can be a **monotonic counter
plus a phase label**, never a percentage, unless the design is willing to pay
a second full directory walk before the run.

The embedding side is the opposite: `src/core/search/indexer.ts:845` —
`const pending = store.findChunksWithoutEmbeddings();` — an array, followed by
`src/core/search/indexer.ts:879` — `for (let i = 0; i < pending.length; i += superBatch)`.
`i / pending.length` is an exact fraction. `planVectorBackfill` even reports
that denominator today as a dry-run field (`pending`,
`src/core/search/vector-backfill.ts:93` and the `VectorBackfillResult.pending`
declaration at `src/core/search/vector-backfill.ts:60`).

So a single progress event shape has to carry an OPTIONAL total. The two
halves of one `o2b search index --embeddings` run genuinely differ: file phase
= counter only, embed phase = counter + total.

### Existing phase vocabularies (do not invent a third)

- Dream: `DREAM_PHASE` at `src/core/brain/dream-phases.ts:19`
  (`close, reconcile, synthesize, heal, log`), reporting order
  `DREAM_PHASE_ORDER` at `src/core/brain/dream-phases.ts:33`, and
  `DreamPhaseSummary { phase, metrics: Readonly<Record<string, number>> }`
  at `src/core/brain/dream-phases.ts:46-49` — a phase label plus integer
  counters is already the house shape.
- Dream execution-order journal: `WORKRUN_PHASE` at
  `src/core/brain/dream-workrun.ts:50-63` (ten identifiers), written per
  transition by `WorkrunHandle.checkpoint(phase, payload?)`
  (`src/core/brain/dream-workrun.ts:71`) into
  `Brain/log/dream-runs/<run-id>.jsonl` (`openWorkrun`,
  `src/core/brain/dream-workrun.ts:79`). Emitted at
  `src/core/brain/dream.ts:235-236` and
  `src/core/brain/dream-apply.ts:106,107,112,120`.
- Bench: durable resumable phases via `completeBenchPhase`, guarded by
  `phaseDone(checkpoint, "<phase>")` at `src/core/bench/phases.ts:73,79,87,107,116`.

Dream's workrun journal is the closest existing thing to a live progress
stream — but it goes to a FILE, not to a caller, and it is opened only on the
mutating path (`src/core/brain/dream.ts:236`, inside the destructive-snapshot
callback), so a dry-run dream emits no phase markers at all.

### Operations the task named that are not what it implies

- "the nightly dream pass" — `dream` iterates PHASES, not notes
  (`src/core/brain/dream.ts:101`, straight-line stage sequence at
  `:120,125,139,140,145,156,165,239,277`). Per-item counts exist inside
  `applyDreamPlan` (`src/core/brain/dream-apply.ts:88`, loops at `:143,176,232,267,330`),
  but the top level has no single denominator. Progress for dream is
  phase-shaped, not fraction-shaped.
- "large maintenance sweeps" — the only thing in the repo actually named a
  maintenance sweep is `runMaintenance` (`src/core/brain/maintenance/lane.ts:121`),
  and it is a 4-item task list (`src/core/brain/maintenance/lane.ts:141-143`),
  whose members are dream / reindex / bridges / clusters. It is a
  *dispatcher* over the other long operations, not a long operation of its own.
  Its per-task boundary is already recorded to the journal
  (`appendJournal`, `src/core/brain/maintenance/lane.ts:170`) with `name`,
  `ok`, `duration_ms` — i.e. exactly a phase-progress record, written after
  each task rather than streamed.

### Operations the task missed

`runHealEnrichment` (`src/core/brain/heal-run.ts:43`) is a two-pass rewrite
over every vault page (`listVaultPages` at `src/core/brain/heal-run.ts:53` —
count known) and runs INSIDE the dream pass when `heal_enrich` is on
(gate resolved at `src/core/brain/dream.ts:110`). `measureVault`
(`src/core/search/link-ratchet.ts:269`) copies the entire vault with
`cpSync` (`:283`), forces a full index (`:285`), then walks again to count
(`:295`) — four sequential phases with no shared progress channel.
`buildBacklinkIndex` (`src/core/brain/backlinks.ts:98`) is a full rebuild on
every call with no incremental path, and `auditMoc`
(`src/core/brain/link-graph/moc-audit.ts:107`) calls it.

---

## 2. MCP progress-token support

### There is no MCP SDK

`package.json` declares exactly one runtime dependency —
`"proper-lockfile": "^4.1.2"` (`package.json:56-58`) — plus dev deps
(`@types/bun`, `@types/node`, `@types/proper-lockfile`, `oxfmt`, `oxlint`,
`typescript`) and three optionals (`@node-rs/jieba`, `sqlite-vec`,
`tiny-segmenter`). A repo-wide grep for `modelcontextprotocol`,
`RequestHandlerExtra`, `sendNotification`, `progressToken`, `progress_token`,
`notifications/progress`, and `_meta` over `src/`, `scripts/`, and
`package.json` returns **zero** matches in any MCP context (the only `_meta`
hits are unrelated: `producer_meta` in `src/core/brain/portability/okf.ts:137`
and `session_meta` in the session adapters).

The server is hand-rolled JSON-RPC 2.0: `MCPServer` at `src/mcp/server.ts:69`,
protocol constants at `src/mcp/protocol.ts:11-20`
(`PROTOCOL_VERSION = "2025-06-18"`). **There is no SDK to expose
`_meta.progressToken` or to send `notifications/progress`. Both would have to
be implemented here.**

### The exact seam, and what it drops today

`handleToolsCall` — `src/mcp/server.ts:319`:

```
const name = params["name"];          // src/mcp/server.ts:320
const argsRaw = params["arguments"] ?? {};  // src/mcp/server.ts:325
```

Those are the only two keys read from `params`. A client's
`params._meta.progressToken` is read by nothing and silently discarded. That
is where a token would be picked up.

The single handler invocation seam is `invokeToolHandler` —
`src/mcp/server.ts:167` — which both `tools/call` (`src/mcp/server.ts:237`)
and the CLI bridge `callTool` (`src/mcp/server.ts:147`) go through. Its
docblock names it "Single seam through which every tool handler runs"
(`src/mcp/server.ts:153-166`), and it is already the site of the
unknown-argument gate and the route-latency timer. It is the natural place to
attach a progress sink.

### The handler signature today, verbatim

`src/mcp/tool-contract.ts:83-86`:

```ts
  readonly handler: (
    ctx: ServerContext,
    args: Record<string, unknown>,
  ) => Promise<unknown> | unknown;
```

`ServerContext` is `src/mcp/tool-contract.ts:30-72`: `vault`, `configPath`,
`repoRoot`, optional `capabilityReport`, optional `artifactStore`, and
`agentName` as a getter. There is **no** third `extra` parameter, no request
id, no notification channel. A per-request progress sink would either be a
new optional `ServerContext` field (but the context is currently
per-SERVER, built by the getter at `src/mcp/server.ts:140`, not per-request)
or a new third handler parameter — a signature change across all 88 tool
registrations.

### Neither transport can currently emit an unsolicited frame

- stdio: `serveStdio` writes only what `handleRequest` returns —
  `src/mcp/stdio.ts:67-68` (`const response = await server.handleRequest(...); if (response !== null) writeFrame(stdout, response);`).
  `writeFrame` is a private function taking a `JsonRpcResponse`
  (`src/mcp/stdio.ts:73`); it cannot be handed a notification object without
  a type change, and it is not reachable from a handler.
- HTTP: one request → one response → connection closed.
  `src/mcp/http.ts:159` (`const response = await mcp.handleRequest(jsonReq);`)
  then a single write. The SSE branch is `src/mcp/http.ts:168` →
  `writeSse` (`src/mcp/http.ts:282`), whose body is
  `res.end(\`event: message\ndata: ${JSON.stringify(response)}\n\n\`)`
  (`src/mcp/http.ts:292`) — `res.end`, i.e. exactly one event, then closed.
  `docs/mcp.md:289-291` documents this: "clients that send
  `Accept: text/event-stream` receive a single SSE `message` event for the
  same JSON-RPC response." There is no persistent GET stream, no session
  resumption, no `Mcp-Session-Id` reuse (a fresh UUID is minted per
  `initialize` at `src/mcp/http.ts:165` and never stored).

So MCP progress requires: (a) reading `params._meta.progressToken`, (b) a
writer handle plumbed from the transport down to the handler, and (c) for
HTTP, converting the SSE branch from `res.end` to a held-open stream.
(a) and (b) are contained; (c) is a transport rewrite.

### Capabilities

`initialize` advertises only `tools` and `resources`
(`src/mcp/server.ts:275-278`). Nothing else is negotiated. Note that
progress notifications are not a server capability in the spec — the client
opts in per-request by sending a token — so no capability change is strictly
required, but `docs/mcp.md:14-18` would be inaccurate until updated.

### Which MCP tools actually run for minutes

`src/mcp/search-tools.ts:5-9` states plainly: "Index management verbs
(`index`, `reindex`, `check`) are intentionally NOT exposed over MCP — they
are operator business, never agent business (design doc §3, principle 5)."
Confirmed: the only MCP call site of `indexVault` is inside
`brain_maintenance` (`src/mcp/brain/admin-tools.ts:317`). The MCP surfaces
that can genuinely run long are therefore:

- `brain_maintenance` → `runMaintenance` at `src/mcp/brain/admin-tools.ts:302`,
  which runs dream (`:311`), indexVault (`:317`), discoverBridges (`:329`),
  detectCommunities (`:358`).
- `brain_dream` → `dream(...)` at `src/mcp/brain/feedback-tools.ts:467`
  (preview) and `:484` (apply).
- `brain_bridges` → `discoverBridges` at `src/mcp/brain/knowledge-tools.ts:170`.
- `brain_clusters` → `detectCommunities` at `src/mcp/brain/knowledge-tools.ts:252`.
- `brain_brief` runs a dry-run dream at `src/mcp/brain/brief-tools.ts:361`.
- `brain_deep_synthesis` → `deepSynthesis` at `src/mcp/brain/knowledge-tools.ts:351`
  (bounded search, but one full `walkVault` at `src/core/brain/deep-synthesis.ts:389`).

Incidental finding: `brain_bridges` and `brain_clusters` pass **no**
`safeguard` (`src/mcp/brain/knowledge-tools.ts:170-174` and `:252-255`),
while the maintenance-lane copies of the same calls do
(`src/mcp/brain/admin-tools.ts:332,358`). Those two MCP tools have no
deadline today.

---

## 3. CLI output substrate

### There is no single JSON emission point

`src/cli/output.ts` (52 lines) is the nominal shared printer:
`ok` (`:10`), `okJson` (`:15`), `fail` (`:20`), `info` (`:26`),
`writeJson(payload, replacer?)` (`:35-38`), `failWith` (`:47`). Its docblock
at `src/cli/output.ts:30-34` claims it "centralises the format so subcommands
don't each repeat the same `JSON.stringify(...) + "\n"` boilerplate". That is
not what the tree looks like:

- `src/cli/output.ts` is imported by 11 files; `writeJson` has 4 real call
  sites (`src/cli/vault/verbs/map.ts:25`, `profile.ts:29`, `status.ts:43`,
  `inspect.ts:70`).
- `okJson` has roughly 280 call sites, all reached through the barrel
  re-export at `src/cli/brain/helpers.ts:98`, and it hard-codes an
  `{ok:true, ...}` envelope (`src/cli/output.ts:15`) — so it is the `brain`
  family's emitter, not the CLI's.
- Everything else writes its own: ~520 `process.stdout.write` calls across
  `src/cli`, of which ~119 shape JSON inline. Representative:
  `src/cli/search/verbs/indexing.ts:104-109`, `src/cli/main.ts:819`,
  `src/cli/brain/verbs/dream.ts:229` and `:404`.
- Formatting is not uniform either: the `search` family emits compact
  single-line JSON (`src/cli/search/verbs/indexing.ts:104`,
  `src/cli/search/verbs/query.ts:164`), most others pretty-print with
  `null, 2`.

`console.log` appears **zero** times in `src/cli`.

### How `--json` routes, and the buffering trap

`--json` is auto-injected into every flag schema —
`src/cli/argparse.ts:39-40`. Dispatch splits into two families at
`src/cli/main.ts:900-903`:

```
if (wantsJsonFlag(rest) && !ownsInternalJson(command, rest)) {
  return await withJsonFallback(command, run);
}
```

`COMMANDS_WITH_INTERNAL_JSON` is the 12-entry fact table at
`src/cli/json-helpers.ts:45-58`: `status, install, update, tool-call,
secrets, brain, search, vault, discipline, partner, doctor, onboarding`.

**The trap:** for every command NOT in that set, `withJsonFallback`
(`src/cli/json-helpers.ts:88`) monkey-patches BOTH `process.stdout.write`
and `process.stderr.write` into string accumulators
(`src/cli/json-helpers.ts:97-106`), restores them in a `finally`
(`:112-113`), and emits one envelope at the end (`:116-119`). Any progress a
wrapped command writes — to either stream — is invisible until the run
finishes, which defeats the entire point.

That is survivable only because the long commands live under `search` and
`brain`, both of which ARE in the internal-JSON set
(`src/cli/json-helpers.ts:51-52`) and therefore unwrapped. A progress design
must state that dependency explicitly; it is load-bearing and undocumented.

### The stdout/stderr boundary today

There is **no** runtime guard forbidding stdout writes. `src/cli/stdout-guard.ts`
is misleadingly named — it maps stdout *stream errors* to exits: `EPIPE_CODE`
(`:16`), `isEpipeError` (`:23`), `handleStdoutError` (`:39`, EPIPE → exit 0),
`installStdoutEpipeGuard` (`:66`), installed once at `src/cli/main.ts:1007`.

What actually enforces the boundary is three partial mechanisms:

1. **The core layering test** — `tests/core/layering.test.ts:20-24` bans
   `process.exit`, `process.stdout.write`, and `console.log(` anywhere in
   `src/core`; its docblock (`tests/core/layering.test.ts:1-11`) states the
   rule: "The CLI owns exit codes and stdout formatting; src/core must never
   terminate the process or write to stdout directly. Fail-soft diagnostics
   on stderr … stay allowed." **This is why `onFile` exists** — core cannot
   print, so it must hand events out. Any progress design that has core
   printing fails this test.
2. **The advisory rail** — `src/cli/advisory-rail.ts`. `advisoryIsLegal` at
   `src/cli/advisory-rail.ts:85-88` refuses to write when
   `jsonRequested && ownsInternalJson(...)`, with named outcomes
   `emitted` / `suppressed-machine-stream` / `unregistered-code`
   (`src/cli/advisory-rail.ts:53-60`). Its docblock (`:15-20`) states the
   rule: "Twelve top-level commands render their own JSON, and their stdout is
   a payload a caller parses; one stray advisory line breaks it." Routing
   through it is voluntary.
3. **`withJsonFallback`'s buffering** — containment, not prohibition.

### What already prints intermediate lines

| Site | What | Stream | Gate |
|---|---|---|---|
| `src/cli/search/verbs/indexing.ts:142-147` | `` `${e.kind}\t${e.path}${msg}\n` `` per file, `o2b search index` | stderr | `--verbose` |
| `src/cli/search/verbs/indexing.ts:184-186` | `` `${e.kind}\t${e.path}\n` `` per file, `o2b search reindex` | stderr | `--verbose` |
| `src/cli/search/verbs/check.ts:255-262` (`announceScan`, called `:311`) | one PRE-scan wait estimate | stderr | `--integrity` |
| `src/cli/search/verbs/watch.ts:63-67` | `` `synced N change(s): +A ~U =E` `` per debounced flush | stderr | always (`o2b search watch`) |

The `announceScan` docblock at `src/cli/search/verbs/check.ts:249-254` is the
nearest thing to a written stream policy: "It goes to stderr in both report
shapes … stdout under `--json` is a payload a caller parses."

`o2b brain dream` prints **nothing** while working — all output lands after
completion (`src/cli/brain/verbs/dream.ts:229`, `:404`). Same for `o2b doctor`
(`src/cli/main.ts:347`).

There is no spinner, no `\r` redraw, no percent counter, and no `ora`-style
dependency anywhere (`package.json:56-58` has one runtime dep). There is no
NDJSON output mode and no `--stream` flag on any command.

---

## 4. Existing counters / metrics

`src/core/brain/metrics.ts` is a **post-hoc, run-level** sink, not a live
counter substrate:

- `appendMetric(vault, {surface, runAt, payload})` —
  `src/core/brain/metrics.ts:83` — appends ONE JSONL line per RUN to
  `Brain/metrics/<surface>.jsonl` (`surfacePath`, `:67`), envelope
  `{schema:"o2b.metrics.v1", surface, run_at, payload}` (`:91-96`).
- The docblock at `src/core/brain/metrics.ts:9-11` is explicit: "Records are
  RUN-LEVEL (one per index run, discovery pass, benchmark or tuning run)".
- Contract documented for external consumers at `docs/metrics.md:1-40`
  (surfaces: `index`, `bridge_discovery`, `communities`, `recall_benchmark`,
  `self_tuning`, `dream_stage`).
- 18 call sites, all AFTER the work completes, e.g.
  `src/core/search/indexer.ts:612` (guarded by
  `if (stats.added + stats.updated + stats.deleted > 0)` at `:608`).

**Conclusion:** a progress reporter cannot reuse this. Reusing it would mean
appending a vault file per progress tick, which turns telemetry into an I/O
amplifier and pollutes a documented dashboard contract whose evolution rule
(`src/core/brain/metrics.ts:16-19`) treats semantic changes as a version bump.
The right reuse is the *shape* — `{surface/phase, integer payload}` — not
the sink.

The other in-flight counter substrate is `MutableStats` /
`EmbeddingPhaseTally`:
`src/core/search/indexer.ts:790-793` declares
`EmbeddingPhaseTally { embeddingsComputed: number; embeddingsRetries: number }`
and its docblock (`:785-789`) explains it was extracted precisely so the
embed phase can serve both the index run and the standalone backfill. That is
a live, mutated-in-place counter object already threaded through both callers
— the closest existing thing to a shared progress accumulator, though it is
read only at the end (`freezeStats`, `src/core/search/indexer.ts:175`).

---

## 5. Prior art for a cross-cutting optional callback

The house idiom exists and is used in exactly this shape. Every instance is
an optional readonly field on an options interface, invoked with `?.`:

| Anchor | Field |
|---|---|
| `src/core/search/indexer.ts:110` | `readonly onFile?: (event: IndexProgressEvent) => void;` |
| `src/core/search/rerank/index.ts:56` | `readonly onTelemetry?: (event: RerankTelemetryEvent) => void;` |
| `src/core/brain/notes/note-walk.ts:62` | `readonly onOversize?: (file: NoteWalkFile, sizeBytes: number) => void;` |
| `src/core/brain/inject-failopen.ts:66` | `readonly audit?: (source, error: unknown) => void;` |
| `src/core/brain/health/remediation.ts:168` | `readonly log?: (message: string) => void;` |
| `src/core/fs-atomic.ts:78` | `readonly validate?: (candidate: string) => void;` |
| `src/core/brain/link-graph/communities.ts:220` | `readonly writeNote?: (path: string, content: string) => void;` |

**`onFile` is the direct precedent and it is already a progress channel.**
`IndexProgressEvent` — `src/core/search/indexer.ts:98-102`:

```ts
export interface IndexProgressEvent {
  readonly path: string;
  readonly kind: "added" | "updated" | "unchanged" | "deleted" | "error";
  readonly message?: string;
}
```

Fired at `src/core/search/indexer.ts:347`, `:363`, `:469`, `:472`, `:477`,
`:485`. Consumed at exactly two sites, both writing tab-separated lines to
stderr behind `--verbose`: `src/cli/search/verbs/indexing.ts:142` and `:184`.
`reindexVault` forwards it through the spread at
`src/core/search/indexer.ts:969` (`{ ...opts, force: !resume }`).

The second, stronger idiom is the **safeguard** — the cross-cutting optional
parameter threaded through this exact operation set:
`readonly safeguard?: Safeguard` appears at
`src/core/search/indexer.ts:115`, `src/core/search/indexer.ts:799`,
`src/core/search/vector-backfill.ts:49`, `src/core/brain/dream-types.ts:212`,
`src/core/brain/dream-stage.ts:100`,
`src/core/brain/link-graph/bridge-discovery.ts:76`,
`src/core/brain/link-graph/communities.ts:69`. It is invoked as
`opts.safeguard?.checkpoint()` at `src/core/brain/dream.ts:104,198,209,224,269,310`,
`src/core/search/indexer.ts:328,882`,
`src/core/brain/link-graph/bridge-discovery.ts:96,135`,
`src/core/brain/link-graph/communities.ts:79,95`. The interface is three
members (`src/core/brain/safeguard.ts:71-78`) and has a no-op constructor
`noopSafeguard` (`src/core/brain/safeguard.ts:95`).

**Every safeguard `checkpoint()` call is already at the exact iteration
boundary a progress tick belongs at.** A progress reporter that follows the
house idiom is: one more optional field on the same options interfaces, one
more call beside each existing `checkpoint()`, invoked with `?.`.

Two things about that idiom the design must respect:

1. `Safeguard.checkpoint()` is **synchronous and returns void**
   (`src/core/brain/safeguard.ts:72`). So is `onFile`. A progress callback
   must be synchronous too — see §7.
2. The safeguard resolves its own config ladder in core
   (`resolveSafeguardTimeoutMs`, `src/core/brain/safeguard.ts:131`) and
   fails soft on an unparseable value (`parseSeconds`, `:150-155`), with the
   docblock at `src/core/brain/safeguard.ts:16-21` stating the ladder. A
   progress reporter's on/off decision should follow the same pattern rather
   than inventing a new config surface.

For the CLI half, the *policy* precedent is `src/cli/advisory-rail.ts` in
full: one module that (1) resolves what to say from a registered CODE and
refuses to accept prose from a caller (`src/cli/advisory-rail.ts:8-15`),
and (2) decides whether the stream is legal to write to
(`advisoryIsLegal`, `:85-88`). A structured progress emitter should be that
module's twin, not 500 more `process.stdout.write` calls.

---

## Divergences

Things in t_62bb944a's framing that do not survive contact with the source.

1. **"No streaming/incremental background-command output surface was found …
   This confirms the feature (progress reporting on long ops) is absent."**
   Wrong for the CLI. `IndexProgressEvent` + `onFile`
   (`src/core/search/indexer.ts:98-110`) is a real per-file progress channel
   wired to stderr at `src/cli/search/verbs/indexing.ts:142` and `:184`.
   `o2b search watch` streams a per-flush line unconditionally
   (`src/cli/search/verbs/watch.ts:63-67`). The gap is that progress is
   unstructured, un-counted, and exists on exactly one operation — not that
   it is absent. This is a *generalize and structure* task, not a *create*.

2. **"MCP supports progress notifications via a progress token"** — true of
   the spec, but the task's "thread MCP progress-notification support through
   the tools" implies an SDK that already carries the token. There is no SDK
   (`package.json:56-58`; zero `modelcontextprotocol` references anywhere).
   `handleToolsCall` reads only `params["name"]` and `params["arguments"]`
   (`src/mcp/server.ts:320,325`), and neither transport can write an
   unsolicited frame (`src/mcp/stdio.ts:67-68`; `src/mcp/http.ts:292` uses
   `res.end`). This is not "plumbing through" — it is implementing progress
   notifications, plus an SSE transport rewrite for the HTTP half.

3. **"Reindex/embeddings/dream are the operations most likely to run for
   minutes … an agent driving OSB over MCP cannot tell a slow run from a hung
   one."** Reindex and embeddings are **not reachable over MCP at all** by
   design: `src/mcp/search-tools.ts:5-9` — "Index management verbs (`index`,
   `reindex`, `check`) are intentionally NOT exposed over MCP — they are
   operator business, never agent business". The only MCP path to `indexVault`
   is as one of four tasks inside `brain_maintenance`
   (`src/mcp/brain/admin-tools.ts:317`). So the MCP half of this task covers
   `brain_maintenance`, `brain_dream`, `brain_bridges`, `brain_clusters`,
   `brain_brief` — a much smaller set than the framing suggests, and two of
   those (`brain_bridges`, `brain_clusters`) run without even a deadline
   today (`src/mcp/brain/knowledge-tools.ts:170,252`).

4. **"`o2b` CLI: already streams to a terminal for interactive runs."**
   Partly false. Only `o2b search index|reindex --verbose` and
   `o2b search watch` stream. `o2b brain dream` and `o2b doctor` print
   nothing until they finish (`src/cli/brain/verbs/dream.ts:229`,
   `src/cli/main.ts:347`). There is no spinner or tick anywhere.

5. **"large maintenance sweeps"** as a peer of reindex/dream. `runMaintenance`
   (`src/core/brain/maintenance/lane.ts:121`) is a gate + lease + 4-task
   dispatcher whose tasks ARE dream and reindex
   (`src/cli/brain/verbs/maintenance.ts:130-186`,
   `src/mcp/brain/admin-tools.ts:307-360`). Treating it as a fourth long
   operation double-counts. Its correct role in this design is as the
   *aggregator* that forwards a child operation's progress upward with a task
   label.

6. **"a low-risk ergonomic win."** The MCP half is not low-risk: it needs a
   request-scoped channel where the current `ServerContext` is server-scoped
   (built by the getter at `src/mcp/server.ts:140`), a change to the handler
   contract at `src/mcp/tool-contract.ts:83` shared by 88 registered tools,
   and an HTTP transport that holds a connection open instead of
   `res.end`-ing (`src/mcp/http.ts:292`). The task's own escape hatch — "If
   MCP progress plumbing proves heavier than the payoff, the CLI-only slice
   still stands on its own" — is the accurate read of this codebase.

7. **The codegraph hint about `jobsFilePath` at `src/cli/discipline-install.ts:19`**
   — could not be verified as still accurate; not checked, and irrelevant
   either way since the task correctly rules the job-console model out.

---

## What a design must not assume

1. **Do not assume a denominator.** `indexVault` walks a generator
   (`src/core/search/indexer.ts:324`, `src/core/search/walker.ts:51`). The
   event shape must make `total` optional, and a UI must render a bare
   counter when it is absent. Materializing the walk to get a total costs a
   second full directory traversal (`src/core/search/link-ratchet.ts:256`) —
   if the design wants it, it must say so and pay for it, not pretend it is
   free.

2. **Do not assume the callback can be `async`.** `dream`
   (`src/core/brain/dream.ts:101`), `discoverBridges`
   (`src/core/brain/link-graph/bridge-discovery.ts:88`), `detectCommunities`
   (`src/core/brain/link-graph/communities.ts:76`), `runDoctor`
   (`src/core/brain/doctor.ts:202`), `runHygieneScan`
   (`src/core/brain/hygiene/scan.ts:38`) and `stageDream`
   (`src/core/brain/dream-stage.ts:238`) are all **synchronous**. A
   `(event) => Promise<void>` sink cannot be awaited inside them, and Bun runs
   SQLite synchronously anyway (`src/core/brain/safeguard.ts:5-7`). The sink
   must be `(event) => void`, matching `onFile`
   (`src/core/search/indexer.ts:110`) and `Safeguard.checkpoint`
   (`src/core/brain/safeguard.ts:72`). This directly constrains the MCP half:
   a synchronous sink cannot `await` a write, so the MCP progress writer must
   buffer or write synchronously.

3. **Do not let core print.** `tests/core/layering.test.ts:20-24` fails the
   build on any `process.stdout.write` or `console.log(` in `src/core`. Core
   emits events; only `src/cli` and `src/mcp` may write them.

4. **Do not write progress to stdout for the twelve internal-JSON commands.**
   `src/cli/json-helpers.ts:45-58` names them; `search` and `brain` are both
   in the set, so their stdout is a caller-parsed payload
   (`src/cli/advisory-rail.ts:15-20`). Progress belongs on stderr, matching
   every existing precedent (`src/cli/search/verbs/indexing.ts:142`,
   `src/cli/search/verbs/check.ts:255-262`,
   `src/cli/search/verbs/watch.ts:63`).

5. **Do not write progress at all from a `withJsonFallback`-wrapped command.**
   `src/cli/json-helpers.ts:97-106` buffers stdout AND stderr for the whole
   run and releases one envelope at the end
   (`src/cli/json-helpers.ts:116-119`). Progress there is not degraded — it is
   silently swallowed and then dumped at completion, which is worse than
   nothing because it looks like it worked. If a long operation ever moves
   outside `COMMANDS_WITH_INTERNAL_JSON`, its progress disappears. That
   dependency must be asserted, not assumed.

6. **Do not assume MCP tools can reach reindex or embeddings.** They cannot
   (`src/mcp/search-tools.ts:5-9`). Any MCP progress work targets
   `brain_maintenance`, `brain_dream`, `brain_bridges`, `brain_clusters`.

7. **Do not emit a natural-language sentence as the progress payload.** The
   repo has a hard rule against caller-supplied prose on structured surfaces
   — `src/cli/advisory-rail.ts:8-15` ("There is deliberately no parameter
   through which a caller can supply a command or a sentence: prose cannot
   enter this surface") — and the same rule is why `IndexProgressEvent.kind`
   (`src/core/search/indexer.ts:100`) and `DREAM_PHASE`
   (`src/core/brain/dream-phases.ts:19`) are stable identifiers rather than
   labels. A progress event must carry a phase identifier and integer counts;
   any human sentence is rendered at the edge, from that identifier.

8. **Do not reuse `Brain/metrics/` as the progress sink.** It is a documented
   run-level dashboard contract (`docs/metrics.md:1-40`,
   `src/core/brain/metrics.ts:9-19`) with one append per RUN. Per-tick
   appends would break it and hammer the disk.

9. **Do not introduce a silent no-op path.** `opts.onProgress?.(…)` with no
   sink attached is fine — that is the existing `onFile` /
   `safeguard?.checkpoint()` idiom, where absence means "nobody asked". What
   is NOT acceptable is a progress surface that is wired but discards events
   because the transport cannot carry them (the HTTP `res.end` case,
   `src/mcp/http.ts:292`): that would report liveness support that does not
   exist. Either the HTTP transport holds the stream open, or the MCP progress
   surface must refuse the token on HTTP and say why.

10. **Do not assume the dream workrun journal is a live stream.** It is a
    file (`Brain/log/dream-runs/<run-id>.jsonl`,
    `src/core/brain/dream-workrun.ts:79-88`), it is opened only on the
    mutating path (`src/core/brain/dream.ts:236`), and `checkpoint` is a
    silent no-op after `finalize`/`interrupt`
    (`src/core/brain/dream-workrun.ts:103`). It is the right *vocabulary*
    source and the right *emission points*, but it is not a channel to a
    caller.
