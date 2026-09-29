# P4 silent-failure hardening - nine verified premises landed where they fail quietly

**Status:** draft
**Author:** osb-developer (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Nine tracker cards describe places where Open Second Brain fails silently: credentials that cross the
egress redaction boundary because a regex class excludes one character, secret values that ride past the
structured redaction walk under a sibling key, note bodies that embed absolute home paths with no
advisory at write time, ingested files that vanish between discovery and plan with no count, skip
reasons that are free text and cannot be aggregated, byte-identical rewrites that bump mtime and
poison recency and validity signals, a WAL journal mode forced onto filesystems where it is unreliable,
and health/orphan signals that exist but are never consolidated where an operator looks. Every premise
was verified against the live source at commit f22df2c5 before this design; all nine survived, each
with anchor corrections and a narrowed scope that this design folds in. The wave ships the surviving
premises as one merged, released increment, continuing the v1.52.0 rule: nothing writes silently,
nothing degrades silently.

## Premise verification

Verification ran against worktree branch `feat/p4-silent-failure-hardening` at commit f22df2c5, in five
cluster reports (`docs/brainstorm/p4-silent-failure-hardening/cli-output/` carries the brainstorm
consultant outputs; the cluster reports were consumed as design inputs). Load-bearing anchors were
spot-checked in the live tree during design (redactor.ts:249, write-batch.ts:584-602,
store/lifecycle.ts:51-60, extractable-gate.ts:29-32, batch-plan.ts:502-522, doctor.ts:139). Per-card
verdicts, all confirmed with corrections folded in:

| Card | Verdict | Evidence anchor | Correction folded in |
|---|---|---|---|
| t_5c777198 | confirmed | redactor.ts:249 (`BASIC_AUTH_URL_RE` password class `[^\s/@]+`), HIGH_ENTROPY gate drops a 20-char JWT header | `BASE64_SECRET_RE` sits at :451, not :324-360; credential-first pass order in `redactInfraTopology` (:487) and the bare-token-before-URL-pass interplay in `scanRawOutput` (:778) are preserved |
| t_c70f3d94 | confirmed | redactor.ts walk() object loop :1042-1049, array branch :1033-1037; `isSecretKeyName('DB_PASSWORD')` already true | anchor moved from :999-1006; ECS `valueFrom` is an ARN reference, out of scope |
| t_796c1a9b | confirmed | write-batch.ts:291/322/393, no redactor import in create-note.ts, `pageLintField` precedent notes-tools.ts:457-463 | paths are reported, never scrubbed, in the structured walk; the warning is non-blocking and advised onto the write receipt like page-lint |
| t_9b30f48b | confirmed | vault.ts:753/:812 bare `continue;` filters; batch-plan.ts:517 extension drop in `collectIngestible`; degradation.ts:47-120 | the drop exists in a second walk (`collectIngestible`); the design states which population is covered |
| t_09d52938 | confirmed, narrowed | extractable-gate.ts:29-32 free-text `reason`; session lane already has a dry run with counters (sessions/import.ts) | no new preview; the new ground is typing `SkippedPage.reason` plus aggregate counters on the source-ingest lane only; drop/cutoff reasons do not exist here |
| t_a77e35a2 | confirmed | fs-atomic.ts:35/:136/:151-158, no production caller passes `skipIfUnchanged`; write-batch.ts:594 and vault.ts:477 are the two unguarded chokepoints | validator-trimmed scope: inline-rewrite and log.ts already self-guard; no fs-atomic default flip; `updated: true` hardcoded at write-batch.ts:535/:569 must become honest |
| t_541083b3 | confirmed | lifecycle.ts:52 `PRAGMA journal_mode = WAL` on both open paths; vault-backing.ts:181-183 maps nfs/cifs/fuse to `durable`, no remoteness axis | lands as skip WAL + warn on remote backing, no hard refuse; ownership anchor drift corrected to :774/:777; WSL 9p false-positive risk respected |
| t_f99250aa | confirmed | doctor.ts:139 `DOCTOR_CHECKS`; `embeddingSunsetCheck` (doctor/embedding-sunset-check.ts:261) is the precedent | target is the brain doctor registry, not the install manifest doctor; `computeSemanticHealth` is rule-set-meaning health, not the embeddings lane |
| t_6cc80627 | confirmed | signal.ts:134/:479/:683 `session_ref` parsed and rendered, never resolved; repair-lane.ts:52-62 confirm-phrase/cap discipline | the concrete orphan is an unresolved `session_ref`; the repairable-vs-informational split is an additive optional field on `DoctorIssue` |

No card was refused this wave.

## Scope

- Egress redaction: widen the URL-credential password class within the documented bounded/linear regex
  constraint, and add a default-on three-segment JWT detector next to the existing `BEARER_RE` pass in
  `scanRawOutput`.
- Structured redaction: the walk inspects plain-object array elements for `{name, value}` shape and
  applies `isSecretKeyName` to the sibling `name`.
- Write receipts: a non-blocking absolute-path advisory, computed with the existing hygiene grammar,
  riding the write result like page-lint, covering both MCP write surfaces through the write-batch
  projection.
- Ingest visibility: typed `SkippedPage.reason` (closed union, membership list, narrowing parser,
  checkable detail) and aggregate per-reason counters plus per-extension unclassifiable counts on the
  source-ingest lane, surfaced through the one wire serializer and the CLI verb.
- mtime stability: `skipIfUnchanged` opt-in at exactly the two unguarded chokepoints; skipped writes
  store no before-image, record no note-write record, and report `updated`/`appended` honestly.
- Journal mode: a remoteness axis on the vault-backing probe; on a remote backing the index opens
  without WAL and warns once, non-Linux stays silent.
- Brain doctor: a read-only failSoft embeddings-health check consolidating the scattered signals, and a
  read-only failSoft orphan-observation check resolving `session_ref`; a repair verb for orphaned
  observations under the repair-lane discipline, plus an additive optional `fix` field on `DoctorIssue`.

## Out of scope

- The two generic vault walks (`walkBasenames`/`walk` in src/core/vault.ts) keep their silent
  extension filters: they serve listing surfaces where exclusion is expected behavior; only the
  source-ingest discovery lane gets counters.
- No new preview command for the ingest lane; the session lane already has one.
- A metrics JSONL surface for skipped extensions; the wire serializer and CLI render are the surfaces
  for this wave.
- No new member in the closed `DEGRADATION_CODE` vocabulary; the unclassifiable counts travel on the
  batch plan and its one serializer, not as per-entry notices.
- ECS `valueFrom` sibling handling (ARN reference, not a literal secret).
- A hard refusal to open the index on remote backing, and any escape-hatch env for one.
- The maintenance lease database (`src/core/brain/maintenance/lease.ts:44`) keeps unconditional WAL;
  the remoteness gate lands on the search index open path only.
- No fs-atomic default flip; the roughly thirty unrelated call sites stay untouched.
- No change to the structured walk's path-like-leaf decision (reported, never rewritten).

## Chosen approach

Variant 2 from the consultant review (see variants.md): keep the nine changes anchor-local, but factor
the three natural pairs onto one seam each. The redactor pair (JWT plus slash-password, sibling
`{name, value}`) lands as two passes in one module with one shared-file sequence. The ingest pair
(unclassifiable counts, typed skip taxonomy) shares one typed taxonomy whose aggregates carry the
unclassifiable bucket, emitted once through `serializeBatchPlan` so the CLI JSON and MCP surfaces
cannot diverge. The doctor pair (embeddings health, orphan observations) shares the check shape of
`embeddingSunsetCheck` and the additive `fix` field. The three singletons - write-path advisory, mtime
gate, WAL remoteness - stay strictly local to their anchors. The write-path advisory and the mtime gate
both touch `src/core/brain/write-batch.ts` and run as an explicit shared-file sequence. Everything is
additive and byte-identical-when-absent, no default flips, no new dependencies.

## Design decisions

- **Redaction pass order is preserved.** The bare-token pass runs before the URL-credential pass in
  `scanRawOutput`; widening the password class to `[^\s@]+` keeps the scheme and `@host` anchors and
  the bounded-repetition no-ReDoS constraint documented at redactor.ts:236-239. A vendor-token-shaped
  password is collapsed by the earlier pass, which is the existing ordering the design keeps.
- **JWT detection is default-on and text-lane only.** A three-segment base64url JWT detector joins
  `BEARER_RE` in `scanRawOutput`; the structured walk's decision to report rather than rewrite
  path-like leaves is unchanged, so a JWT-shaped string inside a path-like leaf stays a report. This
  changes the default byte-parity of egress output (continuity payloads flag it via `redacted`); that
  visibility is the point of the card, and the affected tests pin the new behavior.
- **The sibling-pair check reuses the existing matcher.** `isSecretKeyName` already matches
  `DB_PASSWORD`; the walk change consults it on the sibling `name` of a plain-object `{name, value}`
  array element. No new secret-name vocabulary.
- **The path advisory reuses the hygiene grammar as-is.** `scanText` from
  src/core/hygiene/hardcoded-paths.ts (unix-home and windows-home detectors, placeholder-segment
  filter, `hygiene:allow-path` escape hatch) is the single grammar; its home-prefix scope is the honest
  leak case and is stated in the advisory rather than widened here. The advisory is computed in the
  write-batch projection over authored note content only (create, update, append; log-line ops skip,
  following page-lint's authored-content rule), carried as an optional byte-identical-when-absent field
  on the write result, and is never a `WriteBatchError` - the batch stays all-or-nothing. Findings echo
  vault-relative paths, line numbers and detector names, never absolute paths (page-lint's
  identifiers-and-integers rule).
- **The mtime gate is chokepoint-level opt-in.** `commitNoteRewrite` passes `skipIfUnchanged: true` and
  branches on the returned wrote boolean to skip `storeBeforeImage` and `recordNoteWrite`; the update
  commit reports `updated: <wrote>` and the append commit `appended: <wrote>`. The
  `writeFrontmatterAtomic` overwrite branch opts in and returns the boolean additively; exclusive-create
  branches are untouched. No audit line exists for a write that did not happen.
- **Remoteness is a second axis, and the response is skip plus warn.** `vault-backing.ts` gains a
  remoteness classification alongside durability: named network magics (nfs, cifs) classify remote;
  fuse stays non-remote because its backing is unknowable and failing safe there would warn every
  user-space mount; unknown and probe-unsupported stay silent and keep WAL. `applyPragmas` consults the
  axis on both open paths and sets the default journal mode (DELETE) instead of WAL on a remote backing,
  emitting one stderr warning naming the filesystem and the reason, in the style of the existing
  restore-from-bak notice. The new classification vocabulary registers in the verdict-vocabulary census.
  The probe seam on the open path is an optional injectable statfs probe so tests can simulate NFS
  without a real mount.
- **Doctor checks are read-only, failSoft, and shaped like the sunset check.** The embeddings-health
  check reads the pending-vector census (preserving its unrecorded-is-not-zero contract), the index
  counts including `staleEmbeddings`, and the provider/vec-extension facts, emits warning issues with a
  message-embedded next command (`o2b search vector-backfill`, `o2b search check`), and sends an
  unrecorded census to the uncertain stream. The orphan-observation check parses signals and resolves
  `session_ref` against the sessions/continuity store; unreadable subtrees go to the uncertain stream.
  Both register in `DOCTOR_CHECKS` with codes in the diagnostics registry and the census tests.
- **The orphan repair detaches, never deletes.** The repair verb clears the dangling `session_ref` from
  a signal's frontmatter, keeping the observation content: dry-run default, exact confirm phrase, hard
  per-run write cap, idempotent rescan, vault-identity assert, atomic frontmatter writes, and never
  reachable from `runDoctor`. The repairable-vs-informational split is an optional additive `fix` field
  on `DoctorIssue` (mirroring the general doctor's `CheckResult.fix`), byte-identical-when-absent so
  existing JSON consumers and drift censuses stay green.

## File changes

New files:
- src/core/brain/write-path-advisory.ts (advisory over authored note content, wrapping the hygiene grammar)
- src/core/brain/doctor/embeddings-health-check.ts
- src/core/brain/doctor/orphan-session-check.ts
- src/core/brain/link-graph/orphan-repair.ts (repair-lane discipline applied to detached session references)
- src/cli/brain/verbs/orphan-repair.ts

Modified files:
- src/core/redactor.ts (password class, JWT pass, sibling-pair walk)
- src/core/brain/write-batch.ts (advisory field on the write result; skipIfUnchanged branch and honest updated flags)
- src/mcp/brain/notes-tools.ts, src/mcp/brain/write-batch-tools.ts (advisory pass-through on receipts)
- src/core/vault.ts (writeFrontmatterAtomic overwrite branch)
- src/core/brain/ingest/extractable-gate.ts (typed reason, membership, narrowing parser)
- src/core/brain/ingest/batch-plan.ts (per-reason and per-extension aggregates)
- src/mcp/brain/ingest-tools.ts, src/cli/brain/verbs/batch-plan.ts (serializer and render)
- src/core/vault-backing.ts (remoteness axis), src/core/search/store/lifecycle.ts (journal-mode decision)
- src/core/brain/doctor.ts (two registry entries), src/core/brain/types.ts (optional `fix` field)
- src/core/brain/diagnostics.ts (new codes; `parseSignal` is already exported for the orphan check)
- docs touched per house rules in the PR phase (mcp.md, cli-reference.md, observability.md as needed)

Test files mirror these under tests/ (redactor, redactor-scan-window, mcp/brain-write-batch,
core/brain/ingest/*, core/vault-backing, core/search store lifecycle, core/brain/doctor/*,
core/brain/link-graph/*, cli repair verb), plus the verdict-vocabulary and doctor censuses.

## Risks and open questions

- Redaction byte-parity: the default-on JWT pass and the wider password class change export and
  continuity output; tests that pin current verbatim leakage must be updated deliberately, and the
  EGRESS_REDACTION_NOTICE volume may grow. Bounded-repetition review is mandatory for any widened class.
- Wire compatibility on the ingest lane: typing `SkippedPage.reason` changes the serialized reason
  values; the narrowing parser accepts both the token and the legacy sentence, and every consumer in
  this repository is updated in the same commit.
- Audit-chain consumers: tests or callers asserting `updated: true` on a byte-identical update will
  move to `updated: false`; the honest flag is the deliverable, and the assertion updates are part of
  the task.
- mtime consumers (recency boost, validity-window fallback, vault-delta counts) change behavior on
  no-op reruns by design; any test pinning inflated counts moves with the task.
- WSL and overlay filesystems: the remoteness axis classifies only named network magics; a WSL 9p mount
  does not classify remote, so no WSL user sees the warning or loses WAL. If a future magic list grows,
  the census test is the gate.
- Doctor contract: the two new checks must stay failSoft and register their codes, or the exit census
  and drift tests fail; that failure is the designed guardrail, not a risk to work around.
