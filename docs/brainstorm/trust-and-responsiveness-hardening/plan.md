# Trust and responsiveness hardening - implementation plan

Four implementation lanes with disjoint file ownership plus one integrator. Each task is TDD-ready: write the failing test first, implement until green, refactor with all tests green, format and lint before every commit, commit only the task's own files (`git commit --only <paths>`, never a plain `git add` + `git commit`). Each lane runs ONLY its own new or changed test files locally (never the full suite); the integrator runs the full gates.

## File ownership table

Each file is owned by exactly one lane (or nobody). A lane that needs a file outside its ownership stops and renegotiates this contract; it never reaches into another lane's files.

| Files | Owner |
|---|---|
| `src/core/brain/text/neutralize-markdown.ts`, `src/core/brain/planted-rows.ts`, `src/core/brain/doctor/planted-rows-check.ts`, `src/core/brain/capture/capture-note.ts`, `src/core/brain/ingest/ingest.ts` | Lane A |
| `tests/core/brain/text/neutralize-markdown.test.ts`, `tests/core/brain/ingest/ingest-marker-neutralize.test.ts`, `tests/core/brain/doctor/planted-rows-check.test.ts`, extended `tests/core/brain/capture/capture-note.test.ts` | Lane A |
| `src/core/brain/gitignore-guard.ts`, `src/core/brain/doctor/git-tracked-state-check.ts`, `src/core/brain/init.ts`, `src/core/brain/secrets/crypto.ts`, `src/core/brain/path-constants.ts`, `src/cli/brain/verbs/bench.ts` | Lane B |
| `tests/core/brain/gitignore-guard.test.ts`, `tests/core/brain/doctor/git-tracked-state-check.test.ts`, extended `tests/core/brain.init.test.ts` | Lane B |
| `src/core/brain/writeback-contract.ts`, `src/core/doctor-readiness.ts`, `src/core/brain/trust/instruction-file-ceiling.ts` (docblock only), `src/core/brain/doctor/removed-tool-checks.ts` (docblock only) | Lane C |
| `tests/core/brain/writeback-contract.test.ts`, `tests/core/doctor-readiness.test.ts` | Lane C |
| `src/mcp/tool-contract.ts`, `src/mcp/tools.ts`, `src/mcp/server.ts`, `src/mcp/stdio.ts`, `src/mcp/hydrate-tool.ts`, `src/mcp/search-tools.ts`, `src/mcp/schema-tools.ts`, `src/mcp/skill-tools.ts`, `src/mcp/wiring-tools.ts`, `src/mcp/watchdog-tools.ts`, every file under `src/mcp/brain/` | Lane D |
| `tests/mcp/stdio-parallel.test.ts`, extended `tests/mcp/brain-tools-parity.test.ts`, `tests/mcp/progress-token.test.ts`, `tests/mcp/mcp.test.ts` | Lane D |
| `src/core/brain/vault-dirty.ts`, `src/core/search/store/writer-lock.ts`, `src/core/brain/sync-lockfile.ts`, `src/core/install/managed-block.ts`, `hooks/` | Nobody - read-only precedents; no lane modifies them |

## Shared files and the append-only protocol

