You are brainstorming architectural variants for the following work. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Open Second Brain is a TypeScript-on-Bun agent memory system: an MCP server (110 tools, hand-rolled JSON-RPC, no SDK), an `o2b` CLI, and an Obsidian-compatible Markdown vault. One release must ship nine units picked off the tracker. Reconnaissance against the real source has already run and corrected most of the nine task bodies, so the framing below is the CORRECTED one — design against it, not against the original upstream framing.

The unifying thesis under consideration: **the system does long, resource-hungry, state-bearing work and tells nobody, and it prints claims it never checked.**

The nine units, as reconnaissance leaves them:

1. **Progress out of a long pass.** The repo already has a canonical vocabulary of long operations (`SafeguardOperation = "dream" | "reindex" | "bridges" | "clusters" | "maintenance"`) and every `opts.safeguard?.checkpoint()` call sits exactly at the iteration boundary a progress tick belongs at. One operation (the indexer) already emits a per-file event through an optional `onFile?: (event) => void` callback consumed on stderr behind `--verbose`. Nothing else emits anything: `o2b brain dream` prints nothing until it finishes. Hard constraints: the sink must be synchronous (`dream`, `discoverBridges`, `detectCommunities`, `runDoctor` are all synchronous functions); a layering test bans `process.stdout.write` in core, so core emits events and only the edge writes; twelve top-level commands own their own JSON on stdout, and every other command has BOTH stdout and stderr monkey-patched into buffers for the whole run, so a progress line there is swallowed and dumped at the end — worse than nothing. For MCP: there is no SDK, `params._meta.progressToken` is silently discarded, the stdio transport writes only what the request handler returns, and the HTTP transport `res.end`s a single SSE event and closes. Index and reindex are deliberately NOT exposed over MCP at all.

2. **A code-scanner that walks what it must not.** A deterministic project scanner renders facts into vault notes behind sentinel regions. Measured on the repo itself: the scan is 388 ms and rendering plus writing is 7.9 ms — 2% of the run. Of 24094 files visited, 21113 are under one tool directory; the skip list honours no `.gitignore` and no dot-directory rule, and the tree is walked twice. The original task asked for concurrency and per-note retry; concurrency would target the 2%. A separate latent defect: a tie-break uses locale-sensitive string comparison, so output is locale-dependent.

3. **Cancellation that exists and is never wired.** A safeguard module already declares `signal?: AbortSignal`, a `SafeguardAbortError` distinguished from timeout precisely so a shutdown coordinator can treat an intentional stop as clean, and checkpoint logic that checks abort in priority over the deadline. No production call site passes a signal, so that error class is dead code. Separately: the outbound-embedding concurrency semaphore is constructed per `embed()` call rather than shared, so the configured concurrency bounds one call and not the process; and one benchmark fan-out is unbounded and amplified 24× by a tuning grid.

4. **A thundering herd of detached reindexes.** A helper spawns a detached `o2b search reindex` from two startup points: every MCP server start and the SessionStart/PostCompact hook. The child is spawned with `stderr: "ignore"`. The collision is already acknowledged in source; the losing child waits on a writer lock, spins about three seconds and throws `INDEX_LOCKED` into a process whose stderr is discarded. N agent sessions after a schema bump produce N detached reindexes and N−1 silent deaths. The original task asked for host-pressure gating, a startup grace period and crash-loop recovery, framed around a daemon. **There is no daemon** — it is a stated architectural invariant, every entry point is one-shot, and nothing schedules the consolidation pass automatically. A maintenance lane already gates background work on a measured pressure signal (interactive query rate) behind a TTL lease and a journal with typed verdicts. Host load average is unavailable in any honest sense: it is `[0,0,0]` on Windows and reports the host run queue inside a container, and this repo's established answer to an unanswerable platform question is to refuse by name rather than return a plausible number. A related finding: a hook self-watchdog defaults to a 55-second ceiling while all fifteen hook entries declare a 10-second host timeout, so the watchdog the repo already has probably cannot fire.

5. **An ingest that takes no lock at all.** The original task asked to hold the single-writer lease for a whole ingest instead of per write. Reconnaissance found the opposite defect: the manifest update and the completion record are unlocked read-modify-writes of shared files. A whole-ingest lease would also break a batch-planning surface that exists so a caller can dispatch each batch as a parallel subagent, because the sync lock has no retry and no stale window by design. Separately, the adapter list is a frozen hardcoded array, while a registry of exactly the required shape (frozen id-keyed map, config-driven selection, loud unknown-id error) already exists elsewhere in the same codebase under a different name. Two silent-empty defects sit on the same path: transcript resolvers collapse "directory absent", "unreadable" and "genuinely idle" into a count of zero, and a dry-run import reports zero created indistinguishably from a real run that wrote nothing.

6. **An install that prints a claim it never checked.** On success the tool should state data ownership — every memory is a Markdown file in your own vault, copy it elsewhere, delete it and the brain is gone, no service to cancel — and expose it as a machine-readable handoff field. Reconnaissance found the claim is not unconditionally true: one editor plugin spools raw conversation turns outside the vault with no pruning, and a machine-local installation secret keys the vault identity that every tool returns, so copying the vault to another machine silently breaks those references. Also, install has four modes with four result types and four JSON shapes, one with no schema version; no test asserts any of them; and install resolves the vault through its own chain that disagrees with the rest of the CLI on precedence, so the path it prints as "your brain" can name a directory nothing else uses.

