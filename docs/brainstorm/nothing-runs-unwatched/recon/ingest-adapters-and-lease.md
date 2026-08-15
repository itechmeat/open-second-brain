# Recon — ingest source adapters and the writer lease (t_da034197)

Reconnaissance only. Branch `feat/nothing-runs-unwatched`, base v1.47.0
(`aa818084 feat: wiring what exists (v1.47.0) (#164)`). Every claim below carries
a `path:LINE` anchor that was read in this pass. Where something could not be
established, it says so.

---

## 1. Every ingest / import path that exists

### 1.1 Session transcript import

- Entry: `src/core/brain/sessions/import.ts:206` `importSession(vault, path, opts)`
  (single `.jsonl` file) and `src/core/brain/sessions/import.ts:582`
  `importSessionPath` (directory walk, `.jsonl` only, `src/core/brain/sessions/import.ts:619`).
- Input shape: one JSONL transcript file per runtime schema, normalised to
  `SessionTurn` (`src/core/brain/sessions/types.ts:119`) by an adapter.
- Reachability: **CLI only**. The single caller is
  `src/cli/brain/verbs/import-session.ts:91` / `:108`. A grep for
  `import_session` / `import-session` over `src/mcp/` returns nothing — there is
  no MCP tool for session import.
- Writes: signals via `writeSignal` (`src/core/brain/sessions/import.ts:276`),
  skill-invocation continuity records (`:431`), extracted facts (`:373`), the
  recall DAG (`:488`), one dedup-telemetry record per file (`:513`), and one
  `appendLogEvent` per file from the CLI (`src/cli/brain/verbs/import-session.ts:130`).

### 1.2 Source-artifact ingest

- Entry: `src/core/brain/ingest/ingest.ts:111` `ingestSource(vault, input, opts)`.
- Input shape: `IngestSourceInput` (`src/core/brain/ingest/ingest.ts:51`) — a
  source identity (vault-relative path **or** URL), agent-written summary prose,
  and an already-extracted entity/relation set. The kernel runs no model
  (`src/core/brain/ingest/ingest.ts:10-15`).
- Reachability: **MCP** (`brain_ingest_source`, `src/mcp/brain/ingest-tools.ts:32`,
  handler `:41`, call `:60`), **in-process SDK**
  (`src/core/brain/sdk.ts:118`), and **the inbox drain**
  (`src/core/brain/capture/inbox-drain.ts:158`, routing a URL-shaped capture).
  No dedicated CLI ingest verb calls it.

### 1.3 Batch planner for large-folder ingest

- Entry: `src/core/brain/ingest/batch-plan.ts` `planBatches`; MCP tool
  `brain_ingest_batch_plan` (`src/mcp/brain/ingest-tools.ts:35`).
- Read-only by design: "the kernel runs NO ingestion and spawns NO subagents
  itself" (`src/core/brain/ingest/batch-plan.ts:9-11`). It consults the content
  manifest and the checkpoint and returns batches; **the caller dispatches each
  batch as a parallel subagent** (same lines). This is load-bearing for §4.

### 1.4 Git history ingest, and `mine`

- Entry: `src/core/brain/git/ingest.ts:109` `ingestGitHistory(vault, repoPath, opts)`.
- Input shape: a worktree path plus `maxCount` (`src/core/brain/git/ingest.ts:58`).
  Read-only against the repo; all writes land in the vault (`:20-22`).
- Entry: `src/core/brain/git/decisions.ts:111` `mineCommitDecisions(vault, repoKey)` —
  the `mine` half. Input is the already-ingested commit store, output is ADR
  candidate notes.
- Reachability: **CLI only** — `src/cli/brain/verbs/git.ts:34` (`ingest`) and
  `:37` (`mine`); calls at `:110` and `:56`. No MCP surface.

### 1.5 Claude-memory / agent-memory manifest import

- Entry: `src/core/brain/import-claude-memory.ts` `importClaudeMemory({vault, memoryDir, mode, backend})`.
- Input shape: a directory of runtime memory files, parsed by a **backend**
  (§2.3). CLI resolves the backend and the directory at
  `src/cli/brain/verbs/import-claude-memory.ts:102-104`.
