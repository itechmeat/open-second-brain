# Signals that survive - variant audit trail

Nine atomic units, one consultant pass each. The primary consultant (Claude Code,
`claude -p`) returned three variants and one recommendation per unit; all nine runs
exited zero, so the Codex fallback was not invoked.

Every consultant claim about the codebase was re-checked against the source before
any decision was taken. One anchor was wrong: the consultant placed
`temporalProximity` in `src/core/brain/temporal-bridge.ts`; it lives in
`src/core/search/temporal-bridge.ts`. Everything else held, including the claim that
`src/core/brain/gaps/gap-loop.ts` is fully implemented and unreferenced - verified by
grep, whose only hit outside the module itself is a comment in `src/core/config.ts`.

## Orchestrator decisions

| Unit | Kanban | Consultant recommendation | Decision |
| --- | --- | --- | --- |
| Git-aware ingest discovery | `t_4b2bd8f7` | Variant 2 - extract a shared module | adopted |
| Doctor path duplication | `t_ceee3b4d` | Variant 2 - typed parse error | adopted |
| Route discriminator | `t_07ad3c42` | Variant 1 - in-router ladder | adopted |
| Unroutable-capture hint | `t_75597bb9` | Variant 1 - extend the write advisory | adopted |
| Query temporal intent | `t_58fc4720` | Variant 3 - capped additive layer | adopted |
| Recurring weak recall | `t_3f96f87a` | Variant 2 - feed the gap loop | adopted, overriding the task brief |
| Fact and skill markers | `t_9ba5c027` | Variant 1 - two kinds, existing entry points | adopted |
| Response shape | `t_80b01448` | Variant 1 - promote the subset validator | adopted with one modification |
| Durable work identity | `t_e6be4f6b` | Variant 1 - declared identity rung | adopted |

### Modification to the response-shape recommendation

The consultant's Variant 1 proposed a configuration key defaulting to today's
tolerance, so strict validation would ship dormant until an operator opted in. That
is rejected. A validator that is off by default validates nothing, and this project
forbids a path that appears to protect something and does not. Validation is
unconditional and fail-closed.

The byte-identical-when-absent convention is not violated by this: it governs the
behaviour of new flags and configuration keys, and this unit introduces neither. It
does change behaviour for a malformed payload - which is the entire point of the
task, whose stated value is turning silent parse degradation into a catchable failure.

### Override of the task brief on the recall-adequacy unit

`t_3f96f87a`'s validated body instructs minting an **obligation**. The implementation
mints a **gap task**. The constraint that instruction was protecting - stay internal,
never write to an external tracker - holds completely: `Brain/gap-tasks/` is a plain
vault directory, and `gap-loop.ts` states in its own header that it never touches the
kanban board.

The reason for the substitution is auto-close. An obligation is cadence-bearing and
has no mechanism to resolve itself; a gap task closes when its topic later recalls
with sufficient confidence. The brief itself names caps and bounding as load-bearing
rather than polish, and a self-closing item is a stronger bound than any mint
threshold. Reusing the existing promotion, agenda and auto-close pipeline also avoids
building a second copy of it against `obligations.ts`.

## Consultant output, verbatim

### Unit: doctor-path-duplication

### Variant 1: Strip the path at the throw sites
- **Approach**: Delete the ` (${path})` tail from the ~15 `throw new Error(...)` sites in `src/core/brain/preference.ts` (`requireField`, `requireString`, `requireStringArray`, the `kind`/`retired_reason` enum checks, and the confidence/schema helpers), leaving the message as pure prose about the field. The doctor's existing `path` field then becomes the single source of the location, and the renderer's tail is untouched. Callers that today rely on the message carrying the path (`dream`, `query`, `export`, `merge`, `apply-evidence`, `pin`, `preference-txn`) must each be audited and given the path from the call site they already know.
- **Trade-offs**:
  - Pro: smallest conceptual change; matches the stated fix direction literally — the message stops embedding the path.
  - Pro: no new type, no new indirection; DRY holds because the path was always duplicated for the doctor.
  - Con: the path is *only* recoverable from the message today for every non-doctor caller that surfaces `(exc as Error).message` bare — stripping it there loses operator context unless each of ~10 caller modules is fixed in the same change, which is exactly the "silently does nothing" failure mode the constraints forbid.
  - Con: blast radius is wide for a cosmetic priority-3 item; every test asserting the current message text (parse-error fixtures, doctor fixtures, dream/query error paths) has to move together.
  - Con: nothing structurally prevents the next `throw` from re-adding `(${path})`.
- **Complexity**: medium
- **Risk**: medium

### Variant 2: Typed parse error carrying `path` as a field
- **Approach**: Introduce a `BrainParseError` (path + bare message) modelled directly on the `BrainStatusFolderMismatchError` that `classifyParseError` already special-cases in `src/core/brain/doctor.ts` — that class carries `path` structurally and its `message` contains no path, so the doctor already emits it correctly. The preference/retired parsers throw `BrainParseError` instead of bare `Error`; the doctor reads `err.path`/`err.message` as fields, and non-structured callers format location through one shared helper rather than string concatenation at 15 sites.
- **Trade-offs**:
  - Pro: the path is never lost — it moves from prose into a field that every caller can read, which is the same move v1.40.0 made for findings.
  - Pro: follows an in-repo precedent living in the exact function being fixed, so the two parse-error branches of `classifyParseError` stop being asymmetric.
  - Pro: makes regression structural — a future throw site cannot embed the path without going around the typed error.
  - Pro: the `parseErrorCode` regex classification (`/missing field/`, `/ISO-8601/i`) keeps working on the bare message and becomes less coupled to incidental path text.
  - Con: largest of the three; a new exported error type plus migration of every throw site and its `instanceof`-blind catch sites.
  - Con: overshoots the reported defect — most of the work buys structure, not the missing byte.
  - Con: callers doing `catch (exc) { fail(exc.message) }` need a decision per site about whether to append the path, so the change is not mechanical.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Normalize at the doctor boundary