7. **Environment class, honestly.** The companion task asks to detect local versus cloud sandbox versus ephemeral container and branch behaviour, plus a durability job check verifying presence AND liveness. Reconnaissance: cgroup v2 has erased the classic container heuristic on this host, every container signal is one-way so a negative proves nothing, "cloud sandbox" cannot be separated from "container", and "container" is not "ephemeral". There is also no job registration anywhere to check the presence of — every scheduled-job surface in the repo is a recipe renderer that writes nothing and installs nothing.

8. **A provider with a death date.** A doctor check should warn when the configured embedding provider or model has an announced decommission date, naming the provider, the date and the migration command. Reconnaissance: the preset catalog has six entries, five of them open-weight checkpoints with no vendor who could announce anything, and the hosted models that actually get decommissioned live in a disjoint pricing table. The model field is a free string with no validation, and the onboarding text itself recommends a model that is not in the catalog and is a preview. The provider field resolves to one of four transport kinds, so it cannot name a vendor; vendor identity exists only inside a free-form base URL that nothing maps. No verb in the tool writes a config key, so "the migration command" cannot be a config edit — the established precedent for that situation points the operator at a catalog-listing verb instead. There are two candidate homes: one doctor has an injected clock and a severity ladder and a hard census requiring every registered code to be pinned in a test, but no check there resolves search config; the other surface owns the provider question and its exit codes but has no clock.

9. **A conformance suite for four memory failure modes.** Proactive know-to-ask paired with an anti-gaming false-fire rate; write-back fidelity through an extractor seam that runs the shipped code with zero model calls; a cross-source-leakage invariant gating at zero; and an average injected-token intrusion budget. Reconnaissance: the "zero model calls" seam is not something to build — the server never calls a model on any write path, by stated architectural contract, so a fixture supplying structured intake IS the shipped architecture. The relevance decision that makes know-to-ask measurable is a pure function with an injectable retriever, but it sits behind a setting that defaults off, while the always-on injection path makes no relevance decision at all and would score degenerately. The surfacing gate fails open by design, so anti-gaming pressure has to land on a confidence floor rather than the gate. There is no exact token count anywhere — five estimators disagree, and the surface that claims exactness subtracts caller-supplied integers. Owner-scope isolation is gated by a setting that also defaults off, so a zero-gate under shipped defaults is vacuous. There are two unrelated bench harnesses sharing nothing, no committed baseline anywhere, and CI runs no bench step at all.

# Project context

TypeScript on Bun. ~2050 source files, 1064 test files, 9816 tests. One runtime dependency. Recent releases, most recent first: wiring what exists; evidence at the boundary; the flush that never landed; silence is not an answer; what the index already knew; provenance at the boundary; module boundaries and the fallbacks behind them.

Conventions the codebase enforces mechanically:

- **Closed-vocabulary four-piece idiom**, mandatory and census-tested: a frozen object with camelCase keys and snake_case values, a derived union type, a members array, and a type guard whose parameter is `unknown`. A separate census test enumerates every registered vocabulary.
- **Census tests as the enforcement mechanism.** Raw filesystem write sites, destructive removal sites, doctor exit codes, MCP tool parity, vault-identity assertions, config-template keys, help-surface parity, and verdict vocabularies each have a test that enumerates the population and fails when a member appears without a declaration. The previous release's whole argument was that a mechanism which must be called by hand is a mechanism that will be missed, and that declaration plus a census is the answer.
- **A six-tier confirmation ladder** for destructive work: no gate, a `dryRun` option, dry-run by default plus `--apply`, `--yes` for non-interactive, an override flag for a proved hazard recorded in a log, and an exact confirmation phrase. Orthogonal to it, a `--expect N` / `--strict` count guard.
- **Byte-identity is measured, never asserted** — a vault-digest helper produces a tree digest so a release can state exactly how many bytes changed.
- **Two config files with different disciplines**: a nested vault config whose bounded-integer reader never clamps and never defaults, because a knob that silently reverted would be indistinguishable from the operator never having set it; and a flat machine config where bad values throw with the key name.
- **A layering test** bans process exit and stdout writes in core.

Constraints from the operator, non-negotiable:

- No fallback that silently does nothing and misleads. If there is an error, show the error explicitly.
- No stubs. No placeholder that reports success it did not achieve.
- SOLID, KISS, DRY. Anything extractable goes into a named constant or local.
- Maximally native integration, no crutches — extend the idioms that exist rather than inventing parallel ones.
- Never hardcode natural-language phrases of any specific language. Everything is English; any handling of other languages must be structural, not a word list.
- The release must not grow a daemon, a scheduler, a background process, or a network dependency it does not already have.

# Required output format

Produce exactly 3 distinct architectural variants for how to shape this release as a whole — the through-line, what carries the nine units, what mechanism makes the fixes durable, and where the boundary of the release sits. Variants must differ in kind, not in degree.

For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
