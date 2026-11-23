# Design

## Context

From `inventory.md`, section "Change A" (each claim with its code reference there):

1. Hosts with a session start hook: Claude Code and Codex (`hooks/hooks.json` and its generated mirror), Grok (its own hooks file); the hook is `hooks/active-inject.ts`, declared with a ten second timeout and a self-watchdog two seconds before it; on session start it already reads the machine config, probes the vault, and fires maintenance without waiting. Every other host reaches the product only through MCP; `handleInitialize` in `src/mcp/server.ts` is synchronous and starts nothing.
2. The self-spawn census (`tests/core/architecture/self-spawn-census.test.ts`) lists every place that starts the product's own process; a new one must be added to its list.
3. The post-upgrade worker is the template: a claim taken before the spawn and handed to the child by a token argument, release when the spawn throws, a failure marker with a cooldown of one hour doubling to a day, lost-worker handling, a capped device-local log, config passed by an environment variable (`src/core/maintenance/ensure-current.ts`, `self-heal-upgrade-state.ts`, `o2b-command.ts`).
4. Device state: `stateRootDir()`, per store `deviceStateDirFor(storeId)`; a machine with no vault has its own root.
5. The dream path computes days in UTC. No record of a last successful pass exists; a pass that changes nothing writes no log event. The replay change writes a coverage record per covered window in the shared partition.
6. The pass lock of the dream owner change is device-local; after that change's review it records its holder's process and is stale only when that process is gone. It cannot be handed to another process as it is, and `withDreamPassLock` waits five seconds; `withLocalLock` with a zero budget does not wait. A cooperative deadline of 600 seconds by default bounds a pass.
8. Neither entry point keeps the machine config it reads: the hook's vault resolution returns only the vault, and the MCP server discards it; resolving the store root reads the config again, twice. The hook fires on `startup`, `resume`, `clear` and `compact`. When its payload is otherwise empty it prints nothing. Notes reach a session through the runtime notices channel of the cached assembly; one cut note is pinned as the payload's last line. `invokeToolHandler` in `src/mcp/server.ts` is the one seam every tool call passes, for the protocol path and the command line bridge. `pi` reaches the product through the command line only.
7. No verb runs a whole pass as one command with the asynchronous front door apart from `o2b brain dream`.

## Goals / Non-Goals

**Goals:**

1. A pass a day on the owner's machine with no setup.
2. A closed-day check that costs one small read beyond what the hook already reads.
3. Never two passes, never a blocked session.

**Non-Goals:**

1. Any scheduler. The digest at session start. Changes to cron recipes.
2. Starting a pass on a machine that is not the owner.

## Decisions

### D1. The record

`<state root>/dream-trigger/<sha256 of the configured store root, first 16 hex>.json`, written atomically:

`{ version, store_root, auto, owner: { device, revision, mine }, owner_checked_day, day, closed, reason, last_run: { started_at, ended_at, outcome, by }, failures, retry_at, line: { shown_day, text } }`

`readTriggerRecord(config)` takes a loaded machine config and does one file read. So that the closed-day path adds one read and not three, the hook's target resolution is changed to return the config it loaded beside the vault, and the MCP server keeps the config its constructor read; the store root is taken from that object, not resolved again. A missing or unreadable record is "unknown": the due path decides.

### D2. The check

`src/core/brain/dream-trigger/check.ts`: `dreamDayCheck(config, now): { started: boolean, note?: string }`, synchronous.

1. No store root configured: return.
2. Read the record. Return when: `auto` is false; `owner.mine` is false and `owner_checked_day` is today (with the note of D6 if one is due); `closed` and `day` is today; `retry_at` is in the future.
3. The due path, only now: open the store, read the setting and fold the owner role (`readDreamOwner`); write the record's `auto`, `owner` and `owner_checked_day`. Not the owner, no owner, or auto off: return (for a non-owner, compute the line of D6).
4. Claim: create `<record path>.claim` exclusively (it fails if the file exists), holding a random token, the time and this process's id. Not created: read it; a claim younger than the pass deadline plus two minutes means a worker was started, return. An older one whose worker is not holding the pass lock is a lost worker: remove the claim, write a failed attempt (the failure count and the retry time) and return; the pass starts at a later check.
5. Under the claim, read the record again; closed today: remove the claim and return.
6. Start the worker (D3) with the token, write `last_run.started_at`, return `{ started: true }`. If the spawn throws, remove the claim and record a failed attempt.

