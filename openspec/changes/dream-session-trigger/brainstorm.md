# Brainstorm

The owner's decisions are in `openspec/changes/agent-neutral-dream/brainstorm.md`, section "Starting dream", items 1 to 8: no operating system scheduler and no resident process; one shared check at session entry that reads one small machine-local record and costs one read when the day is closed; a claim before anything is spawned; a detached one-shot worker; a day stamp that is not coverage; failure sets a retry time with bounded backoff; any agent on the owner's machine may wake the worker; other machines are silent except one cached line after three days. `inventory.md` is the code inventory for this change and the next (section "Change A").

## What this change settles

1. **The record is keyed by the configured store root, not by the store's identity.** The session start hook already reads the machine config. Keying the record by a hash of the configured store root makes the closed-day path that read plus one small file, with no store opened. Alternative: the store's own state directory, which needs the store id and therefore a second read. Rejected for the fast path; the worker uses the store's directory for everything else.
2. **Two entry points, one function.** The session start hook where a host has one (Claude Code, Codex, Grok), and a successful MCP `initialize` for the rest. Hosts start a stdio server per session, so `initialize` is a session event for them; a long-lived server is checked again on its first tool call of a new day. The check is one function with no host knowledge.
3. **Ownership is not checked on the fast path.** Deciding whether this device is the owner means folding the role records. The record caches the answer with the owner revision it was computed for, and it is recomputed at most once a day, by the worker or by a due check, never by a closed-day check.
4. **What closes a day.** The worker's pass ended with the replay not behind, no source gap, and no queue item that is ready, due and answerable by an executor this machine has. Anything else leaves the day open and sets a retry time: one hour, doubling, capped at one day. A queue whose items nobody can answer here (no decision model, no agent command) does not keep the day open forever: that state is reported by doctor and the session note, and the day closes.
5. **The claim is a record with a token, as the post-upgrade worker's is.** The first draft made the claim the pass lock. The review showed why it cannot be: the pass lock lives as long as the process that holds it, and the process that claims exits at once. The check creates a claim file exclusively and hands its token to the worker; the worker takes the pass lock itself.
6. **A pass started any other way also closes the day.** `o2b brain dream`, the MCP dream tool and the maintenance lane write the same record through the same function when they finish. So an old cron job and the trigger do not run two passes: whichever comes second finds the day closed or the lock held. The first proposal said adoption would refuse the old trigger; that is not needed and would break a user's working cron job for no gain. The documentation says the cron job can be removed.
7. **A setting turns the trigger off.** `dream.auto`, a shared setting, on by default for a brain with an owner. A brain with no owner is never triggered.
8. **The three-day line needs a synced fact.** A pass that changes nothing writes no log event today, so silence cannot be told from an empty run. The coverage record of the replay change is written for every covered window and syncs; a machine that is not the owner reads the newest one when it refreshes its cached ownership, once a day at most, and shows one line when it is older than three days.

## Rejected

1. An operating system scheduler or a resident process (the owner's decision).
2. Checking in the MCP server's constructor or on a timer: the server may live for days, and a timer is a resident process.
3. Refusing passes started by an external trigger after adoption (decision 6).
4. Running the pass inside the hook: the hook has ten seconds and a pass with model work has minutes.

## Partner

The decisions are the owner's, from the shared brainstorm and its partner. This change adds a code inventory and one independent review of its artifacts.
