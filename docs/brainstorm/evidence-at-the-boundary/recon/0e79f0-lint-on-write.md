# Recon: a write that never says what is wrong with what it wrote (kanban t_0e79f0b3)

Read-only reconnaissance against `main` @ 29ea0099.

## The existing lint is not a quality report and cannot run per page

`lint-consolidate.ts` checks exactly two things (`LINT_CONSOLIDATE_KIND:42-45`):
`fix-merged-link`, which rewrites wikilinks to a canonical target for any page
carrying `merged_into:`, and `demote-stale-stable`, which fires on a preference
whose lifecycle is stable and whose evidence is old.

Its finding types are repair records, not findings: `LintFix {kind, path, from,
to}` and `LintDemotion {kind, id, path, ageDays}` (`:47-67`). There is no
severity, no message, no fix hint, no code beyond `kind`. The report answers what
`--apply` would rewrite, not what is wrong with a page.

`lintConsolidate(vault, opts)` takes a vault, not a path, and walks all of
`Brain/**`.

Measured on a live 2090-page vault: the full pass is **359 ms**; the merge-map
build alone is 25 ms (it parses every preference and retired file, and `retired/`
grows monotonically); `collectAllBasenames` is 6 ms readdir-only; `loadSchemaPack`
is 1 to 5 ms and is not cached. So the vault pass is categorically unusable per
write.

Only half the checks are factored per page: `scanFileForMergedLinks(path, raw,
merge)` is already pure, and `detectStaleStable` has its predicate inlined in a
readdir loop.

The honest per-page subset is merged-link only, and it does not need the merge
map: `resolveCanonicalId` (`page-meta/page-id.ts:80`) already walks the
`merged_into:` chain with cycle and depth guards. Per page that is a handful of
stat and parse calls, roughly 0 to 2 ms. `demote-stale-stable` is inapplicable to
a page written this turn by construction, because its trigger is creation age, and
that exclusion should be stated rather than silently dropped.

## There is no shared write envelope, and that is the core finding

| Entry point | Returns today | Location |
|---|---|---|
| `brain_create_note` | `{created, outcome, path}` | `notes-tools.ts:244` |
| `brain_update_note` | `{updated: true, path}` (hardcoded true) | `notes-tools.ts:291` |
| `brain_append_note` | `{appended: true, path}` (hardcoded true) | `notes-tools.ts:306` |
| `brain_write_batch` | `{applied, results[], done: true}` | `write-batch-tools.ts:144-181` |
| `brain_write_session` | its own `WriteSessionEnvelope` with `errors[]` | `write-session/types.ts:116-128` |

Beneath them, create goes through `createNote` (`create-note.ts:431`) and
update/append/batch through `applyWriteBatch` (`write-batch.ts:206`), which
commits with raw `atomicWriteFileSync` rather than through `createNote`. The
create tool cannot be rerouted through the batch, which deliberately refuses
`strict`, `template` and `if_exists`. So no single existing function sees every
note write; the attachment point has to be created, and creating it is the DRY fix
rather than a workaround.

None of the four tools declares an `outputSchema`, so an additive key breaks no
contract. All four are listed in `PREVIEW_BUDGET_EXEMPT` with reasons that say
"small fixed-shape receipt" (`registry-guard.ts:88-93`); those strings become
false and must be updated.

## Precedents to compose rather than invent

`WriteSessionError {code, path, message}` (`write-session/types.ts:45-50`) is
produced by `validateArtifact` and already reaches a write response, as
`CreateNoteError.violations` surfaced at `notes-tools.ts:258`. `DoctorIssue`
supplies `severity`. `RuntimeNotice` supplies the `next_command` idiom resolved
through `nextCommandField(code)`.

