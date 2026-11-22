# Tasks: the dream owner and its gate

Work in order, one section at a time. Before a section, read its part of
`design.md` and the spec delta it names. Tick each box (`- [x]`) as soon
as it is done, so an interrupted run can resume from the first open box.
Partial edits from an earlier attempt may already be in the tree: review
them, keep what is right, finish the rest.

For every behaviour: write the failing test first, run it and see it
fail, then write the code.

## Environment and rules

1. Work only in this checkout. Never read or write the real user state: not the real machine config, not a real vault, not the real state directories, not any real agent host configuration. Tests use the fixtures and temp directories the neighbouring tests use (`tests/setup.ts` isolates the state roots).
2. Your own temporary data goes under one directory you create with `mktemp -d` and remove at the end by its exact path. Never remove anything by a wildcard.
3. English only, no exclamation marks, the product name written "Open Second Brain" in full. No version bump. No personal settings, host names or account names.
4. No test-only seams in production code. A spy or a module mock is restored in `finally`.
5. Source files stay under 700 lines. `src/core/brain/dream.ts` is already large: new code goes into the new folder `src/core/brain/dream-owner/`. The only edits inside `dream.ts` are the gate call and the pass lock around a live pass (design D2, D3).
6. Search before reading: `zg "<meaning>"` or `zg --rg -F "<text>"`.
7. Commit locally, one commit, with the project identity given in the brief you were started with; no attribution trailers. Do not push, do not open or comment on pull requests, no subagents.
8. During a section run the test files you touched and their neighbours. The full suite runs once, in the gate section.

## 0. Preconditions

- [x] 0.1 Confirm the tree is clean and on the branch named in your brief. Run `bun test tests/core/view tests/core/brain/dream*.test.ts tests/mcp/dream*.test.ts --timeout 30000` and note the counts as the baseline. Stop and report on a failure that is not yours.
- [x] 0.2 Read `src/core/view/writer.ts` and `src/core/view/writer-fold.ts` in full: the owner role is built the same way (design D1).

## 1. The role: records and fold (spec: "A brain has at most one dream owner")

- [x] 1.1 Tests first, `tests/core/brain/dream-owner/fold.test.ts`: no records gives no owner; one claim gives its device and agent; two claims resolve to the lower (clock, device) on any input order; a request leaves the owner and sets `pending`; a release after a request makes the requester the owner; a release with no request leaves no owner; two requests then a release name exactly one successor; a forced claim supersedes without a release; a malformed record is ignored.
- [x] 1.2 `src/core/brain/dream-owner/fold.ts`: the pure fold and its types. Reuse the record comparison the view writer fold uses; do not copy it.
- [x] 1.3 Tests first, `tests/core/brain/dream-owner/owner.test.ts` on a fixture store: read on an empty store; claim; a second claim on the same device changes the agent with a new revision; request from a second device root; release under the local lock; the requester sees itself as owner only after it has caught up with the release.
- [x] 1.4 `src/core/brain/dream-owner/owner.ts` and `constants.ts`: `readDreamOwner`, `claimDreamOwner`, `requestDreamOwner`, `releaseDreamOwner`, `releaseIfRequested`, `claimSeen`, `claimSettled`. Record kinds `dream-owner-claim`, `dream-owner-request`, `dream-owner-released` in `shared`. No registration is needed: kinds are validated by form in `src/core/store/envelope.ts` and read by their own fold. Mirror `src/core/view/constants.ts` for the constants, including a device-local state directory, a claim-seen file and the pass lock name.
- [x] 1.5 Tests first, then the code: the claim-settle rule (a device that holds the role through its own claim is "settled" only from the catch-up after the one that first saw it; two devices that both claimed before syncing are not both settled) and the pass lock (`withLocalLock` on the exported lock target; a second holder waits or is refused as the view render lock does).

## 2. The gate (spec: "Only the owner's device runs a live pass")

- [x] 2.1 Tests first, `tests/core/brain/dream-owner/gate.test.ts`: unbound answers "unbound"; the owner's device passes; another device on a live call throws `DreamNotOwnerError` with the code `dream_not_owner`, the owner's device and agent and the transfer command in the message; a dry run on another device passes; a brain on the legacy tree answers "unbound".
- [x] 2.2 `src/core/brain/dream-owner/gate.ts`: `assertDreamOwner(vaultOrNull, { live })` (design D2).
- [x] 2.3 Tests first, one table in `tests/core/brain/dream-owner/gate-entry-points.test.ts`: on a device that is not the owner each of these is refused and writes nothing (compare a listing of the store and of the brain tree before and after), and asks no model: the dream verb live; the MCP dream tool `action=run`; the staged `stage`, `apply`, `discard` and `retriage` from the verb and from the tool; the writing step `heal-enrich`; the lane's dream task (skipped with the reason, the lane's other tasks run, exit not a failure). The front doors build their decision provider internally, so "asks no model" is asserted with a module mock of the decide entry (`prepareTopicVerdicts` in `src/core/topics/decide-auto.ts`), restored in `finally`. A second table pins that the previews still answer on that device: the dry run of the verb and the tool, the count-guard previews, `review-candidates`, the summary verb and the brief view tool. A third case: a device that holds the role through an unsettled claim is refused a live pass and passes after the next catch-up.
- [x] 2.4 Wire the gate: at the very top of `dream()` for a live run, before the topic and view pass wrappers and before `repairLaneEntryIds`; in the dream verb, the MCP tool and the lane task before `prepareTopicVerdicts`; in `runDreamStep` for the writing step; in `stage`, `apply`, `discard` and `retriage` of the staged lifecycle. Wrap the live pass in the pass lock of 1.5. Map the error: the verb exits 1 with one `error:` line; MCP returns the named code; the lane records a skipped task.
- [x] 2.5 The pass record: the summary and the log event carry `owner` (device and agent) and the calling agent. A test for a pass started by another agent on the owner's device.