- Reachability: **CLI only** (`src/cli/brain/verbs/import-claude-memory.ts:9`).

### 1.6 Truth / claim ingest

- Entry: `src/core/brain/truth/ingest.ts:51` `claimsFromAssertion`.
- Input shape: one atomic assertion plus an explicit entity; only assertions
  matching a structured fact family ingest (`src/core/brain/truth/ingest.ts:4-6`,
  structurers at `:40-43`).
- Reachability: `o2b brain facts decompose --ingest` and an MCP ingest op
  (`src/core/brain/truth/ingest.ts:6-7`); help text at
  `src/cli/brain/help-text.ts:433-436`.

### 1.7 Other import-shaped verbs (named, not fully traced)

`src/cli/brain/verbs/`: `inbox-drain.ts` (dry-run default + `--apply`,
docblock `:5`), `bank-import.ts`, `graph-import.ts`, `okf-import.ts`,
`telegram-capture.ts`, `apply-markers.ts` (`:5-6`), `scan-inline.ts`.
These write into the vault from outside material but were not traced to their
lock/dry-run details in this pass.

### 1.8 The thing that is *not* an ingest path

`src/core/brain/ingest/sources-registry.ts` — confirmed as the triage said. It is
list/get/delete over the `Brain/sources` summary pages the pipeline already wrote
(`:82`, `:113`, `:132`), with a containment check that refuses ids outside
`Brain/sources` (`:69-79`). No adapter, no dispatch, no registration.

---

## 2. How adapters are selected today

### 2.1 Session adapters — a frozen array with sniffing plus an explicit override

- Dispatch structure: a **frozen array**, not a map or a switch —
  `src/core/brain/sessions/registry.ts:19-25`, five members
  (claude, codex, hermes, opencode, grok).
- Selection is **both**: explicit caller argument wins, else sniff. `chooseAdapter`
  at `src/core/brain/sessions/import.ts:191-204`: `opts.format` → `getAdapter`;
  otherwise read the first line only (`firstLineOfFile`,
  `src/core/brain/sessions/import.ts:165-172`) and probe adapters in registry
  order (`detectAdapter`, `src/core/brain/sessions/registry.ts:42-47`, first match
  wins).
- No match → **explicit failure**, not an empty result:
  `SessionImportError("DETECT_FAIL", …; pass --format to override)` at
  `src/core/brain/sessions/import.ts:198-201`. An unknown `--format` is rejected
  before any work at `src/cli/brain/verbs/import-session.ts:74-76`, and
  `getAdapter` throws on an unregistered id
  (`src/core/brain/sessions/registry.ts:56`).
- Directory walk downgrades `DETECT_FAIL` to a per-file **warning** and continues
  (`src/core/brain/sessions/import.ts:636-643`). That is reported, not silent.
- Cross-table locked by `tests/core/brain.sessions.registry.test.ts:66-80`.
- One near-silent arm, reported rather than hidden: a session the capture boundary
  classifies `ignore` returns an all-zero result
  (`src/core/brain/sessions/import.ts:324-343`), but the reason travels on
  `boundary_decision` (`:335`).

### 2.2 Discipline transcript runtimes — an array with **no** selection and a silent-empty failure

- `src/core/discipline/transcripts/index.ts:20-24` `DEFAULT_TRANSCRIPT_RUNTIMES`
  is a second hardcoded array (claudecode, codex, cursor). There is no `detect`
  in the contract (`src/core/discipline/transcripts/types.ts:59-74`) — the
  aggregator runs **every** runtime unconditionally
  (`src/core/discipline/transcripts/index.ts:37-47`).
- **Defect worth naming.** `claudeCodeTranscript.collect` returns `[]` for three
  different conditions: the base dir does not exist
  (`src/core/discipline/transcripts/claude-code.ts:21`), `readdir` failed —
  permissions, I/O (`:27`), and a project dir that cannot be read (`:34`), plus a
  per-file `stat` failure swallowed at `:44`. All surface identically as
  `fileCount: 0` (`src/core/discipline/transcripts/index.ts:41`), which is the
  same value as "the agent genuinely did nothing today". The signal feeds an alert
  decision (`src/core/discipline/transcripts/index.ts:5-9`), so an unreadable home
  reads as a clean "no activity confirmed".