The architectural precedent is `write-advisory.ts`: an advisory computed around a
write, never gating it, surfaced as an additive key that is absent entirely when
there is nothing to say (`captureRoutingHintField` returns `{}` for null at
`:238-250`), with the forward pointer resolved strictly at module scope and a
visible stderr warning on failure. Its test asserts the key is absent on the clean
path.

So the payload is `WriteSessionError` plus `severity` plus optional
`next_command`: a composition of two existing conventions, not a third one.

Ranking is new: there is no comparator for lint findings anywhere. Name it once
and export it so the CLI and MCP cannot drift.

Note that `fix-merged-link` and `demote-stale-stable` are registered in
`applier-capability.ts:243-255` but not in `DIAGNOSTIC_SIGNALS`, so
`nextCommandField("fix-merged-link")` returns nothing today. Registering them is
the honest way to carry a fix hint; `broken-wikilink` is already registered.

## Recommended surface

One new module `src/core/brain/page-lint.ts` modelled field for field on
`write-advisory.ts`, exporting `PageLintFinding` (severity, code, path, message,
optional next_command), `PageLintReport` (findings, total, returned, truncated,
skipped, optional unavailable), a finding cap, the comparator,
`lintWrittenPage`/`lintWrittenPages`, and `pageLintField(report)` returning `{}`
when there is nothing to say.

Checks all reuse existing detectors and are structural or frontmatter keyed:
`validateArtifact` for the error-severity codes, so a strict create and a linted
update agree; merged-link per page via `resolveCanonicalId` rather than the merge
map; broken Brain-artifact wikilink against `collectAllBasenames`.

Attachment is one function, `noteWriteResult(ctx, writtenPaths, receipt)`, and the
four handlers' return statements become calls to it. `brain_write_session` keeps
its own `errors[]` channel, and the plan must say so rather than imply coverage.

It runs after the commit and never gates the write, reading what is actually on
disk. Failure degrades to `lint.unavailable = {code, message}`, never to a missing
key: an absent `lint` key must mean clean, and only that.

Cost stays bounded by computing the basename index and schema pack once per call
rather than per operation, never walking vault content, capping page bytes with
the existing artifact limit and reporting an over-cap page in `skipped[]` rather
than dropping it, and capping findings with `total`, `returned` and `truncated`
always present so a truncated list can never read as complete. Budget is under
about 10 ms for a typical single write against 359 ms for the vault pass.

## Adjacent defects worth the same pass

1. `notes-tools.ts:325` returns `path: "path" in only ? only.path : ""`. The empty
   arm is unreachable, and if it were reached the tool would report success with an
   empty path. Delete the fallback and narrow the type.
2. `{updated: true}` and `{appended: true}` restate what `WriteBatchOpResult`
   already carries: two sources for one fact.
3. The merged-link rewrite is single-hop: `buildMergeMap` reads one level while
   `resolveCanonicalId` walks the chain. After a two-step merge the pass rewrites
   to a target that is itself merged away, reports a `to` that is not canonical,
   and needs a second run to converge. Reusing `resolveCanonicalId` fixes the bug,
   deletes the duplicated walk and removes the 25 ms map build.
4. The merge map scans only `preferences` and `retired` while the rewrite covers
   all of `Brain/**`, so a merged page anywhere else is invisible to the lint that
   claims to fix merged links.
5. Two staleness definitions for one signal: `lint-consolidate.ts:138-150` reads
   raw frontmatter against a module default while
   `doctor/preference-hygiene.ts:96-125` uses the parsed field against the
   configured threshold.
6. `write-session/engine.ts:336-380` and `distill/distill-source.ts:203` write with
   their own lexical validation, bypassing `resolveNoteTarget` and the vault-scope
   and write-binding guards the four note tools go through. State that they are
   uncovered rather than imply coverage.
7. No document validation at all on update, append or batch: `assertValidDocument`
   runs only under `strict` on create, so those paths can write a document with no
   frontmatter, a bogus type or malformed tags and return `{updated: true}`. That
   is the actual quality hole this unit closes.
