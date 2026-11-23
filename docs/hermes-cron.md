# Optional digest delivery for Hermes users

Dream runs through the configured Open Second Brain owner and needs no Hermes
schedule. This guide shows how a Hermes user can separately schedule delivery
of the read-only brain digest.

## Prerequisites

- Hermes gateway is running.
- The Open Second Brain plugin is installed and enabled.
- `o2b` is on `PATH` for the gateway user.
- `o2b brain init --vault /path/to/vault` has created the Brain configuration.
- A Telegram destination is configured for the Hermes job.

## Add an optional digest job

This example reports the trailing 24 hours at 20:00 UTC:

```bash
hermes cron create \
  --name "brain-digest-daily" \
  --deliver "telegram:<chat_id>:<topic_id>" \
  --workdir "/" \
  --no-agent --script \
  '0 20 * * *' \
  'o2b brain digest --vault /path/to/vault --silent-if-empty'
```

The job runs only the digest command. It does not start dream. The digest is
read-only, and `--silent-if-empty` exits with code `2` when the selected window
contains no changes, so Hermes sends no message.

The default window is the trailing 24 hours. Use `--since <ISO>` and
`--until <ISO>` to choose another interval. Use Hermes commands to list, edit,
pause, resume, run, or remove this optional job.

## Use a printed maintenance recipe

Open Second Brain prints cron and systemd user timer recipes for maintenance,
search reindexing, and codegraph resync. The recipes do not install anything.
Choose a scheduler for the machine and add the printed command yourself.

```bash
o2b brain maintenance run --vault /path/to/vault --cron-template
o2b search reindex --vault /path/to/vault --cron-template
o2b partner codegraph resync --cron-template
```

Freshen on read keeps the keyword index current while agents work. Schedule
reindexing only when you want to refresh embedding vectors periodically.
