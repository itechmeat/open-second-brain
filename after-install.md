# Open Second Brain after install

These steps are the same for every supported agent host. They assume the
package is installed and one host is connected ([`install.md`](install.md)).

## 1. Check the installation

```bash
o2b install --check
o2b doctor
```

`o2b install --check` verifies each connected host. `o2b doctor` reports
the machine, the brain store and, when one is configured, the vault. Add
`--vault /path/to/vault` to check a specific vault.

## 2. Confirm the dream owner

Dream runs on one installation, the dream owner. The installation that
created the brain is the owner when its agent name was known. Check it:

```bash
o2b dream owner
```

To make this machine and agent the owner, run:

```bash
o2b dream owner --here --agent "<agent-name>"
```

On the owner's machine this changes the agent at once. On another machine
it records a request, and the owner's machine hands the role over the next
time it looks. Other machines preview dream and refuse a live pass with
`dream_not_owner`. The full model is in [`docs/dream.md`](docs/dream.md).

## 3. Set and verify the dream agent

On the owner's machine, set the command that starts your own agent for
dream's model work, then verify it with a real short session. No preset
commands ship: you choose the command and the flags that restrict the
session to the one MCP server it is given.

```bash
o2b dream agent set '["/path/to/agent", "--your-flags", "{prompt}", "--mcp-config", "{mcp_config}"]'
o2b dream agent check
```

Until a verified command exists, that work waits in the dream queue and
doctor reports `dream-agent-unset` or `dream-agent-unverified`. A decision
model is an optional accelerator for dream's closed questions:
[`docs/decision-models.md`](docs/decision-models.md).

## 4. Check that dream starts

Nothing needs to be scheduled. The first session of a day on the owner's
machine starts the day's pass. See the state of the day:

```bash
o2b dream status
```

To keep model-written text for review before it is applied:

```bash
o2b brain settings set dream.apply_drafts review
```

## 5. Read the human view

With a vault the readable pages go to its `o2b-memory/` folder; name
another folder with `view_target` in the machine config (or `none` for no
pages). The view writer renders them at session start and after each dream
pass; to render at once:

```bash
o2b view render
```

The pages are plain Markdown: `about-me.md`, weekly history, decisions and
one page per topic. Editing a rule on `about-me.md` records your
correction; deleting its line retires the rule. Details:
[`docs/brain-store.md`](docs/brain-store.md#the-human-view).

## 6. Optional maintenance

Dream needs no scheduler. For periodic reindexing and other upkeep, print a
recipe and choose a scheduler yourself:

```bash
o2b brain maintenance run --vault /path/to/vault --cron-template
```

The recipe prints crontab and systemd forms. It does not install a
schedule.

## More machines

To share one brain between machines, sync the store's partitions with a
sync tool you choose; Open Second Brain does not sync them itself. See
[`docs/brain-store.md`](docs/brain-store.md#more-machines).

## Agent guides

Every supported host has its own page; the router is
[`install.md`](install.md#supported-clients).

## Uninstall

Review the detected integrations before removing local files:

```bash
o2b uninstall
```

Add `--apply-local` to remove the local Open Second Brain config
directory. Your vault, your Markdown notes and the brain store are kept.
