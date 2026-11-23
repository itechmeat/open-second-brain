# Cross-project setup

When the coding work happens in a project directory that is not the
Open Second Brain vault, the agent needs a pointer to find the vault
on session start. This page describes the canonical snippet to drop
into a project, the dream owner (the one device and agent that runs
live dream passes), and what changes when several devices share the
same vault.

## 1. Add the pointer snippet to your project

Append the block below to one of the agent-prompt files your runtime
reads on startup. Common targets:

- `CLAUDE.md` — Claude Code.
- `AGENTS.md` — Codex, Cursor, Aider, and other tools that follow the
  `agents.md` convention.

Pick one location per project. You can have Open Second Brain write
and maintain this block for you instead of pasting it by hand:
`o2b install --target <host> --apply` writes the managed block into the
agent-instruction file your host reads at the vault root (AGENTS.md for
codex, cursor, opencode and aider; GEMINI.md for gemini-cli), under an
explicit consent prompt, keeping every byte outside the block intact on
every re-run. The installed block merges the usage content below with
the memory write gate, and a later uninstall removes exactly the pair
the tool wrote. The manual snippet stays for hosts you provision by
hand. Install only writes the vault-root instruction file of the target
host; there, a pasted snippet or any hand edit inside the managed
fences makes the run refuse with `user-modified-block` unless `--force`
replaces it (a backup of the previous file is taken first).

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

When a dream owner is bound, live dream runs only on the owner's device:
ask `o2b dream owner` (MCP `brain_dream_owner`) before a live
`o2b brain dream`. Unbound and legacy brains retain live passes from
any device. A dry run is always fine.
# <<< open-second-brain managed <<<
```

The snippet is intentionally short. The agent does not need
configuration here — every operational detail lives in the vault
itself (preferences, the active digest, the `_brain.yaml` config).

## 2. The dream owner

A brain has one dream owner: one agent installation on one device. Only
that device runs a live `dream` pass; every other device previews.
The installation that creates the brain (`o2b init`, `o2b store init`)
becomes the owner when its agent name is known; attaching another
device, initialising again and switching a machine to the store never
change it. Ask who it is from any device:

```bash
o2b dream owner            # or the MCP tool brain_dream_owner, operation status
```

Move it with one operation:

- `o2b dream owner --here --agent <name>` on the owner's device changes
  the agent at once.
- `o2b dream owner --here` on another device records a request; the
  owner's device hands the role over the next time it looks (a dream
  pass, its status, or a session start), and only then does the
  requesting device run live passes.
- `o2b dream owner --here --force` takes the role at once, for an owner
  device that is lost. The old owner keeps passing its own gate, and may
  run passes, until its first catch-up after the forced claim reaches it.
- `o2b dream owner --release` gives the role up with no successor.

Through MCP, `brain_dream_owner` offers `take` and `release` at local
reach; there is no forced transfer there.

On a device that is not the owner every live dream path refuses with
`dream_not_owner` before it asks a model or writes anything: `o2b brain
dream`, its staged `stage`, `apply`, `discard` and `retriage`, the
writing step `--step heal-enrich`, `brain_dream`, and the maintenance
lane's dream task, which is skipped with the reason while the lane's
other tasks run. Dry runs answer on every device. Any agent on the
owner's device may run the pass; its summary names the owner and the
agent that started it.

### A brain from before the dream owner

A brain with no owner record behaves as before: a live pass runs from
any device, and a declared `primary_agent` keeps producing the
`non-primary-dream-run` warning for another agent:

- The CLI prints
  `warning: non-primary-dream-run: dream run from agent '<caller>', ...`
  to `stderr`. Exit code stays `0`.
- The MCP `brain_dream` tool returns a `warnings` array containing
  `{ code: "non-primary-dream-run", message: "..." }` alongside the
  usual summary.
- The dream summary log event gains a `non_primary_agent: <caller>`
  payload row.

`o2b dream owner` and doctor name a declared `primary_agent` as the
requested owner. Adopt the brain by running `o2b dream owner --here` on
the device that should own dream; ownership is never inferred from an
installed agent, the last writer or the machine that ran an update.
Every machine of the brain must run a release with the dream owner
before the role is relied on: an older binary ignores the gate. A brain
whose records still live in the legacy `Brain/` tree reports that the
owner is enforced once the brain moves to the store.

`o2b brain set-primary <name>` keeps working: on a brain with an owner
it changes the owner's agent on the owner's device (and refuses
elsewhere with `dream_not_owner`); on a brain with no owner it writes
the declared name as before.

```bash
o2b brain set-primary --clear --vault <vault-path>
```

clears the declaration. On a legacy vault, `o2b brain init
--primary-agent <name>` writes the value into the fresh `_brain.yaml`
on the first run; on re-runs against an existing file `--primary-agent`
is ignored — use `set-primary` instead. A machine switched to the brain
store refuses the flag: there the dream owner (`o2b dream owner`) is the
role.

## 3. Multi-device through Syncthing

The vault is designed to be Syncthing-shared. Signals can be captured
on any peer:

- `brain_feedback` from a coding session on the laptop.
- `o2b brain feedback` from a terminal.
- `@osb` markers added by hand in Daily notes from the phone (captured
  later by `o2b brain scan-inline` on any peer).

All of these land in the brain. The dream owner's device picks them up
on its next pass, regardless of which peer wrote them. The dream owner
keeps dream serialised to one device so signal processing does not
race; the rest of the Brain layer is conflict-free because writes are
append-only or locally-scoped (signals, daily logs, snapshots).
