# Recon: concurrency, cancellation, and host pressure (t_fe4b6be0, t_992f0c33)

Read-only reconnaissance against `feat/nothing-runs-unwatched` @ `aa818084` (v1.47.0).
Every claim is anchored to lines that were read. Findings that change the shape of
either task are marked **(shape-changing)**.

Both tasks arrive from a daemon-shaped upstream product. Open Second Brain is not
daemon-shaped, and does not call a chat model. Most of what follows is the record of
where that framing breaks.

---

## 1. Where this codebase issues LLM inference

**It does not. The server process never makes an outbound chat-model call. (shape-changing)**

The kernel's contract is to hand model work *back to the caller* as a typed envelope,
never to prompt a model itself. This is stated at the readiness probe that would have
been the natural place to hide an inference client — `src/core/doctor-readiness.ts:40-44`:

> the deterministic Brain core has no in-repo chat-LLM client (write-time model steps
> are handed back to the host as `needs-llm-step` envelopes). The only model-inference
> credential the system itself resolves is the embedding provider's API key

The `needs-llm-step` envelope is the whole mechanism, and it appears at five producers:

| Producer | Envelope construction | What the caller is asked to generate |
|---|---|---|
| `src/core/brain/rollup-ladder.ts:63-72`, built at `:193-197` | `RollupEnvelope` | the rollup summary note for a fired rung |
| `src/core/brain/diarization.ts:83`, built at `:237` | diarization envelope | subject-profile prose |
| `src/core/brain/write-session/engine.ts:98` | session step | the current section's draft |
| `src/core/brain/write-session/panel.ts:89`, `:197` | panel step | panel prose |
| `src/core/brain/write-session/types.ts:23,35` | the status vocabulary itself | — |

The determinism claim is repeated as a module invariant across the layer, not asserted
once: `src/core/brain/note-history.ts:11`, `src/core/brain/generation-reports.ts:5`
("Open Second Brain's kernel never calls an LLM - the calling agent…"),
`src/core/bench/judge.ts:5`, `src/core/reliability/command-bridge.ts:5`,
`src/core/brain/idempotency-ledger.ts:31`, `src/core/surface/lexical-score.ts:3`.

**The dream pass is one of these producers, not a consumer.** `dream()` emits rollup
envelopes (`src/core/brain/dream-types.ts:140`, plan built in
`src/core/brain/dream.ts:220-222`). Whatever inference those envelopes cause happens in
the *host agent's* process, after `dream()` has already returned. Nothing inside this
repo can cap it, count it, or cancel it.

### What outbound network calls actually exist

Six `fetch` sites in `src/`, none of them a chat completion:

| Site | Purpose | Concurrency bound today |
|---|---|---|
| `src/core/search/embeddings/openai-compat.ts:431` | `/v1/embeddings` | `Semaphore(config.concurrency)` per `embed()` call — `:279` |
| `src/core/search/embeddings/zeroentropy.ts:192` | embeddings | `Semaphore(config.concurrency)` per `embed()` call — `:107` |
| `src/core/search/rerank/cross-encoder.ts:85` | cross-encoder rerank | **none** — one request at a time by construction; per-request `AbortController` timeout at `:82,96` |
| `src/core/brain/research/external-fetch.ts:231` | Brave / Tavily web search | unbounded `Promise.all` over `pool.providers` (`src/core/brain/research/research.ts:310`), but the pool is at most 2 |
| `src/core/brain/capture/telegram-capture.ts:418` | `getUpdates` long poll | strictly sequential — each cycle uses the previous offset (`:348-354`) |
| `src/core/brain/capture/telegram-capture.ts:433` | `sendMessage` | sequential, inside the same loop |

`src/core/brain/explorer.ts:324` is a `fetch` *handler* (`Bun.serve`), i.e. inbound, not
an egress site.

Note also that the repo's egress census (`src/core/egress/registry.ts:87-160`,
enforced by `tests/core/architecture/egress-census.test.ts`) covers **export-to-file**
paths only — the seven `o2b … export` verbs. None of the six network sites above is in
it. The registry's own framing says so: "The boundary that exists is the export
surface" (`src/core/egress/registry.ts:8-9`). There is no census of outbound network
calls, so "every place this process talks to a remote host" is not currently a
maintained list.

**Consequence for t_fe4b6be0:** "a daemon-wide ceiling on concurrent LLM inference calls
shared across extraction/synthesis/dream workers" has no subject. There are no
extraction, synthesis, or dream *workers*; there is no inference to cap. The honest
restatement of the task is a ceiling on **concurrent outbound HTTP to the embedding and
rerank providers**, which is a different, smaller, and already-partly-solved problem
(§2).

---

## 2. What concurrency exists today

### 2.1 `dream()` is synchronous **(shape-changing)**

`src/core/brain/dream.ts:101`:

```ts
export function dream(vault: string, opts: DreamOptions = {}): DreamRunSummary {
```

Not `async`. There is no `await` anywhere in the function. Stage 0
(`scanBrain`, `src/core/brain/dream-scan.ts:124-137`) is `readdirSync` +
`parseFrontmatter` in a plain loop; the apply stage
(`src/core/brain/dream-apply.ts`, via `withDestructiveSnapshot` at `dream.ts:213`) is
synchronous file I/O. The whole pass occupies one turn of the event loop.

That has three consequences a design must absorb:

- There is nothing *concurrent* inside a dream pass to bound. The pass is a single
  serial computation.
- A pressure gate can only run **before** the pass or **at a checkpoint**, never
  "during" it in any preemptive sense.
