# Design

## Context

1. `dream()` in `src/core/brain/dream.ts` is the single engine. Live callers: the dream verb (`src/cli/brain/verbs/dream.ts`), the MCP dream tool with `action=run` (`src/mcp/brain/dream-tools.ts`), the staged apply from both (`src/core/brain/dream-stage.ts`), the writing step `heal-enrich` (`src/core/brain/dream-step.ts`) and the maintenance lane's dream task (`src/core/brain/maintenance/lane-tasks.ts`). Callers that only preview and are not gated: `src/core/brain/review-candidates.ts`, `src/cli/brain/verbs/summary.ts`, `src/mcp/brain/brief-view-tools.ts` and the count-guard previews of the verb and the tool. The staged lifecycle also has `stage`, `discard` and `retriage`, which write and delete bundle files under the brain tree without calling the engine live. The front doors prepare model verdicts before they call the engine; the engine repairs lane entry ids before it looks at `primary_agent`.
2. `primary_agent` is a scalar with two homes (the legacy `_brain.yaml`, the shared store setting). A mismatch only warns. An agent cannot overwrite a value a person set (`src/core/brain/policy/settings-write.ts`).
3. The view writer role (`src/core/view/writer.ts`, `writer-fold.ts`) already solves "one device holds a role across machines that sync late": claim, request and release records in the `shared` partition, a fold that picks one holder by (clock, device), a release written under a local lock, a claim that waits one catch-up.
4. A device has a stable id in the machine config (`src/core/config.ts`).

## Goals / Non-Goals

**Goals:**

1. One owner per brain, bound to a device, with the agent recorded.
2. One gate under every live path, placed before model preparation and before the early repair writes.
3. A transfer that works every time, from the command line and from MCP, and that cannot produce two owners.
4. No change for a brain until it is adopted.

**Non-Goals:**

1. Starting dream (the trigger change), model work (the executors change), the replay (its own change).
2. Moving the view writer or tying the two roles together.
3. Proving which agent process runs on the owner's device: the gate is on the device.

## Decisions

### D1. The owner is a folded role, like the view writer

This replaces the wording of the brainstorm's "the owner record keeps the name `primary_agent` and is a shared setting": the owner is a role of folded records, and `primary_agent` stays as the declared name (D4, D6).

Three record kinds in `shared`: `dream-owner-claim`, `dream-owner-request`, `dream-owner-released`. Record kinds need no registration: they are validated by form in `src/core/store/envelope.ts` and each fold reads its own; `src/core/view/constants.ts` is the pattern for the constants. A new module pair mirrors the view writer: `src/core/brain/dream-owner/fold.ts` (pure fold: records to state) and `owner.ts` (read, claim, request, release). The state: `{ owner: { device, agent, revision } | null, pending: { device, agent, at } | null, claims: n }`. The revision is the hybrid logical clock of the winning record. Ties resolve by (clock, device), the rule the view writer fold uses; share its comparison rather than copying it.

A claim waits one local catch-up, as the view writer's does (`claimSeen` and `claimSettled` in `src/core/view/writer.ts`, with a device-local claim-seen file): a device that holds the role through its own claim passes the live gate only from the catch-up after the one that first saw it hold the role. Two devices that both claim before either has synced therefore do not both run a live pass only when sync delivers each the rival claim before its second local look. When it does not, both devices pass their local gates and can run concurrent live passes; the device-local pass lock does not prevent that. This is the same limit `src/core/store/FORMAT.md` states for the view writer.

Alternative rejected: keep the scalar setting and add a device field. A setting has last-writer-wins semantics and an authority rule that blocks the second transfer; a role needs request and release.

### D2. The gate is the device

`assertDreamOwner(vaultOrNull, { live })` in `src/core/brain/dream-owner/gate.ts`. With no owner record it returns "unbound" and the caller behaves as today. With an owner it compares the owner's device with this machine's device id. A mismatch on a live call throws `DreamNotOwnerError` (code `dream_not_owner`) carrying the owner's device and agent and the transfer command. The agent name is recorded on the pass and never refused: any agent on the owner's device may start the pass.

The gate is called in two places so nothing runs ahead of it: at the top of `dream()` for a live run, before `repairLaneEntryIds`; and in each front door before `prepareTopicVerdicts` (the dream verb, the MCP tool, the lane task), so no model is asked for a pass that will be refused. `runDreamStep` and the staged apply call it for their writing forms, and so do `stage`, `discard` and `retriage` of the staged lifecycle: they write files into the brain tree, which syncs, so on a device that is not the owner they are refused like a live pass; only the forms that write nothing stay open. The lane maps the error to a skipped task with the reason.

Read "the top of `dream()`" literally: the gate goes before the `withTopicPass` and `withViewPass` wrappers, whose writes follow the engine, not at the top of the inner run.

Alternative rejected: the gate only in the front doors. A new caller of `dream()` would bypass it.