- **Approach**: Leave `preference.ts` untouched and fix it where the two representations meet: `classifyParseError` in `src/core/brain/doctor.ts` builds the issue from a message with its own trailing ` (<path>)` suffix removed, keyed off the `path` it is already passing into the issue. The renderer at `doctor.ts:49` and every non-doctor caller of the parsers keep byte-identical behaviour.
- **Trade-offs**:
  - Pro: one function, one change, no cross-module audit; all four parse-error kinds (`preference-missing-field`, `preference-invalid`, `retired-missing-field`, `retired-invalid`, plus `iso-invalid` routed through the same push) are fixed at once because they share this single construction point.
  - Pro: zero risk to any other surface — dream, query, export, MCP errors are unaffected.
  - Con: it is prose parsing to undo prose formatting — the doctor now depends on the parser's exact suffix spelling, which is a second, quieter coupling replacing the first.
  - Con: fixes the symptom in one consumer; the same duplication reappears anywhere else that pairs these errors with a structured path field.
  - Con: sits awkwardly against the "findings carry data as fields, not prose" convention — the message still carries the data, it is just trimmed on the way out.
- **Complexity**: small
- **Risk**: low

### Recommended: Variant 2
**Rationale**: The path only lives in prose today, so Variant 1 deletes operator context from every non-doctor caller unless the same change fixes all of them, and Variant 3 trades one prose coupling for another that the next consumer will hit again. Variant 2 does what the fix direction asks — the message stops embedding the path — while keeping the data as a field, and it does so by extending a pattern (`BrainStatusFolderMismatchError`) that already exists in the very function being changed, so the two branches of `classifyParseError` end up consistent instead of one being the exception. If the cosmetic priority argues against the full migration, the typed error can land scoped to `parsePreference`/`parseRetired` only, with the remaining throw sites converted as they are touched.

### Unit: durable-work-identity

### Variant 1: Declared work identity as a precedence rung above the crutch

- **Approach**: Add an optional durable pair — `workId` and `laneId` — sourced at the capture boundary in strict precedence (host payload field, then an environment/config key, then a per-worktree marker recorded in `Brain/.state/`), and persist both as new optional `wid`/`lane` fields on `LedgerLine`. `resolveSessionLineageDetailed` gains a rung between `payload` and `crutch`: when this session and exactly one predecessor share a `wid`, the link is made on identity alone with no freshness bound and no `cwd`/branch/commit predicate, so a resumed work item re-attaches after a model, account, branch or worktree switch. Lanes are a hard separator rather than a tiebreaker — two entries sharing a `wid` but carrying different `laneId` values can never link, and two same-lane survivors abstain through the existing ambiguity path with new named reasons (`lane-conflict`, `work-ambiguous`).
- **Trade-offs**:
  - Exact/external identity always wins, and nothing is inferred; the kernel stays deterministic and no natural-language signal is consulted.
  - Absent `wid`/`lane` the resolver is the current one line-for-line, so the byte-identical-when-absent rule holds without a compatibility shim.
  - The ledger already hashes line bodies by removal of chain fields and compacts verbatim, so new optional fields ride the existing integrity chain untouched.
  - `CRUTCH_LINK_WINDOW_MS` survives as the fallback bound rather than being deleted; the crutch is demoted, not removed, which leaves two resolution rules to reason about.
  - Value depends on something actually declaring the id — an unwired host gets no benefit, so the feature is only as good as its capture-boundary adapters.
  - A stale or copied marker file in a cloned worktree would assert a false identity; the lane separator contains it but does not detect it.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Derived work fingerprint with an attestation-union registry

- **Approach**: Derive the work identity structurally instead of declaring it — a content-addressed fingerprint over canonical remote, upstream/merge-base ref, and worktree gitdir identity — and maintain a union registry in `Brain/.state/` that binds fingerprints observed together by one session into a single work identity, so a branch or worktree switch inside one session teaches the registry that both fingerprints name the same work. The lane is derived from the gitdir identity, keeping parallel worktrees separate by construction. Resolution keys on registry membership, and a union that would join two already-distinct works abstains rather than merging.
- **Trade-offs**:
  - Requires no host cooperation and no operator action; every existing session gains identity immediately.
  - Lane separation falls out of the same derivation as identity, so there is no second thing to wire or forget.
  - The property that must survive — branch and worktree change — is precisely what the fingerprint encodes, so identity only survives through a learned union, and the very first switch cannot be recognized until after the fact.
  - Unions are cumulative and effectively irreversible; one bad attestation permanently welds two work items, which inverts the fail-closed contract that v1.39.0 established.
  - Merge-base and upstream probes are unbounded git work at a fail-soft lifecycle boundary, and their absence in a detached or non-git tree silently collapses the fingerprint space.
  - The registry is mutable shared state inside a Syncthing-replicated tree, where two peers can produce conflicting unions with no arbiter.
- **Complexity**: large
- **Risk**: high

### Variant 3: Lane lease ledger replacing the freshness window outright

- **Approach**: Make the execution lane the primary durable object: each session opens a lease on a work id at `SessionStart` and releases or hands it off at the compression boundary, recorded as explicit open/handoff/close lines in the existing append-only ledger. Continuation becomes lease re-acquisition — a new session links only to a predecessor whose lease is in handed-off state and unclaimed — so `CRUTCH_LINK_WINDOW_MS` is deleted rather than demoted, and concurrency is refused because a live lease is already held rather than because two candidates tied.
- **Trade-offs**:
  - The timing crutch disappears entirely; freshness stops being a proxy for anything.
  - Concurrent lanes are structurally impossible to collapse, not merely detected and abstained on.
  - The lease lifecycle is observable and auditable in the same chained ledger, and a handoff is an explicit fact rather than an inference.
  - A crashed or SIGKILLed session leaks an open lease forever; reclaiming it needs a staleness age, which reintroduces a time window at exactly the point the variant claims to remove one.
  - Lease semantics assume a single authority over the state file, which a Syncthing-replicated vault does not provide; two peers can each believe they hold the same lease.
  - Deleting the window is an incompatible change to a resolution path that currently degrades to `flat` gracefully, and every hook must now emit a close event or continuity quietly stops working.
- **Complexity**: large
- **Risk**: medium

### Recommended: Variant 1

**Rationale**: The upstream contract's substantive claim is that exact and external identifiers always win while inference stays advisory, and Variant 1 is the only one that implements that literally — identity is declared, never derived, so the kernel adds no new inference and the ambiguity layer shipped in v1.39.0 is reused rather than re-litigated. It fits the scoping note by extending the lineage/crutch layer with two optional ledger fields and one precedence rung instead of standing up a registry subsystem, and it keeps behaviour byte-identical when the fields are absent. Variants 2 and 3 both place mutable, authority-assuming state inside a peer-replicated vault and both reintroduce the failure they set out to remove — an irreversible silent union in one case, a time-based lease reclamation in the other.