### 2.3 Memory backends — a real registry, by id, from config

- `src/core/brain/agent-backend/registry.ts:18-22` — a frozen `ReadonlyMap`
  keyed by backend id (claude, mem0, generic).
- Selection is by **explicit id or config key**, never by sniffing:
  `getMemoryBackend(id)` (`:30`) throws with the registered list on an unknown id
  (`:32-37`); `resolveMemoryBackend` reads the `memory_backend` device-config key
  with `claude` as default (`:45-48`). CLI `--from` / `--backend` overrides
  (`src/cli/brain/verbs/import-claude-memory.ts:43-48`, resolution at `:102-103`).
- The protocol (`src/core/brain/agent-backend/types.ts:45-70`) states the exact
  property (a) asks for: "Adding a runtime means adding ONE module that satisfies
  this interface and registering it — no changes to the import core, CLI, or MCP
  surfaces" (`:9-11`).

### 2.4 Other registries in the tree

`src/core/brain/agent-source/registry.ts:10` (frozen provider array, all providers
always collected, `:14-23`), `src/core/install/registry.ts`,
`src/core/search/embeddings/registry.ts`, `src/core/search/rerank/registry.ts`,
`src/core/brain/entities/registry.ts`, `src/core/egress/registry.ts`.

---

## 3. The closed-vocabulary house idiom

### 3.1 Confirmed against two real examples

`src/core/brain/triggers/types.ts`:

- frozen object, camelCase key → snake/kebab value: `:20-28` (`TRIGGER_STATUS`);
- derived union type: `:30` `type TriggerStatus = (typeof TRIGGER_STATUS)[keyof typeof TRIGGER_STATUS]`;
- members array: `:37-45` `TRIGGER_STATUSES: ReadonlyArray<TriggerStatus>`, frozen,
  built from the object's own keys;
- guard whose parameter is `unknown`: `:47-49`
  `isTriggerStatus(value: unknown): value is TriggerStatus`.

`src/core/search/provider-probe.ts`: `PROVIDER_PROBE` `:58`, `ProviderProbeState`
`:66`, `PROVIDER_PROBE_STATES` `:69-75`, `isProviderProbeState(value: unknown)`
`:82`.

### 3.2 What the census enforces

`tests/core/architecture/verdict-vocabulary-census.test.ts`:

- the registered shape is `{name, values, members, guard}`
  (`:186-195`, guard typed `(value: unknown) => boolean` at `:194`);
- the audit (`:213-247`) asserts: `values` is frozen; no duplicate value; no
  duplicate member; every declared value is a member and is accepted by the guard;
  every member is declared by some value; and the guard rejects every entry of
  `NON_MEMBERS` (`:202-210` — `""`, `" "`, a near-miss string, `null`,
  `undefined`, `42`, `{}`);
- registration is one entry appended to `CENSUS` (`:250-617`), and the suite fails
  if the registry is emptied rather than fixed (`:621-626`).

### 3.3 What a new adapter-kind vocabulary must look like

Concretely, in the module that owns the vocabulary (not in the registry file):

```ts
export const INGEST_ADAPTER_KIND = Object.freeze({
  sessionTranscript: "session-transcript",
  sourceArtifact: "source-artifact",
  gitHistory: "git-history",
  agentMemory: "agent-memory",
} as const);
export type IngestAdapterKind =
  (typeof INGEST_ADAPTER_KIND)[keyof typeof INGEST_ADAPTER_KIND];
export const INGEST_ADAPTER_KINDS: ReadonlyArray<IngestAdapterKind> =
  Object.freeze([ /* every member, spelled from INGEST_ADAPTER_KIND.* */ ]);
export function isIngestAdapterKind(value: unknown): value is IngestAdapterKind {
  return typeof value === "string" &&
    (INGEST_ADAPTER_KINDS as ReadonlyArray<string>).includes(value);
}
```

Registered by adding one `{name, values, members, guard}` entry to `CENSUS` at
`tests/core/architecture/verdict-vocabulary-census.test.ts:250-617`.

A companion vocabulary for the *failure* arm is what §2.2 is missing: "base
absent" vs "base unreadable" vs "no activity" cannot be one value.