### D3. Release happens when the owner's device next looks

The pass lock: a device-local lock in a `dream-owner` state directory (constants beside the role's, mirroring `VIEW_STATE_DIR` and `VIEW_RENDER_LOCK`), taken with the process lock of `src/core/store/process-lock.ts`. A live `dream()` pass holds it for its whole length, and every release is written under it. A pass is synchronous and long, so the lock is not judged by age, as `withLocalLock` is (taken over after 60 seconds and never refreshed during synchronous work): it is a file created exclusively that records the holder's pid and start identity, judged by the migration gate's liveness rule (`src/core/store-migration/holder-liveness.ts`). A live holder keeps it however long it runs, a gone holder is taken over at once, and only a holder that cannot be checked falls back to the 60 second age. Taking, taking over and releasing run under a short `withLocalLock` mutex, and a release removes the file only while it carries its own token. That is the one edit this change makes inside `src/core/brain/dream.ts` besides the gate call: the live pass is wrapped in the lock, with the lock target exported from `src/core/brain/dream-owner/`.

A request from another device is pending until the owner's device writes the release. The owner's device looks, and releases under the pass lock, at: the gate (any live attempt), the owner status command, and the background maintenance that session start and the MCP server start already run (`src/core/maintenance/ensure-current.ts`). A pass in progress finishes before the release is written. The requester becomes the owner only after it has seen the release.

A forced transfer writes a claim that supersedes the owner without a release. It is a command-line flag and is refused through MCP. Its warning says what is true: the previous owner keeps passing its own gate, and may run passes, until its first catch-up after the forced claim reaches it.

### D4. The transfer is its own operation, not a setting write

`o2b dream owner` (status), `o2b dream owner --here [--agent <name>]` (take or adopt on this device; on the owner's device with `--agent` it changes the agent), `o2b dream owner --release` (give the role up with no successor), `--force`. MCP: `brain_dream_owner` with `operation: status | take | release`, where `take` and `release` are refused at remote reach. It does not go through `settings-write.ts`, so the authority of the previous change does not block it; every record carries the agent and whether a person or an agent made it.

`o2b brain set-primary <name>` keeps working: on a brain with an owner it is `--agent <name>` on the owner's device and refuses elsewhere with the same named error; on a brain with no owner it writes the declared name as today.

### D5. Creation claims, attachment does not

`ensureBrainStore` already distinguishes creating from attaching (`status: "created" | "existing"` in `src/core/brain/init-store.ts`), and its create branch is where the view writer claim runs (`claimOnCreate`). `o2b store init` is a second creating path with its own claim call (`src/cli/store.ts`). On create, in both paths and only then, the claim is written for this device with the resolved agent name (the `--agent-name` flag, else the configured name). With no name it writes nothing and prints one line: no owner, run `o2b dream owner --here --agent <name>`. A fresh `o2b init` that creates the store goes through the same path.

### D6. Unbound and legacy brains

No owner record: the gate answers "unbound", live passes run from anywhere, the existing `primary_agent` warning stays. Status and doctor say "no dream owner is bound" and name a declared `primary_agent` as requested. A brain whose records live in the legacy tree has no `shared` partition to hold the role: status says ownership starts when the brain moves to the store, and the gate is "unbound". A store whose `shared` partition this machine does not hold (`o2b store init --partitions private`) is different: the role exists but cannot be read here, so the owner is unknown, a live pass is refused with `dream_not_owner` naming the missing partition, and previews still answer. Only a readable `shared` partition with no owner record is "unbound".

### D7. Surfaces

1. Doctor: a new check group with the codes `dream-owner-unbound` (information), `dream-owner-elsewhere` (information), `dream-owner-pending` (uncertain when this device must release), `dream-owner-agent-differs` (information when `primary_agent` and the owner's agent differ).
2. The dream summary and the log event name the owner and the caller; `non_primary_agent` stays for unbound brains.
3. Text that tells agents who runs dream: the managed writeback block (`src/core/brain/writeback-contract.ts`), the session start instructions and the install guides stop saying "do not run dream here" and say to ask the owner status.

## Risks / Trade-offs

1. A device id copied with a cloned machine config makes two machines one device. The role cannot tell them apart; doctor already reports a duplicated device id in the store roster, and the status prints the device id so a person can see it. Not solved here.
2. An owner device that is lost never releases. The forced transfer is the way out, and it is a person's decision on the command line.
3. An older binary on another machine ignores the gate. Adoption text says that every machine of the brain must run a release with this change before the role is relied on; the status lists devices whose last record came from an older release where the roster knows it.
4. The lane's skipped dream task hides a brain that never consolidates on a machine that is not the owner. The skip reason and doctor's `dream-owner-elsewhere` say where it runs.
5. Two gate call sites per front door (before verdicts, inside the engine) cost two folds of a few records; both read the same catch-up.
