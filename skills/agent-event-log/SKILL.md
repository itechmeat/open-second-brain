---
name: agent-event-log
description: Append-only operational event logging for Open Second Brain. Daily Markdown notes are the default backend.
---

# Agent Event Log

Use this skill after substantial work or when the user asks for an operational log entry.

## Purpose

The event log records what happened, when, and which agent did it. It is evidence, not a polished wiki page.

## Rules

- Append only.
- Keep entries short and factual.
- Include the agent name when supported.
- Do not include secrets.
- Redact sensitive values as `[REDACTED]`.

## Compatibility

The compatibility command is `vault-log`.

Future Open Second Brain CLI commands may include:

```bash
asb append-event --as <agent-name> "message"
vault-log --as <agent-name> "message"
```

## Example

```bash
vault-log --as hermes-vps-agent "created initial open-second-brain repository documentation and plugin skeleton"
```
