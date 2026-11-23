# Proposal

## Why

Everything dream needs now exists: an owner, a replay of missed days, a queue and its executors. Nothing starts it. Today a user builds a cron job or it never runs. The owner's decision: the product starts dream itself, at the first session of the day on the owner's machine, with no scheduler and no resident process, and the check must be nearly free on every other session.

## What Changes

1. A day check at session entry: in the session start hook for hosts that have one, at MCP `initialize` (and on the first tool call of a new day for a long-lived server) for the rest. On a closed day it reads one small machine-local record and returns.
2. When a pass is due on the owner's device, the check takes the pass lock without waiting, rechecks, and starts a detached one-shot worker, `o2b dream run`, that runs the whole pass (questions, executors, replay, planning, view) and records the outcome.
3. A failed or incomplete pass sets a retry time with bounded backoff, so later sessions do not start it again at once.
4. Every way of running a live pass records the day the same way, so an external trigger and this one never both run.
5. A shared setting `dream.auto` (on by default for a brain with an owner).
6. A machine that is not the owner stays silent, except one line at session start when the owner has covered nothing for three days, with the command that transfers the role.
7. `o2b dream status` shows the day, the last run, the retry time and why a day is open.

This is the seventh of the eight changes of the series.

## Capabilities

### New Capabilities

- `dream-trigger`: when a pass starts without a scheduler, what the check costs, what closes a day, and what other machines say.

## Impact

1. Code: a new `src/core/brain/dream-trigger/` (the record, the check, the claim hand-off, the outcome), `hooks/active-inject.ts` (the call and one note lane), `src/mcp/server.ts` (the call at initialize and the first call of a day), a new `src/cli/dream/run.ts` and `status.ts`, the three existing live entry points (the outcome record), `src/core/maintenance/o2b-command.ts` users (one more spawn site in the self-spawn census), the shared setting key, doctor, `docs/dream.md`, `docs/cli-reference.md`.
2. Depends on every earlier change of the series.
3. Risks: the hook's ten second budget; a worker that dies holding the claim; two sessions starting at the same second; a brain on a machine with no session for days.
4. Not in this change: any scheduler recipe change (the next change), the digest at session start (the next change).
