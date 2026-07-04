# Brain Integrity & Safety Hardening — a nine-task suite hardening write-time discipline, cross-machine portability, and corpus-level safety

**Status:** draft
**Author:** product-tech-lead (via hermes-workflows Phase 0)
**Audience:** implementation (driven card workers, one card at a time on the shared branch)
**Branch:** `feat/brain-integrity-safety-hardening`
**Consultant:** Claude Code (`claude -p`, model `claude-opus-4-8`), exit 0, 3 parseable variants → no fallback invoked.

## Problem statement

Open Second Brain syncs a plain-Markdown vault across VPS/Mac/Android via Syncthing and is called concurrently by many runtimes (Hermes, Claude Code, Codex, OpenClaw, …) through MCP. Three architectural strips are soft today:

1. **Write-time integrity.** There is no single-writer discipline across *all* Brain writes, so concurrent MCP tools/hooks/imports/jobs can race on the same artifact and produce lost updates or noisy Syncthing conflict files. Codegraph-derived artifacts can be subtly wrong while syntactically present, and a generated note whose title slugifies to punctuation-only or empty produces a fragile/colliding filename.
2. **Cross-machine portability.** Graph/index artifacts and generated examples that carry absolute, machine-local paths (`/root/vault/...` vs a Mac/Android home) are stale on every other device, forcing full re-extraction/re-index instead of incremental reuse, and hardcodes in docs/templates leak private host assumptions.
3. **Corpus-level safety.** The injection-pattern detector fires only at *read-time* context assembly, so a poisoned memory that got persisted sits in the vault until it happens to be read; the secret redactor silently drops the tail past a 256 KB ceiling and recognises only `key=value`/Bearer shapes, so secrets beyond the ceiling and bare infra-topology (public IPs, internal hostnames) leak; and a contested truth-ledger slot is a binary flag that cannot say *which side* carries more independent support.

This suite hardens each strip as opt-in (or byte-identical-when-off / projection-only) capabilities without changing any existing default, and without introducing a hidden daemon or an LLM call inside the kernel.

## Scope

Nine atomic tasks, one feature branch, one release (1.20.0 → 1.21.0). Implemented one-by-one via TDD. Each task is one conventional commit. Cards are driven **one at a time** on the shared branch — each worker builds on the commits the previously-driven cards already landed.

**Task letter → card id → one-line title:**

- **A** `t_559fbe1f` (p4) — Single-writer queue / lease-backed write lane for concurrent Brain writes (no daemon).
- **B** `t_e032ff18` (p4) — Portable graph/index artifact keys: scan-root-relative, not absolute.
- **C** `t_aec23bd0` (p4) — Scheduled corpus-wide prompt-injection sweep (reuse `context-guard` patterns; no LLM).
- **D** `t_de2ccadd` (p4) — Redactor fail-closed past the 256 KB scan ceiling + infra-topology detectors.
- **E** `t_301db77e` (p4) — Read-only graph health gate before labeling/import.
- **F** `t_4678a91a` (p4) — Signed source-diversity grounding score for contested truth-ledger slots.
- **G** `t_44f91e9b` (p3) — Hardcoded absolute-path hygiene check (report-only).
- **H** `t_5c364387` (p3) — Safe fallback names for punctuation-only generated notes.
- **I** `t_0c7bed77` (p3) — Memory cost meter: write-volume accounting alongside read telemetry.

## Out of scope

- **`t_9935bd26`** (the umbrella card for this cluster) — purely meta; its leaf children are the work.
- **Hermes-core conformance tasks** `t_2c8448bb`, `t_3190e771` (upstream children) — a different axis (Hermes-core alignment), not the integrity/safety/portability axis; left out of this triage.
- **Raising OSB's 256 KB redactor window** as a value — the *fail-closed* marker is in scope; the window size itself stays a tunable, decided separately.
- **Migrating existing on-disk graph/index artifacts** to relative keys — portability converges on the next extraction/index pass; no one-shot migration (matches the NFC-identity precedent from the Vault Integrity suite).
- **Persisting any derived view into note frontmatter** — the read-time-derive precedent holds (F, E, I compute at read time; nothing new on disk for them).
- **Any new runtime dependency.** Only `proper-lockfile` (already a dependency) is reused.
- **Auto-deleting** any corpus-scan / hygiene / graph-health finding — findings are surfaced for operator decision (quarantine / fix / ignore), never silently deleted.