**Existing violation, in scope.** `isSessionAdapterId` takes `string`, not
`unknown` (`src/core/brain/sessions/registry.ts:27`), and `SessionAdapterId` is a
hand-written string union (`src/core/brain/sessions/types.ts:108`) with no frozen
object and no members array. `SESSION_ADAPTERS` is not in the census. So the
existing adapter identity does *not* follow the house idiom, and a new adapter
vocabulary cannot be derived from it without rewriting it first.

---

## 4. The writer lease

### 4.1 The primitives

Three, not one.

| primitive | file | mechanism | stale policy | retry | re-entrant |
|---|---|---|---|---|---|
| `withFileLock` (async) | `src/core/reliability/lock.ts:22` | `proper-lockfile` | 30 s default (`:32`) | 3 × 250 ms (`:34-39`) | no |
| `acquireLockSync` | `src/core/brain/sync-lockfile.ts:65` | `openSync(target + ".lock", "wx")` (`:72`) | **none** | **none** (`:13-15`) | no (`:75-80` → `ELOCKED`) |
| `acquireWriterLockSync` / `acquireWriterLock` | `src/core/search/store/writer-lock.ts:37` / `:64` | `proper-lockfile` on the live index path | 60 s (`:18`), 30 s heartbeat on the async form (`:29`, `:71`) | 10 × 50 ms sync / 3 × 1 s async | no |

`withFileLock` has exactly two callers: `src/core/brain/schema-mutate.ts:197` and
`src/core/brain/health-baseline.ts:58`. It is **not** on any ingest path.

### 4.2 Granularity, hold time, crash behaviour

- Granularity is **per target file**, never per vault: the preference file
  (`src/core/brain/preference-txn.ts:182`), the continuity month shard
  (`src/core/brain/continuity/store.ts:291`), the idempotency month shard
  (`src/core/brain/idempotency-ledger.ts:157`), the log **directory**
  (`src/core/brain/log.ts:243`), the search index path
  (`src/core/search/store/writer-lock.ts:43`).
- Hold time is the duration of one write. The one existing exception, and the
  precedent a whole-run lease should follow, is the skill-accept lock: taken once
  and held across the entire multi-step sequence
  (`src/core/brain/skill-proposals.ts:633`, `:741`, `:765`), with a named typed
  refusal on contention (`SkillAcceptLockedError`, `:819-828`) and a journal so an
  interrupted sequence is rolled forward or back (`:836-861`).
- Stale policy for the brain sync lock: **there is none**. Normal process exit
  unlinks held locks via an exit hook (`src/core/brain/sync-lockfile.ts:40-53`);
  a hard crash (SIGKILL/OOM) leaves the `.lock` on disk forever and the next
  acquire fails `ELOCKED` (`:17-21`). Recovery is manual: the doctor lists every
  `.lock` under `Brain/` as an *uncertainty*, explicitly refusing to break it
  because "a live writer cannot be told from a dead one"
  (`src/core/brain/doctor/uncertainty-probes.ts:133-148`,
  `src/core/brain/sync-lockfile.ts:123`).
- Contention is mapped to typed refusals, never retried into silence:
  `BrainCollisionError(sourceLock)` (`src/core/brain/preference-txn.ts:185-190`),
  `SearchError("INDEX_LOCKED")` (`src/core/search/store/writer-lock.ts:34`).

### 4.3 The concrete cost of the current discipline in an ingest

**`ingestSource` × N sources — zero locks, `2N` unlocked read-modify-writes.**

Reading the body of `src/core/brain/ingest/ingest.ts:111-216`: the summary page is
written with `writeFrontmatterAtomic` (`:186`) after a byte-compare no-op check
(`:182-187`) — no lock. Then, per source:

- `updateManifest(vault, [canonicalSource])` (`:194`) →
  `src/core/brain/ingest/content-manifest.ts:227-239`: read the whole manifest,
  merge one entry, `atomicWriteFileSync` (`:180`). **One vault-global file, no
  lock.**
- `recordCompleted(...)` (`:201`) →
  `src/core/brain/ingest/checkpoint.ts:170-194`: read the plan checkpoint, union
  one path, `atomicWriteFileSync` (`:192`). **One per-plan file, no lock.** The
  call is wrapped in a bare `try {} catch {}` (`:200-204`) — a checkpoint write
  failure is swallowed by design.

