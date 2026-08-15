# Nothing runs unwatched - long work that reports, and claims that were checked

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Nine units were picked off the tracker by priority. Reconnaissance against the
real source ran before any of them was designed, and it found the same two
defects underneath all nine.

The first: this system does long, resource-hungry work and reports nothing while
it runs. `o2b brain dream` prints its first character after it has finished. A
consolidation pass, a bridge discovery, a community detection and a maintenance
lane all accept a `safeguard` whose `checkpoint()` sits at exactly the iteration
boundary a progress tick belongs at, and none of them emits one. A herd of
detached reindexes is spawned from two startup points with `stderr: "ignore"`,
so every loser of the writer-lock race throws `INDEX_LOCKED` into a discarded
stream. A cancellation contract - `signal`, `SafeguardAbortError`, abort checked
in priority over the deadline - is fully written and passed by no production
call site, which makes that error class dead code.

The second: this system prints claims it has not checked. The install success
path is asked to state that every memory is a file in the operator's own vault
and that deleting it ends the brain - while one editor plugin spools raw
conversation turns outside the vault with no pruning, a machine-local secret
keys the `vault://` identity every tool returns, and install resolves the vault
through a chain that disagrees with the rest of the CLI, so the path it would
print as "your brain" can name a directory nothing else uses. A token-impact
surface reports `method: "exact"` over integers a caller supplied. Four
estimators disagree about what a token is.

The two are the same defect seen from two sides: a system that does not report
cannot be trusted, and a system that reports what it did not check cannot be
trusted either.

## Scope

Eleven implementation units carrying nine tracker tasks.

- **U1 - the progress spine.** A synchronous, optional progress sink threaded
  beside the `safeguard` option it mirrors, emitted from the checkpoints that
  already exist, rendered only at the edge. A census test over every long
  operation.
- **U2 - MCP progress: stdio carries it, HTTP refuses by name.** The
  `_meta.progressToken` is read rather than discarded; the stdio transport gains
  a notification writer; the single-response HTTP transport states a typed
  refusal instead of accepting a token it cannot honour.
- **U3 - cancellation, wired.** A real `AbortSignal` reaches the safeguard, an
  interrupt stops the pass cleanly at the next checkpoint, and a deliberate stop
  is not reported as a crash.
- **U4 - a ceiling that spans the process.** The embedding semaphore is shared
  per resolved provider rather than constructed per call, and the one unbounded
  fan-out is bounded.
- **U5 - the herd.** A reindex that can already be shown to lose the lock is not
  spawned, and the outcome of one that is spawned is written where the operator
  can read it.
- **U6 - a fourth gate, and a streak.** Host pressure joins the maintenance
  lane's existing gate set, refusing by name on platforms where the metric is
  degenerate; a consecutive-failure streak read off the lane journal is the
  portable analogue of crash-loop recovery for a system with no daemon. The hook
  watchdog ceiling is reconciled with the host timeout that pre-empts it.
- **U7 - the ingest lock that was never taken.** The unlocked read-modify-writes
  are locked, the frozen adapter array becomes a registry on the pattern already
  present in this codebase, and two silent-empty results learn to say which
  emptiness they mean.
- **U8 - the install says only what it checked.** One ownership statement
  derived from the resolved vault path, with the out-of-vault state it does not
  cover named rather than omitted; a vault-resolution disagreement fixed; an
  environment verdict that admits what it cannot determine.
- **U9 - the provider death date.** A sunset check that distinguishes "no sunset
  announced" from "unknown to the catalog", on the doctor that has a clock.
- **U10 - four failure modes, measured.** A conformance suite over proactive
  recall, write-back fidelity, cross-source isolation and injected-token cost,
  with one token estimator instead of five and a committed baseline.
- **U11 - the scanner's walk.** The traversal stops visiting what it must not,
  stops doing it twice, and stops depending on the host locale.

## Out of scope

Each of these is a decision, not an omission.

- **No daemon, no scheduler, no supervisor.** The absence is a stated
  architectural invariant (`docs/architecture.md:229`), and a rejected design
  item (`docs/plans/2026-05-18-brain-maturity-design.md:690-691`). The tasks
  asked for a startup grace period and crash-loop recovery; both are shaped for
  a resident process. The portable analogue is a gate evaluated at the top of a
  one-shot command with its state on disk, which is what U6 builds.