## 3. Transfer (spec: "Ownership is transferred by one operation")

- [x] 3.1 Tests first, `tests/cli/dream-owner.test.ts`: `o2b dream owner` on an unbound brain, on the owner's device, on another device, with a pending request (text and `--json`); `--here` adopts an unbound brain; `--here --agent <name>` on the owner's device changes the agent at once; `--here` on another device records a request and exits 0 saying it is pending; after the owner's device runs `o2b dream owner` (which releases) the requester is the owner; `--release`; `--force` takes at once and prints the warning; a second transfer after one made on the command line succeeds; two devices request and the owner releases: the loser's `o2b dream owner` (text and `--json`) names the winner and says its own request lost.
- [x] 3.2 `src/cli/dream/owner.ts` and its dispatch in `src/cli/main.ts` (a new top-level `dream` command group; `o2b brain dream` is unchanged). Its entry in `src/cli/command-manifest.ts`, help text, completions and `docs/cli-reference.md`: `tests/cli/manifest-completeness.test.ts`, `tests/cli/help-surface-parity.test.ts` and `tests/cli/completions.test.ts` say what a new command group needs.
- [x] 3.3 Tests first, `tests/mcp/dream-owner-tool.test.ts`: `brain_dream_owner` `status` at local and remote reach (remote sees the device and agent names, no host paths); `take` and `release` at local reach; both refused at remote reach with nothing recorded; no `force` operation exists.
- [x] 3.4 `src/mcp/brain/dream-owner-tool.ts`, its registration, its row in the tool tables and in `docs/mcp.md` (the census tests name every table).
- [x] 3.5 Release points (design D3): the gate, the status command, and the background maintenance in `src/core/maintenance/ensure-current.ts`. A test that a pending request is released by a background maintenance run on the owner's device and that a pass in progress is not interrupted (the release is written under the pass lock of 1.5: hold the lock in the test and show the release waits).
- [x] 3.6 `o2b brain set-primary`: on a brain with an owner it changes the agent on the owner's device and refuses elsewhere with `dream_not_owner`; on an unbound brain it behaves as today. Tests for both.

## 4. Creation and adoption (spec: "The creating installation becomes the owner", "A brain from before this capability...")

- [x] 4.1 Tests first: creating a store with an agent name claims; creating with no name claims nothing and prints the line that says how to choose; attaching claims nothing; initialising again changes nothing; a fresh `o2b init` claims. Also: `o2b store init` that creates the store claims, and one that attaches does not. Use the existing tests as the pattern (`tests/core/store/store-init.test.ts`, `tests/cli/store-init-claim.test.ts`, `tests/cli/init-interactive.test.ts`, `tests/cli/init-no-vault.test.ts`).
- [x] 4.2 The claim in the create branch of `ensureBrainStore` (`src/core/brain/init-store.ts`, beside `claimOnCreate`) and in the create branch of `o2b store init` (`src/cli/store.ts`) (design D5).
- [x] 4.3 Tests first: a brain with a declared `primary_agent` and no owner record runs live passes from any device and keeps the existing warning; status names the declared agent as requested and not bound; `--here` adopts; a legacy-tree brain reports that ownership starts with the store.
- [x] 4.4 Doctor (design D7): the four codes, registered in the diagnostics registry and the doctor census tests. `o2b brain doctor` and `brain_doctor`.

## 5. Text that tells agents who runs dream

- [x] 5.1 `src/core/brain/writeback-contract.ts`: the managed block no longer says not to run dream here; it says dream runs on the owner's device and to ask `o2b dream owner` (or `brain_dream_owner`). Regenerate anything generated from it; `bun run sync-plugin-mirrors` if a skill or `hooks/hooks.json` changed.
- [x] 5.2 `install/hermes.md` step that designates that installation as primary, `docs/how-it-works.md` ("A vault shared across hosts..." and the dream section), `docs/cross-project-pointer.md`, `docs/brain-store.md`: describe the owner, the gate, the transfer and adoption. Do not touch the cron recipes or the discipline installer (a later change).
- [x] 5.3 `CHANGELOG.md`: entries under `## [Unreleased]`, the refused live pass marked as a breaking change for a brain that has an owner.

## 6. The gate

- [x] 6.1 Run each on its own and fix what fails: `bun run test`, `bunx tsc --noEmit -p .`, `bun run lint`, `bun run fmt:check`, `bun run check:paths`, `bun run sync-plugin-mirrors:check`, `bun run scripts/sync-version.ts --check`.
- [x] 6.2 If the OpenClaw bundle includes changed code, rebuild it with `bunx bun@1.4.4 run build:openclaw` and commit `openclaw/index.js` only if it changed.
- [x] 6.3 New test files that take more than a few seconds on Windows: say which, so the timings file can be refreshed from the first CI run.

## 7. Report

- [x] 7.1 Report: per section what was built (files), the tests added with real counts, the full-suite counts, every place the design was not followed and why, and what is left open. Name each existing test whose expectation you changed and why.

## Workflow follow-up

- Independent code review rounds, then archive the change inside its pull request.