So an ingest of N sources performs **0 acquire/release cycles** and **2N unlocked
read-modify-write cycles on two shared files**. Under the parallel-subagent
dispatch the batch planner prescribes (`src/core/brain/ingest/batch-plan.ts:9-11`),
those 2N cycles race last-writer-wins across processes.

**`importSession` — locks per side effect, not per signal.**

- `writeSignal` takes **no lock**: name allocation and creation are one exclusive
  create with a candidate ladder (`src/core/brain/paths.ts:879-901`,
  `src/core/brain/sessions/import.ts:276`). Session import supplies no
  `idempotency_key`, so the ledger's shard lock is never taken either.
- One acquire/release per **skill invocation** record
  (`src/core/brain/sessions/import.ts:431` → `src/core/brain/continuity/store.ts:291`).
- One acquire/release per **new recall turn**, plus per summary node
  (`src/core/brain/session-recall.ts:351` → same `appendRecord`); the batch helper
  that would collapse these into one lock per shard
  (`src/core/brain/continuity/store.ts:168-176`) is not on this path.
- One per file for the dedup-telemetry record, only when something deduped
  (`src/core/brain/sessions/import.ts:511-517`).
- One **log-directory** lock per file, with a 10 × 50 ms retry loop
  (`src/cli/brain/verbs/import-session.ts:130` → `src/core/brain/log.ts:238-252`).

Total for a directory of F files with K skill calls and R new recall turns:
roughly `K + R + (R / groupSize summaries) + F + F` acquire/release cycles, and
**zero** for the signals themselves.

**`ingestGitHistory` — one run, no locks.** `appendGitRecords`
(`src/core/brain/git/store.ts:178-215`) reads every existing record (`:185`),
dedups in memory (`:191-210`) and appends once (`:213`) with no lock at all; the
watermark (`src/core/brain/git/ingest.ts:194`) and the digest (`:200`) are further
unlocked writes. `mineCommitDecisions` writes one note per candidate with
`atomicWriteFileSync` and no lock (`src/core/brain/git/decisions.ts:134-135`).

---

## 5. Dry-run inertness, per tier

Tier names as given in the brief; the ladder is not written down in one place in
the repo, so each placement below is anchored to the gate it actually implements.

| path | tier | anchor |
|---|---|---|
| `ingestSource` / `brain_ingest_source` | **0 — no gate** | `IngestSourceOptions` has no dry-run field (`src/core/brain/ingest/ingest.ts:60-79`); the MCP handler writes on the first call (`src/mcp/brain/ingest-tools.ts:60`); grep for `dry_run` in that file returns nothing |
| `ingestGitHistory`, `mineCommitDecisions` | **0 — no gate** | options are `maxCount` / `now` only (`src/core/brain/git/ingest.ts:58-62`); `mineCommitDecisions` takes no options (`src/core/brain/git/decisions.ts:111`) |
| `importSession` | **1 — `dryRun` option, off by default** | `ImportSessionOptions.dryRun` (`src/core/brain/sessions/import.ts:63`), CLI `--dry-run` (`src/cli/brain/verbs/import-session.ts:29`) |
| `import-claude-memory` | **2 + 3 + 4** | dry-run is the default and `--apply` opts in (`src/cli/brain/verbs/import-claude-memory.ts:13`, `:60`); `--apply` additionally requires `--yes` when stdin is not a TTY (`:87-92`); `--allow-arbitrary-memory-path` is the override flag (`:79-82`) |
| `inbox-drain`, `apply-markers` | **2 — dry-run default + `--apply`** | `src/cli/brain/verbs/inbox-drain.ts:5-6`; `src/cli/brain/verbs/apply-markers.ts:5-6` |
| link-graph repair | **5 — exact phrase** | `REPAIR_CONFIRM_PHRASE = "apply repair"` (`src/core/brain/link-graph/repair-lane.ts:67`), enforced at `:210` and again at `src/cli/brain/verbs/repair-lane.ts:187` |
| note delete | **5 — exact phrase** | `src/cli/brain/verbs/note-lifecycle.ts:15`; `src/cli/brain/help-text.ts:228` |