The claim is a record, not the pass lock: the process that makes it exits at once, and a lock that follows its holder's life cannot be handed over. The worker proves the token, takes the pass lock itself for the length of the pass, and removes the claim when it has recorded the outcome.

Callers: `hooks/active-inject.ts` on every event its session start matcher fires for (start, resume, clear, compact: the closed-day path is cheap enough, and a long session that is compacted the next morning is then covered), after its target resolution, before rendering; `MCPServer` at `handleInitialize`, and in `invokeToolHandler` at the first call whose UTC day differs from the day of the server's last check (one comparison per call otherwise), which also covers a host whose plugin never calls initialize. A host that uses only the command line (`pi`) has no session entry; its passes come from another agent on the machine or from the command, and the documentation says so. Both wrap it so that any throw is swallowed and logged: the check can never fail a session. The check does not run in a process that carries the dream session marker.

The spawn site is added to the self-spawn census.

### D3. The worker

`o2b dream run [--claim <token>] [--json]` (`src/cli/dream/run.ts`): the one command that runs a whole live pass: owner gate, the front door (produce questions, the decision model executor, the agent executor), `dream()`, then the outcome (D4). With `--claim` it must find the claim file holding that token, or it exits without running; it then takes the pass lock as any pass does. Without `--claim` it is the same thing run by hand and makes no claim.

Started with `spawnSelfDetached`: the absolute executable, the config by environment variable, standard error to a capped device-local log (`<device state>/dream/worker.log`, one header per attempt), detached and unreferenced. Its deadline is the dream safeguard's; the agent executor's clamp of the launched agent change applies to it.

### D4. The outcome

`recordDreamOutcome(vault, result)` in `dream-trigger/outcome.ts`, called at the end of `o2b dream run` and of the three existing live entry points (the dream verb, the MCP dream tool, the lane task), on the owner's device:

1. Complete: the pass returned, the replay status says not behind and no gap, and the queue has no item that is ready, due and answerable here (per operation: the decision model answers it, or a verified agent command exists). Write `closed: true`, the day, `failures: 0`, no `retry_at`.
2. Complete but work waits that nothing here can answer: closed, with `reason` and a `note` naming the operations and what would answer them. The note is shown at session start on the owner's machine once a day (D6) and by doctor (`dream-work-unanswerable`, D7).
3. Anything else (a throw, the deadline, windows behind, a gap, answerable work left): `closed: false`, `failures + 1`, `retry_at = now + min(1 h * 2^(failures-1), 24 h)`, `reason`.

The day is the UTC day at the pass's start: a pass that crosses midnight closes the day it started in.

### D5. The setting

`dream.auto` in the closed list of shared setting keys, default true. `o2b brain settings` sets it as it sets the others.

### D6. The line on other machines

On the due path of a non-owner (at most once a day): read the newest coverage record of the shared partition. Older than three days, or none while the owner record is older than three days: store in the record `line.text` ("Dream is owned by <device> (<agent>) and last covered <day>. To run it here: o2b dream owner --here") and return it as the note once per day (`line.shown_day`). The same carrier serves the owner's note of D4. The hook passes it through the runtime notices channel of its assembly, and when its payload would otherwise be empty it prints the note alone; the MCP server puts it in the instruction text of that initialize.

### D7. Status and doctor

1. `o2b dream status [--json]` (`src/cli/dream/status.ts`): the record, the owner, the replay status and the queue summary in one place; the manifest entry and `docs/cli-reference.md`.
2. Doctor: `dream-auto-off` (info), `dream-day-open` (advice, with the reason and the retry time, when open for more than one day), `dream-worker-lost` (warning, after a lost worker), `dream-work-unanswerable` (advice: the day closed with work no executor here can answer, with what would). Registered and placed for the exit census.

## Risks / Trade-offs

1. The due path opens the store inside the hook's ten seconds. It happens at most once a day per machine plus once per retry; the fold of the owner role is the same read the owner gate does. The hook's watchdog still bounds it, and a check cut by the watchdog started nothing and wrote nothing.
2. A machine with no session for days runs no pass. The replay covers the gap at the next session; this is the owner's decision.
3. The record is keyed by the configured store root. Changing the configured root starts a new record; the old file is harmless and small.
4. A user who keeps a cron job gets passes from both, never two at once, and at most one that does work per day.
5. A long-lived MCP server is checked on the first tool call of a new day, which adds one date comparison to every call.