These files are touched by more than one lane. The protocol: a lane edits shared files ONLY in its final lane task, appends only (never edits, reorders or deletes another lane's entries), and commits them in that lane's own final commit via `git commit --only`. The integrator reconciles any textual overlap and re-freezes ordering in one pass.

- **`src/core/brain/doctor.ts` (DOCTOR_CHECKS registry).** Lane A appends exactly one entry, `plantedRowsCheck`, immediately after `privacyMarkerCheck`. Lane B appends exactly one entry, `gitTrackedStateCheck`, immediately after `secretsSyncExposureCheck`. Neither lane reorders existing entries; the registry's order is a report contract.
- **`src/core/brain/doctor-exits.ts` (DOCTOR_EXIT_EXCLUSIONS).** Lane A appends one entry for `planted-structure-rows` (no single command remediates third-party text). Reason may not name an `o2b` invocation (:31-33).
- **`src/core/brain/diagnostics.ts` (DIAGNOSTIC_SIGNALS).** Lane B appends one entry for the tracked-state code with `nextCommand` "o2b brain init" (the seeder is idempotent and merge-safe).
- **`tests/core/brain/doctor-exit-census.test.ts`, `tests/core/brain/doctor.test.ts`, `tests/core/brain.doctor.test.ts`.** Append-only: a lane extends them only with assertions for its own code/entry (census coverage, registry-order position). Neither lane edits the other's assertions.
- **`docs/` files and `CHANGELOG.md`.** Each lane's final task appends its own rows (its own doc sections, one CHANGELOG bullet under the unreleased heading). Appends only; the integrator reconciles into one coherent pass and owns any prose that spans lanes.

## Lane A - write-time marker neutralization (t_c2ac4fc8)

### Task A1: Pure neutralizer and shared detection grammar

- **Files**: new `src/core/brain/text/neutralize-markdown.ts` (families: wikilinks, `@osb` inline markers, ```osb fence lines, ATX headings including log headings; backslash-escape of sigils within detector match spans; fence-masked detection reusing `wikilink.ts` codeRegions/maskCodeRegions; escape-aware detectors, odd-backslash-run rule; single-pass non-backtracking regexes; API returns `{ text, changed, kinds }`); new `tests/core/brain/text/neutralize-markdown.test.ts`.
- **Acceptance**: passing unit tests prove each family is detected and escaped (wikilink plain and aliased, `@osb` inline per `KNOWN_KINDS`, ```osb open and close fence lines, `##` headings incl. the log-heading shape); content inside fenced code and inline code is untouched; already-escaped sigils are not re-escaped (odd backslash run is data); `neutralize(neutralize(x))` is byte-identical to `neutralize(x)`; unchanged input returns `changed: false` and identical bytes; vault-authored samples (`- [[id]]` link rows, `## Guidance` renderer output) escape only when fed through the caller-text entry point; no invisible characters are ever introduced.
- **Depends on**: none.

### Task A2: Gate mode resolver

- **Files**: modified `src/core/brain/text/neutralize-markdown.ts` (frozen `MARKDOWN_NEUTRALIZE_MODE` vocab `off|shadow|enforce`, `MARKDOWN_NEUTRALIZE_MODE_CONFIG = "markdown_neutralize_mode"`, env twin `OPEN_SECOND_BRAIN_MARKDOWN_NEUTRALIZE_MODE`, `resolveMarkdownNeutralizeMode` with env-over-config and invalid-value refusal naming the key actually in force - the `resolveSearchTrustGateMode` shape); extended `tests/core/brain/text/neutralize-markdown.test.ts`.
- **Acceptance**: passing resolver tests prove: absent everywhere resolves `off`; env wins over config; `shadow` and `enforce` resolve; an invalid value throws naming the key and the received value; the resolver reads only its arguments (pure).
- **Depends on**: A1.

### Task A3: Capture seam

- **Files**: modified `src/core/brain/capture/capture-note.ts` (in `writeCaptureNote` (:233): resolve gate mode; on `enforce`, neutralize the caller-supplied body text before `renderCaptureBody` composes it, and the guidance tail; renderer-authored structure stays untouched; on `changed`, write the conditional provenance key naming the kinds; `captureBaseId` hashes the persisted post-neutralize body; on `off`/`shadow` bytes are unchanged); extended `tests/core/brain/capture/capture-note.test.ts`.
- **Acceptance**: passing tests prove: gate off, a body full of live `[[...]]`/`@osb`/`##` markers persists byte-identical to today (end-to-end byte-identity); gate enforce, the persisted body has no live markers per a fence-masked scan, renders read as literal text, and the provenance key names the kinds; gate shadow, bytes are unchanged; the guidance split still fires only on writer-set frontmatter, never on a neutralized heading; re-capture of the same text under a stable gate is idempotent; zero bytes are added when nothing changed.
- **Depends on**: A1, A2.

### Task A4: Ingest seam

- **Files**: modified `src/core/brain/ingest/ingest.ts` (at body assembly (:449-457): on gate `enforce` and an untrusted source, neutralize `input.summary` once so staged and published bytes are the same `nextContents`; vault-authored sections (`renderProvenanceSection`, `renderLinkSection`, derivation.section) appended after, untouched; conditional frontmatter key rides the existing provenance merge); new `tests/core/brain/ingest/ingest-marker-neutralize.test.ts`.
- **Acceptance**: passing tests prove: enforce + untrusted, planted markers are inert on BOTH the published page and the Brain/pending/ staged copy (identical bytes); re-ingest of the published page never re-stages and stays idempotent; gate off and trusted-source paths are byte-identical to today; vault-authored sections never appear escaped; the write disposition gate (:465-492) is unaffected.
- **Depends on**: A1, A2.

### Task A5: Doctor audit and shared registrations (lane final)

- **Files**: new `src/core/brain/planted-rows.ts` (pure planner importing the A1 detectors; population split by family: the marker and osb-fence families on every readable page under `Brain/` - no Brain writer ever emits a live marker line or osb fence - and the wikilink and heading families on the third-party lanes only (capture pages, untrusted-stamped pages, quarantined entity pages, source summaries), whose structure the Brain's own writers render by design elsewhere; the sections those writers render - a capture's marker-authorized `## Guidance`, a source summary's `## Sources`/`## Premises`/link and derivation sections - excluded from the report as the vault's own output; fence-masked body scan; staged-vs-published dedupe); new `src/core/brain/doctor/planted-rows-check.ts` (`failSoft: true`, one warning, code `planted-structure-rows`, `NAMED_PATH_LIMIT = 5`, `ctx.readable` filter - the privacyMarkerCheck shape; shadow mode adds the would-be-enforce wording); new `tests/core/brain/doctor/planted-rows-check.test.ts`; SHARED appends: `src/core/brain/doctor.ts` (registry entry after `privacyMarkerCheck`), `src/core/brain/doctor-exits.ts` (exclusion entry), the three shared test files; lane-final docs append (`docs/cli-reference.md` doctor row, CHANGELOG bullet).
- **Acceptance**: passing tests mirror the privacy-marker suite: silent when nothing planted; one warning with count and capped named paths; unreadable pages excluded via `ctx.readable`; staged copies counted once; registry-order assertions pass with the new entry in position; exit census and doctor-order tests stay green with the new classification; the check never mutates and never throws.
- **Depends on**: A1 (A2 for the shadow wording).

## Lane B - gitignore guardrails (t_206562ae)

### Task B1: Guard module and derived-state census

- **Files**: new `src/core/brain/gitignore-guard.ts` (managed-block seeder: block markers with a named id, entry list starting as exactly `/.open-second-brain/`; exact-line membership pre-check; create-with-block when no `.gitignore` exists; insertManagedBlock merge when it does; named conflict on malformed existing markers, warn-and-continue; CRLF-safe; returns created/skipped); modified `src/core/brain/path-constants.ts` and `src/cli/brain/verbs/bench.ts` (bench runs dir hoisted from the locally-spelled join at bench.ts:37 to a named constant beside `DERIVED_STORE_DIR`); new `tests/core/brain/gitignore-guard.test.ts` including a source-reading census pinning every known derived-state writer (brain.sqlite, hook-audit, maintenance sqlite and journals, ingest checkpoints, dead-letters, session ledgers, watchdog fallback, self-heal state, locks, bench runs) under `DERIVED_STORE_DIR`.
- **Acceptance**: passing tests prove: a missing `.gitignore` is created containing only the block; an existing user `.gitignore` is byte-preserved outside the block and gains the block appended with a separator; a second run is a no-op (idempotent, byte-equal); CRLF files keep their line endings; malformed existing markers surface the named conflict without writing; the census test fails if a derived-state writer moves outside the covered directory.
- **Depends on**: none.

### Task B2: Brain-init wiring and invariant update

- **Files**: modified `src/core/brain/init.ts` (`bootstrapBrain` (:318) gains the gitignore step beside the identity stamp, reported through the existing created/skipped arrays); modified `src/core/brain/secrets/crypto.ts` (docblock :62-66 reworded to name the two sanctioned `.gitignore` writers; behavior unchanged, secrets marker kept); extended `tests/core/brain.init.test.ts`.
- **Acceptance**: passing tests prove: fresh `o2b brain init` in a git-inited temp vault leaves `git status --porcelain` empty after runtime creates `.open-second-brain/brain.sqlite`; `created.length` assertions updated deliberately (7 to 8) with the `.gitignore` named; a second init reports no creations; a pre-existing user `.gitignore` survives init byte-preserved outside the block; init into a non-git folder succeeds identically (no git dependency at init).
- **Depends on**: B1.

### Task B3: Doctor tracked-state row and shared registrations (lane final)

- **Files**: new `src/core/brain/doctor/git-tracked-state-check.ts` (`failSoft`; worktree detection first, silent when not a worktree or the directory is absent; `git ls-files -z -- .open-second-brain` vault-bounded for tracking, `git check-ignore` exit discipline for the ignore state; tracked paths to severity error naming `git rm -r --cached <path>` capped by the named-path limit plus the missing ignore line; present-but-unignored untracked state to severity warning; git that cannot answer means silence); new `tests/core/brain/doctor/git-tracked-state-check.test.ts` (real temp git repos per the sync-exposure test shape); SHARED appends: `src/core/brain/doctor.ts` (registry entry after `secretsSyncExposureCheck`), `src/core/brain/diagnostics.ts` (signal with `nextCommand` "o2b brain init"), the three shared test files; lane-final docs append (`docs/cli-reference.md` doctor row, CHANGELOG bullet).
- **Acceptance**: passing tests prove: doctor exits 1 on a fixture with a committed `.open-second-brain` file; exits 0 after `git rm -r --cached` plus the ignore line; warning (not error) for untracked-but-unignored; silent in a non-git folder, when the directory is absent, and when git is missing; the doctor never edits anything; census and registry-order tests stay green.
- **Depends on**: B1 (B2 for the end-to-end remediation assertion).

## Lane C - shadowed agent instruction files (t_00b617b6)

### Task C1: Host precedence constants and pure shadow resolver

- **Files**: modified `src/core/brain/writeback-contract.ts` (exported `HOST_INSTRUCTION_PRECEDENCE`: host to ordered instruction files - claude-code reads CLAUDE.md; codex, cursor, opencode, aider read AGENTS.md; gemini-cli reads GEMINI.md - docblock citing `docs/cross-project-pointer.md:13-17` and marking repo-cited versus name-implied entries; pure resolver over the per-candidate audits returning shadowed triples `{ host, readsPath, contractPath }`: the host's first existing candidate lacks the managed block while another candidate carries it in any block-bearing state); extended `tests/core/brain/writeback-contract.test.ts`.
- **Acceptance**: passing unit tests prove: CLAUDE.md present without a block plus AGENTS.md carrying a conforming block yields the claude-code shadow triple naming both paths; GEMINI.md-only and AGENTS.md-only workspaces yield no shadow; a host whose preferred file carries the block yields no shadow; absent-only workspaces yield nothing; symlink candidates are ignored by the resolver without crashing (evidence refused, never read); the resolver performs no writes and no I/O (pure over its input).
- **Depends on**: none.

### Task C2: Shadow row in the readiness probe

- **Files**: modified `src/core/doctor-readiness.ts` (in `probeWritebackContract` (:1742): between the workspace audit (:1744) and the aggregation (:1750), grade each shadow triple as a `fail` row whose detail names the host, the file the host reads, the file carrying the contract, and an embedded read-only recovery clause following `WRITEBACK_CONTRACT_RECOVERY` phrasing; absent-only workspaces stay `skipped`; shadow-free multi-file workspaces keep passing; census arithmetic stays coherent); extended `tests/core/doctor-readiness.test.ts`.
- **Acceptance**: passing tests prove: conforming AGENTS.md plus bare CLAUDE.md fails naming both files with the recovery clause; the probe verdict is fail and exits non-zero under `--readiness`; one-conforming-among-absent still passes; the no-file case still skips with the existing wording; the worst-of aggregate and census stay correct when a shadow coexists with a malformed block elsewhere; the probe performs only reads and lstats (no writes, no symlink following).
- **Depends on**: C1.

### Task C3: List-consistency sweep and docs (lane final)

- **Files**: modified `src/core/brain/trust/instruction-file-ceiling.ts` and `src/core/brain/doctor/removed-tool-checks.ts` (docblock-only: state the list's purpose - existence loop, not precedence - cross-reference `AGENT_INSTRUCTION_FILES` and `HOST_INSTRUCTION_PRECEDENCE`, and record the open question on GEMINI.md's absence; NO behavior change, list contents and orders untouched); modified `docs/cli-reference.md` (the `--readiness` probe description gains the shadowed-instruction finding and its grading impact); SHARED: CHANGELOG bullet.
- **Acceptance**: passing tests prove no behavior change in either swept module (existing suites green unchanged); the CLI reference documents the new vocabulary; no fourth divergent filename list was introduced (the repo now has exactly the three existing lists plus the precedence table that references them).
- **Depends on**: C2.

## Lane D - parallel MCP reads on stdio (t_90409204)

### Task D1: Registry classification (no behavior change)

- **Files**: modified `src/mcp/tool-contract.ts` (required `readonly kind: "read" | "write"` on `ToolDefinition`, docblock distinguishing it from the host-facts `ToolCeilingKind.kind` and stating the write-mode-dominant rule and that the field never reaches the wire); modified `src/mcp/tools.ts` and every slice - `src/mcp/brain/` tools files, `src/mcp/search-tools.ts`, `src/mcp/schema-tools.ts`, `src/mcp/skill-tools.ts`, `src/mcp/wiring-tools.ts`, `src/mcp/watchdog-tools.ts`, `src/mcp/hydrate-tool.ts` - setting `kind` per tool (dual-capability tools are write: brain_watchdog, brain_lifecycle, brain_dream, brain_receipts; brain_retention and brain_review_candidates ship as read - parity-pinned, recommendation-only/dry-run planners whose descriptions promise no mutation); extended `tests/mcp/brain-tools-parity.test.ts` (registry-guard-style walk failing when any registered tool lacks `kind`, and the read/write partition pinned beside `FROZEN_BRAIN_TOOL_NAMES`); extended `tests/mcp/mcp.test.ts` (a wire-identity assertion: the `tools/list` result serializes exactly `name`, `description`, `inputSchema`, optional `outputSchema` - byte-identical to the pre-change payload).
- **Acceptance**: passing tests prove every registered tool carries `kind`; the partition matches the pinned list (a deliberately wrong entry fails the test); `tools/list` output is byte-identical; no dispatch behavior changed in this task.
- **Depends on**: none.

### Task D2: stdio parallel dispatch with exclusive writes

- **Files**: modified `src/mcp/server.ts` (classifier helper over `findTool`: non-`tools/call` methods are reads; `tools/call` is a write when the tool's `kind` is `write`, fail-closed on a missing kind); modified `src/mcp/stdio.ts` (production `serveStdio` loop: reads dispatched unawaited up to a named concurrency cap constant, default 4, with the loop backpressuring on a slot before reading further lines; writes through an in-loop async mutex, FIFO, one write in flight; each request's response written inside its own drain begin/finish window; EOF, drain break and `rl.close()` resolve only after the in-flight set empties; `serveStdioFromString` untouched and still sequential).
- **Acceptance**: passing tests prove: two reads issued back-to-back with a held first handler both complete (the second no longer head-of-line blocks); a write issued between them waits for the write gate and runs alone (interleaving log shows no read/write overlap and no write/write overlap); responses carry their own ids regardless of completion order; the in-flight count never exceeds the cap; after stdin EOF the loop resolves only when every dispatched request settled.
- **Depends on**: D1.

### Task D3: Invariant tests for the new concurrency

- **Files**: new `tests/mcp/stdio-parallel.test.ts` (PassThrough real-stream fixture plus the http-drain held-request pattern: frame integrity under N concurrent calls, per-request adjacency - all of request K's notifications before response K - write exclusivity via an interleaving log, drain abandoned labels, EOF awaiting the in-flight set with a controllable slow handler); extended `tests/mcp/progress-token.test.ts` (two concurrent calls with progress tokens: every notification precedes its own response, cross-request interleaving is legal, the progress-refusal envelope still holds); updated `tests/mcp/mcp.test.ts` (order-dependent frame assertions rewritten for legal reordering; the harness loop's sequential assertions kept for `serveStdioFromString` only).
- **Acceptance**: passing tests prove frame atomicity under concurrency (no notification splices inside a response frame on a real stream); reordering across requests is asserted legal and adjacent-per-request; the drain reports abandoned labels; EOF never resolves under a floating handler.
- **Depends on**: D2.

### Task D4: Comment and docs reconciliation (lane final)

- **Files**: modified `src/mcp/stdio.ts` (comment-only: module docblock :13 "the one request that can be in flight" reworded for bounded parallel reads with exclusive writes; the `serveStdioFromString` comment :258-262 rewritten to say the harness loop is sequential for positional assertions, not because the transport serializes); SHARED: `docs/mcp.md` (transport note: stdio now runs reads concurrently under a cap with writes exclusive, out-of-order responses are JSON-RPC-legal, cross-request progress interleaving is the documented behavior change), CHANGELOG bullet.
- **Acceptance**: a repo-wide comment scan finds no doc or comment still claiming strict stdio request sequencing; `docs/mcp.md` matches the shipped behavior; no code change in this task beyond comments (existing suites green).
- **Depends on**: D3.

## Integrator

### Task I1: Reconciliation and full gates

- **Files**: the shared files if any lane-overlap needs re-freezing (`src/core/brain/doctor.ts` final registry order, the three shared test files, `docs/` and `CHANGELOG.md` coherence pass).
- **Acceptance**: the full local gates pass in CI order - formatter check, lint, typecheck, and the FULL test suite (the only place the full suite runs); `tests/core/brain/doctor-exit-census.test.ts` green with both new codes classified; the doctor registry order assertions reflect the final frozen order; every user-visible surface added by lanes A-D has a docs row; no placeholders anywhere; the branch contains only lane commits plus this reconciliation.
- **Depends on**: A5, B3, C3, D4.

## Commit shape

- Lane commits use conventional messages on this branch, each committing only its own files via `git commit --only <paths>`: `feat(brain): neutralize structure-bearing markdown in imported text` (lane A), `feat(brain): seed gitignore guardrails for derived brain state` (lane B), `feat(doctor): detect shadowed agent instruction files` (lane C), `feat(mcp): parallel reads on the stdio transport` (lane D). The integrator commits `chore(brainstorm): reconcile shared registries and docs` or folds into the release-preparation pass.
- The brainstorm artifacts commit separately as `chore(brainstorm): trust-and-responsiveness-hardening` before any lane work.
- Lane D's wire constraint is a review gate, not just a test: any diff showing `kind` in a `tools/list` payload, an added advertised field, or a reordered advertised list is a defect regardless of test outcome.