- Yielding mid-pass would require making `dream()` async, which changes the signature
  of a function called from five sites (`src/core/brain/review-candidates.ts:102`,
  `src/core/brain/dream-stage.ts:241,356,395`, `src/mcp/brain/feedback-tools.ts:467,484`,
  `src/cli/brain/verbs/maintenance.ts:135`).

The same is true of the write path: `applyWriteBatch`
(`src/core/brain/write-batch.ts:206`) is synchronous, and its own header names the cost
at `:51-54` — "performs synchronous file I/O … which blocks the event loop for the
duration of the whole batch; an unbounded [batch] …" — which is exactly why
`MAX_BATCH_OPERATIONS = 100` (`:56`) exists as a hardcoded constant.

### 2.2 The one in-process concurrency limiter

`Semaphore` — `src/core/search/embeddings/http-util.ts:81-100`. Counting semaphore,
FIFO waiter queue, floor of `Math.max(1, n | 0)` at `:85`.

It is **instantiated per call**, not shared: `openai-compat.ts:279` and
`zeroentropy.ts:107` each do `new Semaphore(this.config.concurrency)` inside `embed()`.
So `embedding_concurrency` bounds *one* `embed()` call, not the process. Two overlapping
`embed()` calls would get `2 × concurrency` requests in flight. In practice the indexer
serialises them — `src/core/search/indexer.ts:879-886` is a sequential `for` loop that
awaits each `provider.embed`, deliberately handed a `superBatch = batchSize × concurrency`
(`:877`) so the provider's internal semaphore stays busy. The over-subscription is
therefore latent, not live — but it is the natural seam for a process-wide ceiling.

There is no async mutex, no write queue, no promise-chain serialiser, and no `p-limit`
anywhere else in `src/`.

### 2.3 Every parallel fan-out

Ten `Promise.all` / `allSettled` / `race` sites in all of `src/`:

| Site | Bound | Kind |
|---|---|---|
| `src/core/search/embeddings/openai-compat.ts:312,315` | `embedding_concurrency` (default 4) | **config-driven** |
| `src/core/search/embeddings/zeroentropy.ts:129,132` | `embedding_concurrency` | **config-driven** |
| `src/core/search/rerank-fit-check.ts:319` | `maxQueries`, applied via `.slice` at `:300` | config-driven |
| `src/core/doctor-readiness.ts:536` | fixed `DEFAULT_PROBES` array; per-probe timeout at `:533` | constant |
| `src/core/brain/research/research.ts:310` | `pool.providers`, at most 2 | constant |
| `src/core/search/tuning.ts:95` | fixed 24-point grid (`src/core/search/tuning-store.ts:22-23`) | constant, **but see below** |
| `src/core/search/benchmark.ts:203` | **none** | **unbounded** |
| `src/core/brain/secrets/exec.ts:133` | 3-tuple of one child's streams | not a fan-out |
| `src/core/brain/recall-inject.ts:349` | `Promise.race` timeout | not a fan-out |
| `src/core/search/watch-runner.ts:101` | `Promise.race` grace window | not a fan-out |

`src/core/search/benchmark.ts:203` is the one genuinely unbounded fan-out: one concurrent
hybrid `search()` per query in an operator-supplied dataset, each a SQLite read, guarded
only by a non-emptiness check at `:194-196`. Reached through `tuneRecall` it is
amplified 24×. The comment at `:186-187` justifies the concurrency on *correctness*
grounds (the queries are read-only) and does not address resource bounding.

### 2.4 Locks

There is **no single shared lock module**. Three primitives plus one lease, plus six
copy-pasted retry loops.

| Module | Primitive | Discipline |
|---|---|---|
| `src/core/reliability/lock.ts:22-50` | `proper-lockfile`, async | stale 30 s (`:32`), 3 retries × 250 ms (`:34-39`); **fail-closed** → `FileLockError` (`:41-43`). Only 2 callers: `src/core/brain/schema-mutate.ts:197`, `src/core/brain/health-baseline.ts:58` |
| `src/core/brain/sync-lockfile.ts:65-80` | hand-rolled `openSync(…, "wx")`, **not** proper-lockfile | **no retry, no backoff, no stale timeout** — by design (`:13-15`). ~10 callers; the Brain write path |
| `src/core/search/store/writer-lock.ts:37,64` | `proper-lockfile`, sync + async | stale 60 s (`:18`); async heartbeats mtime every 30 s (`:29,71`). Sync: 10 × `Bun.sleepSync(50)` (`:37-52`). Async: 3 retries × 1000 ms (`:64-77`). **fail-closed** → `SearchError("INDEX_LOCKED")` (`:32-35`) |
| `src/core/brain/maintenance/lease.ts:59-83` | SQLite conditional upsert | TTL-based, not mtime-based; **fail-closed** (work skipped, never done unlocked) |