## Chosen approach

**Variant 3 — Risk-ordered incremental, minimal abstraction (refactor-on-second-use).** Ignore thematic grouping; sequence all nine strictly by blast radius. Byte-identical-when-off, report-only / projection-only leaves land first; the concurrency-invariant change (A, the single-writer lane) lands **last**, after the safety net (E's non-aborting health gate, I's write meter, C/D's scanners) is already in place. Shared primitives are extracted **opportunistically, on the second real consumer** — the ordering itself engineers those second-use points:

- **I's write meter attaches at A's write-boundary chokepoint**, because A lands after I is anticipated; A's `proper-lockfile` lane becomes the already-known seam where write-volume accounting plugs in.
- **D shares C's linear-bounded detector contract**, because D follows C; both need a regex family that stays linear on large inputs, so the contract is named once when the second consumer (D) appears.
- **E's graph-health findings and C's injection findings share the existing `DoctorIssue`/hygiene-scan finding shape** rather than a new unified reporter — E follows C and reuses the shape, not a new abstraction.

The derive-vs-persist tension is resolved by one rule, inherited from the prior suite: **read-time-derive everywhere** (F's signed score is a projection over the append-only claim ledger; E's gate is a read-only post-construction pass; I's meter folds write events already flowing through known boundaries against existing read telemetry) — **no new persisted derived state**, and **no history mutation** (F computes alongside the existing fold, never mutates the append-only ledger).

## Design decisions

- **Ordering is the architecture.** The release ships in risk order — G, H, I, E → B, F → C, D → A (see `plan.md`). The tree stays shippable and every step is independently revertible. This is the lowest-risk path against the byte-identical-when-off and no-silent-fallback hard gates.
- **No speculative shared module.** Unlike the prior Vault Integrity suite (which had one provably-shared identity primitive, NFC path+hash), this suite's tasks share only *contract shapes* (linear-regex detector; lockfile lease; findings record), which are extracted on second use, not pre-built. There is no "brain-integrity kernel".
- **A (single-writer lane) reuses the existing `proper-lockfile` writer-lock pattern** from `src/core/search/store.ts:228` (`lockfile.lockSync`, `realpath:false`, stale-ms guard) and the maintenance lease shape from `src/core/brain/maintenance/lease.ts`. The lane is an **explicit, cooperative, process-exit-safe discipline**: acquire-on-write, release-on-completion, stale-guarded. It is **not** a daemon and **not** mandatory for read paths. It serializes write operations on the same artifact to give deterministic ordering and clearer failure/retry. (Whether it is opt-in per call-site or enforced at the write-session chokepoint is a per-task TDD decision recorded in `plan.md` Task A, but the chokepoint at `src/core/brain/write-session/engine.ts:347` is the natural home.)
- **B (portable keys) is confirmed-scoped, not blind.** The search store already stores document paths as **vault-relative POSIX** (`store.ts:46,537,553,566,579`), so the search index is *not* the leaker. The task's first step is to confirm the actual on-disk key format of the **codegraph** artifacts (`manifest.json` keys, `graph.json` `source_file`, generation reports) and any embedding-index keys; if a reader already stores relative paths, scope down to only the absolute-leaking readers. This is the "no misleading fallback / report honestly" discipline — do not relativize what is already relative.
- **C (injection sweep) reuses `context-guard.ts` `TEXT_PATTERNS` verbatim** — no new pattern list. It is wired as a corpus scan in the **existing maintenance lane** (`runMaintenance`, leased, quiet-window, sequential) and/or as a hygiene detector in the existing `src/core/brain/hygiene/scan.ts` registry, so it runs in the quiet window with the lease. Findings flow to the operator (quarantine/auto-fix via the existing hygiene `apply` plan), **never silent deletion**. Deterministic regex, no LLM.
- **D (redactor) is two independent, separately-shippable fixes.** (1) Fail-closed: oversized input past `MAX_REDACTOR_INPUT` gets a `scan_truncated` marker that **demotes/excludes** the artifact instead of the current silent drop treating the unscanned tail as clean. (2) Infra-topology detector family (`public_ipv4`, `public_ipv6`, `basic_auth_url`, `fqdn_port`, `ipv4_port`, `internal_host`). Both detector families (the existing SECRET_KEYS key=value/Bearer family and the new topology family) must stay **linear** (bounded regexes, no catastrophic backtracking) to avoid ReDoS on large inputs — port upstream's linearity property. The fail-closed marker benefits the 256 KB receipts path; the topology detectors benefit the MCP artifact-store path (which already scans the full payload via `maxInput: Infinity`) most.
- **E (graph health gate) is read-only and non-aborting.** A post-construction pass over the codegraph/index that surfaces dangling references, self-loops, collapsed-edge warnings, and cache-root mismatches as **warnings in the existing `doctor`/`vault_health` surfaces** (`DoctorIssue` with a stable `code`), before labels/import/recall trust the graph. It never aborts the run and never mutates state.
- **F (signed grounding score) is a pure projection.** `groundingScore(slot): { signed: number; sufficiency: number; band: string }` computed from `ClaimVersion` provenance (independent `source` + `agent`) already in the ledger, weighting N mentions across N independent sources far above N mentions in one source. Computed **alongside** `computeTruthState` (in `truth/fold.ts`) and `computeTruthStateWithConflicts` (in `truth/conflicts.ts`) — **never mutates** the append-only ledger. The binary CONTESTED flag remains (backward compatible); the signed score is an *additional* dimension. Deterministic counting + weighting, no LLM. Confidence stays unsigned bands in `page-meta/confidence.ts`; the signed score is a separate, signed dimension, not a replacement of the unsigned confidence.
- **G (hardcoded-path hygiene) is report-only, with an allowlist escape hatch.** A deterministic check (regex for absolute/home paths) registered in `o2b brain doctor` and/or CI, scanning OSB **source, docs, generated examples, and plugin config templates**. Annotated fixtures (a marker comment or a documented allowlist) suppress intentional-example false positives. Never auto-edits files.
- **H (safe fallback names) strengthens the slug boundary, never weakens traversal protection.** `slugify` (in `src/core/vault.ts:204`, consumed by `deriveSlug` at `src/mcp/brain/feedback-tools.ts:54`) **already** falls back to a constant `"note"` when the input is punctuation-only/empty; the task strengthens that collision-prone constant into a hash-distinct name (`unnamed-<short-hash>`) so many bad inputs no longer collide on `note`. `ensureInsideVault` is untouched and remains the traversal gate.
- **I (write cost meter) reuses the recall-telemetry shape with a write dimension.** A `writeTelemetry` sibling to `emitRecallTelemetry` that records write events (preference/note/fact saves) already flowing through `brain_feedback` / `apply_evidence` / `create_note`, and a `summarizeWriteTelemetry` that folds write counts against `summarizeRecallTelemetry` reads into a write-vs-read ratio per period. Deterministic counting. The meter attaches at A's write-boundary chokepoint once A lands (A is sequenced after I in `plan.md`; I anticipates the seam, A provides it).
- **Every task opt-in or byte-identical-when-off.** No existing caller changes behaviour unless it opts in; the projection tasks (E, F, I) are additive outputs (new fields/findings), not behaviour changes.

## File changes (indicative — finalized per task in `plan.md`)

New:
- `src/core/brain/write-lane.ts` (or `write-session/lane.ts`) — single-writer/lease-backed write discipline (Task A).
- Corpus-injection scan: a new maintenance task and/or hygiene detector registering `context-guard` `TEXT_PATTERNS` (Task C); tests.
- Infra-topology detector family + `scan_truncated` fail-closed marker in/near `src/core/redactor.ts` (Task D); tests.
- `src/core/partner/graph-health.ts` (or sibling) — read-only graph-health gate (Task E); tests.
- `groundingScore` projection in `src/core/brain/truth/` (Task F); tests.
- Hardcoded-path hygiene check in `src/core/brain/doctor.ts` or a new CI lint (Task G); tests.
- `slugify` punctuation-only/empty fallback in `src/core/vault.ts` (Task H); tests.
- `write-telemetry.ts` sibling to `recall-telemetry.ts` (Task I); tests.

Modified:
- `src/core/redactor.ts` — fail-closed marker + topology detectors (Task D).
- `src/core/brain/truth/fold.ts`, `truth/conflicts.ts` — surface the signed grounding score alongside CONTESTED (Task F).
- `src/core/brain/doctor.ts` and/or `src/core/brain/hygiene/*` — register the injection sweep + hardcoded-path check (Tasks C, G).
- `src/core/brain/maintenance/lane.ts` — register the corpus injection-sweep task (Task C).
- `src/core/partner/codegraph-report.ts` (+ codegraph artifact readers) — relativize any absolute-leaking keys (Task B, after on-disk-format confirmation).
- `src/core/vault.ts` (`slugify`) — safe fallback name (Task H).
- `src/core/brain/write-session/engine.ts` — attach the single-writer lane at the commit chokepoint (Task A); attach write-telemetry at the same seam (Task I).
- `src/mcp/brain/health-tools.ts` / `src/mcp/tools.ts` — surface graph-health + meter findings (Tasks E, I, as applicable).
- `README.md`, `CHANGELOG.md` (`## [1.21.0]`), `package.json` (+ `scripts/sync-version.ts`).

## Risks and open questions

- **A (single-writer lane) is the one concurrency-invariant change.** Sequencing it **last** (after E/I/C/D) means the health gate, meter, and scanners exist before the write path is touched — the safety net precedes the risk. Open question for Task A: enforce the lane at the write-session commit chokepoint (broadest coverage, highest blast radius) vs. an opt-in per-call `acquireWriteLane()` (narrower, lower risk). Resolved in Task A's TDD: prefer the chokepoint for deterministic coverage, but only if every existing write path already funnels through it (verify via grep before locking the design); otherwise start opt-in and expand.
- **B (portable keys) hinges on confirming the codegraph on-disk format.** If the codegraph artifacts already store relative keys, the task shrinks to a no-op-with-test (pin the invariant) — do **not** invent work. The search index is already relative; do not touch it.
- **D ReDoS.** The new topology detector regexes must be provably linear on large inputs. The acceptance test includes a pathological-large-input case asserting bounded time; port upstream's bounded pattern property.
- **C corpus-sweep performance.** Scanning every stored memory on a schedule must stay bounded; the maintenance lane's quiet-window + lease + sequential discipline is the host, and the scan reuses the already-linear `context-guard` patterns. A large-vault acceptance test asserts bounded time.
- **F source-diversity definition.** "Independent source" must be crisply defined (distinct `source` values, optionally weighted by `agent`) so the score is deterministic; the acceptance test pins the N-docs-vs-N-sources weighting explicitly. The score must not change any existing recall ranking unless opted in (it is an *additional* surfaced dimension, not a ranking input by default).
- **H false friends.** The hash-strengthened fallback must not change the slug of any currently-valid input (byte-identical for all non-punctuation-only inputs); only the existing `"note"` fallback value is replaced by a hash-distinct name for the punctuation-only/empty branch.