- **No cap on model inference.** The kernel makes no chat-model call at all -
  model work is handed back to the caller as `needs-llm-step` envelopes, and
  whatever inference a dream pass causes happens in the host agent's process
  after `dream()` has returned. Naming a ceiling "inference" would be a
  hardcoded falsehood about what this process does. U4 caps what actually
  crosses the boundary: outbound HTTP to the embedding provider.
- **No concurrency in the project scanner.** Measured on this repository:
  rendering and writing are 7.9 ms of a 396 ms run. Parallelising 2% is theatre.
  The measurement is recorded in the recon note and the refusal is stated in the
  release, not buried.
- **No whole-ingest writer lease.** The batch-planning surface exists so a caller
  can dispatch each batch as a parallel subagent, and the sync lock has no retry
  and no stale window by design, so subagents 2..N would fail immediately with
  `ELOCKED`. The task's premise - that the lease is taken too often - is
  inverted: it is taken not at all.
- **No three-way environment classifier.** cgroup v2 has erased the classic
  container heuristic, every container signal is one-way so a negative proves
  nothing, "cloud sandbox" cannot be separated from "container", and "container"
  is not "ephemeral". U8 probes what backs the resolved vault path and admits
  `undetermined` rather than guessing a class and stating the guess as fact.
- **No host load average as a portable metric.** It is `[0,0,0]` on Windows and
  reports the host run queue inside a container. This repository's established
  answer to an unanswerable platform question is to refuse by name
  (`src/core/config.ts:35,45-59`), not to return a plausible number.
- **No progress over the HTTP MCP transport.** It writes one SSE event and
  closes. A progress surface that accepts a token and discards the events would
  report liveness support that does not exist.

## Chosen approach

Variant 1 from the consultant, with one correction and one graft.

**The spine.** A closed four-piece vocabulary `PROGRESS_KIND`
(`started`/`advanced`/`refused`/`stopped`/`finished`) and a
`ProgressSink = (event: ProgressEvent) => void` - synchronous, because `dream`,
`discoverBridges`, `detectCommunities` and `runDoctor` are synchronous
functions and an async sink cannot be awaited inside them. It is an optional
readonly field on the same options interfaces that already carry
`safeguard?: Safeguard`, invoked with `?.`, exactly matching the house idiom
that `onFile`, `onTelemetry`, `onOversize` and `validate` already follow. Core
emits; only `src/cli` and `src/mcp` write, which is what the layering test
requires.

The event carries the operation identifier from the existing
`SafeguardOperation` union - the repository's own definition of "long" - a stage
identifier drawn from that operation's existing phase vocabulary, an integer
`completed`, and an **optional** `total`, because the index walk is a generator
and materialising a denominator costs a second full traversal.

**The correction to Variant 1.** The consultant treated both MCP transports as
non-carriers. That is true of HTTP and false of stdio: the frame writer is
private but reachable, and a third optional handler parameter does not force a
change at the 88 registration sites, because a handler declaring two parameters
satisfies a type declaring three. So stdio gains real progress notifications and
HTTP gains a typed refusal. One transport carries it; the other says why it
cannot. Neither pretends.

**The graft from Variant 3.** Every unit lands inside a mechanism this
repository already enforces rather than a new one: the maintenance lane's gate
set and journal for U6, the `agent-backend` registry shape for U7, the doctor
code census for U9, the write-site census's syntactic technique for U1's census,
the existing bounded-integer config readers for every new knob.

**Durability.** The mechanism that makes this last is the progress census: a
test enumerating every options interface that accepts `safeguard?: Safeguard`
and failing when one does not also accept `onProgress?: ProgressSink` or carry a
written declaration of why it cannot. This is the same declaration-plus-census
idiom the previous release established for destructive removal sites, and it is
the answer to the same failure: a mechanism that must be called by hand is a
mechanism that will be missed.

## Design decisions

- **Reuse `SafeguardOperation`, do not invent a second "long operation" list.**
  It already names `dream`, `reindex`, `bridges`, `clusters` and `maintenance`,
  and it came from an earlier task in this same family.