**Does any dry-run path touch disk?** For `importSession`, no — traced:
`emit()` returns before `writeSignal` (`src/core/brain/sessions/import.ts:260-265`);
skill-invocation continuity records are gated on `opts.dryRun !== true` (`:423`);
recall import is gated (`:478`); the dedup-telemetry record is gated (`:511`);
the CLI log append is gated (`src/cli/brain/verbs/import-session.ts:127`);
`routeExtractedFacts` skips the write (`src/core/brain/fact-extract.ts:389`) and
also skips the durability-skip log (`:364`) and the anchorable precompute
(`:320-322`). For `import-claude-memory`, the dry-run branch returns before any
write and takes no snapshot (`src/core/brain/import-claude-memory.ts:176-185`),
and the vault-identity write guard is deliberately skipped because the path is a
read (`:82-86`).

**Defect worth naming.** A dry run cannot report what it *would* write.
`signals_created` stays 0 by explicit design
(`src/core/brain/sessions/import.ts:260-264`), and `facts_extracted` is 0 for the
same reason because `routeExtractedFacts` returns `created: 0` under `dryRun`
(`src/core/brain/fact-extract.ts:389`, `:417`). So a dry run's counters are
indistinguishable from a real run that found nothing — the exact shape the
operator's "no fallbacks that silently do nothing" rule forbids. Only
`signals_deduped`, `turns_scanned` and `durabilityRejected` carry information.

---

## 6. Idempotency

### 6.1 The ledger

`src/core/brain/idempotency-ledger.ts` guarantees, per **client-supplied key**:
same key + same payload hash → `duplicate_match` no-op; same key + different hash
→ `payload_mismatch`, never a silent overwrite; unseen key → `inserted`
(`:50-54`, `:147-181`). Granularity is one key ↔ one content hash
(`computePayloadHash`, `:120`), stored in month-sharded JSONL under a per-shard
lock with a re-scan inside the lock (`:157-159`). The residual race is documented,
not hidden: two genuinely concurrent *first* writers of one key can both insert
(`:25-29`).

**It is not on the ingest path.** Session import supplies no `idempotency_key`
(the `writeSignal` call at `src/core/brain/sessions/import.ts:276-307` sets none),
and `ingestSource` never touches the ledger.

### 6.2 What actually makes each ingest idempotent

- **Session import**: a dedup-hash index built once per run from the inbox and
  processed dirs (`src/core/brain/sessions/import.ts:217`), mutated in memory as
  each write lands (`:308`), and shared across every file of a directory walk
  (`:625-629`). Granularity: one hash per (topic, signal, principle, scope)
  (`:394-399`).
- **`ingestSource`**: the summary page filename keys on a source-identity hash
  (`src/core/brain/ingest/ingest.ts:147-148`), the write is skipped when the bytes
  would not change (`:182-187`), and the content manifest records the source's
  content hash so a re-ingest classifies `unchanged` (`:189-194`).
- **Git ingest**: a watermark (`src/core/brain/git/ingest.ts:122-139`,
  `:191-197`) plus store-level sha / (tag, target) dedup
  (`src/core/brain/git/store.ts:191-210`).

### 6.3 Resume vs restart

- **`ingestSource` under a batch plan resumes at the item boundary**:
  `recordCompleted` folds each completed source into the plan checkpoint
  (`src/core/brain/ingest/ingest.ts:199-205`), `planBatches({resume: true})`
  excludes them (`src/core/brain/ingest/batch-plan.ts:96-101`), and the plan id is
  derived from the *full* discovered set so it survives a resume
  (`src/core/brain/ingest/checkpoint.ts:76-87`). Checkpointing is on unless
  `OSB_INGEST_NO_CHECKPOINT` is truthy (`:64-69`). Caveat: a checkpoint write
  failure is swallowed (`src/core/brain/ingest/ingest.ts:202-204`), so resume can
  silently re-do items — harmless because the write is idempotent, costly because
  the extraction is not free.
- **Session import does not checkpoint at all.** An interrupted directory walk
  restarts from the first file (`src/core/brain/sessions/import.ts:633-644`); the
  already-written signals are absorbed by the dedup index rebuilt from disk
  (`:217`), so it converges, but it re-reads and re-scans every file.