### Unit: git-aware-ingest-discovery

### Variant 1: Inline mirror inside `batch-plan.ts`

- **Approach**: Copy the hygiene scan's layering shape directly into the ingest planner: a private `buildGitScope(dirAbs)` that reads `.git/info/exclude` then the root `.gitignore`, and a per-directory `.gitignore` extension inside `collectIngestible`, stacked *under* the operator `--exclude` layer so `--exclude` always wins. Submodules are skipped by testing each candidate directory for a `.git` entry (gitlink file or directory) before recursing. Nothing outside `src/core/brain/ingest/` changes.
- **Trade-offs**:
  - Smallest blast radius: hygiene's `listScanTargets` and its golden tests are untouched, so the 910-test suite risk is confined to ingest.
  - Byte-identical no-git path falls out naturally — with no ignore files present every added layer is empty and `IgnoreScope.isEmpty` holds, so `planId` does not shift.
  - Resolves the vault-relative/root-relative base-dir mismatch locally: layers are based at `dirRel` (or the nested dir's vault-relative path), which is exactly what `IgnoreLayer.baseDir` already models.
  - Direct DRY violation against an explicit repo constraint: two near-identical `extendWithIgnoreFile` + walk implementations that must be kept in step forever, and the submodule rule then exists in only one of them.
  - Malformed-pattern warnings need a second, ingest-shaped disposition (`buildExcludeScope` throws for `--exclude`; a repo's own broken `.gitignore` line must not fail an ingest plan), so the warning policy gets invented twice.
  - Repo-root discovery is ad hoc: if `sourceDir` points at a subtree of a checked-out repo, an inline implementation either ignores the ancestor `.gitignore` files or grows its own upward walk.
- **Complexity**: small
- **Risk**: low

### Variant 2: Extract a shared git-aware discovery module under `src/core/fs/`

- **Approach**: Promote the layering logic out of `scan-repo.ts` into a sibling of `ignore.ts` — a module owning "given a repo root, produce the base `IgnoreScope`" and "given a directory, extend a scope with its `.gitignore`", plus a submodule/non-working-tree predicate, with malformed-pattern warnings returned as structured `IgnoreWarning[]` rather than printed. `scan-repo.ts` keeps its `hygiene:` stderr sink by consuming those warnings itself; `collectIngestible` consumes the same module and chooses its own disposition (structured field on the plan, or advisory-rail code). Submodule skipping lands once and both discovery paths inherit it.
- **Trade-offs**:
  - Satisfies the DRY/SOLID constraint the repo states outright, and puts the git-metadata reader next to the matcher engine it composes with, where the next consumer will look for it.
  - Submodule handling — the one net-new piece — is written, tested, and reviewed once instead of diverging between hygiene and ingest.
  - Warnings become data rather than a side effect, which fits "findings carry their data as structured fields" and lets the plan surface a broken repo `.gitignore` without printing from the kernel.
  - Touches a currently-green subsystem: hygiene's scan is behaviour-pinned by tests, so the refactor must be provably inert there before the ingest wiring is even visible.
  - Larger review surface for a change whose user-visible payoff is entirely in ingest; the hygiene diff is pure motion.
  - Forces an early decision on the base-dir contract (repo-root-relative vs. vault-relative) that both callers must agree on, rather than deferring it.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Delegate discovery to `git` itself

- **Approach**: When `isGitRepo(dirAbs)` holds, obtain the candidate file set from `git ls-files --cached --others --exclude-standard` through the existing `runGit` helper in `src/core/brain/git/reader.ts`, then filter by extension and apply the operator `--exclude` scope on top; otherwise walk as today. Git's own answer covers nested `.gitignore`, `.git/info/exclude`, `core.excludesFile`, and submodule boundaries with no reimplementation.
- **Trade-offs**:
  - Exact parity with git semantics, including the corners `ignore.ts` explicitly disclaims (it documents a subset, not `git check-ignore` parity) — no drift between what the operator sees in `git status` and what ingest picks up.
  - Submodules, sparse checkouts, and assume-unchanged entries come free; no new matcher code at all.
  - Makes a core deterministic planner depend on an external `git` binary and on user-global config (`core.excludesFile`, `~/.config/git/ignore`), so the same vault on two machines can produce different `planId`s — directly against the deterministic-kernel and no-hidden-runtime-dependency constraints.
  - A missing or failing `git` cannot silently fall back to the dot-entry walk (that is the forbidden silent-no-op), so it must surface as an explicit error, which makes ingest newly fragile on machines without git.
  - Sits awkwardly against the repo's stance that the replicated vault carries no git; a source dir under the vault that is a real checkout is an edge the current code does not otherwise assume.
  - Process-spawn cost per plan, and output parsing/quoting (`core.quotePath`) becomes a new correctness surface.
- **Complexity**: medium
- **Risk**: high

### Recommended: Variant 2

**Rationale**: The task's own framing is that both halves already exist and the work is composition — which makes duplicating the hygiene walk (Variant 1) a self-inflicted maintenance seam right where the repo's DRY constraint is loudest, especially since submodule handling is net-new and would otherwise be implemented in only one of two twins. Variant 3 buys exact git parity at the price of an external binary and user-global config inside a planner whose `planId` must be reproducible, which the deterministic-kernel constraint rules out. Variant 2 keeps discovery pure, in-process, and byte-identical when a source carries no ignore files, and the hygiene refactor it requires is inert motion pinned by existing tests rather than new behaviour.

### Unit: llm-response-shape

### Variant 1: Ingress shape gate — one shared validator, static shape table

- **Approach**: Promote the existing JSON-Schema-subset validator in `src/mcp/output-contract.ts` (`OutputSchema` / `validateOutputContract`) into a core module — named for *response shape*, not "schema", to stay clear of `schema-contracts.ts` / `schema-pack.ts` / `schema-admin.ts` — and declare one frozen shape descriptor per model-authored write path (distill claims, derived facts, dream/synthesis payloads). Each consumer site validates the agent-supplied payload against its descriptor before any normalization, replacing scattered ad-hoc coercion with a single fail-closed check that emits structured `{code, path, message}` findings. The descriptors stay deliberately shallow — required keys, primitive types, array-of-object items — so extraction recall is not squeezed by over-constraint.
- **Trade-offs**:
  - Reuses a validator that already exists and is already tested; no new dependency, no zod.
  - Removes loose parsing from three write paths in one pass, with findings carried as structured fields rather than prose.
  - Enforcement is at the boundary only — the model still generates free-form and a mismatch costs a full round trip that Open Second Brain cannot itself initiate.
  - Tightening validation can reject payloads today's callers get away with, so it needs a config key defaulting to the current tolerance to keep behaviour byte-identical when absent — which means the strict path ships dormant until an operator opts in.
  - The subset validator is intentionally small; a shape needing conditionals or unions has nowhere to go without growing it.
- **Complexity**: small
- **Risk**: low

### Variant 2: Generalize the write-session contract loop to every model-authored payload

- **Approach**: `src/core/brain/write-session/` already implements the full pattern the upstream PR is reaching for — a session holding a declared target and `schemaType`, fail-closed validation, machine-readable errors, and a correction prompt derived from the error list so the agent resubmits the whole artifact. Extract that open → submit → validate → correct → commit engine into a payload-shape-agnostic primitive and route distillation, fact derivation, and dream synthesis through it, each registering its own shape descriptor and reserved-target policy. A bad response then becomes a *retryable session state* with an operator-visible attempt record, not a silent parse degradation.
- **Trade-offs**:
  - Highest fidelity to the goal: a malformed response is caught, named, and given an explicit exit, which matches the no-dead-ends and no-silent-fallback conventions directly.
  - Reuses an engine already proven on the riskiest write path rather than inventing a parallel mechanism — strong DRY win, and one correction-prompt derivation instead of three.
  - Turns three currently stateless single-shot calls into stateful multi-step ones: session records, TTLs, abandonment, idempotency, and the audit trail all multiply.
  - Changes the shape of existing CLI and MCP surfaces for `brain_distill_source` / `brain_derive_fact` / `brain_dream`; keeping them compatible means running both the direct and session forms, which is duplicated surface, not less.
  - Largest test surface: the session engine's failure matrix has to be re-verified per new consumer.
- **Complexity**: large
- **Risk**: medium

### Variant 3: Two-sided contract — publish shape descriptors outward, verify on return

- **Approach**: Keep the kernel model-free and instead make each write path's expected response shape a *first-class published artifact*: exposed in MCP tool metadata and capabilities, printable from the command line, and stable enough for the calling harness (Claude, Hermes routing) to feed straight into its own native structured-output mechanism. Open Second Brain then runs a thin ingress verification of the same descriptor on the returned payload, so constrained generation happens where the model actually lives and validation happens where the vault write happens.
- **Trade-offs**:
  - The only variant that gets genuine *constrained generation* rather than post-hoc rejection, without the kernel ever issuing a model call.
  - Descriptors become versioned public contract, which is exactly what makes the auto-memory extraction follow-on (`t_1dace26d`) cheap to add — it registers a descriptor instead of a parser.
  - Effectiveness is contingent on caller cooperation; a harness that ignores the published descriptor gets no benefit beyond Variant 1's rejection, so the win is unevenly distributed across clients.
  - Publishing descriptors on MCP tool metadata expands a surface that is already covered by `registry-guard.ts` and the preview-budget rules — schema growth there has token cost on every session.
  - Two enforcement points can drift; the descriptor must have exactly one definition with both the published form and the validator derived from it.
- **Complexity**: medium
- **Risk**: medium

### Recommended: Variant 1

**Rationale**: The kernel issues no model calls, so the real defect here is loose parsing at the ingress of agent-supplied payloads, and Variant 1 fixes exactly that with a validator the repository already owns — no new dependency, no zod, no surface change, and a config key that keeps behaviour byte-identical when absent. Variant 2's session loop is the correct end state but pays large structural cost up front for three call sites that are single-shot today, and Variant 3's outward publication is only worth the versioned-contract burden once the descriptors have proven stable in practice. Variant 1 is also the strict prerequisite that makes the other two cheap later: it establishes the single shape-descriptor definition and the distinct naming (response *shape*, never *schema*) that both would build on.

### Unit: marker-kinds-fact-skill

### Variant 1: Two kinds on the existing grammar, existing entry points only

- **Approach**: Extend `MarkerKind` with `fact` and `skill`, add their rows to `KNOWN_KINDS` and `REQUIRED_FIELDS` (`fact`: topic + principle + premises; `skill`: name + trigger + procedure), and add two narrowing type guards beside `isFeedbackMarker`. Routing reuses stores that already carry a review gate: a `fact` marker lands as an unconfirmed preference via the `derive-fact` path (premise validation stays fail-closed, so an unresolvable premise is an explicit error, not a silent drop), a `skill` marker lands in the **pending** skill-proposal store with a marker-sourced pattern kind, never in accepted. Answer to the open question is "no": `o2b brain scan-inline --path <dir>` already lets an operator point the scan at a chosen subtree, and the source bundle stays inside the vault.
- **Trade-offs**:
  - Pro: no second grammar, no new entry point, no new trust boundary — the fence-awareness, sentinel idempotence, dedup-hash and rewrite machinery apply to the new kinds for free.
  - Pro: absent markers, behaviour is byte-identical; the two kinds are purely additive to a table.
  - Pro: reviewability comes from the destination stores (unconfirmed preference, pending proposal), not from new gating code.
  - Pro: `skill` proposals seeded by marker need a `SkillProposalPatternKind` value; adding a marker-provenance kind touches the verifier's assumptions about pattern evidence.
  - Con: does not satisfy the article's literal "arbitrary source bundle" — plain text living outside the vault must first be copied in.
  - Con: `fact` and `skill` payloads are richer than `topic=…`-style scalars; multi-line procedures effectively force the block shape, so the inline shape is second-class for `skill`.
- **Complexity**: small
- **Risk**: low

### Variant 2: Two kinds plus a read-only external source-bundle verb

- **Approach**: Variant 1, plus a new deterministic verb (`o2b brain scan-source <file>`) that runs `discoverMarkersDetailed` over an operator-supplied path outside the vault and reports every marker with its parse verdict. Default is report-only: no signal write, no source rewrite, because the file is outside the replicated tree and `ensureInsideVault` cannot cover it; an explicit `--import` flag copies the discovered markers into `Brain/inbox/` while leaving the external file untouched (idempotence then rests on the dedup hash alone, not on the consumed sentinel).
- **Trade-offs**:
  - Pro: matches the article's workflow exactly — a bundle authored by another tool is exercised end to end with zero model calls.
  - Pro: strong fixture and demo surface: one file, one command, structured per-marker verdicts suitable for golden tests.
  - Pro: gives cross-tool authoring a real seam without a Model Context Protocol round trip.
  - Con: introduces the first read path outside the vault root, which is a genuine new trust boundary against the path-safety invariant, and needs its own size/symlink/encoding limits.
  - Con: without in-file rewrite, re-running `--import` over the same bundle relies entirely on dedup hashing; any hash-relevant field change silently re-imports as new.
  - Con: a new verb means a new registered diagnostic code family for its failures and a new command-line surface to keep stable.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: New kinds route into the staged dream proposal bundle

- **Approach**: Add the two kinds as in Variant 1, but do not let them write to their final stores. Marker discovery becomes an input to `dream stage`: `fact` and `skill` markers flatten into `proposals.jsonl` as new proposal types (`create_derived_fact`, `create_skill_proposal`) alongside the existing `create_preference` rows, and are only materialised when the operator applies the bundle. The staged report renders them in their own sections, and discard drops them with the rest of the bundle.
- **Trade-offs**:
  - Pro: closest to the article's actual thesis — reviewable self-improvement, with a single uniform review point rather than one per destination store.
  - Pro: one place to validate premises and skill shape, so the skill verifier is never handed a marker-seeded candidate it has no pattern evidence for.
  - Pro: the persisted bundle is already the deterministic artifact tests assert against, so fixtures get stronger with no new file format.
  - Con: widens `planToProposals` and the plan type beyond preference/signal lifecycle, which is the largest conceptual change of the three.
  - Con: markers now have two different fates depending on kind (feedback writes a signal immediately, fact/skill waits for an apply), which is a real asymmetry operators must learn.
  - Con: plan-drift detection between stage and apply must be extended to cover the new rows, or a bundle can be applied against source files that have since changed.
- **Complexity**: medium to large
- **Risk**: medium

### Recommended: Variant 1

**Rationale**: The open question resolves to "no" — `scan-inline --path` and `apply-markers --path` already give an operator marker discovery over a chosen subtree, and reading source files outside the vault would breach the path-safety invariant for a convenience the operator can get by placing the bundle in the vault, so Variant 2's cost buys little. Variant 3 solves a review problem that is already solved by the destination stores: a marker-seeded fact becomes an *unconfirmed* preference that the dream pass gates, and a marker-seeded skill lands in the *pending* proposal store that already has accept/reject, so routing them through the stage bundle duplicates gating rather than adding it. Variant 1 keeps the change to two rows in `REQUIRED_FIELDS`, two type guards and their routing, which is byte-identical when the markers are absent and is exactly the narrow delta the re-verification identified.

### Unit: query-temporal-intent

### Variant 1: Temporal intent at the query-plan seam, modulating `recencyMul` only
- **Approach**: Extend `src/core/search/query-plan.ts` with a new structural `temporal` intent, detected only from signals that survive the language-agnostic invariant — ISO tokens in the query text (reusing `extractTemporalConstraints`) and the existing `<field>:<value>` grammar (`since:`/`until:`). The plan resolves a target window and, when that window's midpoint is materially older than `now`, emits a `WeightProfile` with `recencyMul` below 1 (down to 0 for an explicitly historical query); a near-now window amplifies it. Nothing in `ranker.ts` changes — `recency * recMul` at ranker.ts:416 is already the modulation point.
- **Trade-offs**:
  - Smallest possible diff: one detector, one profile row, zero new scoring layers, zero new `ScoreBreakdown` fields, no MCP surface change.
  - `planHash` already feeds the query cache, so cache correctness comes for free.
  - Bounded by construction — the existing `[0.7, 1.4]` profile discipline means a misdetection can only re-weight, never float an unrelated document.
  - Only suppresses or amplifies; it cannot *promote* documents inside the target window, so "what did I decide back in spring?" stops being actively hurt but is not actively helped.
  - Overloads a single scalar with two distinct meanings (freshness prior strength vs. temporal-intent direction), which makes the `reasons` output harder to read: a suppressed recency layer just silently disappears.
  - `WeightProfile` is currently a per-intent constant table; a window-derived continuous `recencyMul` breaks that table's "fixed structural-feature → profile" property.
- **Complexity**: small
- **Risk**: low

### Variant 2: Anchor-shifted Weibull — recency measured from the query window, not from `now`
- **Approach**: Keep one recency layer but make its reference instant query-derived: the plan resolves a target window and `search.ts` threads an optional `recencyAnchorMs` (or the resolved window) into `RankerOptions`, so `recencyBoost` computes age as distance from the *window edge* rather than from `now`. Absent an anchor the age is `now - mtime` exactly as today, so ranking stays byte-identical; with an anchor, the same Weibull curve becomes a soft two-sided band centred on the queried period.
- **Trade-offs**:
  - Conceptually the most faithful reading of "window-shift the recency layer": one curve, one tuning surface, `recencyShape`/`recencyScale`/`recencyAmplitude` keep their meaning, and `recencyAmplitude: 0` remains the documented global off switch.
  - No new score component, no new breakdown field, no growth in the explain payload.
  - Changes the semantics of `weibullDecay`'s only input from "age" to "distance", which currently has a documented one-sided contract (`ageDays <= 0`, including future timestamps, returns full amplitude). Making it two-sided touches the most-depended-upon and most-tested primitive in the ranking stack.
  - The `recency: 0.041` reason string silently changes meaning per query, and downstream consumers (`feedback.ts`, MCP `explain`, tuning/eval gates, the semantic-health baseline watermark) compare recency across queries — a shifted anchor makes those series non-comparable without a marker field.
  - Fights the existing tie-break, which sorts by `mtime` descending: an older in-window document can win on score and then lose the tie-break to a newer out-of-window one.
- **Complexity**: medium
- **Risk**: high

### Variant 3: Detection at the plan seam + a separate capped `temporal_match` layer
- **Approach**: Same detection front half as Variant 1 (ISO tokens plus structured field tokens, resolved through `time-range.ts` into a `ResolvedTimeRange`), but the ranker consumes it as its own bounded additive layer rather than as a recency multiplier: reuse the already-pure `temporalProximity` from `temporal-bridge.ts` over a per-candidate event time (validity start, else `mtime`) to produce a capped boost, alongside a modest `recencyMul` damping when the window is historical. It follows the exact shape every other layer in `rankResults` uses — optional input map, absent map contributes zero, one `reasons` entry, one `ScoreBreakdown` field.
- **Trade-offs**:
  - Handles both halves of the problem: suppresses the wrong-direction freshness prior *and* promotes documents that actually sit in the queried window, which is the whole point of the upstream signal.
  - Reuses two already-written, already-tested pure functions (`temporalProximity`, `parseTimePoint`) and the existing event-time resolver `search.ts` already builds for the temporal bridge — very little genuinely new math.
  - Freshness prior and temporal intent stay separately observable in `reasons`/`breakdown`, so tuning, eval gates, and the `explain` projection can attribute a ranking change to the right layer.
  - Soft window match complements — rather than duplicates — the existing hard `since`/`until` filter: a query-text-derived window biases without excluding, which is the safer default for an inferred signal.
  - Widest blast radius of the three: a new `ScoreBreakdown` key (additive, but it is an MCP-visible shape), new plumbing through `search.ts`, and a new capped constant that must be calibrated against the link/entity/activation/reuse caps so the layers stay in proportion.
  - Requires an event-time map for the full candidate pool, not just link expansions — more store work per query than either alternative.
  - Two knobs move at once (new boost plus recency damping), so an A/B on retrieval quality needs both isolated.
- **Complexity**: medium
- **Risk**: medium

### Recommended: Variant 3
**Rationale**: It is the only variant that delivers the actual upstream capability — biasing *toward* the queried window — rather than merely stopping the freshness prior from hurting, and it does so in the exact idiom the ranker already uses (optional input map, capped additive boost, absent map ⇒ byte-identical ranking), so the "every new key leaves behaviour byte-identical when absent" constraint is satisfied structurally rather than by care. Variant 2 buys elegance by mutating `weibullDecay`'s contract and silently redefining the `recency` component that tuning, feedback, and eval gates already track across queries, which is a disproportionate regression surface for an enhancement-priority item. Variant 1 is the cheapest and is a legitimate fallback if scope must shrink, but it leaves the motivating "what did I decide back in spring?" case only half-served; note that under this repo's language-agnostic rule, *all three* variants must detect intent from ISO tokens and structured field tokens only — the "last week"/"recently" natural-language detection Signet performs is not portable here and should not be attempted.

### Unit: recurring-weak-recall-obligation

### Variant 1: Verdict-stamped demand log, dream-phase minting into obligations
- **Approach**: Solve question identity by reusing the bucket key `query-demand.ts` already owns — sorted significant terms (`normalizeQueryTerms`, IDF-derived, redacted, capped), never a word list — by adding an optional `adequacy` level to `QueryDemandRecord` and stamping it from the two existing verdict sites (`brain_recall_gate`, `brain_context_pack`). A new dream phase aggregates buckets whose weak/insufficient count clears a demand threshold, ranks by the existing `demandScore`, and mints at most top-N obligations via `addObligation` with a slug hashed from the bucket key and a re-check cadence, deduped through `obligationExists`. Session-start renders open obligations of that kind as the agenda, and the dream phase completes an obligation once the same bucket recalls `sufficient`.
- **Trade-offs**:
  - Pro: no new store, no new key concept — compaction, byte caps, secret-shaped-term dropping, and `[since, until]` filtering are inherited, not rebuilt.
  - Pro: minting is off the recall hot path; the dream pass is where the project already puts gated batch promotion, and caps are naturally per-run rather than per-attempt.
  - Pro: matches the brief's explicit "mint an obligation, not a board item" scoping without touching `agenda.ts`.
  - Con: couples two features — a demand record now also carries a retrieval verdict, so `query-demand.ts` stops being purely about coverage.
  - Con: obligations are cadence-bearing by construction; a one-shot "write coverage for this topic" is an awkward fit, and the re-check cadence is a semantic stretch that needs justifying.
  - Con: nothing happens until dream runs — the loop closes on a schedule the operator may not run, and a never-dreaming vault silently accumulates nothing.
  - Con: `demandScore` was tuned for coverage-driven ranking; reusing it as the mint trigger imports a threshold that was never validated for this purpose.
- **Complexity**: medium
- **Risk**: medium

### Variant 2: Second signal source into the existing gap loop, gap-task as the durable item
- **Approach**: Emit each adequacy verdict as a gated continuity record through `emitGatedTelemetry`, carrying the bucket key computed by the shared `normalizeQueryTerms` pure function so no new identity logic is invented. Generalize `gaps/gap-loop.ts` `detectRecurringGaps` to aggregate over both its current structural `gap_counts` source and the new verdict records, leaving promotion (`promoteGapsToTasks`, exclusive-create dedupe on `gapTaskKey`), the session-start agenda (`renderGapAgenda`), and auto-close (`autoCloseRecalledGaps`, with the self-close guard) exactly as built. Wire the currently dormant module into the session-start/session-end hooks behind the existing `gap_loop_enabled` / `gap_loop_threshold` keys.
- **Trade-offs**:
  - Pro: the promotion → agenda → auto-close half is already implemented and tested; this variant adds a signal source and hook wiring rather than a second copy of the same machinery.
  - Pro: auto-close is what makes the item *bounded* — a minted item that resolves itself when coverage appears is the difference between a tracked obligation and vault litter; only gap-loop has it today.
  - Pro: telemetry rides the continuity rail as convention requires (config-gated, fail-open, redaction-passing), and the agenda surface is one that was purpose-built for recall gaps.
  - Con: deviates from the brief's stated target — obligations get no use, and the vault gains recall-driven items in `Brain/gap-tasks/` instead of `Brain/obligations/`.
  - Con: scope grows beyond the feature: this variant must also wire a dormant module, so a bug there surfaces as a regression in this release.
  - Con: mixing a coarse structural code bucket (`no_matching_context`) and a fine term bucket in one aggregate makes `occurrences` mean two different things across rows in the same agenda.
  - Con: leaves the repo with two candidate durable-item kinds; if obligations later become the convention, this needs a migration.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Structural retrieval-neighborhood fingerprint, no query text at all
- **Approach**: Define question identity with zero natural-language input — hash the ordered top-artifact id set from the `recall_telemetry` `top_artifacts` payload into a "weak neighborhood" fingerprint, falling back to the registered structural gap code when the attempt returned nothing. Aggregate directly over `recall_telemetry` continuity records already on disk, so the feature works retroactively over existing history with no new store and no new emitted field, and mint one obligation per neighborhood that clears both an occurrence and an escalation threshold.
- **Trade-offs**:
  - Pro: the strictest possible reading of the language-agnostic rule — the key never touches prompt text, so it cannot be argued into a word list later.
  - Pro: no new persistence, no new write path, and no change to the two verdict call sites; retroactive over telemetry already captured.
  - Con: the fingerprint is unstable — one different artifact in top-k forks the bucket, so demand fragments across near-identical questions and the threshold rarely clears at all.
  - Con: the zero-result case is the one that matters most and has no artifacts, so it collapses onto a handful of coarse gap codes and over-aggregates unrelated questions into a single obligation.
  - Con: making it work needs quantization or set-similarity tuning — a new knob class the project deliberately avoids, and one that cannot be validated without a corpus.
  - Con: builds a third recurrence-key concept alongside the two the repo already has, with no reuse of the redaction and cap work.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 2
**Rationale**: The genuinely missing piece is only the aggregation link — `query-demand.ts` already solved deterministic, language-agnostic question identity and `gaps/gap-loop.ts` already implements promotion, the session-start agenda, and the auto-close that makes a minted item bounded rather than permanent litter, so this variant adds a signal source and hook wiring instead of a second copy of that machinery. It also gives the caps their teeth: an item that closes itself when recall recovers is a stronger guard against one bad afternoon than any mint threshold. The one deliberate deviation is the durable target — this mints a gap-task, not an obligation; that still satisfies the actual constraint the validator was protecting (stay internal, never write to an external board), but it contradicts the brief's literal instruction and should be confirmed before implementation, since Variant 1 is the ready alternative if obligations must be the artifact.

### Unit: route-discriminator

### Variant 1: In-router discriminator ladder on a candidate-score table

- **Approach**: Keep `routeExtractedFacts` as the single write router, but split its decision into two explicit pure functions: `scoreRouteCandidates(fact, ctx)` returning a frozen, deterministically-ordered `{ route, score }[]` built from the structural features already available (family-pattern match length, span coverage of the line, overlap with a URL range, entity-anchor count, durability signal set, dedup history for the hash), and `discriminate(candidates)` which fires only when `top.score - second.score <= MARGIN`. The discriminator is a fixed, ordered ladder of registered rules, each a pure structural predicate with a stable id (`overlap-containment`, `anchor-majority`, `span-coverage`, `family-table-order` as the terminal always-decides rule); the first rule that separates the tied candidates wins and its id is recorded. Every discrimination emits one `route_discrimination` continuity record through `emitGatedTelemetry` behind a new config key, carrying the candidate set, scores, margin, winning route, and the rule id — never the fact text.
- **Trade-offs**:
  - Pro: touches one call site; the existing dedup → durability → staging → write chain is unchanged, and with the gate key absent behaviour is byte-identical because the terminal rule reproduces today's family-table order.
  - Pro: fully deterministic and word-list-free — every feature is a count, an offset, or a set membership, so it behaves identically across scripts.
  - Pro: rule ids make tie-breaks auditable and tunable; `MARGIN` is one named constant, and misroute rates become measurable per rule.
  - Pro: no new public CLI/MCP surface required to ship the mechanism; the reader can follow later.
  - Con: the score table is bespoke to the extracted-facts router; a second write path (preference vs note vs pinned) would need its own copy unless it is generalised later.
  - Con: score weights are a tuning surface with no ground truth on day one — early records will mostly confirm the terminal rule fires, which looks like low value until data accumulates.
  - Con: adds a second decision point to a hot capture path, so the ladder must stay allocation-cheap.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Extracted two-stage routing kernel shared by all write surfaces

- **Approach**: Introduce `src/core/brain/routing/` holding a route-agnostic kernel — a `RouteCandidate` type, a `CandidateScorer` interface, a `Discriminator` registry keyed by stable id, and a `resolveRoute()` driver that runs primary scoring, detects near-equality, applies the registry in registration order, and emits the gated `route_discrimination` record once for every write surface. `routeExtractedFacts` becomes the first consumer by supplying a fact-specific scorer; the signal/preference/note/pinned writer entry points become subsequent consumers with their own scorers over the same kernel, so the tie-break record shape is identical regardless of which write path produced it.
- **Trade-offs**:
  - Pro: DRY across the whole write surface — the misfiled-write problem the task names is not confined to extracted facts, and this is the only variant that addresses signal-vs-obligation and note-vs-decision ambiguity in the same mechanism.
  - Pro: one telemetry schema, one config gate, one advisory-rail code family for every routed write; `dream` gets a uniform reconciliation input.
  - Pro: the registry makes the discriminator set inspectable and testable independently of any router.
  - Con: largest blast radius — it re-plumbs write paths that currently have no ambiguity problem proven against them, and the writer MCP tools are an existing public surface that must stay compatible.
  - Con: the abstraction is being designed from exactly one concrete consumer, so the scorer interface risks being shaped wrong and rewritten at the second adopter.
  - Con: significant test surface across many existing writer tests before any behaviour improves.
- **Complexity**: large
- **Risk**: medium

### Variant 3: Ambiguity as its own route — quarantine plus a registered advisory exit

- **Approach**: Compute the same candidate score table, but when the top candidates are within the margin, do not pick a winner: route the fact to an explicit ambiguous lane (reusing the existing `Brain/pending/` staging machinery already wired through `writeApprovalEnabled` and `brainDirsForWrite`), record the full candidate set on the staged item, and surface a registered advisory-rail code so the operator or `dream` resolves it. The tie-break rules exist only as ranking hints presented alongside the candidates, never as an autonomous decision, and the gated `route_discrimination` record captures both the candidate set and the eventual resolution when it lands.
- **Trade-offs**:
  - Pro: strictly honest — an ambiguous write is never silently guessed, and it fits the v1.40.0 "every diagnosis names its exit" precedent directly, since ambiguity is exactly a state that needs a named exit.
  - Pro: reuses `Brain/pending/` rather than inventing a lane; the resolution events become ground-truth training data for the score table a later variant would need.
  - Pro: zero risk of a wrong automated tie-break, since there is no automated tie-break.
  - Con: does not actually cut the misfiled-write rate — it converts misfiles into operator queue depth, moving the cost rather than removing it, and the task's stated value is reducing what `dream` must reconcile.
  - Con: a low margin threshold floods the pending lane; a high one makes the whole stage inert, and there is no data yet to pick between them.
  - Con: requires a resolution surface (CLI or MCP) to drain the lane, or the quarantine is a leak.
- **Complexity**: medium
- **Risk**: medium

### Recommended: Variant 1

**Rationale**: It delivers the actual deliverable — a deterministic, auditable tie-break with its own gated emission — against the one router the corrected hints anchor to, without re-plumbing write paths whose ambiguity is still hypothetical, and the terminal `family-table-order` rule guarantees byte-identical behaviour when the gate key is absent as the conventions require. Variant 2 designs a cross-surface abstraction from a single consumer and would very likely be rewritten at the second one; the kernel is the right eventual shape, but only after Variant 1's records show what the scorer interface actually needs. Variant 3 answers a different question (who resolves ambiguity) rather than the one asked (how routing disambiguates), and its quarantine lane is best added later as a bounded escalation when Variant 1's telemetry shows a margin band the ladder genuinely cannot separate.

### Unit: unroutable-capture-hint

### Variant 1: Extend the existing write-advisory seam with a scope-routing hint
- **Approach**: Add a sibling of `adviseIncomingFeedback` in `src/core/brain/write-advisory.ts` that runs on the same operator-facing feedback path (CLI `o2b brain feedback` and MCP `brain_feedback`), after the write has landed. When the effective scope resolves to `undefined` (no `--scope`, no `feedback.default_scope`), it returns a structured `routing_hint` naming the missing signal (`scope`) plus the eligible scope slugs observed in the vault — the distinct `scope` values on confirmed preferences and recent signals, ranked by document frequency. An empty candidate set yields `null` (the absent case, exactly like the conflict advisory), so a fresh personal vault stays silent; the human path prints its forward pointer through `emitNextStep` against one newly registered `DIAGNOSTIC_SIGNALS` code.
- **Trade-offs**:
  - Reuses a proven, tested precedent for "non-blocking, computed around the write, surfaced as a structured field and logged" — the shape the triage note asked for, with no new mechanism.
  - No new configuration key, so the "byte-identical when absent" rule is satisfied by construction: an unscoped write on a vault with no scope corpus behaves exactly as today.
  - Eligible scopes come from vault frontmatter and frequency, not from any word list, so the language-agnostic rule holds.
  - Touches only two call sites that already thread `effectiveScope`; `routeExtractedFacts` is untouched, preserving the existing "advisory never double-fires on the extracted-fact path" invariant.
  - Covers only the feedback surface. Anchor-less extracted facts and note captures remain unhinted, so the "unrouted note" problem is addressed for one write family, not all of them.
  - Inferring eligibility from corpus frequency means the candidate list drifts with vault contents and can surface a scope the operator considers retired.
  - Needs one registered diagnostic code whose `nextCommand` must be a structural string; the honest exit is re-recording with `--scope` or setting `feedback.default_scope`, so the registry entry has to name a real command rather than a paraphrase.
- **Complexity**: small
- **Risk**: low

### Variant 2: Declared scope registry in Brain config
- **Approach**: Widen the existing `feedback:` config block from a single `default_scope` into a declared registry of eligible scopes (each with the slug it routes to), mirroring upstream's "covers-declaring scopes are registered" model. A scope-less write consults the registry and returns a hint naming the missing routing signal and the registered scopes it could have carried; with no registry declared, the hint never fires and the path stays byte-identical. Validation lives in `policy.ts` beside the existing `feedback.default_scope` rules, sharing the same slug constraints.
- **Trade-offs**:
  - Highest fidelity to the upstream feature: eligibility is declared by the operator rather than guessed, so the hint never names a stale or accidental scope.
  - Silent by default on personal installs, which matches upstream behaviour and satisfies the additive-configuration rule cleanly.
  - Gives the vault an explicit routing vocabulary that later surfaces (hygiene, dream, active-pack scoping) could reuse, so the investment is not single-purpose.
  - Requires the operator to configure something before the feature does anything, which is the opposite of the "reduce unrouted notes" goal for the users most likely to have them — the ones who never configured scopes.
  - Adds config schema, validation, template, and documentation surface for a hint, which is a large ratio of mechanism to payoff.
  - Two sources of truth for what a valid scope is (declared registry versus scopes already on disk) invites drift and a new doctor check to reconcile them.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Cross-surface capture-routability seam
- **Approach**: Introduce one routability module that every capture write funnels through, modelling "missing routing signal" as a small closed set of families: a scope-less feedback signal, an extracted fact that resolved no canonical entity anchor, and a captured note with no anchor or scope. Each family declares its missing-signal token and its candidate resolver, each maps to its own registered diagnostic code, and the aggregate is emitted through `emitGatedTelemetry` so unrouted-capture rates become observable alongside the existing route metrics.
- **Trade-offs**:
  - Addresses the actual retrieval-noise problem end to end: anchor-less extracted facts are the larger unrouted population, and they are exactly what Variant 1 leaves out.
  - One model for "unroutable capture" instead of a per-surface advisory, which is the DRY answer if more capture surfaces arrive later.
  - Telemetry makes the effect measurable rather than asserted, matching how this codebase already treats recall and route quality.
  - `routeExtractedFacts` runs per fact inside the capture hot path; adding a candidate-resolution step there risks turning a bounded loop into a per-fact vault read unless results are hoisted, and that path is already carefully budgeted.
  - Breaks the documented invariant that the advisory fires only on the operator-facing feedback path, so the double-fire question has to be re-answered rather than inherited.
  - Largest blast radius across capture, MCP, CLI, and telemetry for a feature whose user-visible output is one hint line; several hundred existing capture tests sit downstream of these seams.
- **Complexity**: large
- **Risk**: medium

### Recommended: Variant 1
**Rationale**: The transferable half of the upstream feature is the shape — a non-blocking hint that names the missing routing signal — and `write-advisory.ts` already implements that shape on the same path, with the same fail-soft, never-blocks-the-write contract and the same structured-field-plus-log surfacing, so the work is an extension rather than a new mechanism. It needs no new configuration key and no change to the extracted-fact hot path, which keeps the "byte-identical when absent" and capture-performance constraints trivially satisfied, and it resolves its forward pointer through the registered advisory rail as the v1.40.0 convention requires. Variant 2 asks the operator to configure their way into the benefit they lack, and Variant 3 spends a large refactor across the hottest capture seam before the smaller version has demonstrated that the hint changes behaviour.