- **`total` is optional and its absence is meaningful.** The index driver
  consumes a generator; the embedding phase has an array. One event shape must
  carry both, and an edge renderer must show a bare counter when no denominator
  exists rather than inventing one.
- **Progress goes to stderr, never stdout.** Twelve top-level commands own their
  stdout as a caller-parsed payload. Every existing intermediate-output
  precedent in the repository is on stderr.
- **A command outside the internal-JSON set must not emit progress at all.** For
  those, both streams are monkey-patched into buffers for the whole run and
  released at the end, so a progress line there is swallowed and then dumped -
  which looks like it worked. The dependency is currently undocumented and
  load-bearing; a test asserts it.
- **No prose in a progress event.** Identifiers and integers only; the sentence
  is rendered at the edge from the identifier. This is the same rule that keeps
  caller-supplied prose off the advisory rail.
- **A deliberate stop is not a failure.** `SafeguardAbortError` exists precisely
  to be distinguished from a timeout; the exit code and the emitted event must
  preserve that distinction, or an operator's Ctrl-C reads as a crash.
- **A gate that cannot evaluate reports that it could not.** The pressure gate
  emits a distinct verdict on platforms where the metric is degenerate. An open
  gate and an unevaluated gate must not be the same journal line.
- **A new knob fails hard on a bad value.** Both disciplines exist in this
  codebase; for a ceiling or a gate, a silent fallback means the operator
  believes a bound is in force that is not.
- **An ownership statement names its exceptions.** The out-of-vault state that
  exists is enumerated by the statement rather than omitted from it, and the
  install path resolves the vault the same way the rest of the CLI does before
  it prints a path at all.
- **One token estimator.** Five disagreeing estimators are five different
  answers to one question; a metric averaged over them means nothing. The
  surface claiming `method: "exact"` over caller-supplied integers stops
  claiming it.
- **No natural-language word list anywhere.** The one prose recognizer on the
  write path hardcodes five English markers, contradicting the rule its own
  sibling module states. It becomes structural.

## File changes

New:

- `src/core/brain/progress.ts` - vocabulary, event, sink.
- `src/cli/progress-rail.ts` - edge renderer and legality decision.
- `src/core/search/embeddings/provider-semaphore.ts` - process-scoped ceiling.
- `src/core/brain/maintenance/pressure.ts` - the fourth gate.
- `src/core/brain/maintenance/streak.ts` - consecutive-failure read off the journal.
- `src/core/brain/ingest/adapter-registry.ts` - the registry shape.
- `src/core/brain/portability/vault-residence.ts` - what backs the vault path.
- `src/core/search/embeddings/sunset.ts` - sunset resolution and verdict.
- `src/core/bench/failure-modes/*` - the four-metric suite.
- `tests/core/architecture/progress-census.test.ts` - the durability mechanism.

Modified, in the layers they belong to: the indexer, dream, bridge discovery,
community detection, the maintenance lane, the MCP server and stdio transport,
the four CLI long verbs, the install renderers, the diagnostics registry, the
architect scanner, the ingest manifest and checkpoint writers, the session
adapter registry, the token estimators, and the hook ceiling.

## Risks and open questions

- **Threading one option through many call sites is the largest blast radius in
  the release.** Mitigation: the option is optional everywhere, absence is the
  existing behaviour, and the census names what is not yet wired rather than
  letting it pass silently.
- **The stdio notification writer must not interleave with a response frame.**
  Writes are line-delimited and synchronous; the design must state the ordering
  guarantee and test it.
- **The progress census may over-reach.** Some options interfaces accept a
  safeguard only to forward it. The census carries a declared-exception list
  with a written reason per entry, on the pattern the write-site census uses.
- **The conformance suite is the largest single unit and the least verified.**
  Two of its four metrics rest on surfaces that default off; the bench calls the
  functions directly, so the default does not block measurement, but the release
  must say that the shipped default is off and that the suite measures the
  capability rather than the delivered behaviour.
- **The install vault-resolution fix changes which directory an existing install
  names.** It is a correctness fix with a user-visible consequence and belongs
  in the breaking section.
