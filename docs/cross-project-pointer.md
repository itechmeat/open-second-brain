# Cross-project setup

When the coding work happens in a project directory that is not the
Open Second Brain vault, the agent needs a pointer to find the vault
on session start. This page describes the canonical snippet to drop
into a project, the conventions around the vault's primary
dream-running agent, and what changes when several devices share the
same vault.

## 1. Add the pointer snippet to your project

Append the block below to one of the agent-prompt files your runtime
reads on startup. Common targets:

- `CLAUDE.md` — Claude Code.
- `AGENTS.md` — Codex, Cursor, Aider, and other tools that follow the
  `agents.md` convention.

Pick one location per project. The managed-block fences let a future
`o2b brain bootstrap` command rewrite the snippet idempotently; manual
edits inside the fences are preserved on subsequent runs.

Replace `<absolute-vault-path>` with the absolute path of your
Obsidian-compatible vault before pasting.

```text
# >>> open-second-brain managed >>>
## Open Second Brain

This project shares an Obsidian-compatible vault with an active
observing-memory layer. At session start, read the current
preferences:

    <absolute-vault-path>/Brain/active.md

Record taste signals via `brain_feedback` (MCP) or
`o2b brain feedback` (CLI). After producing a durable artifact, call
`brain_apply_evidence` with `result: applied | violated | outdated`
for any preference whose `scope` matches.

Do not run `o2b brain dream` from this runtime. The vault has a
primary dream-running agent declared in `<vault>/Brain/_brain.yaml`
(key `primary_agent`).
# <<< open-second-brain managed <<<
```

The snippet is intentionally short. The agent does not need
configuration here — every operational detail lives in the vault
itself (preferences, the active digest, the `_brain.yaml` config).

## 2. Primary agent and the dream cron

A shared vault has exactly one runtime responsible for running the
deterministic `dream` consolidation pass. Declare that runtime in
`Brain/_brain.yaml`:

```bash
o2b brain set-primary <agent-name> --vault <vault-path>
```

`<agent-name>` is the value of `agent_name` in
`~/.config/open-second-brain/config.yaml` on the host that runs the
dream cron. To verify, run:

```bash
grep agent_name ~/.config/open-second-brain/config.yaml
```

When dream runs from a different agent, the response carries a
structured warning:

- The CLI prints
  `warning: non-primary-dream-run: dream run from agent '<caller>', ...`
  to `stderr`. Exit code stays `0`.
- The MCP `brain_dream` tool returns a `warnings` array containing
  `{ code: "non-primary-dream-run", message: "..." }` alongside the
  usual summary.
- The dream summary log event (`Brain/log/<date>.md`) gains a
  `non_primary_agent: <caller>` payload row so the breach is greppable
  in the audit trail.

The pass still completes — the declaration is observability, not
access control. Pinning, rejecting, and toggling pins remain
unrestricted: any agent on any device can mutate the protected set.

To clear the primary declaration (the vault becomes single-host
again, or you want to disable the check during local
experimentation):

```bash
o2b brain set-primary --clear --vault <vault-path>
```

A vault initialised with `o2b brain init --primary-agent <name>`
writes the value into the fresh `_brain.yaml` on the first run; on
re-runs against an existing file `--primary-agent` is ignored — use
`set-primary` instead.

## 3. Multi-device through Syncthing

The vault is designed to be Syncthing-shared. Signals can be captured
on any peer:

- `brain_feedback` from a coding session on the laptop.
- `o2b brain feedback` from a terminal.
- `@osb` markers added by hand in Daily notes from the phone (captured
  later by `o2b brain scan-inline` on any peer).

All of these land in `Brain/inbox/`. The primary host's dream cron
picks them up on the next pass, regardless of which peer wrote them.
Use the `primary_agent` declaration to keep dream serialised to one
host so signal processing does not race; the rest of the Brain
layer is conflict-free because writes are append-only or
locally-scoped (signals, daily logs, snapshots).
