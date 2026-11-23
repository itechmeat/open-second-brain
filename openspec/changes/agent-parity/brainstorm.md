# Brainstorm

The owner's decisions are in `openspec/changes/agent-neutral-dream/brainstorm.md`, section "No agent is privileged": the Hermes cron line and environment file leave the shared recipes; the embeddings guide and the uninstall plan stop assuming Hermes; the digest is shown by any agent at session start; the discipline check moves into doctor; the Hermes cron installer with its Telegram format is removed; what is specific to Hermes as a host stays (the memory provider, the host memory bridge, profile isolation, the repository root as its install entry). `inventory.md` is the code inventory (section "Change B").

## What this change settles

1. **Recipes print two ways, not three.** Every printed scheduler recipe has a crontab form and a systemd form; the third block, a `hermes cron create` line, is removed. A user of Hermes schedules with either like anyone else. The scripts sourced `$HOME/.hermes/.env` for embedding variables; they source an optional file of the product's own, `$OPEN_SECOND_BRAIN_ENV_FILE` or `<config dir>/env`, when it exists.
2. **The digest is pushed where a host can be pushed to, and offered elsewhere.** After a pass that changed something, a session on any machine of the brain shows a short digest once: at session start through the hook's notes lane where there is a hook, and as one line in the MCP instruction text ("a dream digest is available") where there is not, since a host with no hook cannot be pushed to and the full digest is a resource it can read. The first draft of the owner's decision said "shown by any agent at session start"; for hosts with no session event this is the strongest form that exists.
3. **Delivery is once per pass per machine, by a record of the machine.** The first draft used the injection ledger. The review showed it is per session and cleared at every session start, so it cannot say what this machine was shown yesterday. A small device-local file holds the keys of delivered digests.
4. **The discipline report stays a command and becomes a doctor finding; its installer goes.** `o2b discipline report` prints plain Markdown. Doctor reports the same verdict as advice when the report is enabled in the brain's settings; it never changes doctor's exit code, because a quiet day is not a fault. `o2b discipline install` and `uninstall`, the packaged script and the Telegram escaping are removed.
5. **Nothing is orphaned silently.** The removed installer wrote jobs into a Hermes file. Doctor and the uninstall plan detect jobs with this product's ids in that file, read-only, and say how to remove them.
6. **The uninstall plan names only what is installed.** Hermes steps are printed when the install manifest or the plugin directory shows a Hermes integration, not always.
7. **Guides are rewritten around the reader's agent.** `after-install.md` becomes the neutral finishing steps; the embeddings skill names the product's own env file and any scheduler; `docs/hermes-cron.md` stays at its address as an operator's guide for Hermes users, without the discipline installer and with a note that dream needs no schedule.
8. **One journey proves it.** A single test drives, with no Hermes, no Python and no network: set up a brain for a file-written host, record signals, run a pass with a scripted decision provider and a fake agent, see the digest at the next session start, move the owner role, and print the uninstall plan with no Hermes line in it.

## Rejected

1. Keeping `discipline install` behind a flag: a second, privileged path is what the owner removed.
2. A push to hosts with no hook by writing into their configuration at each pass.
3. Removing Hermes' own adapter features.

## Partner

The decisions are the owner's, from the shared brainstorm and its partner. This change adds a code inventory and one independent review of its artifacts.