- **Git ingest resumes via the watermark**, and a watermark that no longer
  resolves degrades to a full re-scan with a reported warning rather than
  duplicating or failing (`src/core/brain/git/ingest.ts:126-139`).

---

## Divergences

Points where t_da034197's framing does not survive contact with the source.

1. **The triage claim is confirmed, with a correction on the second half.**
   `SESSION_ADAPTERS` is a frozen hardcoded array at
   `src/core/brain/sessions/registry.ts:19`, and
   `src/core/brain/ingest/sources-registry.ts` is CRUD over `Brain/sources` pages
   (`:82`, `:113`, `:132`). Both verified by reading. But —

2. **A registry-shaped thing already exists under another name, and it is an
   ingest registry.** `src/core/brain/agent-backend/registry.ts:18-48` is a frozen
   id-keyed map with config-driven selection, a loud unknown-id error naming the
   registered set (`:32-37`), and a protocol whose docblock states exactly the
   property (a) asks for (`src/core/brain/agent-backend/types.ts:9-11`). Any design
   that invents a new registry shape without reconciling with this one ships two
   idioms for one job.

3. **There are three different adapter families with three different selection
   models.** Session adapters sniff-with-override
   (`src/core/brain/sessions/import.ts:191-204`); memory backends select by
   explicit id or config key (`src/core/brain/agent-backend/registry.ts:45-48`);
   transcript runtimes and agent-source providers run *all* members with no
   selection at all (`src/core/discipline/transcripts/index.ts:37`,
   `src/core/brain/agent-source/registry.ts:18`). A single registry cannot serve
   all three without deciding which model it imposes on the other two.

4. **The existing adapter identity is not house-idiom-compliant**, so it cannot be
   the seed of an adapter-kind vocabulary as-is: `SessionAdapterId` is a bare
   string union (`src/core/brain/sessions/types.ts:108`) with no frozen object and
   no members array, and `isSessionAdapterId` takes `string`, not `unknown`
   (`src/core/brain/sessions/registry.ts:27`). It is absent from the census.

5. **(b)'s premise — "a lease acquired and released per write" — does not describe
   the ingest path.** On `src/core/brain/ingest/`, nothing is locked at all:
   `updateManifest` (`content-manifest.ts:227-239`) and `recordCompleted`
   (`checkpoint.ts:170-194`) are *unlocked* read-modify-writes of shared files, and
   `appendGitRecords` (`git/store.ts:178-215`) is an unlocked read-modify-append.
   The real defect is a missing lock, not a too-granular one. Reframing (b) as
   "hold a lease" without saying which shared state it protects would ship a lease
   over writes that never contended and leave the two files that do contend
   unprotected.

