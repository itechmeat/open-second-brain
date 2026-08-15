# Recon: allocateSlug loses a concurrent write (GitHub #161)

Read-only reconnaissance against `main` @ 29ea0099. Every claim below is cited;
the ones that changed the shape of the fix are marked.

## The defect is not signal-local

Three callers allocate a slug and then create the file exclusively. None retries.

| Caller | Exclusive create | On collision |
|---|---|---|
| `src/core/brain/signal.ts:302` `writeSignal` | `signal.ts:390-394`, `existsErrorKind: "signal"` | terminal - this is #161 |
| `src/core/brain/dead-ends.ts:104` `recordDeadEnd` | `dead-ends.ts:124-128`, `existsErrorKind: "dead-end"` | terminal, same defect |
| `src/core/brain/capture/capture-note.ts:124` `writeCaptureNote` | `capture-note.ts:127`, no `existsErrorKind` | terminal, and reports a raw errno with an absolute path |

`writeSignal` itself has eight callers (`src/cli/brain/verbs/feedback.ts:91`,
`src/mcp/brain/feedback-tools.ts:157`, `session-lifecycle.ts:685`,
`session-checkpoint.ts:236`, `fact-extract.ts:393`, `pending.ts:116`,
`inline-scan.ts:233`, `sessions/import.ts:276`). The last three write many
signals per run on the same date and often the same topic stem, so they are the
highest-collision producers in the system. Fixing inside `writeSignal` covers
all eight.

## There is no typed collision signal today (shape-changing finding)

`writeFrontmatterAtomic` (`src/core/vault.ts:447-471`) sits over
`atomicCreateFileSyncExclusive` (`src/core/fs-atomic.ts:117-141`, `linkSync`).
Collision surfaces two different ways and neither is a class:

- without `existsErrorKind`: the native `Error & { code: "EEXIST" }` propagates;
- with `existsErrorKind`: `vault.ts:467` throws a plain
  `new Error("<kind> already exists: <rel>", { cause: nativeErr })`. The outer
  error has no `.code`; the errno survives only on `.cause`.

So a retry today could only key off a string message or a per-call-site cause
walk. Both are forbidden. The typed error is a prerequisite, not an extra.

Nothing in `src/` reads that message and no test asserts it, so introducing the
class while keeping the wording is message-compatible.

## allocateSlug contract

`src/core/brain/paths.ts:704-770`. `AllocateSlugOptions { vault, targetDir,
prefix, slug, maxAttempts? }` returns `AllocateSlugResult { slug, path, suffix }`.
Candidate n is `slug` for n=1 and `${slug}-${n}` after. `maxAttempts` (inline
`10_000` at `paths.ts:743`) bounds candidate names probed inside one call, and
exhaustion throws loudly. The docblock already concedes the probe is not
race-safe and says the caller closes the window; the caller only detects it.

## The lockfile is the wrong tool

`src/core/brain/sync-lockfile.ts` gives `acquireLockSync(target)` with a single
attempt by design (docblock 12-15), `ELOCKED` on contention, and a stale lock
after a hard kill that only `brain_doctor` clears. `preference-txn.ts:185-190`
maps it to `BrainCollisionError`.

It locks a known target path. The contended resource here is "the next free name
under this directory for this prefix", which would need a directory-scoped lock
(the shape `src/core/brain/log.ts:238-251` uses), and it would add a
crash-stale-lock failure mode to the hottest write path while buying nothing:
`link(2)` already provides race-free exclusivity. The only missing piece is
"on collision, try the next name".

## Where the retry belongs

One fused helper beside `allocateSlug` in `paths.ts`, with the create injected:

```ts
export function allocateAndCreate<T>(
  opts: AllocateSlugOptions,
  create: (allocation: AllocateSlugResult) => T,
): { readonly allocation: AllocateSlugResult; readonly value: T };
```

One loop over attempts, sharing a private `slugCandidate(baseSlug, attempt)`
with `allocateSlug` so the naming rule exists once; `existsSync` fast-skip,
`create(...)`, and on a typed collision continue, on anything else rethrow.
`maxAttempts` keeps exactly one meaning. Looping `allocateSlug` instead would
make the bound quadratic and its exhaustion message false.

The callback is required rather than a fixed-bytes `allocateAndWrite`: all three
callers derive the frontmatter `id` from the allocated slug (`signal.ts:307`,
`dead-ends.ts:110`, `capture-note.ts:125`), so re-linking pre-rendered bytes
would ship a file whose `id` contradicts its own filename.

`paths.ts` is the right owner: it already holds `allocateSlug`, `ensureInsideVault`
and the naming vocabulary. With the create injected it never imports `vault.ts`
and never names a write call, so it stays outside
`tests/core/architecture/write-site-census.test.ts` and needs no exclusion entry.
A new module that imported `writeFrontmatterAtomic` would owe entries to two
censuses.

## Proving it without a mocking idiom

There is no module or fs mocking anywhere in `tests/` - zero `mock.module`, zero
`spyOn(fs)`. `tests/helpers/run-cli.ts:164` refuses concurrent in-process runs
unless `{ subprocess: true }`.

The injected seam makes mocking unnecessary. The invariant test passes a `create`
callback that, on its first invocation only, writes the target file itself and
then throws the typed collision - a byte-exact replay of what the losing process
sees. Assert the call returns, lands `-2`, and invoked `create` twice. Mirror
cases: a non-collision error propagates from attempt 1, and a callback that
always collides exhausts a small `maxAttempts` and throws loudly. The
eight-way concurrent CLI reproduction stays as a regression smoke test, not as
the proof, because it is probabilistic.

Existing suites: `tests/core/brain.paths.test.ts:208-345`,
`tests/core/brain.signal.test.ts:239-246`, `tests/core/brain/dead-ends.test.ts`,
`tests/core/brain/capture/capture-note.test.ts`.

## Adjacent defects found in the same path

1. `src/core/brain/snapshot-gate.ts:82-96` `createUniqueSnapshot` is a second
   probe-create-retry, and it discriminates the retry by re-running `existsSync`
   after the throw: any unrelated `createSnapshot` failure that happens while the
   path exists is swallowed and retried, losing the real error. This is exactly
   the misleading fallback the release theme is about.
2. `src/core/brain/dream.ts:400-410` `nextAvailableDreamRunId` is a third copy,
   pure check-then-write and unbounded. `snapshot-gate.ts:73` claims to mirror it
   "but closes the race window", leaving this one open.
3. `src/core/brain/capture/capture-note.ts:127` reports collisions as a raw errno
   with an absolute path, unlike its two siblings.
4. `src/core/vault.ts:462-466` hand-rolls `path.startsWith(vault + "/") ? slice()`,
   duplicating `vaultRelative` from `src/core/path-safety.ts` which `paths.ts`
   already re-exports.
5. `src/core/brain/paths.ts:743` inlines `10_000`; the docblock at 715-720 already
   narrates it as a named bound.
