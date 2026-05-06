---
name: open-second-brain
description: Use Open Second Brain to read, write, and maintain an agent-owned second brain in an Obsidian-compatible Markdown vault.
---

# Open Second Brain

Use this skill when a user asks an agent to use, configure, inspect, or maintain Open Second Brain.

## Core principles

- Treat the vault as user-owned durable knowledge.
- Write only inside configured agent-owned areas unless explicitly instructed.
- Keep raw operational events separate from synthesized knowledge.
- Never write secrets, tokens, passwords, private keys, or credential-bearing connection strings.
- Prefer deterministic CLI commands over guessing file paths.

## v0 expectation

In v0, Open Second Brain is expected to provide documentation, scripts, skills, and plugin manifests. Deep runtime automation and MCP tools are future work.

## Default workflow

1. Check whether Open Second Brain is configured.
2. Read the machine-local config if available.
3. Read the vault-local operating manual if available.
4. Use `vault-log` or `asb append-event` for event logging.
5. Use Markdown edits for durable synthesized knowledge only when the user asks or the configured policy allows it.

## Safety

If a write operation might affect personal notes outside the agent-owned area, ask for explicit confirmation.