6. **Holding one lease for a whole ingest directly contradicts the batch-plan
   design.** `src/core/brain/ingest/batch-plan.ts:9-11` exists so the caller can
   dispatch each batch as a **parallel subagent**, each calling
   `brain_ingest_source`. A whole-ingest lease either serialises those batches
   (removing the feature's reason to exist) or refuses them outright — the brain
   sync lock has **no retry by design** (`src/core/brain/sync-lockfile.ts:13-15`),
   so the second, third and fourth subagent fail immediately with `ELOCKED`.

7. **A long-held lease under `Brain/` makes `brain doctor` report an uncertainty
   on every ingest.** `scanStaleLocks` lists every `.lock` under the brain root
   (`src/core/brain/sync-lockfile.ts:123-127`) and the probe deliberately cannot
   distinguish a live holder from a crash leftover
   (`src/core/brain/doctor/uncertainty-probes.ts:125-148`). Today locks are held
   for milliseconds so the window is negligible; a minutes-long ingest lease makes
   the report fire routinely and trains operators to ignore it.

8. **The "long-held lock blocks an MCP read" fear is unfounded; the real casualty
   is MCP writes.** Brain reads take no lock anywhere, and the search store's read
   mode explicitly never locks (`src/core/search/store.ts:96-97`; only
   `mode: "write"` acquires, `src/core/search/store/writer-lock.ts:56-63`). What a
   held lease would block is a concurrent MCP *write* — and it would block it with
   an immediate `ELOCKED` rather than a wait, surfacing as
   `BrainCollisionError(sourceLock)` (`src/core/brain/preference-txn.ts:185-190`).

9. **A crash while an ingest lease is held is unrecoverable without an operator.**
   The sync primitive has no stale window at all
   (`src/core/brain/sync-lockfile.ts:13-21`); the exit hook only fires on normal
   exit (`:40-53`). The only precedent for a long-held lease pairs it with a
   forward/backward-recoverable journal
   (`src/core/brain/skill-proposals.ts:633`, `:836-861`) — an ingest lease without
   an equivalent leaves the vault wedged after one SIGKILL.

10. **Two silent-empty results exist today and are in scope for the "no fallbacks
    that silently do nothing" rule**: the transcript resolvers collapsing
    "absent / unreadable / genuinely idle" into `fileCount: 0`
    (`src/core/discipline/transcripts/claude-code.ts:21`, `:27`, `:34`, `:44`), and
    a session-import dry run reporting `signals_created: 0` and
    `facts_extracted: 0` indistinguishably from a real run that wrote nothing
    (`src/core/brain/sessions/import.ts:260-264`,
    `src/core/brain/fact-extract.ts:389`).

11. **`ingestSource` sits on tier 0 with no dry-run at any layer** — core, SDK and
    MCP alike. Making "dry-runs stay inert" true for the ingest path is not a
    matter of preserving an existing behaviour; the behaviour has to be built
    first (`src/core/brain/ingest/ingest.ts:60-79`,
    `src/mcp/brain/ingest-tools.ts:41-81`).

---

## What a design must not assume

- **Do not assume ingest currently locks anything.** It does not
  (`src/core/brain/ingest/ingest.ts`, `src/core/brain/git/store.ts:211-214`). "Hold
  the lease for the whole ingest instead of per write" describes a refactor of a
  discipline that is absent.
- **Do not assume one process performs one ingest.** The batch planner exists to
  fan out across processes (`src/core/brain/ingest/batch-plan.ts:9-11`). A
  process-scoped lease and a plan-scoped lease are different objects.
- **Do not assume the lock primitive waits.** `acquireLockSync` has no retry and no
  stale window (`src/core/brain/sync-lockfile.ts:13-21`); `withFileLock` retries 3
  times over 750 ms (`src/core/reliability/lock.ts:34-39`). Neither will queue
  behind a multi-minute holder.
- **Do not assume a lock is re-entrant.** Every primitive here fails a second
  acquire of the same target from the same process
  (`src/core/brain/sync-lockfile.ts:72-80`). Any lease target must be disjoint from
  every target the inner writes take: the continuity month shard
  (`src/core/brain/continuity/store.ts:291`), the idempotency month shard
  (`src/core/brain/idempotency-ledger.ts:157`), the log directory
  (`src/core/brain/log.ts:243`), the preference file
  (`src/core/brain/preference-txn.ts:182`), and the search index path
  (`src/core/search/store/writer-lock.ts:43`).
- **Do not assume an adapter registry can be a single frozen array.** The three
  existing families disagree on whether selection is by sniff, by id, or absent
  (§2, divergence 3).
- **Do not assume `SessionAdapterId` can be reused as the adapter-kind
  vocabulary.** It fails three of the four idiom requirements
  (`src/core/brain/sessions/types.ts:108`,
  `src/core/brain/sessions/registry.ts:27`).
- **Do not assume a dry-run counter today means "what would be written".** It means
  "what was written", which is zero by construction
  (`src/core/brain/sessions/import.ts:260-264`).
- **Do not assume a crash leaves recoverable state.** Absent a journal, a held sync
  lock survives the crash and blocks every subsequent write until an operator
  removes the file by hand (`src/core/brain/doctor/uncertainty-probes.ts:141-147`).

### Not established in this pass

- The lock and dry-run behaviour of `bank-import`, `graph-import`, `okf-import`,
  `telegram-capture` and `scan-inline` (named at §1.7, not traced).
- Whether the truth-ingest MCP op has its own gate; only the CLI `--ingest` flag
  path was read (`src/cli/brain/help-text.ts:433-436`).
- Whether `emitGatedTelemetry` can itself fail in a way that leaves a continuity
  shard lock held (`src/core/brain/dedup-telemetry.ts:115-127` was read; the helper
  body was not).