Per-call-site locks with hardcoded, mutually inconsistent policies:
`src/core/brain/log.ts:237-252` (stale 10 s, 10 × 50 ms, fail-closed),
`src/core/brain/triggers/store.ts:760-768` (**zero retries**),
`src/core/brain/secrets/store.ts:86-111` (20 × 25 ms),
`src/core/brain/portability/profiles.ts:147-168` (10 × 50 ms),
`src/core/brain/inline-rewrite.ts:55-59` (30 retries, factor 1.2, 30→500 ms — the most
generous in the repo; it locks the **parent directory** because a per-file lock would
race `atomicWriteFileSync`'s temp sibling, `:17-19,50-51`).

Three sites are **fail-open** and must be named because a pressure gate would sit
next to them:

- `src/core/config.ts:453-457` and `:536-543` — after exhausting attempts, `release`
  stays `undefined` and the code **proceeds unlocked**. Documented as intentional at
  `:435-440`; the cost is a duplicate device-id, absorbed downstream by
  `src/core/brain/log.ts:254-273`.
- `src/core/search/store/lifecycle.ts:81-88` — `restoreFromBakIfMissing` swallows the
  lock failure and returns **without restoring** (`:73-76`).
- `src/core/brain/lineage/ledger.ts:772-786` — drops the observation but records a typed
  gap (`lockBusy` / `lockFailed`) rather than staying silent. This is the honest pattern
  the operator's "no misleading fallback" rule points at.

Stale windows are inconsistent — 60 s / 30 s / 10 s / **∞**. `sync-lockfile.ts` has no
stale concept at all: recovery is only the `process.on("exit")` sweep (`:40-53`), so a
SIGKILL during a Brain write leaves a `.lock` that nothing ever reclaims. It is
*surfaced*, not cleared, by `scanStaleLocks` (`:120-125`) →
`src/core/brain/doctor/uncertainty-probes.ts:138`. The single exception that breaks a
stale lock is `src/core/brain/lineage/ledger.ts:929-941` (`GAP_LOCK_STALE_MS = 60_000`,
`:119`).

`src/core/brain/metrics.ts:11-14` is the *absence* of a lock, deliberately: single-line
`O_APPEND` writes (`:101`) that interleave rather than race. The task hint calls this a
concurrency control; it is the opposite — a documented decision not to have one.

Atomic writes and locks are **orthogonal and composed by the caller**.
`src/core/fs-atomic.ts` takes no lock, and says so at `:49-50`: `renameSync` "clobbers an
existing target … **No exclusivity guarantee**". Atomicity prevents torn files; it does
not prevent lost updates.

---

## 3. Cancellation

### 3.1 `AbortSignal` exists, is well-designed, and is not wired to the dream pass **(shape-changing)**

`src/core/brain/safeguard.ts` already models exactly the contract a teardown needs:

- `SafeguardAbortError` (`:51-59`) — an intentional stop, deliberately distinct from
  `SafeguardTimeoutError` so "the watch shutdown coordinator can treat an intentional
  abort as a clean stop rather than a failure" (`:46-49`).
- `CreateSafeguardOptions.signal?: AbortSignal` (`:91`).
- `checkpoint()` checks abort **in priority over** the deadline (`:117-122`).
- `throwIfAborted(signal, operation)` (`:66-68`) for hot loops holding a bare signal.

**No production call site passes `signal`.** All six construct with `operation` +
`timeoutMs` only: `src/cli/brain/verbs/dream.ts:204-207`,
`src/cli/brain/verbs/bridges.ts:155-158`, `src/cli/brain/verbs/clusters.ts:256-259`,
`src/cli/brain/verbs/maintenance.ts:120-123`, `src/cli/search/verbs/indexing.ts:59-62`,
`src/mcp/brain/admin-tools.ts:298-301`. `SafeguardAbortError` is therefore unreachable in
production.

`throwIfAborted` has exactly two callers, both in the indexer:
`src/core/search/indexer.ts:330` (between files) and `:883` (between embedding batches).
Its signal comes from `IndexVaultOptions.signal` (`:123`, `:800`).

**So: on-demand cancellation exists on exactly one path — reindex under
`o2b search watch`. The dream pass has no cancellation mechanism other than the
cooperative deadline.**

### 3.2 The one working teardown, and it is a good model

`IndexWatchRunner` — `src/core/search/watch-runner.ts:44-103`. Single-flight
(`flush()` returns the in-flight promise, `:68-86`), then `shutdown()` (`:93-102`):
stop accepting flushes, `controller.abort()`, `await Promise.race([inflight, wait(graceMs)])`
so a wedged pass cannot block exit forever. Wired at `src/cli/search/verbs/watch.ts:93-106`,
where `process.once` is deliberate — a *second* SIGINT hits the default handler and
force-kills (`:99-100`).

### 3.3 Process signal handling

Four sites, all in one-shot or operator-launched foreground commands:

| Site | Behaviour |
|---|---|
| `src/cli/search/verbs/watch.ts:105-106` | **drains, bounded** (above) |
| `src/cli/brain/verbs/explorer.ts:57-64` | closes the server; does **not** drain in-flight requests. `.catch().finally()` so a rejected `close()` cannot hang Ctrl-C (`:54-56`) |
| `src/cli/brain/verbs/telegram-capture.ts:60-61,75-76` | sets a cooperative `stop` flag checked **between** cycles (`src/core/brain/capture/telegram-capture.ts:346,374`). Does **not** abort the in-flight 30 s long poll, so SIGINT can take a full poll timeout to land |
| `src/core/brain/sync-lockfile.ts:43`, `src/core/search/store-exit.ts:34` | `process.on("exit")` cleanup sweeps, not signal handlers; explicitly not SIGKILL-safe (`store-exit.ts:17-18`) |

The MCP stdio server has **no signal handler at all** — `src/mcp/stdio.ts:37-70`, a
`for await` over stdin lines that `return 0`s on EOF. Closing the pipe is the entire
shutdown mechanism.

### 3.4 What an interrupted dream pass leaves behind

Three artifacts, and none of them is resumable state:

1. **A dangling workrun journal.** `src/core/brain/dream-workrun.ts:50-64` writes one
   JSONL line per phase to `Brain/log/dream-runs/<run-id>.jsonl`. The module header
   states the contract at `:9-13`: "Recovery is **non-resuming** - the next dream pass
   processes the inbox fresh; the dangling file serves as forensic evidence, not a
   resumable state machine." Markers are truthful — each is written where that phase's
   durable output has landed (`src/core/brain/dream.ts:225-234`). No fsync per phase
   (`dream-workrun.ts:20-22`).
2. **A pre-run snapshot that is not automatically applied.**
   `withDestructiveSnapshot` (`src/core/brain/snapshot-gate.ts:360-377`) takes the
   archive *before* `op` runs, then: "If it throws, the error propagates and the archive
   above stays exactly where it is: it is the recovery point the caller now needs"
   (`:371-373`). **There is no auto-rollback.** Restoring is an operator action.
3. **Partially applied disk state.** Each individual write is atomic
   (`src/core/fs-atomic.ts`), so no file is torn, but the *set* of writes is not
   transactional. A pass interrupted between `synthesize` and `heal` leaves the earlier
   phases committed.

**`idempotency-ledger.ts` is not a dream-resumption ledger. (shape-changing)** The task
body cites `src/core/brain/idempotency-ledger.ts:23-167` as if it were run state. Its
header (`:1-33`) is explicit: it is a **client-supplied idempotency-key** store for the
feedback/signal *write* path, deduping "a retried or double-delivered tool call". Its
concurrency boundary is stated at `:23-29`: check-and-append is atomic within one
month shard under `acquireLockSync`; two genuinely-concurrent first writers of the same
key can both observe "absent" and both proceed. `dream()` never touches it.

---

## 4. Config surface

There are **two** config files, and they are not interchangeable.

| | Plugin / device config | Vault config |
|---|---|---|
| Path | `$OPEN_SECOND_BRAIN_CONFIG` → `$XDG_CONFIG_HOME/open-second-brain/config.yaml` → `~/.config/…` — `src/core/config.ts:120-131` | `<vault>/Brain/_brain.yaml` — `BRAIN_CONFIG_FILE` at `src/core/brain/path-constants.ts:156`, joined by `brainConfigPath()` at `src/core/brain/paths.ts:196-198` |
| Shape | flat `Readonly<Record<string,string>>` — `src/core/types.ts:10-14` | nested typed `BrainConfig` |
| Reader | `discoverConfig()` — `src/core/config.ts:199-212` | `loadBrainConfig()` — `src/core/brain/policy/load.ts:57-94` |
| Parser | `parseSimpleYaml` — `src/core/config.ts:153-174` | indent-aware parser, `src/core/brain/yaml-parse.ts`; policy at `src/core/brain/policy.ts:1-33` |
| Holds | `embedding_*`, `search_*`, `safeguard_timeout_*` | `dream.*`, `guardrails.*`, `lessons.*`, … |
| Ratchet test | **none** | **yes** |

### The idiom for a bounded numeric key

**In `_brain.yaml` — the canonical one.** `readBoundedInt(map, key, min, max, field, source)`
at `src/core/brain/policy/field-checks.ts:142-153`. Absent → `undefined`;
present-and-bad → `BrainConfigError`. The policy is stated at `field-checks.ts:5-8`:

> none of them clamps, defaults, or returns a neutral value, because a knob that
> silently reverted would be indistinguishable from the operator never having set it.

Worked example, `src/core/brain/policy/blocks/lessons.ts`: default/min/max constants
`:19-27`, `KNOWN_KEYS` `:29`, `openBlock(ctx, BLOCK)` `:32`, three `readBoundedInt`
calls `:35-58`, then `warnUnknownKeys(ctx, map, KNOWN_KEYS, BLOCK)` `:59` — that last
call is what registers the sub-keys in the key index
(`src/core/brain/policy/key-index.ts:33-46`, `:100-116`), which is what the ratchet reads.

**In the plugin config — fail-hard variant** (`embedding_*`): `DEFAULTS` literal
`src/core/search/index.ts:150-181`; parse via
`parseInteger(envOrConfig(env, config, "<ENV>", "<key>"), DEFAULTS.x, "<key>", { min: 1 })`
— `embedding_concurrency` at `:508-513`; re-validated after programmatic overrides by
`validateIntegerRange` at `:277-298`, called at `:338-340`. Helpers in
`src/core/validate.ts:17-40` (`parseInteger` — null → default, blank/non-integer/
non-finite/out-of-range → `throw`) and `:100-111` (`envOrConfig` — env wins, empty
string counts as unset on both sides). Bad value surfaces as CLI exit 2 with the key
name on stderr, pinned by `tests/cli/search.test.ts:219-223` and
`tests/core/search/config.test.ts:303-314`.

**In the plugin config — fail-soft variant.** `resolveSafeguardTimeoutMs`
(`src/core/brain/safeguard.ts:131-148`) with `parseSeconds` (`:150-156`) returns
`undefined` on a bad value and **silently falls through to the next source**; it even
swallows `ConfigReadError` (`:136-140`). Same shape at `src/core/config.ts:1002-1009`
and `:1044-1051`. Both disciplines are live in the repo; a new key must pick one
deliberately, and for a *safety* ceiling the fail-hard form is the one that matches the
operator's rule.

### The ratchet

`tests/core/brain/config-template-ratchet.test.ts` — for `_brain.yaml` only. Keys are
enumerated **by running the validator** (`brainConfigKnownKeys()`,
`src/core/brain/policy/validate.ts:214-228`), not from a hand-kept list. Four assertions
a new key must satisfy: top-level coverage `:191-196`, sub-key coverage `:198-211`,
reverse direction (template names no unknown key) `:213-226`, every omission carries a
written reason `:228-233`. Plus `:245-247` — the live surface must stay byte-identical
to the frozen v1.38.0 `LEGACY_TEMPLATE` (`:67-111`), so **a new key must be emitted
commented, not live**, and `:249-258` asserts non-live keys appear nowhere uncommented.

**There is no equivalent ratchet for the flat plugin config**: no known-key list, no
unknown-key warning, no docs-coverage test. There is also no JSON schema for either file
(`schemas/` holds only four *report* schemas). And there is no canonical env-var list:
104 distinct `OPEN_SECOND_BRAIN_*` names appear in `src/`, 28 appear in
`docs/cli-reference.md`; only seven are hoisted into named constants. The naming
convention (`OPEN_SECOND_BRAIN_` + upper-snaked key) is unenforced and frequently
abbreviated — `embedding_batch_size` → `OPEN_SECOND_BRAIN_EMBEDDING_BATCH`,
`safeguard_timeout_seconds` → `OPEN_SECOND_BRAIN_SAFEGUARD_TIMEOUT`.

---

## 5. Host-pressure measurement

**Nothing in this repo measures host pressure. (shape-changing)**

`node:os` is imported at 14 sites in `src/`, and every single one is `homedir` or
`tmpdir`. There is **zero** use of `os.loadavg()`, `os.cpus()`, `os.freemem()`,
`os.totalmem()`, or `os.availableParallelism()`. There is no `/proc` read, no cgroup
read, and no `process.cpuUsage()` / `process.memoryUsage()` call in a gating position.

### What exists instead, and it is most of the feature

`src/core/brain/maintenance/lane.ts` is already a "gate background work on measured
pressure" lane. Its header (`:1-19`) names three gates:

1. **window** — a configured local-time hour window, tz-aware, midnight-wrap aware
   (`dailyWindowContains`, `:82-97`); unconfigured = always open.
2. **busy** — `evaluateGates` at `:99-113` counts recall-telemetry records in a lookback
   window: `MAINTENANCE_BUSY_MINUTES = 10`, `MAINTENANCE_BUSY_THRESHOLD = 5` (`:29-31`).
   Over threshold → `"skipped:busy"`. **This is a measured-pressure gate — the metric is
   interactive query rate, not host CPU.**
3. **lease** — `acquireLease` (`src/core/brain/maintenance/lease.ts:59-83`), never
   bypassable even with `--force`, "because two concurrent heavy passes on one vault is
   the exact failure this lane exists to prevent" (`lane.ts:11-13`).

Tasks then run **sequentially by design** — `lane.ts:149` ("the lane exists to serialize
heavy work") — stale-first, each attempt journaled with a typed verdict.

So t_992f0c33's design is not a new subsystem. It is **a fourth gate in `evaluateGates`**
plus a fourth `MaintenanceVerdict`. Everything else — the lease, the journal, the
force-bypass semantics, the sequential runner — already exists.

### Portability, stated honestly

- `os.loadavg()` on Linux and macOS returns real 1/5/15-minute run-queue averages.
- **On Windows, Node and Bun return `[0, 0, 0]`** — a constant, not a measurement. A
  gate keyed on it would read "always idle" and never fire.
- Inside a container, `os.loadavg()` reports the **host's** run queue, not the cgroup's.
  `os.cpus().length` likewise reports host CPUs, not the CPU quota. A load-average gate
  on a shared host or a CPU-limited container is measuring something other than the
  pressure the operator cares about. (This is a platform fact, not a claim about this
  repo — nothing in `src/` reads either value today.)

**On Windows specifically, this repo already refuses rather than guesses.**
`src/core/config.ts:35` declares `UNSUPPORTED_CONFIG_PLATFORMS = ["win32"]`, and the
error class at `:45-59` explains why in exactly the terms the operator's rule uses:

> the alternative - returning `C:\Users\…\.config\open-second-brain\config.yaml` - is a
> plausible-looking answer to a question this build cannot answer

That is the precedent a pressure gate must follow. `os.loadavg()` returning `[0,0,0]` on
Windows is the same class of plausible-looking wrong answer. The honest alternatives, in
order of preference:

1. **Name the metric as unavailable and leave the gate open**, reporting a verdict that
   says *why* — e.g. a `MaintenanceVerdict` value meaning "pressure unmeasurable on this
   platform", journaled like every other verdict (`lane.ts:129`). The operator sees that
   the gate did not evaluate. This is not a silent no-op.
2. **Refuse to enable the gate** when the metric is degenerate, the way
   `UnsupportedPlatformError` refuses, pointing at the config key to unset.
3. Do **not** substitute `cpus().length` or a synthetic proxy and present it as load.

Option 1 is the one that composes with the existing lane, because the lane already has a
verdict vocabulary and a journal to carry the reason. Note `src/core/brain/gates/durability.ts:156`
and `tests/core/architecture/verdict-vocabulary-census.test.ts` — verdict tokens are a
maintained namespace here, so a new one has a home and a ratchet.

Practically, on the platforms this build actually supports (POSIX only, per
`config.ts:35`), `os.loadavg()[0] / os.availableParallelism()` is a measurable,
dependency-free normalised pressure ratio. That is the only such metric available
without a native dependency.

---

## 6. Startup, crash-loop, thundering herd

### 6.1 There is no daemon **(shape-changing)**

It is a stated architectural invariant, not an accident:

- `docs/architecture.md:229` — "Filesystem-first. No database, no daemon."
- `src/core/brain/anticipatory-cache.ts:14` — "Hard constraints honored here: NO daemon
  and NO file watcher (refresh piggybacks on events that already fire)"
- `src/mcp/artifact-store.ts:24` — "no daemon, matching the 'no hidden process' convention"
- `src/cli/partner-codegraph-cron.ts:6` — "it refuses daemons and filesystem watchers for
  this purpose"
- `docs/plans/2026-05-18-brain-maturity-design.md:690-691` — a *rejected* design item:
  "`o2b search reindex --watch` long-running daemon. The OSB invariant 'no daemon' stands."

Entry points: `scripts/o2b` → `src/cli/main.ts:1004-1013` (one-shot, `process.exit(code)`);
`scripts/vault-log`, `scripts/o2b-hook`, `bin/o2b-discipline-report`, `hooks/*.ts` — all
one-shot. `cli.py:16` is a re-export shim, not a process. `src/openclaw/index.ts:36-37`
is an in-process plugin owning no loop, timer, or subprocess.

Three operator-launched foreground processes, each living and dying with the terminal or
client that started it: the MCP server (`src/mcp/stdio.ts:37-70` stdio by default per
`src/cli/main.ts:583`; HTTP opt-in at `src/mcp/http.ts:53-57`), the explorer HTTP server
(`src/core/brain/explorer.ts:320-340`, loopback-only, default port 7777), and
`o2b search watch`. Plus the Telegram long-poll bot, whose own verb doc says
"Never invoked from a hook; nothing runs implicitly"
(`src/cli/brain/verbs/telegram-capture.ts:8-9`).

The MCP server holds process-scoped state (`src/mcp/server.ts:97-113`: tool table,
route-metrics flag, an `ArtifactStore` keyed `run-${process.pid}-${Date.now()}`), but
holds **no open SQLite handle** — every writer is opened and closed per call
(`src/core/search/store-exit.ts:20-23`).

**"Startup grace period" and "crash-loop recovery" have no daemon to attach to.** The
portable analogue is per-invocation: a gate evaluated at the top of a one-shot command,
with the *cross-invocation* state kept on disk (the lease and the journal already are
exactly that).

### 6.2 No scheduler is shipped

No cron file, no `.service`, no `.timer`, no plist anywhere in `install/`, `templates/`,
`scripts/`, or `.claude-plugin/`. `templates/install/` contains one file
(`aider-context.md.tmpl`).

The dream pass has exactly three trigger paths, all caller-initiated:
MCP tool `brain_dream` (`src/mcp/brain/feedback-tools.ts:296`, registered `:760`, whose
own description at `:762` says "Typically scheduled via cron"); CLI
`o2b brain dream` (`src/cli/brain.ts:193-194` → `src/cli/brain/verbs/dream.ts`);
and `o2b brain maintenance run` (`src/cli/brain/verbs/maintenance.ts:1-14`, "Designed as
the cron entry point", calling `dream()` at `:135`). **No hook invokes it** — grep across
`hooks/`, `.githooks/`, `install/`, `templates/` finds only prose and one starter-vault
fixture.

What the repo ships instead is cron **recipes** — text on stdout that installs nothing.
`src/cli/cron-recipe.ts:6-10`: "A recipe is text on stdout and nothing else. … No verb
that renders a recipe writes a file, spawns a scheduler, or installs anything". The two
consumers are `search reindex --cron-template` and `partner codegraph resync
--cron-template`; neither is dream. The one verb that writes a real schedule,
`o2b discipline install` (`src/cli/discipline-install.ts:17,101,141-163`), mutates an
**external Hermes** job file and does not schedule dream. `README.md:53` states the
ownership boundary: "Hermes Agent owns the schedule (dream cron, daily digests…)".

### 6.3 The thundering herd is real, and it is not the dream pass **(shape-changing)**

`ensureVaultCurrent(vault, { background: true })` is called at **two** startup points:

- `src/cli/main.ts:648` — every full-scope MCP server start;
- `hooks/active-inject.ts:161` — the `SessionStart` hook.

  **Correction (implementation, U5).** This note originally said "the
  `SessionStart` **and** `PostCompact` hook". That is wrong: the call is
  guarded by `if (hookEventName === "SessionStart")` at
  `hooks/active-inject.ts:158`, so a PostCompact event spawns nothing. The
  module IS registered for both events, which is where the error came
  from - reading the registration rather than the branch. The herd is
  therefore one spawn per session start plus one per MCP server start,
  not two per session. It is still a herd, and the losers still died into
  a discarded stderr, so the unit's subject is unchanged; the multiplier
  is smaller than this note claimed.

In background mode it calls `spawnDetachedReindex`
(`src/core/maintenance/ensure-current.ts:87-99`): `Bun.spawn(["…/o2b", "search",
"reindex", …])` with `stdin/stdout/stderr: "ignore"`, then `proc.unref()`.

The source already acknowledges the collision — `src/core/search/indexer.ts:930-937`:

> a second concurrent reindex — the double-reindex a schema-bump upgrade triggers when
> CLI and the long-lived MCP server both self-heal at once — waits-or-bails on the SAME
> lock

The mitigation is `acquireWriterLock(config.dbPath)` (`indexer.ts:937`), whose async
policy is **3 retries × 1000 ms** (`src/core/search/store/writer-lock.ts:64-77`), then
`SearchError("INDEX_LOCKED")`. In a detached process with `stderr: "ignore"`, that throw
goes **nowhere the operator can see**. So today: N agent sessions starting after an
upgrade produce N detached reindexes; one runs, N−1 spin ~3 s and die silently. That is
the concrete thundering herd this task should address, and its subject is
`ensure-current.ts`, not `dream.ts`.

### 6.4 There is no crash-loop detection, and no supervisor

No PID file, no singleton-instance guard by PID, no restart logic, no repeated-failure
counter that survives a process. Two mechanisms come closest:

- **Crash recovery by lease expiry.** `src/core/brain/maintenance/lease.ts:1-8`: "a
  crashed worker's lease frees itself by expiry, never by manual cleanup". TTL
  `MAINTENANCE_LEASE_TTL_MS = 30 min` (`lane.ts:26`). `acquireLease` fails closed on a
  non-positive TTL (`lease.ts:60-64`) — "a non-positive TTL would mint an already-expired
  lease and every contender would acquire at once - silent loss of mutual exclusion."
  PIDs are written into `sync-lockfile` bodies but are **diagnostic only**
  (`src/core/brain/sync-lockfile.ts:88-91`).
- **The only exponential backoff at process level** is the Telegram transport ladder:
  `transportBackoffMs` (`src/core/brain/capture/telegram-capture.ts:81-84`, base doubling,
  capped at `TRANSPORT_BACKOFF_MAX_MS = 30_000` at `:70`), applied at `:371`, with the
  rationale at `:362-366` — "so a persistent outage … settles into a gentle retry cadence
  instead of a hot loop that hammers the API and pins the CPU, which matters because
  production runs with no maxCycles". `consecutiveFailures` is a local variable
  (`:336`); it resets to zero on every process start, so it is **not** crash-loop
  recovery.

### 6.5 A watchdog that probably cannot fire

`hooks/lib/process-ceiling.ts` is the repo's existing "nothing runs unwatched" primitive:
a spawned hook arms an `unref`ed timer on **itself** and `exit(0)`s at the deadline
(`:60-80`), disarmed in a `finally`. Default `DEFAULT_HOOK_CEILING_MS = 55_000` (`:23`),
floor 1000 ms, and a bad `OPEN_SECOND_BRAIN_HOOK_CEILING_MS` falls back to the default
"so a typo can never disable the watchdog" (`:28-40`). Seven hooks arm it
(`active-inject`, `session-capture`, `recall-inject`, `nav-inject`, `pretool-orient`,
`gap-agenda`, `gap-promote`).

But **all 15 hook entries in `hooks/hooks.json` set `"timeout": 10`** (verified: 15
occurrences, all value 10). If the host enforces that 10-second timeout by killing the
hook process, the 55-second self-ceiling can never fire under the shipped configuration.
The module doc at `:19-20` calls the host timeout "a second line of defence"; under
`hooks.json` as shipped it is the *first* and only one. This is worth resolving as part
of a "nothing runs unwatched" release, since it is the one watchdog the repo already has.

The module also states the limit any deadline design inherits (`:17-19`): "a JavaScript
timer cannot interrupt a fully-synchronous CPU hang on a single thread". Given §2.1 —
`dream()` is fully synchronous — that limit applies to the dream pass directly.

---

## Divergences

Points where the task framing does not survive contact with the source.

| # | Task claim | Source |
|---|---|---|
| 1 | t_fe4b6be0: cap "concurrent LLM inference calls" | The process makes **no** chat-model call. `src/core/doctor-readiness.ts:40-44`; the `needs-llm-step` envelope contract at `src/core/brain/rollup-ladder.ts:63-72`, `src/core/brain/diarization.ts:83`, `src/core/brain/write-session/engine.ts:98`. Inference happens in the caller's process, after `dream()` returns |
| 2 | "shared across extraction/synthesis/dream **workers**" | There are no workers. `dream()` is a **synchronous function** — `src/core/brain/dream.ts:101`. `src/core/brain/maintenance/lane.ts:149`: "Sequential by design: the lane exists to serialize heavy work" |
| 3 | `src/core/brain/dream-phases.ts:19-34` is "the multi-phase LLM pipeline" | It is a **label enum and a reporting order**. Nothing executes. `src/core/brain/dream-step.ts:7-11` is explicit: "The five `DREAM_PHASE` labels are a REPORTING layer … there is no function named `close`, `reconcile`, `synthesize`, `heal` or `log` to call" |
| 4 | Existing concurrency controls are "FILE-LEVEL locks serializing writes" (`inline-rewrite.ts:17,51`, `log.ts:310`, `metrics.ts:13`) | Two of the three are right; the third is inverted. `src/core/brain/metrics.ts:11-14` documents the deliberate **absence** of a lock (bare `appendFileSync` at `:101`, relying on `O_APPEND` atomicity). And `inline-rewrite.ts` locks the **parent directory**, not the file (`:17-19`) |
| 5 | `src/core/brain/idempotency-ledger.ts:23-167` is dream run state | It is a **client-supplied idempotency-key store for the signal write path** (`:1-33`). `dream()` never touches it. The dream pass's own journal is `src/core/brain/dream-workrun.ts`, explicitly **non-resuming** (`:9-13`) |
| 6 | t_992f0c33: "startup crash-loop recovery" and "startup grace period" | **No daemon exists.** `docs/architecture.md:229`; `src/cli/main.ts:1004-1013`. Every entry point is one-shot or client-scoped. There is no PID guard, no supervisor, and no cross-process failure counter |
| 7 | The thundering herd is about the dream pass | It is about **reindex**: `src/core/maintenance/ensure-current.ts:87-99` spawns a detached `o2b search reindex` from *both* MCP startup (`src/cli/main.ts:648`) and the `SessionStart` hook (`hooks/active-inject.ts:161`; see the correction in §6.3 - PostCompact is registered but branches away). The collision is already named in-source at `src/core/search/indexer.ts:930-937`. Dream is never triggered automatically at all |
| 8 | "a write-batch primitive that yields when pressure is high" | `brain_write_batch` already exists and is **all-or-nothing atomic** — `src/core/brain/write-batch.ts:206`, `src/mcp/brain/write-batch-tools.ts:1-16`. A batch that yields mid-way would break the contract the tool is named for. Its bound is a hardcoded `MAX_BATCH_OPERATIONS = 100` (`:56`), justified precisely as a blocking-window cap (`:51-54`) |
| 9 | (implied) a pressure gate is new ground | `evaluateGates` (`src/core/brain/maintenance/lane.ts:99-113`) is already a measured-pressure gate — the metric is interactive query rate, not host load. The lease, the journal, the verdict vocabulary and the `--force` semantics all exist |

---

## What a design must not assume

1. **Do not assume an inference call to cap.** If t_fe4b6be0 survives at all, its subject
   is outbound HTTP to the embedding and rerank providers — five `fetch` sites (§1) — not
   model inference. Naming it "inference" in code or config would be a hardcoded
   falsehood about what the process does.

2. **Do not assume anything is concurrent inside a dream pass.** `dream()` is
   synchronous end to end (`src/core/brain/dream.ts:101`). A ceiling has nothing to
   count there. Making it async to enable yielding is a signature change across five
   call sites and would forfeit the byte-reproducibility the module is built on
   (`dream.ts:253-255`).

3. **Do not assume a process to keep state in.** No daemon, no scheduler, no supervisor.
   Any counter that must survive — a failure streak, a herd token, a grace deadline —
   has to live on disk. The existing on-disk precedents are the SQLite lease
   (`src/core/brain/maintenance/lease.ts`) and the lane journal
   (`src/core/brain/maintenance/journal.ts`); a new in-memory counter would reset on
   every invocation, exactly as `consecutiveFailures` does at
   `src/core/brain/capture/telegram-capture.ts:336`.

4. **Do not assume `os.loadavg()` means what it says.** It is `[0,0,0]` on Windows and
   reports the *host* run queue inside a container. This repo's established answer to an
   unanswerable platform question is to refuse by name
   (`src/core/config.ts:35,45-59`), not to return a plausible number. A gate that
   evaluates to "idle" on a platform where the metric is degenerate is precisely the
   silent-no-op fallback the standing rules forbid — it would be indistinguishable from a
   genuinely quiet host.

5. **Do not assume a new subsystem is needed for pressure gating.** Add a fourth gate to
   `evaluateGates` and a fourth verdict token. The verdict namespace is already
   ratchet-tested (`tests/core/architecture/verdict-vocabulary-census.test.ts`), the
   journal already records every verdict (`lane.ts:129,136`), and `--force` already has
   defined semantics (soft gates bypassable, lease never — `lane.ts:15-17,126-138`).

6. **Do not assume a new config key is free.** A `_brain.yaml` key must go through a
   block parser under `src/core/brain/policy/blocks/`, register via `warnUnknownKeys`,
   be templated in `BRAIN_CONFIG_TEMPLATE` **commented, not live** (the frozen-surface
   assertion at `tests/core/brain/config-template-ratchet.test.ts:245-247`), and satisfy
   four ratchet assertions (`:191-233`). A plugin-config key has no ratchet at all —
   which means forgetting to document it fails nothing, so document it deliberately.

7. **Do not assume a bad value may fail soft.** Both disciplines exist
   (`src/core/validate.ts:17-40` throws; `src/core/brain/safeguard.ts:150-156` falls
   through silently). For a ceiling or a gate, silent fallback means the operator
   believes a bound is in force that is not. Follow `field-checks.ts:5-8`.

8. **Do not assume cancellation needs building.** `src/core/brain/safeguard.ts` already
   has `signal`, `SafeguardAbortError`, and abort-beats-deadline priority (`:91,117-122`);
   `IndexWatchRunner` (`src/core/search/watch-runner.ts:44-103`) already has
   single-flight + abort + bounded grace. The gap is **wiring**: no call site passes a
   signal, and `throwIfAborted` has only two callers, both in the indexer. Wiring the
   existing seam is a much smaller change than the task implies — and it is a real one,
   because `SafeguardAbortError` is currently dead code in production.

9. **Do not assume an interrupted pass can be resumed.** The workrun journal is forensic
   by explicit contract (`src/core/brain/dream-workrun.ts:9-13`), and
   `withDestructiveSnapshot` does not auto-rollback
   (`src/core/brain/snapshot-gate.ts:371-373`). A "coordinated teardown" therefore means
   *stopping cleanly at a checkpoint with the journal telling the truth about what
   landed* — which the current markers already do (`dream.ts:225-234`) — and not
   *resuming later*.

10. **Do not add a watchdog without checking it can fire.** `hooks/hooks.json` sets
    `"timeout": 10` on all 15 entries while `hooks/lib/process-ceiling.ts:23` defaults to
    55 s. Before adding a second watchdog, reconcile the one that exists.
